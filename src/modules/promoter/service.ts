import { newId } from "../../core/ids.js";
import type { Sink } from "../../core/persistence.js";
import type { Mail } from "../../server/email-templates.js";
import { PermissionError } from "../identity/index.js";
import { MetaRejected, publishProblems, type MetaTarget, type PostStats, type Published, type PublishInput } from "../meta/index.js";
import type { Completer } from "../model-gateway/types.js";
import { SITES, SITE_KEYS, knowledgeText, isSiteKey, type SiteKey, type SiteProfile } from "./knowledge.js";
import {
  CHANNELS, MAX_FOLLOW_UPS, MIN_FOLLOW_UP_GAP_DAYS, PromoterError, checkLead, checkPlanInput, copyFlags, emailFooter, planCampaign, sendProblems, trackedLink,
  type CampaignPlan, type Channel, type LeadBasis, type LeadKind, type PlanInput, type Sender,
} from "./rules.js";

export interface Campaign {
  id: string;
  site: SiteKey;
  name: string;
  goal: string;
  budgetGbp: number;
  startDate: string;
  weeks: number;
  plan: CampaignPlan;
  /** plan_ready: waiting for the owner. approved: the owner agreed the plan and budget. paused / done: no new drafts. */
  status: "plan_ready" | "approved" | "paused" | "done";
  spend: { at: string; amountGbp: number; note: string }[];
  results: { at: string; metric: string; value: number; note?: string }[];
  createdAt: string;
  approvedAt?: string;
}

export type ItemStatus = "awaiting_approval" | "approved" | "rejected" | "sending" | "publishing" | "sent" | "posted" | "failed";
export type ItemKind = "email" | "post" | "article" | "ad" | "partner_pitch" | "affiliate_invite" | "seo_fix";

export interface DraftItem {
  id: string;
  site: SiteKey;
  campaignId?: string;
  channel: Channel;
  kind: ItemKind;
  title: string;
  subject?: string;
  body: string;
  /** Email only: who it is to and which step of the sequence it is (0 first email, 1 and 2 follow-ups). */
  leadId?: string;
  step: number;
  /** Warnings about claims the owner should look at before approving. */
  flags: string[];
  status: ItemStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
  sentAt?: string;
  postedUrl?: string;
  /** Posted through Meta: where, the post id there, when it goes live (scheduled posts) and the latest engagement. */
  target?: MetaTarget;
  externalId?: string;
  scheduledFor?: string;
  stats?: PostStats;
  error?: string;
  /** How it was written: the model that drafted it, or "template" when no model was available. */
  writtenBy: string;
}

export interface Lead {
  id: string;
  email: string;
  name?: string;
  company?: string;
  kind: LeadKind;
  basis: LeadBasis;
  source: string;
  relevance?: string;
  site: SiteKey;
  /** The secret in this person's unsubscribe link. */
  token: string;
  status: "active" | "opted_out" | "replied";
  addedAt: string;
  addedBy: string;
}

export interface PromoterOptions {
  now?: () => Date;
  completer?: Completer;
  /** Sends one email through the platform's email sender. */
  send?: (mail: Mail) => Promise<void>;
  unsubscribeUrl: (token: string) => string;
  sender: Sender;
  /** Facebook and Instagram, when connected. Only ever called for a draft the owner approved. */
  meta?: { status(): { facebook: boolean; instagram: boolean }; publish(i: PublishInput): Promise<Published>; stats(t: MetaTarget, id: string, now: Date): Promise<PostStats> };
  /** Called whenever something new waits for the owner. */
  notifyOwner?: () => void;
}

const MAX_TEXT = 6000;
const MAX_ITEMS = 2000;
const MAX_LEADS = 5000;
const KIND_FOR_CHANNEL: Record<Channel, ItemKind> = { email: "email", social: "post", content: "article", seo: "seo_fix", partnership: "partner_pitch", affiliate: "affiliate_invite", community: "post", paid_ads: "ad" };

export class PromoterService {
  private campaigns = new Map<string, Campaign>();
  private items = new Map<string, DraftItem>();
  private leads = new Map<string, Lead>();
  private optedOut = new Set<string>();
  private facts = new Map<SiteKey, string[]>();
  private sink?: Sink;

