import type { Sink } from "../core/persistence.js";
import { EventBus } from "../core/events.js";
import { AuditLog } from "../modules/audit/index.js";
import { ChannelRouter, SlackChannel } from "../modules/channels/index.js";
import { EnergyMeter } from "../modules/energy/index.js";
import { IdentityService, PermissionError } from "../modules/identity/index.js";
import { Ledger } from "../modules/ledger/index.js";
import { AnthropicAdapter } from "../modules/model-gateway/adapters/anthropic.js";
import { MockAdapter } from "../modules/model-gateway/adapters/mock.js";
import { ModelGateway } from "../modules/model-gateway/gateway.js";
import { RunPodAdapter } from "../modules/model-gateway/adapters/runpod.js";
import { makeInstantAnswerer } from "./instant-answers.js";
import { RoutingGateway } from "../modules/model-gateway/routing/router.js";
import { SpendLedger } from "../modules/model-gateway/routing/ledger.js";
import { RoutingSettingsStore, defaultSettings } from "../modules/model-gateway/routing/settings.js";
import type { Completer } from "../modules/model-gateway/types.js";
import { AdminManager } from "../modules/admin-manager/index.js";
import { InMemoryModelProvisioner, InMemoryStorageProvisioner } from "../modules/admin-manager/provisioning.js";
import { OnboardingService } from "../modules/onboarding/index.js";
import { BatchService } from "../modules/batch/service.js";
import { WorkforceService } from "../modules/workforce/index.js";
import { IntegrationService, defaultRegistry, type OAuthApp } from "../modules/integrations/index.js";
import { QualityReviewService } from "../modules/review/index.js";
import { DecisionDigest, openDecisions, type OpenDecision } from "./decisions.js";
import type { LoginApps } from "./social-login.js";
import { PriceBook, paidTeamPlan } from "../modules/pricing/index.js";
import { SpecialistReviewService, type SpecialistRequest } from "../modules/review/specialists.js";
import { templateFromRole } from "../modules/workforce/templates.js";
import { MockPaymentProvider, PaymentService, type PaymentProvider } from "../modules/payments/index.js";
import { quote } from "../modules/store/cart.js";
import { ReconciliationService } from "../modules/reconciliation/index.js";
import { localParts } from "../modules/batch/schedule.js";
import { RotaService, RotaError } from "../modules/rota/index.js";
import { PeopleService } from "../modules/people/index.js";
import { ConversationService } from "../modules/conversations/index.js";
import { NotificationService } from "../modules/notifications/index.js";

import { ConsoleEmailSender, QueuedEmailSender, ResendEmailSender, type EmailSender } from "./email.js";
import { brandFrom, decisionsWaitingEmail, ownerAlertEmail } from "./email-templates.js";
import { userIdFor } from "./identity.js";
import { ExpiringSet, SendLog } from "./expiring.js";
import { AffiliateService, CouponService } from "../modules/promotions/index.js";
import { PromoterService } from "../modules/promoter/index.js";
import { GrowthService } from "../modules/growth/index.js";
import { MetaGraph, MetaRejected, type MetaConfig } from "../modules/meta/index.js";
import { OwnerWhatsApp, WhatsAppCloud, type WhatsAppConfig } from "../modules/whatsapp/index.js";
import { ConnectionsService } from "../modules/connections/index.js";
import { COMPANY } from "../company.js";
import { CredentialStore } from "../modules/credentials/index.js";

export interface PlatformConfig {
  anthropicApiKey?: string;
  anthropicModel?: string;
  /** RunPod Serverless endpoint (vLLM worker) that does the heavy lifting. Both come from environment variables. */
  runpod?: { apiKey: string; endpointId: string };
  sessionSecret: string;
  /** Where sign-in emails come from. Defaults to printing them (development). */
  email?: EmailSender;
  /** Public address of the website, used in sign-in links. */
  appUrl?: string;
  /** Help address shown in email footers. Left out of the footer when not set. */
  supportEmail?: string;
  /** Dev-only sign-in by email, no verification. Must stay off in production. */
  allowDevAuth: boolean;
  slack?: { clientId: string; clientSecret: string; signingSecret: string; redirectUri: string };
  /** "Continue with Google / Microsoft": the provider apps that are switched on (from environment variables). */
  loginApps?: LoginApps;
  /** Our OAuth app for each connector that has one (for example square), from environment variables. */
  integrationApps?: Record<string, OAuthApp>;
  /**
   * Emails of the MAIZ platform owner(s), from PLATFORM_OWNER_EMAILS. Only they see the quality review
   * queue and sign off specialised tasks. Clients can never approve their own.
   */
  platformOwners?: readonly string[];
  /**
   * Takes payments. Leave out for no charging: checkout is then refused. Development (allowDevAuth) defaults to a
   * mock provider that charges nobody. A real provider (Stripe) is a class implementing PaymentProvider.
   */
  payments?: PaymentProvider;
  /** Facebook Page and Instagram publishing for the promotion agent (owner only). From environment variables. */
  meta?: MetaConfig;
  /** The owner's WhatsApp line to the promotion agent. From environment variables. */
  whatsapp?: WhatsAppConfig;
  /**
   * The server-set services' variables (Resend, Stripe, RunPod, Anthropic, Slack, META_GRAPH_VERSION), only so the
   * owner's Connections page can say whether each is set and test it. Never sent to the browser.
   */
  connectionEnv?: Record<string, string | undefined>;
  now?: () => Date;
  http?: typeof fetch;
}