  constructor(private readonly isOwner: (userId: string) => boolean, private readonly opts: PromoterOptions) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(kind: string, data: any): void {
    if (kind === "campaign") this.campaigns.set(data.id, data);
    else if (kind === "draft") this.items.set(data.id, data);
    else if (kind === "lead") this.leads.set(data.id, data);
    else if (kind === "optout") this.optedOut.add(String(data.email));
    else if (kind === "fact" && isSiteKey(data.site)) this.facts.set(data.site, data.facts);
  }

  private now(): Date { return this.opts.now?.() ?? new Date(); }
  private require(userId: string): void {
    if (!this.isOwner(userId)) throw new PermissionError("only the platform owner can use the promotion agent");
  }
  private saveCampaign(c: Campaign): Campaign { this.campaigns.set(c.id, c); this.sink?.promo("campaign", c.id, c); return c; }
  private saveItem(i: DraftItem): DraftItem { this.items.set(i.id, i); this.sink?.promo("draft", i.id, i); return i; }
  private saveLead(l: Lead): Lead { this.leads.set(l.id, l); this.sink?.promo("lead", l.id, l); return l; }
  private item(id: string): DraftItem {
    const i = this.items.get(id);
    if (!i) throw new PromoterError("draft not found");
    return i;
  }
  private campaign(id: string): Campaign {
    const c = this.campaigns.get(id);
    if (!c) throw new PromoterError("campaign not found");
    return c;
  }

  // ---------------------------------------------------------------- knowledge

  knowledge(userId: string): { sites: (SiteProfile & { ownerFacts: string[] })[] } {
    this.require(userId);
    return { sites: SITE_KEYS.map((k) => ({ ...SITES[k], ownerFacts: this.facts.get(k) ?? [] })) };
  }

  /** The owner confirms or adds a fact (a price, a result, a new page). Drafts use it from then on. */
  addFact(userId: string, site: unknown, text: unknown): string[] {
    this.require(userId);
    if (!isSiteKey(site)) throw new PromoterError("choose one of the three websites");
    const t = String(text ?? "").trim();
    if (t.length < 5 || t.length > 400) throw new PromoterError("a fact is 5 to 400 characters");
    const next = [...(this.facts.get(site) ?? []), t].slice(-40);
    this.facts.set(site, next);
    this.sink?.promo("fact", site, { site, facts: next });
    return next;
  }

  // ---------------------------------------------------------------- campaigns

  createCampaign(userId: string, raw: unknown): Campaign {
    this.require(userId);
    const input: PlanInput = checkPlanInput(raw);
    const name = String((raw as any)?.name ?? "").trim().slice(0, 80) || `${SITES[input.site].name}: ${input.goal.slice(0, 40)}`;
    const c: Campaign = { id: newId("campaign"), site: input.site, name, goal: input.goal, budgetGbp: input.budgetGbp, startDate: input.startDate, weeks: input.weeks, plan: planCampaign(input), status: "plan_ready", spend: [], results: [], createdAt: this.now().toISOString() };
    this.saveCampaign(c);
    this.opts.notifyOwner?.();
    return c;
  }

  setCampaignStatus(userId: string, id: string, status: unknown): Campaign {
    this.require(userId);
    const c = this.campaign(id);
    if (status !== "approved" && status !== "paused" && status !== "done") throw new PromoterError("status must be approved, paused or done");
    if (status === "approved" && c.status === "done") throw new PromoterError("a finished campaign cannot be restarted. Make a new one.");
    return this.saveCampaign({ ...c, status, approvedAt: status === "approved" ? this.now().toISOString() : c.approvedAt });
  }

  /** The owner records money they spent. It cannot pass the approved budget, and an unapproved plan has none. */
  recordSpend(userId: string, id: string, amount: unknown, note: unknown): Campaign {
    this.require(userId);
    const c = this.campaign(id);
    const amountGbp = Number(amount);
    if (!Number.isFinite(amountGbp) || amountGbp <= 0 || amountGbp > 1_000_000) throw new PromoterError("enter an amount in pounds above zero");
    if (c.status !== "approved") throw new PromoterError("approve the campaign and its budget before recording spend");
    const spent = c.spend.reduce((s, x) => s + x.amountGbp, 0);
    if (Math.round((spent + amountGbp) * 100) / 100 > c.budgetGbp) throw new PromoterError(`this would pass the approved budget of £${c.budgetGbp} (£${Math.round(spent * 100) / 100} already spent)`);
    return this.saveCampaign({ ...c, spend: [...c.spend, { at: this.now().toISOString(), amountGbp, note: String(note ?? "").trim().slice(0, 200) }] });
  }

  recordResult(userId: string, id: string, metric: unknown, value: unknown, note?: unknown): Campaign {
    this.require(userId);
    const c = this.campaign(id);
    const m = String(metric ?? "").trim().slice(0, 60);
    const v = Number(value);
    if (!m) throw new PromoterError("name the metric, for example visits or sign-ups");
    if (!Number.isFinite(v) || v < 0) throw new PromoterError("the value must be a number, zero or more");
    return this.saveCampaign({ ...c, results: [...c.results, { at: this.now().toISOString(), metric: m, value: v, note: note === undefined ? undefined : String(note).trim().slice(0, 200) }] });
  }

  /** Totals per metric, spend, and cost per result for the owner's report. */
  report(userId: string, id: string): { spentGbp: number; budgetGbp: number; metrics: { metric: string; total: number; costPerGbp?: number }[]; draftsByStatus: Record<string, number> } {
    this.require(userId);
    const c = this.campaign(id);
    const spentGbp = Math.round(c.spend.reduce((s, x) => s + x.amountGbp, 0) * 100) / 100;
    const totals = new Map<string, number>();
    for (const r of c.results) totals.set(r.metric, (totals.get(r.metric) ?? 0) + r.value);
    const draftsByStatus: Record<string, number> = {};
    for (const i of this.items.values()) if (i.campaignId === id) draftsByStatus[i.status] = (draftsByStatus[i.status] ?? 0) + 1;
    return { spentGbp, budgetGbp: c.budgetGbp, metrics: [...totals].map(([metric, total]) => ({ metric, total, costPerGbp: total > 0 && spentGbp > 0 ? Math.round((spentGbp / total) * 100) / 100 : undefined })), draftsByStatus };
  }

  // ---------------------------------------------------------------- leads

  addLead(userId: string, site: unknown, raw: unknown): Lead {
    this.require(userId);
    if (!isSiteKey(site)) throw new PromoterError("choose which website this contact is for");
    const input = checkLead(raw);
    if (this.optedOut.has(input.email)) throw new PromoterError("this person has opted out and cannot be added again");
    if ([...this.leads.values()].some((l) => l.email === input.email && l.site === site)) throw new PromoterError("this person is already on the list for that website");
    if (this.leads.size >= MAX_LEADS) throw new PromoterError("the lead list is full");
    return this.saveLead({ id: newId("lead"), ...input, site, token: newId("unsub"), status: "active", addedAt: this.now().toISOString(), addedBy: userId });
  }

  markReplied(userId: string, id: string): Lead {
    this.require(userId);
    const l = this.leads.get(id);
    if (!l) throw new PromoterError("lead not found");
    return this.saveLead({ ...l, status: l.status === "opted_out" ? l.status : "replied" });
  }

  /** Public: the link in every email. The secret token is the only thing needed, so it can be opened from a mail app. */
  unsubscribe(token: string): boolean {
    const l = [...this.leads.values()].find((x) => x.token === token);
    if (!l) return false;
    this.optedOut.add(l.email);
    this.sink?.promo("optout", l.email, { email: l.email, at: this.now().toISOString() });
    for (const x of this.leads.values()) if (x.email === l.email && x.status !== "opted_out") this.saveLead({ ...x, status: "opted_out" });
    return true;
  }

  leadsList(userId: string): (Omit<Lead, "token"> & { basisLabel?: never; sent: number })[] {
    this.require(userId);
    return [...this.leads.values()].map(({ token: _t, ...l }) => ({ ...l, sent: [...this.items.values()].filter((i) => i.leadId === l.id && i.status === "sent").length }));
  }

  // ---------------------------------------------------------------- drafts