/** Wires every module together. One place, so the server and tests build the same system. */
export function createPlatform(cfg: PlatformConfig) {
  const now = cfg.now ?? (() => new Date());
  const audit = new AuditLog();
  const bus = new EventBus();
  const identity = new IdentityService(audit, bus);
  const energy = new EnergyMeter(identity, audit, now);
  /**
   * Open models on RunPod do the work and Claude supervises (see model-gateway/routing). Everything about it,
   * models, thresholds and caps included, is editable by the platform owner. Without any key the answers are mocks.
   */
  const aiSettings = new RoutingSettingsStore(defaultSettings(cfg.anthropicModel ?? "claude-haiku-5-5"));
  const spend = new SpendLedger(now);
  const runpod = cfg.runpod ? new RunPodAdapter(cfg.runpod.apiKey, cfg.runpod.endpointId, aiSettings.get().runpod.model, cfg.http) : undefined;
  const claude = cfg.anthropicApiKey ? new AnthropicAdapter(cfg.anthropicApiKey, cfg.anthropicModel ?? "claude-haiku-5-5", cfg.http) : undefined;
  const routing = runpod || claude ? new RoutingGateway({ settings: aiSettings, ledger: spend, runpod, claude, now: () => now().getTime() }) : undefined;
  const gateway: Completer = routing ?? new ModelGateway([new MockAdapter()]);
  const workforce = new WorkforceService(identity, audit, bus, gateway, energy);
  const ledger = new Ledger(identity, audit);
  const ownerEmailsEarly = (cfg.platformOwners ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const ownerIdSet = new Set(ownerEmailsEarly.map(userIdFor));
  /** Prices, trial terms and per-agent energy, set by the platform owner on the Prices page. */
  const prices = new PriceBook((userId) => ownerIdSet.has(userId), now);
  energy.setQuotaResolver((_ws, employeeId) => {
    const key = workforce.templateOf(employeeId);
    return key ? prices.agentAllowance(key) : undefined;
  });
  // Add-on employees and specialists add their weekly energy to a paid team pool.
  energy.setPoolBonusResolver((ws) => workforce.templatesIn(ws).reduce((sum, key) => sum + prices.weeklyEnergyFor(key), 0));
  /** Discount coupons: trial days and free energy work today; discounts on the bill are recorded for when billing starts. */
  const coupons = new CouponService((userId) => ownerIdSet.has(userId), {
    isTrial: (ws) => energy.onTrial(ws),
    extendTrial: (ws, days, by) => { energy.extendTrial(ws, days, by); },
    grantEnergy: (ws, n, by) => energy.grantEnergy(ws, n, by),
  }, now);
  /** Referral partners: links, signups, commission earned and payouts the owner marks as paid by hand. */
  const affiliates = new AffiliateService((userId) => ownerIdSet.has(userId), now);
  const onboarding = new OnboardingService(identity, workforce, ledger, energy, audit, now, () => {
    const g = prices.general();
    return { days: g.trialDays, teamEnergy: g.trialTeamEnergy, dailyTeamCeiling: g.dailyTeamCeiling };
  });
  const router = new ChannelRouter(identity, workforce, audit);
  /** Business apps (tills, payroll). Employees get only the app data the owner granted them. */
  // Our Xero/Square apps: the server's when set there, otherwise what the owner typed on the Connections page
  // (looked up on each use, so a saved app works at once).
  const oauthApps = new Proxy({} as Record<string, OAuthApp>, {
    get: (_t, k) => (typeof k === "string" ? cfg.integrationApps?.[k] ?? connections.integrationApps()[k] : undefined),
  });
  const integrations = new IntegrationService(identity, audit, ledger, defaultRegistry(), { http: cfg.http, now, oauthApps });
  workforce.addContext((ws, templateKey) => integrations.contextFor(ws, templateKey));
  /** Welcomes new owners and runs setup. Storage and models are stand-ins until real RunPod/bucket provisioning is wired in. */
  const admin = new AdminManager(identity, workforce, audit, bus, new InMemoryStorageProvisioner(), new InMemoryModelProvisioner(), router, { now });
  /** Batch work: compiled during the day, sent to the pod at each client's closing time or when enough has gathered. */
  /** What each client said to each employee, kept per employee so follow-ups have context. */
  const conversations = new ConversationService(identity, now);
  /** The bell: one notice per event, with a read marker per person. */
  const notices = new NotificationService(identity, now);
  /** Tells the client in the Admin manager's inbox (and their chat app), and rings the bell once. */
  const tellClient = async (ws: string, title: string, text: string, kind: "batch_done" | "review" | "specialist", link: string) => {
    notices.add(ws, { kind, title, body: text, link });
    await admin.tell(ws, text, link);
  };
  const batch = new BatchService({
    identity, audit, workforce, settings: aiSettings, ledger: spend, isPlatformOwner: (id) => ownerIdSet.has(id), now,
    notify: (ws, text, link) => tellClient(ws, "Your batch is done", text, "batch_done", link ?? "/app.html#work"),
    ended: (job, outcome, answer) => {
      if (outcome === "done" && answer !== undefined) conversations.fileQueued(job.workspaceId, job.employeeId, job.id, answer);
      else if (outcome === "failed") conversations.failQueued(job.workspaceId, job.employeeId, job.id);
    },
  });
  // The weekly refill and "today" follow the client's own clock (the same zone as their batch schedule).
  energy.setZoneResolver((ws) => batch.scheduleOf(ws).timezone);
  workforce.setIntake(batch);
  workforce.addContext((ws, templateKey, taskType) => batch.contextFor(ws, templateKey, taskType));
  // Email goes through the server's Resend settings when set there, otherwise the ones typed on the Connections
  // page (a new sender as soon as they change), otherwise the log.
  const consoleEmail = new ConsoleEmailSender();
  let typedMail: { apiKey: string; from: string; sender: QueuedEmailSender } | undefined;
  const currentEmail = (): EmailSender => {
    if (cfg.email) return cfg.email;
    const s = connections.emailSettings();
    if (!s) return consoleEmail;
    if (typedMail?.apiKey !== s.apiKey || typedMail.from !== s.from) typedMail = { ...s, sender: new QueuedEmailSender(new ResendEmailSender(s.apiKey, s.from, cfg.http)) };
    return typedMail.sender;
  };
  const email: EmailSender & { idle(): Promise<void> } = { send: (m) => currentEmail().send(m), idle: async () => { await typedMail?.sender.idle(); } };
  const base = (cfg.appUrl ?? "").replace(/\/$/, "");
  /** Signed-in user ids of the platform owners (the same id the session carries). */
  const ownerEmails = ownerEmailsEarly;
  const isPlatformOwner = (userId: string) => ownerIdSet.has(userId);
  /** The platform owner's open decisions, newest problems first. The owner's address is the only way in. */
  const ownerDecisions = (): OpenDecision[] => {
    const owner = [...ownerIdSet][0];
    if (!owner) return [];
    return openDecisions({ reviews: reviews.queue(owner), specialists: specialists.queue(owner), promotions: promoter.waiting(owner), growth: growth.waiting(owner) }, now().getTime());
  };
  // One email for any number of waiting decisions, with a button to the page that lists them all.
  const decisionDigest = new DecisionDigest({
    now: () => now().getTime(),
    count: () => ownerDecisions().length,
    send: async (count) => {
      for (const to of ownerEmails) {
        await email.send({ to, ...decisionsWaitingEmail(count, `${base}/owner-decisions.html`, brandFrom(cfg)) });
      }
    },
  });
  /**
   * The promotion agent for the owner's three websites. Everything it drafts waits for the owner (the same decisions
   * page and email digest as quality review); it sends email only one person at a time and only after approval.
   */
  /**
   * Facebook, Instagram and WhatsApp come from the owner's Connections page (stored encrypted) or, when set, the
   * server's environment variables. They are rebuilt whenever the owner saves, so no restart or server login is needed.
   */
  const live: { graph?: MetaGraph; wa?: OwnerWhatsApp; waState?: unknown; sink?: Sink } = {};
  const connections = new ConnectionsService((userId) => ownerIdSet.has(userId), {
    now, http: cfg.http, appUrl: base, envMeta: cfg.meta, envWhatsApp: cfg.whatsapp, env: cfg.connectionEnv,
    onChange: () => rebuildChannels(),
    whatsapp: () => live.wa,
  });
  const graphNow = (): MetaGraph => {
    if (!live.graph) throw new MetaRejected("Facebook and Instagram are not connected yet: connect them on the Connections page");
    return live.graph;
  };
  const promoter = new PromoterService((userId) => ownerIdSet.has(userId), {
    now, completer: gateway, send: (mail) => email.send(mail),
    meta: { status: () => live.graph?.status() ?? { facebook: false, instagram: false }, publish: (i) => graphNow().publish(i), stats: (t, id, at) => graphNow().stats(t, id, at) },
    unsubscribeUrl: (token) => `${base}/unsubscribe.html#t=${encodeURIComponent(token)}`,
    sender: { name: COMPANY.name, address: COMPANY.registeredOffice },
    notifyOwner: () => { decisionDigest.poke(); void live.wa?.notifyWaiting(); },
  });
  const firstOwner = [...ownerIdSet][0];
  function rebuildChannels(): void {
    const m = connections.metaConfig();
    live.graph = m ? new MetaGraph(m, cfg.http) : undefined;
    const w = connections.whatsappConfig();
    if (live.wa) live.waState = live.wa.exportState();
    live.wa = w && firstOwner ? new OwnerWhatsApp(new WhatsAppCloud(w, cfg.http), promoter, { ownerUserId: firstOwner, now }) : undefined;
    if (live.wa && live.waState) live.wa.restore(live.waState);
    if (live.wa && live.sink) live.wa.useSink(live.sink);
  }
  rebuildChannels();
  /**
   * The Content Distribution and Community Growth Manager: researches places to publish, drafts for each one, and records
   * what went out and what it earned. Owner only. It never posts, creates accounts or sends pitches itself.
   */
  const growth = new GrowthService((userId) => ownerIdSet.has(userId), { now, completer: gateway, notifyOwner: () => decisionDigest.poke() });
  /** MAIZ quality review: every client's specialised tasks wait here for the platform owner's sign-off. */
  const reviews = new QualityReviewService(identity, audit, isPlatformOwner, {
    now,
    notifyOwner: async () => decisionDigest.poke(),
    notifyClient: async (item) => {
      const chosen = item.proposal.directions?.find((d) => d.key === item.proposal.chosenDirection);
      await tellClient(item.workspaceId, "Quality review passed", `"${item.proposal.title}" passed quality review${chosen ? ` (direction: ${chosen.name})` : ""}. Your ${item.proposal.employee} has started the work.${item.noteToClient ? ` Note from MAIZ: ${item.noteToClient}` : ""}`, "review", "/app.html#work");
    },
  });
  /** New custom specialists: drafted for the client, checked and priced by the platform owner before training. */
  /** A custom specialist's template: its approved role and job description, usable only by the client that asked for it. */
  const customTemplateOf = (r: SpecialistRequest) => ({ ...templateFromRole(r.role, `custom-${r.id}`), jobDescription: r.jobDescription });
  const specialists = new SpecialistReviewService(identity, audit, isPlatformOwner, (tier) => {
    const g = prices.general();
    return tier === "premium" ? g.specialistPremiumMonthlyGbp : g.specialistStandardMonthlyGbp;
  }, {
    now,
    hire: async (userId, r) => {
      const t = customTemplateOf(r);
      workforce.registerCustomTemplate(r.workspaceId, t);
      return workforce.hire(userId, r.workspaceId, t.key);
    },
    notifyOwner: async () => decisionDigest.poke(),
    notifyClient: async (r) => {
      const text = r.status === "approved"
        ? `MAIZ approved your new specialist "${r.role.title}" at £${r.priceGbp} a month. It is ready to hire.`
        : r.status === "changes_requested"
          ? `MAIZ reviewed your new specialist "${r.role.title}" and asked for changes: ${r.messageToClient}`
          : `MAIZ will not offer the specialist "${r.role.title}": ${r.messageToClient}`;
      await tellClient(r.workspaceId, "Update on your new specialist", text, "specialist", "/app.html#team");
    },
  });

  let alertOwnersLate: (subject: string, text: string) => Promise<void> = async () => undefined;
  /** Staff and shifts, so rota questions are answered from real records. */
  const rota = new RotaService(identity, audit);
  workforce.addContext((ws, templateKey) => rota.contextFor(ws, templateKey, now().toISOString().slice(0, 10)));
  /** Short questions the records answer exactly (who is in today, cash, energy left) skip the AI altogether. */
  workforce.setInstant(makeInstantAnswerer({ rota, ledger, energy, batch, workforce, now }));
  /** The HR manager desk: full staff records. A person added here goes on the rota too, so there is one staff list. */
  const people = new PeopleService(identity, audit, {
    now,
    addToRota: (userId, m) => {
      try {
        return { id: rota.addStaff(userId, m.workspaceId, { name: m.name, role: m.jobTitle, ...(m.payBasis === "hour" && m.payPence !== undefined && m.payPence <= 100_000 ? { hourlyRateMinor: m.payPence } : {}) }).id };
      } catch (e) {
        // Already on the rota under that name, or the rota is full: the record is still kept, and the owner is told why.
        if (e instanceof RotaError) return { problem: e.message };
        throw e;
      }
    },
    removeFromRota: (userId, m, today) => {
      try { rota.deactivate(userId, m.workspaceId, m.rotaStaffId!, today); } catch (e) { if (!(e instanceof RotaError)) throw e; }
    },
    rotaWeek: (ws, rotaStaffId, today) => {
      const w = rota.weekFor(ws, today);
      const mine = w.shifts.filter((s) => s.staffId === rotaStaffId);
      const h = w.hoursByPerson.find((x) => x.staffId === rotaStaffId);
      if (!h && !mine.length) return undefined;
      return { weekStart: w.weekStart, shifts: mine.map((s) => ({ date: s.date, start: s.start, end: s.end, hours: s.hours, ...(s.role ? { role: s.role } : {}) })), hours: h?.hours ?? 0, cap: h?.cap ?? 48 };
    },
    syncRota: (m, prefs) => {
      try { rota.setLimits(m.workspaceId, m.rotaStaffId!, prefs); } catch (e) { if (!(e instanceof RotaError)) throw e; }
    },
    businessName: (ws) => identity.workspaceById(ws)?.name,
  });
  workforce.addContext((ws, templateKey) => people.contextFor(ws, templateKey));
  /** Checkout and orders. What a paid order buys is hired here, from the same templates the store sells. */
  const payments = new PaymentService(identity, audit, {
    provider: cfg.payments ?? (cfg.allowDevAuth ? new MockPaymentProvider() : undefined),
    quote: (lines) => quote(lines, prices.catalogue()),
    appUrl: base,
    customerEmail: (userId) => identity.workspacesFor(userId).map((w) => w.ownerEmail).find(Boolean),
    now,
    alert: (subject, text) => alertOwnersLate(subject, text),
    fulfil: async (order) => {
      const ids: string[] = [];
      for (const line of order.lines) {
        // A consultant line is "consultant:pass"; the employee template is the part before the colon.
        const templateKey = line.key.split(":")[0]!;
        for (let i = 0; i < line.qty; i++) ids.push((await workforce.hire(order.userId, order.workspaceId, templateKey)).id);
      }
      // A recurring line makes the client a paying one: they leave the free trial and start the paid plan with a full
      // pool (the trial's energy is not held against it). One-off consultant passes alone do not end the trial.
      // A referred client's payment earns the affiliate their commission (the first N payments only).
      // Only subscriptions count: one-off passes do not earn commission.
      if (order.lines.some((l) => l.billing === "monthly")) affiliates.recordPayment(order.workspaceId, order.dueTodayMinor / 100, order.id);
      if (order.lines.some((l) => l.billing === "monthly")) energy.switchToPaid(order.workspaceId, paidTeamPlan(prices.general()), `user:${order.userId}`);
      return ids;
    },
  });

  /** Nightly check of every client's books, run once after each client's own midnight (their batch time zone). */
  const reconciliation = new ReconciliationService({
    workspaceIds: () => identity.allWorkspaces().map((w) => w.id),
    localDate: (ws) => {
      const l = localParts(now(), batch.scheduleOf(ws).timezone);
      return `${l.y}-${String(l.m).padStart(2, "0")}-${String(l.d).padStart(2, "0")}`;
    },
    books: (ws) => ledger.rawBooks(ws),
    records: (ws) => integrations.recordsOf(ws),
    orders: (ws) => payments.all().filter((o) => o.workspaceId === ws),
    now,
    alert: async (ws, report) => {
      const name = identity.workspaceById(ws)?.name ?? ws;
      const errors = report.findings.filter((f) => f.severity === "error");
      await alertOwnersLate(`Books need a look: ${name}`, `Tonight's check of ${name}'s books found ${errors.length} problem(s):\n\n${errors.map((f) => `- ${f.message}`).join("\n")}\n\nNothing was changed. Details: ${base}/owner-clients.html`);
    },
  });

  /**
   * The client's control center, from real records: each employee's energy, the task board and the week's totals.
   * Everything is read through the services, so permissions and workspace walls apply.
   */
  const dashboard = (userId: string, workspaceId: string) => {
    const nowDate = now();
    const weekAgo = new Date(nowDate.getTime() - 7 * 86_400_000).toISOString();
    const team = workforce.team(userId, workspaceId);
    const energyDays = energy.recentDays(userId, workspaceId, 7);
    const done = workforce.tasksSince(userId, workspaceId, weekAgo).filter((t) => t.status === "ready_for_review");
    const open = batch.openJobsOf(workspaceId);
    const label = (id: string) => team.find((e) => e.id === id)?.name ?? "Employee";
    const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
    const people = team.map((e) => {
      const allowance = energy.quotaOf(userId, workspaceId, e.id);
      const week = energyDays.byEmployee.get(e.id) ?? new Array(7).fill(0);
      const mine = open.filter((j) => j.employeeId === e.id);
      const running = mine.find((j) => j.status === "running") ?? mine[0];
      return {
        id: e.id, name: e.name, templateKey: e.templateKey, allowance, usedToday: week[6] as number, week,
        doneWeek: done.filter((t) => t.employeeId === e.id).length,
        status: running ? "working" : "idle",
        doing: running ? clip(running.brief, 100) : null,
      };
    });
    const reviewsNeedingYou = reviews.forClient(userId, workspaceId).filter((r) => r.status === "gathering_info" || r.status === "more_info_requested");
    const inReview = reviews.forClient(userId, workspaceId).filter((r) => r.status === "in_review").length;
    const tasks = [
      ...open.filter((j) => j.status === "queued").map((j) => ({ id: j.id, employeeId: j.employeeId, title: clip(j.brief, 80), column: "planned" as const, runsAt: j.runsAt })),
      ...open.filter((j) => j.status === "running").map((j) => ({ id: j.id, employeeId: j.employeeId, title: clip(j.brief, 80), column: "in_progress" as const })),
      ...reviewsNeedingYou.map((r) => ({ id: r.id, employeeId: null, title: r.title, column: "waiting" as const, note: "Needs your answers" })),
      ...done.slice(0, 40).map((t) => ({ id: t.id, employeeId: t.employeeId, title: clip(t.brief, 80), column: "done" as const, energy: t.energyUsed ?? 0, at: t.at })),
    ];
    const use = energy.usageOf(workspaceId);
    const sched = batch.forClient(userId, workspaceId);
    // The team's shared pool (null on older per-employee plans): what the dashboard shows as the allowance.
    const teamEnergy = energy.teamEnergy(userId, workspaceId) ?? null;
    return {
      asOf: nowDate.toISOString(),
      team: people,
      teamEnergy,
      tasks: tasks.map((t) => ({ ...t, employeeName: t.employeeId ? label(t.employeeId) : null })),
      totals: {
        energyToday: use.energyToday,
        allowanceToday: teamEnergy ? teamEnergy.leftToday + use.energyToday : people.reduce((n, e) => n + e.allowance, 0),
        energyWeek: people.reduce((n, e) => n + e.week.reduce((a: number, b: number) => a + b, 0), 0), energyMonth: use.energyMonth,
        queued: sched.queued, waitingOnYou: reviewsNeedingYou.length, inReview, doneWeek: done.length,
        nextRunLabel: sched.nextRunLabel,
      },
    };
  };

  /** The platform owner's AI spend and routing controls. Nothing here is visible to clients. */
  const ai = {
    overview: (userId: string) => {
      if (!ownerIdSet.has(userId)) throw new PermissionError("only the platform owner sees AI spend");
      return { configured: { runpod: !!runpod, claude: !!claude }, status: routing?.status() ?? null, settings: aiSettings.get(), ...spend.summary(30), cacheable: aiSettings.get().cache.enabled };
    },
    health: async (userId: string) => {
      if (!ownerIdSet.has(userId)) throw new PermissionError("only the platform owner sees AI spend");
      return runpod ? runpod.health() : { reachable: false, error: "RunPod is not configured (RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID)" };
    },
    update: (userId: string, patch: unknown) => {
      if (!ownerIdSet.has(userId)) throw new PermissionError("only the platform owner changes AI settings");
      return aiSettings.update(patch);
    },
  };

  /** The platform owner's clients screen: every client at a glance. */
  const clients = (userId: string) => {
    if (!isPlatformOwner(userId)) throw new PermissionError("only the platform owner sees all clients");
    const nowIso = now().toISOString();
    const openReviews = new Map<string, number>();
    for (const r of reviews.queue(userId)) if (r.status !== "approved") openReviews.set(r.workspaceId, (openReviews.get(r.workspaceId) ?? 0) + 1);
    const openSpecialists = new Map<string, number>();
    for (const r of specialists.queue(userId)) if (r.status === "in_review") openSpecialists.set(r.workspaceId, (openSpecialists.get(r.workspaceId) ?? 0) + 1);
    return identity.allWorkspaces().map((w) => {
      const plan = energy.planOf(w.id);
      const use = energy.usageOf(w.id);
      return {
        id: w.id,
        name: w.name,
        ownerEmail: w.ownerEmail ?? null,
        createdAt: w.createdAt ?? null,
        trialEndsAt: plan.expiresAt ?? null,
        status: plan.expiresAt && plan.expiresAt < nowIso ? "trial_ended" : plan.expiresAt ? "trial" : "active",
        setup: admin.setupStateOf(w.id) ?? "not_started",
        employees: workforce.countIn(w.id),
        energyToday: use.energyToday,
        energyMonth: use.energyMonth,
        /** What MAIZ paid model providers this month, in US dollars. */
        aiCostUsdMonth: Math.round(use.costMicroMonth / 10_000) / 100,
        /** Last nightly check of this client's books: ok, problems found, or not run yet. */
        books: (() => { const r = reconciliation.latestFor(w.id); return r ? { ok: r.ok, date: r.date, problems: r.findings.filter((f) => f.severity === "error").length, warnings: r.findings.filter((f) => f.severity === "warn").length } : null; })(),
        openReviews: openReviews.get(w.id) ?? 0,
        specialistsToReview: openSpecialists.get(w.id) ?? 0,
      };
    }).sort((a, b) => Number(b.setup === "needs_attention") - Number(a.setup === "needs_attention") || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  };
  /**
   * A setup that could not undo itself needs a person. The Admin manager tells the client that MAIZ
   * has been alerted, so this is where the platform owner actually is.
   */
  const alertOwners = alertOwnersLate = async (subject: string, text: string) => {
    for (const to of ownerEmails) await email.send({ to, ...ownerAlertEmail(subject, text, brandFrom(cfg)) }).catch((e) => console.error("owner alert failed:", e));
    if (!ownerEmails.length) console.error(`platform alert (no PLATFORM_OWNER_EMAILS set): ${subject}`);
  };
  for (const type of ["setup.failed", "setup.rolled_back"]) {
    bus.on(type, async (e) => {
      const status = (e.payload as { status?: string }).status;
      if (status !== "rollback_failed") return;
      const client = identity.workspaceById(e.workspaceId)?.name ?? e.workspaceId;
      await alertOwners(`Setup needs you: ${client}`, `${client}'s setup stopped and could not undo every step (${type}). The client was told MAIZ has been alerted and does not need to do anything.\n\nWorkspace: ${e.workspaceId}\nThe audit log has each step's result.`);
    });
  }
  /** Bot tokens by Slack team. Held in memory for now; encrypted storage comes with Postgres wiring. */
  const slackTokens = new Map<string, string>();
  router.register(new SlackChannel((team) => slackTokens.get(team) ?? "", cfg.http));
  /** Remember a Slack bot token (and store it encrypted when storage is on). */
  let sink: (Sink & { flush(): Promise<void> }) | undefined;
  const saveSlackToken = (workspaceId: string, team: string, token: string) => {
    slackTokens.set(team, token);
    sink?.slackToken(workspaceId, team, token);
  };

  /**
   * Turn on durable storage: load everything saved, put it back into the services,
   * then start writing every new change behind them. Call once, before serving.
   */
  async function attachStore(store: Sink & { flush(): Promise<void>; load(): Promise<import("../core/persistence.js").Snapshot> }): Promise<void> {
    const s = await store.load();
    for (const w of s.workspaces) identity.restoreWorkspace(w);
    for (const m of s.memberships) identity.restoreMember(m.workspaceId, m.userId, m.role);
    for (const e of s.employees) workforce.restoreEmployee(e);
    for (const x of s.profiles) workforce.restoreProfile(x.workspaceId, x.profile);
    for (const t of s.training) workforce.restoreTraining(t.employeeId, t.notes);
    for (const r of s.adminOrgs) admin.restoreOrg(r);
    for (const m of s.adminMessages) admin.restoreMessage(m);
    for (const x of s.accounts) ledger.restoreAccount(x.workspaceId, x.account);
    for (const e of s.entries) ledger.restoreEntry(e);
    for (const u of s.usage) energy.restoreUsage(u);
    for (const x of s.plans) energy.restorePlan(x.workspaceId, x.plan);
    for (const a of s.audit) audit.restore(a);
    for (const c of s.connections) router.restoreConnection(c);
    for (const l of s.links) router.restoreLink(l.key, l.userId);
    for (const t of s.slackTokens) slackTokens.set(t.team, t.token);
    for (const c of s.integrations ?? []) integrations.restoreConnection(c);
    for (const x of s.integrationSecrets ?? []) integrations.restoreSecret(x.connectionId, x.secret);
    for (const r of s.integrationRecords ?? []) integrations.restoreRecord(r);
    for (const r of s.reviews ?? []) reviews.restore(r);
    for (const c of s.priceChanges ?? []) prices.restore(c);
    for (const r of s.specialistRequests ?? []) specialists.restore(r);
    for (const x of s.records ?? []) {
      if (x.kind === "conversation") conversations.restore(x.data);
      else if (x.kind === "notices") notices.restore(x.data);
      else if (x.kind === "order") payments.restore(x.data);
      else if (x.kind === "recon") reconciliation.restore(x.data);
      else if (x.kind === "task") workforce.restoreTask(x.data);
      else if (x.kind === "rota_staff") rota.restoreStaff(x.data);
      else if (x.kind === "rota_shift" && !x.data.removed) rota.restoreShift(x.data);
    }
    for (const r of specialists.approved()) workforce.registerCustomTemplate(r.workspaceId, customTemplateOf(r));
    if (s.aiSettings) aiSettings.restore(s.aiSettings);
    for (const d of s.aiDays ?? []) spend.restore(d);
    for (const x of s.batchSchedules ?? []) batch.restoreSchedule(x.workspaceId, x.schedule);
    for (const j of s.batchJobs ?? []) batch.restoreJob(j);
    for (const m of s.staff ?? []) people.restore(m);
    for (const x of s.peopleSettings ?? []) people.restoreSettings(x.workspaceId, x.settings);
    for (const r of s.batchRuns ?? []) batch.restoreRun(r);
    for (const c of s.credentials ?? []) credentials.restore(c.userId, c);
    for (const c of s.connectionSecrets ?? []) connections.restore(c.key, c.secret);
    rebuildChannels();
    for (const x of s.promoRecords ?? []) {
      if (x.kind === "coupon") coupons.restoreCoupon(x.data);
      else if (x.kind === "redemption") coupons.restoreRedemption(x.data);
      else if (x.kind === "channel") { live.waState = x.data; live.wa?.restore(x.data); }
      else if (["campaign", "draft", "lead", "optout", "fact"].includes(x.kind)) promoter.restore(x.kind, x.data);
      else if (["opportunity", "post", "publication", "account", "approval"].includes(x.kind)) growth.restore(x.kind, x.data);
      else affiliates.restore(x.kind, x.data);
    }
    sink = store;
    for (const part of [audit, identity, energy, workforce, ledger, router, admin, integrations, reviews, prices, specialists, aiSettings, spend, batch, payments, rota, reconciliation, people, conversations, notices, credentials, coupons, affiliates, promoter, growth, connections]) part.useSink(store);
    live.sink = store;
    live.wa?.useSink(store);
  }

  /** True when changes are written to the database (false: memory only, lost on restart). */
  const hasStore = () => !!live.sink;
  const healthy = () => (sink as { healthy?: boolean } | undefined)?.healthy !== false;

  /**
   * One-time links already used, kept only until the link itself expires. In memory: a restart inside the
   * 15-minute life of a link would allow one reuse.
   */
  const usedLinks = new ExpiringSet(() => now().getTime());
  /** Sign-in emails sent per address and hour, to stop the form being used to spam someone. */
  const sends = new SendLog();
  /** Failed password tries per address, and password-reset emails per address. */
  const loginFails = new SendLog(15 * 60_000);
  const resets = new SendLog();
  const credentials = new CredentialStore(() => now().getTime());
  /** Opens and saves per staff form link, so a link cannot be hammered. */
  const formHits = new SendLog();
  /** Wrong coupon codes per person and per address, so codes cannot be guessed. */
  const codeFails = new SendLog(15 * 60_000);
  /** Starts a sleeping RunPod worker for a client who just opened the app or started typing. */
  const warm = () => routing?.warm() ?? "skipped";
  /**
   * The config as the routes read it: Slack and the Google/Microsoft sign-in apps include what the owner typed on
   * the Connections page, looked up on each request. Server settings win.
   */
  const liveCfg: PlatformConfig = Object.defineProperties({ ...cfg }, {
    slack: { enumerable: true, get: () => cfg.slack ?? connections.slackApp() },
    loginApps: { enumerable: true, get: (): LoginApps => ({ ...connections.loginApps(), ...cfg.loginApps }) },
  });
  return { conversations, notices, warm, ownerDecisions, decisionDigest, dashboard, reconciliation, rota, people, payments, batch, email, usedLinks, sends, loginFails, resets, credentials, formHits, codeFails, coupons, affiliates, promoter, growth, connections, get ownerWhatsApp() { return live.wa; }, admin, reviews, prices, specialists, ai, clients, isPlatformOwner, healthy, hasStore, cfg: liveCfg, now, audit, bus, identity, energy, workforce, ledger, onboarding, router, integrations, slackTokens, saveSlackToken, attachStore };
}
export type Platform = ReturnType<typeof createPlatform>;