  /** Follow-ups that are due: first email sent at least the minimum gap ago, no reply, no opt-out, under the limit. */
  followUpsDue(userId: string): { lead: string; email: string; site: SiteKey; nextStep: number }[] {
    this.require(userId);
    const now = this.now().getTime();
    const out: { lead: string; email: string; site: SiteKey; nextStep: number }[] = [];
    for (const l of this.leads.values()) {
      if (l.status !== "active" || this.optedOut.has(l.email)) continue;
      const sent = [...this.items.values()].filter((i) => i.leadId === l.id && i.status === "sent").sort((a, b) => a.step - b.step);
      const last = sent[sent.length - 1];
      if (!last || last.step >= MAX_FOLLOW_UPS) continue;
      const pending = [...this.items.values()].some((i) => i.leadId === l.id && (i.status === "awaiting_approval" || i.status === "approved"));
      if (pending || now - Date.parse(last.sentAt!) < MIN_FOLLOW_UP_GAP_DAYS * 86_400_000) continue;
      out.push({ lead: l.id, email: l.email, site: l.site, nextStep: last.step + 1 });
    }
    return out;
  }

  /** Asks the model (RunPod first, Claude checking) for a draft. With no model it writes from a template. Always lands as awaiting the owner. */
  async draft(userId: string, raw: unknown): Promise<DraftItem> {
    this.require(userId);
    const r = (raw ?? {}) as Record<string, unknown>;
    if (!isSiteKey(r.site)) throw new PromoterError("choose one of the three websites");
    const site = r.site;
    if (typeof r.channel !== "string" || !(CHANNELS as readonly string[]).includes(r.channel)) throw new PromoterError("choose a channel");
    const channel = r.channel as Channel;
    const brief = String(r.brief ?? "").trim().slice(0, 600);
    const campaign = r.campaignId ? this.campaign(String(r.campaignId)) : undefined;
    if (campaign && campaign.site !== site) throw new PromoterError("that campaign is for a different website");
    if (campaign && (campaign.status === "paused" || campaign.status === "done")) throw new PromoterError("that campaign is not running");
    if (channel === "paid_ads" && campaign?.status !== "approved") throw new PromoterError("ad drafts need an approved campaign and budget");
    if (this.items.size >= MAX_ITEMS) throw new PromoterError("too many drafts are stored. Reject or clear some first.");
    const step = Number(r.step ?? 0);
    if (!Number.isInteger(step) || step < 0 || step > MAX_FOLLOW_UPS) throw new PromoterError(`step must be 0 to ${MAX_FOLLOW_UPS}`);
    let lead: Lead | undefined;
    if (channel === "email") {
      lead = this.leads.get(String(r.leadId ?? ""));
      if (!lead) throw new PromoterError("an email draft is written to one person from the lead list: choose a lead");
      if (lead.site !== site) throw new PromoterError("that lead is for a different website");
      if (lead.status !== "active" || this.optedOut.has(lead.email)) throw new PromoterError("this person has opted out or replied");
    }
    const profile = SITES[site];
    const link = trackedLink(site, campaign?.name ?? `${site}-promo`, channel, lead ? `step-${step}` : undefined);
    const { text, by } = await this.write(profile, channel, brief, lead, step);
    let subject: string | undefined;
    let body = text.replace(/\{\{\s*LINK\s*\}\}/g, link).trim().slice(0, MAX_TEXT);
    if (channel === "email") {
      const m = /^\s*subject:\s*(.+)\n+/i.exec(body);
      subject = oneLine(m?.[1] ?? `${profile.name}: ${profile.oneLine}`);
      if (m) body = body.slice(m[0].length).trim();
    }
    if (!body) throw new PromoterError("the draft came back empty. Try again.");
    const item: DraftItem = {
      id: newId("draft"), site, campaignId: campaign?.id, channel, kind: KIND_FOR_CHANNEL[channel],
      title: brief.slice(0, 80) || `${profile.name} ${channel} draft`, subject, body, leadId: lead?.id, step,
      flags: copyFlags(site, `${subject ?? ""}\n${body}`), status: "awaiting_approval", createdAt: this.now().toISOString(), writtenBy: by,
    };
    this.saveItem(item);
    this.opts.notifyOwner?.();
    return item;
  }

  private async write(site: SiteProfile, channel: Channel, brief: string, lead: Lead | undefined, step: number): Promise<{ text: string; by: string }> {
    const fallback = (): { text: string; by: string } => ({ text: template(site, channel, brief, lead, step), by: "template" });
    if (!this.opts.completer) return fallback();
    const system = [
      "You write promotion drafts for one of three websites owned by the same founder. The owner reads and approves every draft before anything is sent or posted.",
      "Use British English, plain words and short sentences. Use only the facts below. Never invent numbers, reviews, results, partnerships or prices. Facts marked NOT CONFIRMED must not appear.",
      "Write for a person, not a crowd: no pressure, no tricks, no fake urgency. Include the placeholder {{LINK}} exactly once where the reader should click.",
      channel === "email" ? "This is a one-to-one email. The first line must be 'Subject: ...' and must not start with Re: or Fwd:. Do not write an unsubscribe line or a signature block: they are added automatically." : "",
      "Reply with the draft only.",
      "",
      knowledgeText(site, this.facts.get(site.key) ?? []),
    ].filter(Boolean).join("\n");
    const who = lead ? `Written to ${lead.name ?? "one person"}${lead.company ? ` at ${lead.company}` : ""}. Why they are getting it: ${lead.relevance ?? lead.source}.${step > 0 ? ` This is follow-up ${step} of ${MAX_FOLLOW_UPS}: short, adds something useful, makes clear no reply is fine.` : ""}` : "";
    const user = `Channel: ${channel}.\n${who}\nBrief: ${brief || "Choose the strongest angle for this site and audience."}`;
    try {
      const res = await this.opts.completer.complete({ messages: [{ role: "system", content: system }, { role: "user", content: user }], maxTokens: 900, tier: "standard", taskType: "promoter" });
      if (!res.text.trim()) return fallback();
      return { text: res.text, by: res.model };
    } catch (e) {
      console.error("promotion draft failed, using the template:", e instanceof Error ? e.message : e);
      return fallback();
    }
  }

  /** The owner edits the words before approving. Editing sends it back to awaiting approval. */
  edit(userId: string, id: string, raw: unknown): DraftItem {
    this.require(userId);
    const i = this.item(id);
    if (i.status === "sent" || i.status === "posted" || i.status === "sending" || i.status === "publishing") throw new PromoterError("this has already gone out or is going out now");
    const r = (raw ?? {}) as Record<string, unknown>;
    const body = r.body === undefined ? i.body : String(r.body).trim().slice(0, MAX_TEXT);
    const subject = r.subject === undefined ? i.subject : oneLine(String(r.subject));
    if (!body) throw new PromoterError("the body cannot be empty");
    return this.saveItem({ ...i, body, subject, flags: copyFlags(i.site, `${subject ?? ""}\n${body}`), status: "awaiting_approval", decidedAt: undefined, decidedBy: undefined });
  }

  /** The sign-off gate: nothing leaves until the owner says yes here. */
  decide(userId: string, id: string, approve: boolean, note?: unknown): DraftItem {
    this.require(userId);
    const i = this.item(id);
    if (i.status !== "awaiting_approval" && !(i.status === "approved" && !approve)) throw new PromoterError(`this draft is already ${i.status}`);
    return this.saveItem({ ...i, status: approve ? "approved" : "rejected", decidedAt: this.now().toISOString(), decidedBy: userId, note: note === undefined ? undefined : String(note).trim().slice(0, 300) });
  }

  /** Sends one approved email. Every anti-spam rule is checked again now, not only when it was written. */
  async send(userId: string, id: string): Promise<DraftItem> {
    this.require(userId);
    const i = this.item(id);
    if (i.status !== "approved") throw new PromoterError("only drafts you approved can be sent");
    if (i.channel !== "email" || !i.leadId) throw new PromoterError("only emails are sent from here. Publish posts and articles yourself, then mark them as posted.");
    const lead = this.leads.get(i.leadId);
    if (!lead) throw new PromoterError("the person this email was for is no longer on the list");
    if (!this.opts.send) throw new PromoterError("email sending is not set up");
    const now = this.now();
    const today = now.toISOString().slice(0, 10);
    // "sending" counts as sent for every limit, so two clicks at once cannot both go out.
    const out = [...this.items.values()].filter((x) => (x.status === "sent" || x.status === "sending") && x.id !== i.id);
    const sentToday = out.filter((x) => (x.sentAt ?? x.decidedAt ?? "").startsWith(today));
    const mine = out.filter((x) => x.leadId === lead.id);
    const last = mine.sort((a, b) => b.step - a.step)[0];
    const problems = sendProblems({
      basis: lead.basis, kind: lead.kind, optedOut: this.optedOut.has(lead.email) || lead.status === "opted_out", replied: lead.status === "replied", step: i.step,
      body: i.body, subject: i.subject ?? "", hasUnsubscribe: true, hasSender: !!this.opts.sender.name && !!this.opts.sender.address,
      previousSentAt: mine.filter((x) => x.step < i.step).sort((a, b) => Date.parse(b.sentAt ?? "0") - Date.parse(a.sentAt ?? "0"))[0]?.sentAt, now, sentToday: sentToday.length,
      coldSentToday: sentToday.filter((x) => this.leads.get(x.leadId ?? "")?.basis === "b2b_legitimate_interest").length,
    });
    if (last && last.step >= i.step) problems.push(`this person already got step ${last.step + 1} of the sequence`);
    if (i.step > 0 && last && last.step !== i.step - 1) problems.push("follow-ups must go in order");
    if (problems.length) throw new PromoterError(`not sent: ${problems.join("; ")}.`);
    const text = i.body + emailFooter(this.opts.sender, this.opts.unsubscribeUrl(lead.token), why(lead));
    // Marked before the first await: a second press while this one is in flight finds it no longer approved.
    this.saveItem({ ...i, status: "sending", sentAt: now.toISOString() });
    try {
      await this.opts.send({ to: lead.email, subject: i.subject!, text });
    } catch (e) {
      this.saveItem({ ...i, status: "failed", sentAt: undefined, error: "the email provider refused it" });
      console.error("promotion email failed:", e instanceof Error ? e.message : e);
      throw new PromoterError("the email could not be sent. Nothing was delivered.");
    }
    return this.saveItem({ ...i, status: "sent", sentAt: now.toISOString() });
  }

  /** What is connected, for the owner's page. */
  channels(userId: string): { facebook: boolean; instagram: boolean } {
    this.require(userId);
    return this.opts.meta?.status() ?? { facebook: false, instagram: false };
  }

  /**
   * Publishes one approved social post to Facebook or Instagram. The same gate as email: only a draft the owner
   * approved, once, and the owner's words are re-read now. It never spends money (organic posts only).
   */
  async publishToMeta(userId: string, id: string, raw: unknown): Promise<DraftItem> {
    this.require(userId);
    const i = this.item(id);
    if (i.status !== "approved") throw new PromoterError("only drafts you approved can be published");
    if (i.channel !== "social" && i.channel !== "community") throw new PromoterError("only social posts are published to Facebook or Instagram");
    const meta = this.opts.meta;
    if (!meta) throw new PromoterError("Facebook and Instagram are not connected yet. Connect them on the Connections page");
    const r = (raw ?? {}) as Record<string, unknown>;
    if (r.target !== "facebook" && r.target !== "instagram") throw new PromoterError("choose Facebook or Instagram");
    const target = r.target;
    if (!meta.status()[target]) throw new PromoterError(`${target === "facebook" ? "Facebook" : "Instagram"} is not connected yet. Connect it on the Connections page`);
    const optional = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v).trim());
    const when = optional(r.scheduleAt);
    const now = this.now();
    const input: PublishInput = { target, message: i.body, imageUrl: optional(r.imageUrl), linkUrl: optional(r.linkUrl), scheduleAt: when ? new Date(when) : undefined };
    const problems = publishProblems(input, now);
    if (problems.length) throw new PromoterError(`not published: ${problems.join("; ")}.`);
    // Marked before the first await, so a second press while this one is in flight finds it no longer approved.
    this.saveItem({ ...i, status: "publishing", target });
    try {
      const out = await meta.publish(input);
      return this.saveItem({ ...i, status: "posted", target, externalId: out.id, postedUrl: out.url, scheduledFor: out.scheduledFor, sentAt: now.toISOString(), error: undefined });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Meta could not be reached";
      if (e instanceof MetaRejected) {
        // A clear refusal: nothing is live, so it goes back to approved and can be retried after fixing the cause.
        this.saveItem({ ...i, status: "approved", target: undefined, error: msg });
        throw new PromoterError(msg);
      }
      console.error("meta publish uncertain:", msg);
      this.saveItem({ ...i, status: "failed", target, error: msg });
      throw new PromoterError(msg);
    }
  }

  /** Reads likes, comments and shares for a post published through Meta. */
  async refreshStats(userId: string, id: string): Promise<DraftItem> {
    this.require(userId);
    const i = this.item(id);
    if (!i.target || !i.externalId || i.scheduledFor && Date.parse(i.scheduledFor) > this.now().getTime()) throw new PromoterError("this post is not live on Facebook or Instagram yet");
    if (!this.opts.meta) throw new PromoterError("Facebook and Instagram are not connected yet");
    try {
      return this.saveItem({ ...i, stats: await this.opts.meta.stats(i.target, i.externalId, this.now()) });
    } catch (e) {
      throw new PromoterError(e instanceof Error ? e.message : "Meta could not be reached");
    }
  }

  /** The short code used in WhatsApp: the first five characters of the draft's id. */
  static shortCode(id: string): string { return id.replace(/-/g, "").slice(0, 5); }

  /** Finds one draft by its short code among the given statuses. Undefined when none or more than one match. */
  findByCode(userId: string, code: string, statuses: ItemStatus[]): DraftItem | undefined {
    this.require(userId);
    const c = code.toLowerCase();
    const hits = [...this.items.values()].filter((x) => statuses.includes(x.status) && PromoterService.shortCode(x.id) === c);
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** The owner published a post, article or ad by hand. */
  markPosted(userId: string, id: string, url?: unknown): DraftItem {
    this.require(userId);
    const i = this.item(id);
    if (i.status !== "approved") throw new PromoterError("approve the draft before marking it as posted");
    if (i.channel === "email") throw new PromoterError("emails are sent from here, not posted");
    const u = url === undefined || url === "" ? undefined : String(url).trim();
    if (u && !/^https:\/\/[^\s]{3,300}$/.test(u)) throw new PromoterError("the link must start with https://");
    return this.saveItem({ ...i, status: "posted", postedUrl: u, sentAt: this.now().toISOString() });
  }

  items_(userId: string): (DraftItem & { leadEmail?: string })[] {
    this.require(userId);
    return [...this.items.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((i) => ({ ...i, leadEmail: i.leadId ? this.leads.get(i.leadId)?.email : undefined }));
  }

  campaignsList(userId: string): Campaign[] {
    this.require(userId);
    return [...this.campaigns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Drafts and plans waiting for the owner, for the decisions page. */
  waiting(userId: string): { drafts: DraftItem[]; plans: Campaign[] } {
    this.require(userId);
    return { drafts: [...this.items.values()].filter((i) => i.status === "awaiting_approval"), plans: [...this.campaigns.values()].filter((c) => c.status === "plan_ready") };
  }

  /** The email preview with its footer, exactly as it will be sent. */
  preview(userId: string, id: string): string {
    this.require(userId);
    const i = this.item(id);
    const lead = i.leadId ? this.leads.get(i.leadId) : undefined;
    return i.channel === "email" && lead ? `To: ${lead.email}\nSubject: ${i.subject ?? ""}\n\n${i.body}${emailFooter(this.opts.sender, this.opts.unsubscribeUrl("PREVIEW"), why(lead))}` : i.body;
  }
}

/** One line of plain text: line breaks and control characters removed, so a subject can never add a mail header. */
const oneLine = (v: string): string => v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 140);

const why = (l: Lead): string => (l.basis === "consent" ? "you asked to hear from us" : l.basis === "existing_contact" ? "you contacted us" : l.basis === "soft_opt_in" ? "you are an existing customer" : "your company's work looks relevant to what we offer");

function template(site: SiteProfile, channel: Channel, brief: string, lead: Lead | undefined, step: number): string {
  const aud = site.audiences[0]!;
  const hello = lead?.name ? `Hello ${lead.name},` : "Hello,";
  if (channel === "email") {
    const subject = step === 0 ? `${site.name}: a quick idea` : `Following up: ${site.name}`;
    return `Subject: ${subject}\n\n${hello}\n\n${aud.message} ${brief}\n\nHave a look: {{LINK}}\n\nNo reply needed if this is not for you.`.replace(/ \n/g, "\n");
  }
  if (channel === "partnership" || channel === "affiliate") return `${hello}\n\nI run ${site.name}. ${site.oneLine} ${brief}\n\nIf it could help the people you work with, here is where to see it: {{LINK}}`;
  if (channel === "seo") return `SEO task for ${site.name}: ${brief || "review the title, description and headings of the main pages"}.\nCurrent gaps: ${site.seo.gaps.join(" ")}`;
  return `${aud.message}\n\n${brief}\n\n{{LINK}}`.trim();
}
