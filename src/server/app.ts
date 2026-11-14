import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { userIdFor } from "./identity.js";
import { SetupError } from "../modules/admin-manager/index.js";
import { ChannelError, noEnergyMessage, parseSlackEvent } from "../modules/channels/index.js";
import { PermissionError } from "../modules/identity/index.js";
import { LedgerError } from "../modules/ledger/index.js";
import { IntegrationError } from "../modules/integrations/index.js";
import { ReviewError } from "../modules/review/index.js";
import { PricingError } from "../modules/pricing/index.js";
import { OWNER_SPECIALISTS, PromoterError } from "../modules/promoter/index.js";
import { GROWTH_ROLE, GrowthError, discoveryQueries } from "../modules/growth/index.js";
import { DEFAULT_COMMISSION, DEFAULT_HOLD_DAYS, PromoError, describeCommission } from "../modules/promotions/index.js";
import { EnergyError, parseAutoReload } from "../modules/energy/index.js";
import { BatchError } from "../modules/batch/schedule.js";
import { SettingsError } from "../modules/model-gateway/routing/settings.js";
import { affiliatePaidEmail, affiliateWelcomeEmail, brandFrom, couponGiftEmail, signInLinkEmail } from "./email-templates.js";
import { SignupError, type SignupChoices } from "../modules/onboarding/index.js";
import { planSignup, readSignupAnswers } from "../modules/onboarding/recommend.js";
import { OTHER_SECTOR, getSector } from "../modules/onboarding/sectors.js";
import { getTemplate, TEMPLATES } from "../modules/workforce/templates.js";
import { getJobDescription } from "../modules/workforce/job-descriptions.js";
import { CUSTOM_SPECIALIST, DEPARTMENTS } from "../modules/workforce/blueprints.js";
import { OVERAGE_RULE } from "../modules/workforce/task-roles.js";
import { CONSULTANTS, HOW_A_PASS_WORKS, menuOf } from "../modules/workforce/consultants.js";
import { quote } from "../modules/store/cart.js";
import { RotaError } from "../modules/rota/index.js";
import { PeopleError } from "../modules/people/index.js";
import { PaymentError, WebhookSignatureError, type Order } from "../modules/payments/index.js";
import type { Platform } from "./platform.js";
import { ConnectionsError } from "../modules/connections/index.js";
import { suggestionsFor } from "./suggestions.js";
import type { Reply } from "../modules/conversations/index.js";
import type { TaskResult } from "../modules/workforce/index.js";
import { passwordRoutes } from "./password-auth.js";
import { LOGIN_PROVIDERS, attemptSecrets, authorizeUrl, completeLogin, isLoginProvider, loginRedirectUri } from "./social-login.js";

const OAUTH_STATE_SECONDS = 600;
const SESSION_SECONDS = 7 * 86_400;
const RENEW_AFTER_SECONDS = 86_400;
const MAX_SESSION_SECONDS = 30 * 86_400;
const ASK_FAILED_MESSAGE = "Your team could not finish this just now because the AI service is busy. Nothing was charged. Try again in a few minutes.";
const OAUTH_COOKIE = "maiz_oauth";
/** Over https the cookie uses the __Host- prefix (Secure, whole site, no Domain), so a sibling subdomain cannot plant one. */
const loginCookieName = (appUrl?: string): string => (appUrl?.startsWith("https://") ? "__Host-maiz_login" : "maiz_login");
const loginCookie = (value: string, maxAge: number, appUrl?: string): string =>
  `${loginCookieName(appUrl)}=${value}; Path=${appUrl?.startsWith("https://") ? "/" : "/api/signin/oauth"}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appUrl?.startsWith("https://") ? "; Secure" : ""}`;
/** A social sign-in link is redeemed by the next page load, so it lives for two minutes rather than fifteen. */
const SOCIAL_LINK_SECONDS = 120;
/** Where the sign-in page sends people when Google or Microsoft did not work out. Only these codes exist, so nothing is reflected. */
const loginFailed = (code: "cancelled" | "failed" | "unverified" | "owner", appUrl?: string): Res => ({
  status: 302,
  headers: { location: `/signin.html?error=${code}`, "set-cookie": loginCookie("", 0, appUrl), "cache-control": "no-store" },
});
const oauthCookie = (nonce: string, maxAge: number, appUrl?: string): string =>
  `${OAUTH_COOKIE}=${nonce}; Path=/api/integrations; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appUrl?.startsWith("https://") ? "; Secure" : ""}`;
function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/** The referral cookie: set by /r/<code>, read at signup. Over https it uses the __Host- prefix like the login cookie. */
const refCookieName = (appUrl?: string): string => (appUrl?.startsWith("https://") ? "__Host-maiz_ref" : "maiz_ref");
const REF_COOKIE_DAYS = 30;
const refCookie = (value: string, maxAge: number, appUrl?: string): string =>
  `${refCookieName(appUrl)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${appUrl?.startsWith("https://") ? "; Secure" : ""}`;
/** Wrong coupon codes allowed per person in 15 minutes. */
const CODE_TRIES = 8;

/** Opens or saves of one staff form link per hour. */
const STAFF_FORM_PER_HOUR = 30;
/** Tries with links that do not exist, across everyone, per hour. */
const UNKNOWN_FORM_LINKS_PER_HOUR = 300;

export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Raw body text (Slack signatures are over the exact bytes). */
  rawBody: string;
}
export interface Res {
  status: number;
  body?: unknown;
  /** A plain-text reply, sent as is (not JSON). */
  text?: string;
  headers?: Record<string, string>;
  /** Work to do after the reply is sent (Slack needs an answer within 3 seconds). */
  after?: () => Promise<void>;
  /** A live reply (server-sent events): the server sends headers, then calls this and ends the reply when it returns. */
  stream?: (send: (event: string, data: unknown) => void) => Promise<void>;
}

/** What a client sees of an order: never the provider's reference. */
const orderView = (o: Order) => ({ id: o.id, status: o.status, lines: o.lines, dueTodayMinor: o.dueTodayMinor, monthlyMinor: o.monthlyMinor, currency: o.currency, createdAt: o.createdAt, paidAt: o.paidAt, employeeIds: o.employeeIds, ...(o.problem && !o.fulfilledAt && o.status === "paid" ? { problem: "We took your payment but could not finish setting up. MAIZ has been alerted." } : {}) });

const json = (status: number, body: unknown): Res => ({ status, body });

// ---- sessions: signed token "payload.signature", 7 days ----
const b64 = (s: string) => Buffer.from(s).toString("base64url");
function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
export function makeToken(secret: string, claims: Record<string, unknown>, ttlSeconds: number, nowMs: number): string {
  const payload = b64(JSON.stringify({ ...claims, exp: Math.floor(nowMs / 1000) + ttlSeconds }));
  return `${payload}.${sign(secret, payload)}`;
}
export function readToken(secret: string, token: string | undefined, nowMs: number): Record<string, any> | undefined {
  if (!token) return undefined;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return undefined;
  const good = Buffer.from(sign(secret, payload));
  const got = Buffer.from(sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return undefined;
  try {
    const c = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof c.exp === "number" && c.exp * 1000 > nowMs ? c : undefined;
  } catch {
    return undefined;
  }
}

export { userIdFor };

export function createApp(p: Platform) {
  const secret = p.cfg.sessionSecret;
  /** Only tokens issued as sessions count. Other signed tokens (sign-in links, Slack install state) never do. */
  const sessionClaims = (req: Req) => {
    const h = req.headers["authorization"];
    const t = h?.startsWith("Bearer ") ? h.slice(7) : undefined;
    const c = readToken(secret, t, p.now().getTime());
    if (c?.k !== "session") return undefined;
    // A password reset or change ends every session started before it.
    const changed = typeof c.e === "string" ? p.credentials.changedAtSeconds(userIdFor(c.e)) : undefined;
    return changed !== undefined && (typeof c.s !== "number" || c.s < changed) ? undefined : c;
  };
  const session = (req: Req): string | undefined => sessionClaims(req)?.u;
  /** `since` is when the person last signed in with an email link (seconds); renewals keep it. */
  const issueSession = (email: string, since = Math.floor(p.now().getTime() / 1000)) => {
    // Never valid past 30 days after the email-link sign-in, however often it is renewed.
    const ttl = Math.min(SESSION_SECONDS, since + MAX_SESSION_SECONDS - Math.floor(p.now().getTime() / 1000));
    return makeToken(secret, { k: "session", u: userIdFor(email), e: email, s: since }, ttl, p.now().getTime());
  };
  /**
   * Sliding sessions: a session used more than a day after it was issued comes back renewed in the
   * x-session-token header, so an active client is not sent back to sign-in every 7 days. Renewal stops
   * 30 days after the last email-link sign-in, so a stolen token cannot be kept alive for ever.
   */
  const renewed = (req: Req, res: Res): Res => {
    const c = sessionClaims(req);
    if (!c || res.status >= 400 || typeof c.e !== "string" || typeof c.exp !== "number") return res;
    const nowS = Math.floor(p.now().getTime() / 1000);
    const since = typeof c.s === "number" ? c.s : c.exp - SESSION_SECONDS;
    // Renew once the token has less than 6 days left, and only while the 30-day limit leaves something to give.
    if (c.exp - nowS > SESSION_SECONDS - RENEW_AFTER_SECONDS || since + MAX_SESSION_SECONDS - nowS <= c.exp - nowS) return res;
    return { ...res, headers: { ...res.headers, "x-session-token": issueSession(c.e, since) } };
  };
  const orgOf = (userId: string) => p.identity.workspacesFor(userId)[0];

  async function route(req: Req): Promise<Res> {
    const { method, path } = req;
    const body = () => {
      try { return req.rawBody ? JSON.parse(req.rawBody) : {}; } catch { throw new BadRequest("invalid JSON"); }
    };

    if (method === "GET" && path === "/api/health") return p.healthy() ? json(200, { ok: true }) : json(503, { ok: false, error: "storage is failing" });
    // Agent store: every employee with its full job description. Public, no sign-in needed.
    if (method === "GET" && path === "/api/store") {
      return json(200, {
        employees: TEMPLATES.map((t) => ({ key: t.key, title: t.title, summary: t.summary, kind: t.kind, tier: t.tier, firstJob: t.firstJob, jobDescription: getJobDescription(t.key) })),
        // Every department and role of a typical business; roles without a ready-made employee are custom specialists.
        departments: DEPARTMENTS.map((d) => ({ key: d.key, name: d.name, mission: d.mission, roles: d.roles.map((r) => ({ key: r.key, title: r.title, purpose: r.purpose, readyMade: Boolean(r.jd), covers: r.covers ?? [] })) })),
        customSpecialist: CUSTOM_SPECIALIST,
        // Consultants: one-off passes with an energy pool, and the task menu each can do.
        consultants: CONSULTANTS.map((c) => ({ key: c.key, title: c.title, purpose: c.purpose, passes: c.passes, menu: menuOf(c.key).map((t) => ({ key: t.key, title: t.title, energy: t.includedEnergy })) })),
        howAPassWorks: HOW_A_PASS_WORKS,
        overageRule: OVERAGE_RULE,
        // What can be added to a cart, and whether it is billed monthly or once.
        catalogue: p.prices.catalogue(),
        // Package prices and trial terms in force today, set by the platform owner.
        prices: p.prices.general(),
      });
    }
    // Prices a cart. Public and pure: nothing is charged or stored (payments are not connected yet).
    if (method === "POST" && path === "/api/cart/quote") {
      const lines = body().lines;
      if (!Array.isArray(lines) || lines.length > 100) throw new BadRequest("lines must be a list of up to 100 items");
      return json(200, quote(lines, p.prices.catalogue()));
    }

    // ---- a member of staff filling in their own details from their form link (no account) ----
    // Public: the unsubscribe link in every promotion email. The secret token in the link is the only thing needed.
    if (method === "POST" && path === "/api/promoter/unsubscribe") {
      const t = String(body().token ?? "").slice(0, 100);
      return p.promoter.unsubscribe(t) ? json(200, { unsubscribed: true }) : json(404, { error: "this link is not valid any more" });
    }
    if (method === "POST" && (path === "/api/staff-form/open" || path === "/api/staff-form/save")) {
      const raw = body();
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequest("send the form as an object");
      const b = raw as Record<string, unknown>;
      const token = typeof b.token === "string" ? b.token.slice(0, 64) : "";
      const nowMs = p.now().getTime();
      // A live link gets its own allowance; every unknown link shares one, so random links cannot fill memory.
      const live = p.people.formLinkLive(token);
      const key = live ? `staff-form:${createHash("sha256").update(token).digest("hex")}` : "staff-form:unknown";
      if (p.formHits.recent(key, nowMs).length >= (live ? STAFF_FORM_PER_HOUR : UNKNOWN_FORM_LINKS_PER_HOUR)) return json(429, { error: "too many tries, please wait a while and try again" });
      p.formHits.record(key, nowMs);
      return { ...json(200, path.endsWith("save") ? p.people.submitForm(token, b) : p.people.formView(token)), headers: { "cache-control": "no-store" } };
    }

    // ---- sign in by email link ----
    if (method === "POST" && path === "/api/signin/start") {
      const email = String(body().email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) throw new BadRequest("a valid email is required");
      const nowMs = p.now().getTime();
      if (p.sends.recent(email, nowMs).length >= 5) return json(429, { error: "too many sign-in emails, try again later" });
      p.sends.record(email, nowMs);
      const link = makeToken(secret, { k: "magic", e: email, n: randomBytes(12).toString("hex") }, 900, nowMs);
      const base = (p.cfg.appUrl ?? "").replace(/\/$/, "");
      // The link opens a page that posts the token back, so mail scanners that pre-open links cannot use it up.
      await p.email.send({ to: email, ...signInLinkEmail(`${base}/signin.html#token=${link}`, brandFrom(p.cfg)) }).catch(() => undefined);
      // Same answer whether or not the address has an account. In development the website skips the email step.
      // Development only: the link comes back in the reply so a tester can sign in without email. Never for a
      // platform owner: an owner session can approve every client's work, so it always needs the emailed link
      // (printed in the API log in development).
      const devLink = p.cfg.allowDevAuth && !p.isPlatformOwner(userIdFor(email)) ? { devLink: link } : {};
      return json(200, p.cfg.allowDevAuth ? { ok: true, dev: true, ...devLink } : { ok: true });
    }
    if (method === "POST" && path === "/api/signin/verify") {
      const c = readToken(secret, String(body().token ?? ""), p.now().getTime());
      if (!c || c.k !== "magic" || typeof c.e !== "string" || typeof c.n !== "string") return json(400, { error: "this sign-in link is invalid or has expired" });
      if (p.usedLinks.has(c.n)) return json(400, { error: "this sign-in link was already used" });
      p.usedLinks.add(c.n, c.exp * 1000);
      return json(200, { token: issueSession(c.e), email: c.e, hasOrganisation: !!orgOf(userIdFor(c.e)), platformOwner: p.isPlatformOwner(userIdFor(c.e)), affiliate: !!p.affiliates.dashboardFor(c.e) });
    }

    // ---- email and password: sign up, log in, forgot password ----
    const authed = await passwordRoutes(req, { p, makeToken: (claims, ttl) => makeToken(secret, claims, ttl, p.now().getTime()), readToken: (t) => readToken(secret, t, p.now().getTime()), issueSession: (e) => issueSession(e), sessionClaims, orgOf, body });
    if (authed) return authed;

    // ---- sign in with Google or Microsoft: proves an email, then hands over the same one-time link as email sign-in ----
    if (method === "GET" && path === "/api/signin/providers") {
      const on = p.cfg.appUrl ? LOGIN_PROVIDERS.filter((k) => p.cfg.loginApps?.[k]) : [];
      return json(200, { providers: on });
    }
    const oauthLogin = /^\/api\/signin\/oauth\/([a-z]+)\/(start|callback)$/.exec(path);
    if (method === "GET" && oauthLogin) {
      const provider = oauthLogin[1];
      const app = isLoginProvider(provider) && p.cfg.appUrl ? p.cfg.loginApps?.[provider] : undefined;
      if (!isLoginProvider(provider) || !app || !p.cfg.appUrl) return json(404, { error: "this sign-in method is not switched on" });
      const redirectUri = loginRedirectUri(p.cfg.appUrl, provider);
      const nowMs = p.now().getTime();
      if (oauthLogin[2] === "start") {
        // The cookie value is a random secret that never appears in a URL; the state only carries a hash of it,
        // and the PKCE verifier and ID-token nonce are worked out from the cookie value.
        const secretValue = randomBytes(24).toString("hex");
        const { binding, challenge, idNonce } = attemptSecrets(secret, secretValue);
        const state = makeToken(secret, { k: "login-oauth", pr: provider, b: binding }, OAUTH_STATE_SECONDS, nowMs);
        return { status: 302, headers: { location: authorizeUrl(provider, app, { redirectUri, state, challenge, idNonce }), "set-cookie": loginCookie(secretValue, OAUTH_STATE_SECONDS, p.cfg.appUrl), "cache-control": "no-store" } };
      }
      // The callback. The signed state says we started this, and the cookie says this browser did.
      const state = readToken(secret, req.query.get("state") ?? undefined, nowMs);
      if (!state || state.k !== "login-oauth" || state.pr !== provider || typeof state.b !== "string") return loginFailed("failed", p.cfg.appUrl);
      const held = readCookie(req.headers["cookie"], loginCookieName(p.cfg.appUrl)) ?? "";
      const mine = attemptSecrets(secret, held);
      if (!held || mine.binding !== state.b || p.usedLinks.has(state.b)) return loginFailed("failed", p.cfg.appUrl);
      p.usedLinks.add(state.b, state.exp * 1000);
      const code = req.query.get("code");
      if (!code || code.length > 2048) return loginFailed(req.query.get("error") ? "cancelled" : "failed", p.cfg.appUrl);
      const { verifier, idNonce } = mine;
      const got = await completeLogin(provider, app, { code, redirectUri, verifier, idNonce, http: p.cfg.http ?? fetch, nowMs });
      if ("problem" in got) return loginFailed(got.problem, p.cfg.appUrl);
      // A platform owner session can approve every client's work, so it always needs the emailed link.
      if (p.isPlatformOwner(userIdFor(got.email))) return loginFailed("owner", p.cfg.appUrl);
      const link = makeToken(secret, { k: "magic", e: got.email, n: randomBytes(12).toString("hex") }, SOCIAL_LINK_SECONDS, nowMs);
      return { status: 302, headers: { location: `/signin.html#token=${link}`, "set-cookie": loginCookie("", 0, p.cfg.appUrl), "cache-control": "no-store" } };
    }

    // ---- referral link: counts the visit, remembers the affiliate for 30 days, and sends the visitor to the front page ----
    const ref = /^\/r\/([a-zA-Z0-9-]{1,40})$/.exec(path);
    if (method === "GET" && ref) {
      const a = p.affiliates.byCode(ref[1]);
      const headers: Record<string, string> = { location: "/", "cache-control": "no-store" };
      // One click per visitor per hour: the cookie's presence stops a refresh from counting again.
      const had = readCookie(req.headers["cookie"], refCookieName(p.cfg.appUrl));
      if (a?.enabled) {
        if (had !== a.code) p.affiliates.trackClick(a.code);
        headers["set-cookie"] = refCookie(a.code, REF_COOKIE_DAYS * 86_400, p.cfg.appUrl);
      }
      return { status: 302, headers };
    }

    // ---- coupons: anyone may ask what a code gives (rate limited, wrong tries counted) ----
    if (method === "POST" && path === "/api/coupons/check") {
      const b = body();
      const claims = sessionClaims(req);
      const email = typeof claims?.e === "string" ? claims.e : typeof b.email === "string" ? b.email : undefined;
      const mine = claims ? orgOf(claims.u) : undefined;
      const ctx = { ...(email ? { email } : {}), ...(mine ? { workspaceId: mine.id } : {}) };
      // Signed in: wrong tries count against the person. Anonymous: only the per-address limit applies, so a made-up email cannot reset or poison a counter.
      if (claims) return codeAttempt(`u:${claims.u}`, () => json(200, p.coupons.check(b.code, ctx)));
      try { return json(200, p.coupons.check(b.code, ctx)); } catch (e) { if (e instanceof PromoError) return json(400, { error: e.message }); throw e; }
    }

    // ---- sign up: needs a verified email (or the development shortcut) ----
    if (method === "POST" && path === "/api/signup") {
      const b = body();
      const claims = sessionClaims(req);
      let email: string;
      if (claims && typeof claims.e === "string") email = claims.e; // verified by a sign-in link
      else if (p.cfg.allowDevAuth) email = String(b.email ?? "").trim().toLowerCase(); // development only: no check
      else return json(401, { error: "verify your email first" });
      if (!claims && p.isPlatformOwner(userIdFor(email))) return json(401, { error: "verify your email first" }); // never an unverified owner session
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BadRequest("a valid email is required");
      const userId = userIdFor(email);
      if (orgOf(userId)) return json(409, { error: "this email already has an organisation" });
      // The three tapped answers (kind of business, needs, apps) become a plan by rules, with no AI call.
      const answers = readSignupAnswers(b);
      const plan = answers.businessName ? planSignup(answers) : undefined;
      const sectorLabel = plan && plan.sector !== OTHER_SECTOR ? getSector(plan.sector).label : "";
      const choices: SignupChoices = {
        ownerEmail: email,
        businessName: answers.businessName,
        businessType: sectorLabel || String(b.sells ?? "") || "small business",
        description: [answers.sells, plan ? plan.prefill.answers.goals : b.goal ? `Main goal: ${b.goal}` : "", answers.website ? `Website: ${answers.website}` : ""].filter(Boolean).join(" ") || answers.businessName,
        country: answers.country ?? answers.countryName ?? "GB",
        currency: plan?.currency,
        teamSize: answers.size ?? "2-10",
        monthlyVolume: typeof b.monthlyVolume === "number" ? b.monthlyVolume : undefined,
        addOns: answers.addOns ? [...answers.addOns] : [],
        prepaidMonths: typeof b.prepaidMonths === "number" ? b.prepaidMonths : undefined,
        contact: b.contact === "slack" ? "slack" : "dashboard",
        plan,
      };
      const org = await p.onboarding.signUp(userId, choices);
      // A referral cookie counts unless it is the affiliate's own address; a bad coupon never stops the signup.
      p.affiliates.attribute(org.workspaceId, email, choices.businessName, readCookie(req.headers["cookie"], refCookieName(p.cfg.appUrl)));
      const coupon = typeof b.coupon === "string" && b.coupon.trim() ? redeemAtSignup(userId, org.workspaceId, email, b.coupon) : undefined;
      await p.admin.welcome(userId, org);
      const token = issueSession(email);
      return json(201, { token, workspaceId: org.workspaceId, blueprint: org.blueprint, trialEndsAt: p.energy.planOf(org.workspaceId).expiresAt ?? org.trialEndsAt, ...(coupon ? { coupon } : {}) });
    }

    // ---- payment provider webhooks: public, authenticated by the provider's signature over the exact bytes ----
    if (method === "POST" && path === "/api/payments/webhook") {
      if (!p.payments.enabled) return json(503, { error: "payments are not switched on" });
      try {
        return json(200, { result: await p.payments.handleWebhook(req.rawBody, req.headers) });
      } catch (e) {
        if (e instanceof WebhookSignatureError) return json(400, { error: "bad signature" });
        throw e;
      }
    }

    // ---- WhatsApp: Meta's one-time handshake, then signed deliveries. Only the owner's number is ever obeyed ----
    if (path === "/api/whatsapp/webhook") {
      const wa = p.ownerWhatsApp;
      if (!wa) return json(503, { error: "whatsapp is not configured" });
      if (method === "GET") {
        const challenge = wa.handshake(req.query);
        if (challenge) p.connections.noteWebhook();
        return challenge ? { status: 200, text: challenge, headers: { "content-type": "text/plain; charset=utf-8" } } : json(403, { error: "bad verify token" });
      }
      if (method === "POST") {
        if (!wa.verifySignature(req.rawBody, req.headers["x-hub-signature-256"])) return json(401, { error: "bad signature" });
        p.connections.noteWebhook();
        let payload: unknown;
        try { payload = JSON.parse(req.rawBody || "{}"); } catch { return json(400, { error: "invalid JSON" }); }
        // Answer Meta at once (it retries slow replies); the work runs after the response is sent.
        return { status: 200, body: { ok: true }, after: async () => { await wa.handle(payload).catch((e) => console.error("whatsapp webhook failed:", e instanceof Error ? e.message : e)); } };
      }
    }

    // ---- Slack events: public, signed by Slack ----
    if (method === "POST" && path === "/api/slack/events") {
      if (!p.cfg.slack) return json(503, { error: "slack is not configured" });
      const { result, message } = parseSlackEvent(
        p.cfg.slack.signingSecret,
        { timestamp: req.headers["x-slack-request-timestamp"] ?? "", signature: req.headers["x-slack-signature"] ?? "" },
        req.rawBody,
        Math.floor(p.now().getTime() / 1000),
      );
      return { status: result.status, body: result.body, after: message ? async () => { await p.router.handle(message).catch(() => undefined); } : undefined };
    }

    // ---- Slack install callback: browser arrives from Slack, no session header; the signed state proves who started it ----
    if (method === "GET" && path === "/api/slack/callback") {
      const cfg = p.cfg.slack;
      if (!cfg) return json(503, { error: "slack is not configured" });
      const state = readToken(secret, req.query.get("state") ?? undefined, p.now().getTime());
      const code = req.query.get("code");
      if (!state?.u || state.k !== "slack-install" || typeof state.n !== "string" || !code) return json(400, { error: "invalid or expired install link" });
      // Usable once. The QR flow finishes on a phone, so this link cannot be tied to the browser that started it.
      if (p.usedLinks.has(state.n)) return json(400, { error: "invalid or expired install link" });
      p.usedLinks.add(state.n, state.exp * 1000);
      const res = await (p.cfg.http ?? fetch)("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri }),
      });
      const o = (await res.json()) as any;
      if (!o.ok || !o.access_token || !o.team?.id) return json(400, { error: "Slack did not approve the install" });
      const org = orgOf(state.u);
      if (!org) return json(400, { error: "no organisation for this user" });
      const team = p.workforce.team(state.u, org.id);
      const lead = team.find((e) => e.templateKey === "business-consultant") ?? team[0]!;
      p.router.connect(state.u, { workspaceId: org.id, channel: "slack", externalWorkspace: o.team.id, defaultEmployeeId: lead.id }, []);
      p.saveSlackToken(org.id, o.team.id, o.access_token);
      if (o.authed_user?.id) p.router.linkUser(state.u, org.id, "slack", o.team.id, o.authed_user.id);
      // Anything the Admin manager was holding for Slack goes out now.
      await p.admin.deliverPending(state.u, org.id).catch(() => 0);
      return { status: 302, headers: { location: "/app.html#team" } };
    }

    // ---- business apps: OAuth return and webhooks are public; state or the secret link proves who they are for ----
    if (method === "GET" && path === "/api/integrations/callback") {
      const state = readToken(secret, req.query.get("state") ?? undefined, p.now().getTime());
      const code = req.query.get("code");
      if (!state?.u || state.k !== "int-oauth" || typeof state.a !== "string" || typeof state.n !== "string") return json(400, { error: "invalid or expired connect link" });
      // Bound to the browser that started it (cookie) and usable once, so a link sent to someone else cannot attach their account.
      if (readCookie(req.headers["cookie"], OAUTH_COOKIE) !== state.n || p.usedLinks.has(state.n)) return json(400, { error: "invalid or expired connect link" });
      p.usedLinks.add(state.n, state.exp * 1000);
      const org = orgOf(state.u);
      if (!code || !org) return { status: 302, headers: { location: "/app.html#apps" } }; // owner pressed Cancel in the app
      try {
        await p.integrations.completeOAuth(state.u, org.id, state.a, code);
      } catch (e) {
        if (!(e instanceof IntegrationError)) throw e;
        return { status: 302, headers: { location: "/app.html?connect=failed#apps" } };
      }
      return { status: 302, headers: { location: "/app.html#apps" } };
    }
    const hook = /^\/api\/integrations\/hooks\/([\w-]{1,64})\/([\w-]{16,128})$/.exec(path);
    if (method === "POST" && hook) {
      let payload: unknown;
      try { payload = JSON.parse(req.rawBody || "{}"); } catch { return json(400, { error: "invalid JSON" }); }
      const result = p.integrations.receiveWebhook(hook[1]!, hook[2]!, payload);
      return result ? json(200, { ok: true, added: result.added, updated: result.updated, warnings: result.warnings }) : json(404, { error: "not found" });
    }

    // ---- everything below needs a signed-in user ----
    const userId = session(req);
    if (!userId) return json(401, { error: "sign in first" });
    // ---- MAIZ quality review: the platform owner's queue across every client. Clients get 403. ----
    if (path === "/api/owner/reviews" || path.startsWith("/api/owner/reviews/")) return ownerReviewRoutes(req, userId, body);
    if (path === "/api/owner/ai" || path.startsWith("/api/owner/ai/")) return ownerAiRoutes(req, userId, body);
    if (path === "/api/owner/prices" || path.startsWith("/api/owner/prices/")) return ownerPriceRoutes(req, userId, body);
    if (method === "GET" && path === "/api/owner/team") {
      if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can see the owner's team" });
      const pw = p.promoter.waiting(userId), gw = p.growth.waiting(userId), go = p.growth.overview(userId);
      const live = {
        "promotion-agent": { waiting: pw.drafts.length + pw.plans.length, doing: `${p.promoter.campaignsList(userId).length} campaigns, ${p.promoter.leadsList(userId).length} people on the list`, due: p.promoter.followUpsDue(userId).length },
        "community-growth-manager": { waiting: gw.items.length + gw.approvals.length, doing: `${go.opportunities.length} places, ${go.publications.length} publications recorded`, due: go.followUpsDue.length },
      } as const;
      return json(200, { specialists: OWNER_SPECIALISTS.map((s) => ({ ...s, status: live[s.key] })) });
    }
    if (path === "/api/owner/connections" || path.startsWith("/api/owner/connections/")) return ownerConnectionRoutes(req, userId, body);
    if (path.startsWith("/api/owner/growth")) return ownerGrowthRoutes(req, userId, body);
    if (path.startsWith("/api/owner/promoter")) return ownerPromoterRoutes(req, userId, body);
    if (path.startsWith("/api/owner/coupons") || path.startsWith("/api/owner/affiliates") || path === "/api/owner/promotions") return ownerPromoRoutes(req, userId, body);
    if (path.startsWith("/api/owner/")) {
      if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can see this" });
      if (method === "GET" && path === "/api/owner/batch") return json(200, p.batch.ownerView(userId));
      if (method === "POST" && path === "/api/owner/batch/run-now") {
        const run = await p.batch.runAllNow(userId);
        return json(200, { started: !!run, run: run ?? null, ...p.batch.ownerView(userId) });
      }
      if (method === "GET" && path === "/api/owner/reconciliation") return json(200, { reports: p.reconciliation.all().map((r) => ({ ...r, clientName: p.identity.workspaceById(r.workspaceId)?.name ?? r.workspaceId })) });
      if (method === "POST" && path === "/api/owner/reconciliation/run") {
        for (const w of p.identity.allWorkspaces()) await p.reconciliation.runOne(w.id);
        return json(200, { reports: p.reconciliation.all().map((r) => ({ ...r, clientName: p.identity.workspaceById(r.workspaceId)?.name ?? r.workspaceId })) });
      }
      if (method === "GET" && path === "/api/owner/decisions") { const items = p.ownerDecisions(); return json(200, { total: items.length, items }); }
      if (method === "GET" && path === "/api/owner/clients") return json(200, { clients: p.clients(userId) });
      if (method === "GET" && path === "/api/owner/specialists") return json(200, { requests: p.specialists.queue(userId) });
      const d = /^\/api\/owner\/specialists\/([\w-]{1,64})\/decide$/.exec(path);
      if (method === "POST" && d) {
        const b = body();
        await p.specialists.decide(userId, d[1]!, { decision: b.decision, message: b.message, priceGbp: b.priceGbp });
        return json(200, { requests: p.specialists.queue(userId) });
      }
      return json(404, { error: "not found" });
    }
    if (method === "GET" && path === "/api/me") return json(200, { platformOwner: p.isPlatformOwner(userId), hasOrganisation: !!orgOf(userId) });

    // ---- affiliate: whoever logs in with an affiliate's email sees their own results ----
    if (method === "GET" && path === "/api/affiliate/me") return json(200, { affiliate: affiliateView(sessionClaims(req)?.e) });

    const org = orgOf(userId);
    if (!org) return json(404, { error: "no organisation yet" });

    // ---- coupons on the account page ----
    if (method === "GET" && path === "/api/coupons") return json(200, { used: p.coupons.forClient(org.id).map((r) => ({ code: r.code, at: r.at, applied: r.applied })) });
    if (method === "POST" && path === "/api/coupons/redeem") {
      p.identity.require(userId, org.id, "workspace.manage");
      const email = String(sessionClaims(req)?.e ?? "");
      return codeAttempt(`u:${userId}`, () => {
        const r = p.coupons.redeem(userId, org.id, email, body().code);
        return json(200, { applied: r.applied, trialEndsAt: p.energy.planOf(org.id).expiresAt ?? null, team: p.energy.teamEnergy(userId, org.id) ?? null });
      });
    }

    if (method === "GET" && path === "/api/dashboard") return json(200, p.dashboard(userId, org.id));

    // ---- rota: staff and shifts ----
    if (path.startsWith("/api/rota/")) {
      const today = p.now().toISOString().slice(0, 10);
      const rotaWeek = (date: string) => json(200, p.rota.week(userId, org.id, date));
      if (method === "GET" && path === "/api/rota/week") return rotaWeek(req.query.get("date") ?? today);
      if (method === "POST" && path === "/api/rota/staff") { const st = p.rota.addStaff(userId, org.id, body()); return json(201, { added: st, ...p.rota.week(userId, org.id, today) }); }
      const left = /^\/api\/rota\/staff\/([\w-]{1,64})\/leave$/.exec(path);
      if (method === "POST" && left) { p.rota.deactivate(userId, org.id, left[1]!, today); return rotaWeek(today); }
      if (method === "POST" && path === "/api/rota/shifts") { const sh = p.rota.addShift(userId, org.id, body()); return json(201, { shift: sh, ...p.rota.week(userId, org.id, sh.date) }); }
      const asg = /^\/api\/rota\/shifts\/([\w-]{1,64})\/assign$/.exec(path);
      if (method === "POST" && asg) { const b = body(); const sh = p.rota.assign(userId, org.id, asg[1]!, typeof b.staffId === "string" && b.staffId ? b.staffId : null); return json(200, { shift: sh, ...p.rota.week(userId, org.id, sh.date) }); }
      const del = /^\/api\/rota\/shifts\/([\w-]{1,64})$/.exec(path);
      if (method === "DELETE" && del) { p.rota.removeShift(userId, org.id, del[1]!); return rotaWeek(req.query.get("date") ?? today); }
      return json(404, { error: "not found" });
    }

    // ---- HR manager desk: staff records (owner and admins only; personal data) ----
    if (path === "/api/people" || path.startsWith("/api/people/")) return peopleRoutes(req, userId, org.id, body);

    // ---- buying from the store ----
    if (method === "POST" && path === "/api/checkout") {
      const { order, url } = await p.payments.checkout(userId, org.id, body().lines);
      return json(201, { order: orderView(order), ...(url ? { url } : {}) });
    }
    if (method === "GET" && path === "/api/orders") return json(200, { enabled: p.payments.enabled, orders: p.payments.mine(userId, org.id).map(orderView) });
    if (method === "POST" && path === "/api/billing/portal") return json(200, { url: await p.payments.portalUrl(userId, org.id, `${(p.cfg.appUrl ?? "").replace(/\/$/, "")}/app.html#team`) });
    const cancelOrder = /^\/api\/orders\/([\w-]{1,64})\/cancel$/.exec(path);
    if (method === "POST" && cancelOrder) return json(200, { order: orderView(await p.payments.cancel(userId, org.id, cancelOrder[1]!)) });

    // ---- new custom specialists: the client asks, MAIZ reviews before anything is trained ----
    if (method === "GET" && path === "/api/specialists") return json(200, { requests: p.specialists.forClient(userId, org.id) });
    if (method === "POST" && path === "/api/specialists") {
      const r = await p.specialists.request(userId, org.id, body());
      return json(201, { request: p.specialists.forClient(userId, org.id).find((x) => x.id === r.id), jobDescription: r.jobDescription, notes: r.notes });
    }

    const hireSpecialist = /^\/api\/specialists\/([\w-]{1,64})\/hire$/.exec(path);
    if (method === "POST" && hireSpecialist) {
      const r = await p.specialists.hire(userId, org.id, hireSpecialist[1]!);
      return json(201, { request: p.specialists.forClient(userId, org.id).find((x) => x.id === r.id), employeeId: r.hiredEmployeeId });
    }

    // ---- specialised tasks: the client follows them through quality review but never approves ----
    if (method === "GET" && path === "/api/reviews") return json(200, { tasks: p.reviews.forClient(userId, org.id) });
    if (method === "POST" && path === "/api/reviews") {
      const item = await p.reviews.submit({ kind: "client", userId }, org.id, body());
      return json(201, { task: p.reviews.forClient(userId, org.id).find((t) => t.id === item.id) });
    }
    const answer = /^\/api\/reviews\/([\w-]{1,64})\/answer$/.exec(path);
    if (method === "POST" && answer) {
      const b = body();
      if (typeof b.label !== "string") throw new BadRequest("say which question you are answering");
      await p.reviews.answer({ kind: "client", userId }, org.id, answer[1]!, b.label, b.value);
      return json(200, { task: p.reviews.forClient(userId, org.id).find((t) => t.id === answer[1]) });
    }

    // ---- Team energy: the week's pool, top-ups that roll over, and opt-in auto-reload with a monthly cap ----
    if (method === "GET" && path === "/api/energy") {
      return json(200, { team: p.energy.teamEnergy(userId, org.id) ?? null, packs: p.prices.topUpPacks() });
    }
    if (method === "POST" && path === "/api/energy/auto-reload") {
      p.energy.setAutoReload(userId, org.id, parseAutoReload(body(), p.prices.topUpPacks()));
      return json(200, { team: p.energy.teamEnergy(userId, org.id) ?? null, packs: p.prices.topUpPacks() });
    }

    if (method === "GET" && path === "/api/org") {
      const plan = p.energy.planOf(org.id);
      return json(200, {
        id: org.id,
        name: org.name,
        trialEndsAt: plan.expiresAt,
        dailyQuotaPerEmployee: plan.dailyQuotaPerEmployee,
        /** The team's shared energy: pool, left, left today, daily ceiling, refill time. Absent on older plans. */
        teamEnergy: p.energy.teamEnergy(userId, org.id) ?? null,
        team: p.workforce.team(userId, org.id).map((e) => ({
          id: e.id,
          templateKey: e.templateKey,
          name: e.name,
          blurb: p.workforce.templateFor(e.templateKey, org.id)?.title,
          energyLeft: p.energy.remainingToday(userId, org.id, e.id),
        })),
      });
    }

    // ---- Admin manager: messages, setup form, setup run ----
    if (method === "GET" && path === "/api/setup") {
      return json(200, { ...p.admin.status(userId, org.id), messages: p.admin.messages(userId, org.id) });
    }
    if (method === "POST" && path === "/api/setup") {
      const b = body();
      if (!b.answers || typeof b.answers !== "object" || Array.isArray(b.answers)) throw new BadRequest("answers are required");
      const run = await p.admin.submitForm(userId, org.id, b.answers);
      const res = json(200, { run, ...p.admin.status(userId, org.id), messages: p.admin.messages(userId, org.id) });
      // The owner's reply goes out first. The first jobs (which call the AI) start in the background once setup finished.
      return run.status === "completed" ? { ...res, after: async () => { await p.admin.startFirstJobs(org.id); } } : res;
    }
    if (method === "POST" && path === "/api/setup/rollback") {
      const run = await p.admin.rollback(userId, org.id);
      return json(200, { run, ...p.admin.status(userId, org.id), messages: p.admin.messages(userId, org.id) });
    }

    if (method === "POST" && path === "/api/ask") {
      const a = prepareAsk(userId, org.id, body());
      const task = await p.workforce.assign(userId, org.id, a.emp.id, a.text, { urgent: a.urgent, when: a.when, history: a.history });
      return json(200, answerBody(userId, org.id, a, task));
    }

    // The same question, answered as it is written: events "accepted", then "delta" pieces, then "done" (or "error").
    // "done" carries the whole answer and is the one to trust: a quality check may have changed what was streamed.
    if (method === "POST" && path === "/api/ask/stream") {
      const a = prepareAsk(userId, org.id, body());
      return {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
        stream: async (send) => {
          send("accepted", { employee: a.emp.name });
          try {
            const task = await p.workforce.assign(userId, org.id, a.emp.id, a.text, {
              urgent: a.urgent, when: a.when, history: a.history,
              stream: { text: (t) => send("delta", { t }), reset: () => send("reset", {}) },
            });
            send("done", answerBody(userId, org.id, a, task));
          } catch (err) {
            console.error("ask stream failed:", err);
            send("error", { message: err instanceof PermissionError ? "You don't have permission to ask." : ASK_FAILED_MESSAGE });
          }
        },
      };
    }

    // ---- saved conversations, one thread per employee ----
    const thread = /^\/api\/conversations\/([\w-]{1,64})(\/clear)?$/.exec(path);
    if (thread) {
      const emp = p.workforce.team(userId, org.id).find((e) => e.id === thread[1]);
      if (!emp) throw new BadRequest("pick one of your employees");
      if (method === "GET" && !thread[2]) return json(200, { employee: emp.name, turns: p.conversations.thread(userId, org.id, emp.id) });
      if (method === "POST" && thread[2]) { p.conversations.clear(userId, org.id, emp.id); return json(200, { turns: [] }); }
    }

    // ---- the bell, and what the records suggest ----
    if (method === "GET" && path === "/api/notifications") return json(200, p.notices.list(userId, org.id));
    if (method === "POST" && path === "/api/notifications/seen") { p.notices.markSeen(userId, org.id); return json(200, p.notices.list(userId, org.id)); }
    if (method === "GET" && path === "/api/suggestions") return json(200, { suggestions: suggestionsFor(p, userId, org.id) });

    // The app calls this when it opens or the ask box is focused, so a sleeping GPU is awake by the time the question is sent.
    if (method === "POST" && path === "/api/warm") {
      p.identity.require(userId, org.id, "task.create");
      return json(202, { status: p.warm() });
    }

    // ---- batch queue: work that waits for the client's closing time ----
    if (method === "GET" && path === "/api/queue") return json(200, p.batch.forClient(userId, org.id));
    if (method === "POST" && path === "/api/queue/run-now") {
      const run = await p.batch.runNow(userId, org.id);
      return json(200, { started: !!run, ...p.batch.forClient(userId, org.id) });
    }
    const cancel = /^\/api\/queue\/([\w-]{1,64})\/cancel$/.exec(path);
    if (method === "POST" && cancel) {
      p.batch.cancel(userId, org.id, cancel[1]!);
      return json(200, p.batch.forClient(userId, org.id));
    }
    if (method === "GET" && path === "/api/batch/schedule") return json(200, p.batch.forClient(userId, org.id));
    if (method === "POST" && path === "/api/batch/schedule") {
      p.batch.setSchedule(userId, org.id, body());
      return json(200, p.batch.forClient(userId, org.id));
    }

    if (method === "GET" && path === "/api/finance/summary") {
      const today = p.now().toISOString().slice(0, 10);
      const from = `${today.slice(0, 7)}-01`;
      return json(200, {
        asOf: today,
        profitAndLoss: p.ledger.profitAndLoss(userId, org.id, { from, to: today }),
        runway: p.ledger.runway(userId, org.id, today),
        balanceSheet: p.ledger.balanceSheet(userId, org.id, today),
      });
    }

    if (method === "POST" && path === "/api/finance/entries") {
      const b = body();
      const entry = p.ledger.post(userId, org.id, { date: String(b.date ?? ""), memo: String(b.memo ?? ""), source: b.source ? String(b.source) : undefined, lines: Array.isArray(b.lines) ? b.lines : [] });
      return json(201, { id: entry.id });
    }

    // ---- business apps ----
    if (path.startsWith("/api/integrations")) {
      const r = await integrationRoutes(req, userId, org.id, body);
      if (r) return r;
    }

    // ---- start the Slack install; the QR code on the website encodes this URL ----
    if (method === "GET" && path === "/api/slack/install") {
      const cfg = p.cfg.slack;
      if (!cfg) return json(503, { error: "slack is not configured" });
      const state = makeToken(secret, { u: userId, k: "slack-install", n: randomBytes(16).toString("hex") }, OAUTH_STATE_SECONDS, p.now().getTime());
      const url = new URL("https://slack.com/oauth/v2/authorize");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("scope", "app_mentions:read,chat:write,im:history,im:read,im:write");
      url.searchParams.set("redirect_uri", cfg.redirectUri);
      url.searchParams.set("state", state);
      return json(200, { url: url.toString() });
    }

    return json(404, { error: "not found" });
  }

  /** The HR desk: owner and admins only (`people.manage`); the service checks it on every call. */
  function peopleRoutes(req: Req, userId: string, ws: string, body: () => any): Res {
    const { method, path } = req;
    const P = p.people;
    if (method === "GET" && path === "/api/people") return json(200, P.overview(userId, ws));
    if (method === "POST" && path === "/api/people") return json(201, P.add(userId, ws, body()));
    if (method === "POST" && path === "/api/people/settings") return json(200, { settings: P.updateSettings(userId, ws, body()) });
    const id = "([\\w-]{1,64})";
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^/api/people/${id}$`).exec(path))) {
      if (method === "GET") return json(200, P.detail(userId, ws, m[1]!));
      if (method === "POST") return json(200, P.update(userId, ws, m[1]!, body()));
      if (method === "DELETE") { P.remove(userId, ws, m[1]!); return json(200, { deleted: true }); }
    }
    if ((m = new RegExp(`^/api/people/${id}/form-link$`).exec(path)) && method === "DELETE") return json(200, P.stopFormLink(userId, ws, m[1]!));
    if (method !== "POST") return json(404, { error: "not found" });
    if ((m = new RegExp(`^/api/people/${id}/documents/([a-z_]{1,40})$`).exec(path))) return json(200, P.setDocument(userId, ws, m[1]!, m[2]!, body()));
    if ((m = new RegExp(`^/api/people/${id}/checklist/([a-z_]{1,40})$`).exec(path))) return json(200, P.setChecklist(userId, ws, m[1]!, m[2]!, body().done));
    if ((m = new RegExp(`^/api/people/${id}/leave$`).exec(path))) return json(200, P.addLeave(userId, ws, m[1]!, body()));
    if ((m = new RegExp(`^/api/people/${id}/leave/${id}/decide$`).exec(path))) return json(200, P.decideLeave(userId, ws, m[1]!, m[2]!, body().approve));
    if ((m = new RegExp(`^/api/people/${id}/reviews$`).exec(path))) return json(200, P.addReview(userId, ws, m[1]!, body()));
    if ((m = new RegExp(`^/api/people/${id}/reviews/${id}/done$`).exec(path))) return json(200, P.completeReview(userId, ws, m[1]!, m[2]!, body()));
    if ((m = new RegExp(`^/api/people/${id}/leaving$`).exec(path))) return json(200, P.setLeaving(userId, ws, m[1]!, body().endDate));
    if ((m = new RegExp(`^/api/people/${id}/profile$`).exec(path))) return json(200, P.updateProfile(userId, ws, m[1]!, body()));
    if ((m = new RegExp(`^/api/people/${id}/form-link$`).exec(path))) {
      const { token, expiresOn } = P.createFormLink(userId, ws, m[1]!);
      // The token rides in the fragment, so it never reaches server logs or another site's Referer header.
      return json(201, { url: `${(p.cfg.appUrl ?? "").replace(/\/$/, "")}/staff-form.html#t=${token}`, expiresOn });
    }
    return json(404, { error: "not found" });
  }

  async function ownerReviewRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can see quality review" });
    const { method, path } = req;
    if (method === "GET" && path === "/api/owner/reviews") return json(200, { reviews: p.reviews.queue(userId) });
    const m = /^\/api\/owner\/reviews\/([\w-]{1,64})\/(approve|request-info)$/.exec(path);
    if (method === "POST" && m) {
      const b = body();
      const str = (v: unknown) => (typeof v === "string" ? v : undefined);
      const item = m[2] === "approve"
        ? await p.reviews.approve(userId, m[1]!, { direction: str(b.direction), noteToClient: str(b.noteToClient), note: str(b.note), seenVersion: str(b.seenVersion) })
        : await p.reviews.requestInfo(userId, m[1]!, { question: str(b.question), note: str(b.note) });
      return json(200, { review: p.reviews.queue(userId).find((r) => r.id === item.id) });
    }
    return json(404, { error: "not found" });
  }

  /** AI spend and routing settings: the platform owner only (the service checks again). */
  async function ownerAiRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can see AI spend" });
    const { method, path } = req;
    if (method === "GET" && path === "/api/owner/ai") return json(200, p.ai.overview(userId));
    if (method === "GET" && path === "/api/owner/ai/health") return json(200, await p.ai.health(userId));
    if (method === "POST" && path === "/api/owner/ai/settings") {
      p.ai.update(userId, body());
      return json(200, p.ai.overview(userId));
    }
    return json(404, { error: "not found" });
  }

  /** Counts a wrong code against the person, and stops the guessing after a few tries. */
  function codeAttempt(key: string, run: () => Res): Res {
    const t = p.now().getTime();
    if (p.codeFails.recent(key, t).length >= CODE_TRIES) return json(429, { error: "Too many wrong codes. Wait 15 minutes and try again." });
    try {
      return run();
    } catch (e) {
      if (!(e instanceof PromoError)) throw e;
      p.codeFails.record(key, t);
      return json(400, { error: e.message });
    }
  }

  /** A code typed at signup: tried once, and the answer comes back with the new account. */
  function redeemAtSignup(userId: string, workspaceId: string, email: string, code: string): { ok: boolean; message: string } {
    const key = `u:${userId}`;
    const t = p.now().getTime();
    if (p.codeFails.recent(key, t).length >= CODE_TRIES) return { ok: false, message: "Too many wrong codes. Try again later in Settings." };
    try {
      return { ok: true, message: `Code applied: ${p.coupons.redeem(userId, workspaceId, email, code).applied}.` };
    } catch (e) {
      if (!(e instanceof PromoError)) throw e;
      p.codeFails.record(key, t);
      return { ok: false, message: `${e.message} Your team was created; you can try another code in Settings.` };
    }
  }

  const referralLink = (code: string) => `${(p.cfg.appUrl ?? "").replace(/\/$/, "")}/r/${code}`;

  /** What an affiliate sees of their own results: counts and money, never the referred clients' names. */
  function affiliateView(email: unknown) {
    const d = typeof email === "string" ? p.affiliates.dashboardFor(email) : undefined;
    if (!d) return null;
    const t = p.now().toISOString();
    return {
      name: d.name, code: d.code, link: referralLink(d.code), enabled: d.enabled, commission: d.commission, commissionText: describeCommission(d.commission), holdDays: d.holdDays, stats: d.stats,
      referrals: d.referrals.map((r) => ({ at: r.at, paying: r.paying, earnedGbp: r.earnedGbp })),
      commissions: d.accruals.map((a) => ({ at: a.at, amountGbp: a.amountGbp, status: a.payoutId ? "paid" : a.payableFrom <= t ? "payable" : "pending", payableFrom: a.payableFrom })),
      payouts: d.payouts.map((x) => ({ at: x.at, amountGbp: x.amountGbp, reference: x.reference ?? null })),
    };
  }

  /** The community growth manager: the platform owner only. Nothing is posted, pitched or created by it; the owner does that by hand and records it here. */
  async function ownerGrowthRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can use the community growth manager" });
    const { method, path } = req;
    const g = p.growth;
    const overview = () => ({ ...g.overview(userId), report: g.report(userId) });
    if (method === "GET" && path === "/api/owner/growth") return json(200, { ...overview(), role: GROWTH_ROLE, discovery: Object.fromEntries((["mocktestroom", "examutor", "maizagents"] as const).map((k) => [k, discoveryQueries(k)])) });
    if (method === "POST" && path === "/api/owner/growth/opportunities") { g.addOpportunity(userId, body()); return json(201, overview()); }
    if (method === "POST" && path === "/api/owner/growth/drafts") { await g.draft(userId, body()); return json(201, overview()); }
    if (method === "POST" && path === "/api/owner/growth/approvals") { g.raiseApproval(userId, body()); return json(201, overview()); }
    if (method === "POST" && path === "/api/owner/growth/accounts") { g.registerAccount(userId, body()); return json(201, overview()); }
    const route = /^\/api\/owner\/growth\/(opportunities|drafts|approvals|publications)\/([\w-]{1,64})\/(update|approve|reject|edit|published|decide|verify|metrics|follow-up)$/.exec(path);
    if (method === "POST" && route) {
      const [, kind, id, action] = route as unknown as [string, string, string, string];
      const b = body() ?? {};
      if (kind === "opportunities" && action === "update") g.updateOpportunity(userId, id, b);
      else if (kind === "drafts" && action === "approve") g.decide(userId, id, true, b.acknowledge === true);
      else if (kind === "drafts" && action === "reject") g.decide(userId, id, false);
      else if (kind === "drafts" && action === "edit") g.edit(userId, id, b);
      else if (kind === "drafts" && action === "published") g.markPublished(userId, id, b);
      else if (kind === "approvals" && action === "decide") g.decideApproval(userId, id, b.approve === true);
      else if (kind === "publications" && action === "verify") g.verify(userId, id, b);
      else if (kind === "publications" && action === "metrics") g.recordMetrics(userId, id, b);
      else if (kind === "publications" && action === "follow-up") g.setFollowUp(userId, id, b);
      else return json(404, { error: "not found" });
      return json(200, overview());
    }
    return json(404, { error: "not found" });
  }

  /**
   * The owner's Connections page: Facebook, Instagram and WhatsApp details typed in the browser (stored encrypted,
   * secrets never sent back), plus the status and a harmless real test of every server-set service.
   */
  async function ownerConnectionRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can manage connections" });
    const { method, path } = req;
    const c = p.connections;
    const all = () => ({ connections: c.list(userId), persistent: p.hasStore() && p.healthy() });
    try {
      if (method === "GET" && path === "/api/owner/connections") return json(200, all());
      if (method === "POST" && path === "/api/owner/connections/whatsapp/send-test") { const r = await c.sendWhatsAppTest(userId); return json(200, { ...r, ...all() }); }
      const m = /^\/api\/owner\/connections\/([a-z]{2,20})(?:\/(test|disconnect))?$/.exec(path);
      if (m && method === "PUT" && !m[2]) { c.save(userId, m[1]!, body()); return json(200, all()); }
      if (m && method === "POST" && m[2] === "test") { await c.test(userId, m[1]!); return json(200, all()); }
      if (m && method === "POST" && m[2] === "disconnect") { c.disconnect(userId, m[1]!); return json(200, all()); }
    } catch (e) {
      if (e instanceof ConnectionsError) return json(400, { error: e.message });
      throw e;
    }
    return json(404, { error: "not found" });
  }

  /** The promotion agent: the platform owner only (the service checks again). Drafts wait for approval; nothing posts or spends by itself. */
  async function ownerPromoterRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can use the promotion agent" });
    const { method, path } = req;
    const pr = p.promoter;
    const overview = () => ({ campaigns: pr.campaignsList(userId), drafts: pr.items_(userId), leads: pr.leadsList(userId), followUpsDue: pr.followUpsDue(userId) });
    if (method === "GET" && path === "/api/owner/promoter") return json(200, { ...overview(), knowledge: pr.knowledge(userId).sites });
    if (method === "POST" && path === "/api/owner/promoter/facts") { const b = body(); return json(200, { facts: pr.addFact(userId, b.site, b.text) }); }
    if (method === "POST" && path === "/api/owner/promoter/campaigns") return json(201, { campaign: pr.createCampaign(userId, body()), ...overview() });
    if (method === "POST" && path === "/api/owner/promoter/leads") { const b = body(); const lead = pr.addLead(userId, b.site, b); return json(201, { lead: { ...lead, token: undefined }, ...overview() }); }
    if (method === "POST" && path === "/api/owner/promoter/drafts") return json(201, { draft: await pr.draft(userId, body()), ...overview() });
    const camp = /^\/api\/owner\/promoter\/campaigns\/([\w-]{1,64})\/(status|spend|results|report)$/.exec(path);
    if (camp) {
      const b = method === "POST" ? body() : {};
      if (method === "GET" && camp[2] === "report") return json(200, { report: pr.report(userId, camp[1]!) });
      if (method === "POST" && camp[2] === "status") pr.setCampaignStatus(userId, camp[1]!, b.status);
      else if (method === "POST" && camp[2] === "spend") pr.recordSpend(userId, camp[1]!, b.amountGbp, b.note);
      else if (method === "POST" && camp[2] === "results") pr.recordResult(userId, camp[1]!, b.metric, b.value, b.note);
      else return json(404, { error: "not found" });
      return json(200, overview());
    }
    const lead = /^\/api\/owner\/promoter\/leads\/([\w-]{1,64})\/replied$/.exec(path);
    if (method === "POST" && lead) { pr.markReplied(userId, lead[1]!); return json(200, overview()); }
    if (method === "GET" && path === "/api/owner/promoter/channels") return json(200, { ...pr.channels(userId), whatsapp: p.ownerWhatsApp?.status() ?? { connected: false } });
    const d = /^\/api\/owner\/promoter\/drafts\/([\w-]{1,64})\/(approve|reject|edit|send|posted|preview|publish|stats)$/.exec(path);
    if (d) {
      const id = d[1]!;
      if (method === "GET" && d[2] === "preview") return json(200, { preview: pr.preview(userId, id) });
      if (method !== "POST") return json(404, { error: "not found" });
      const b = body();
      if (d[2] === "approve") pr.decide(userId, id, true, b.note);
      else if (d[2] === "reject") pr.decide(userId, id, false, b.note);
      else if (d[2] === "edit") pr.edit(userId, id, b);
      else if (d[2] === "send") await pr.send(userId, id);
      else if (d[2] === "publish") await pr.publishToMeta(userId, id, b);
      else if (d[2] === "stats") await pr.refreshStats(userId, id);
      else pr.markPosted(userId, id, b.url);
      return json(200, overview());
    }
    return json(404, { error: "not found" });
  }

  /** Coupons and affiliates: the platform owner only (the services check again). */
  async function ownerPromoRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can manage coupons and affiliates" });
    const { method, path } = req;
    const base = (p.cfg.appUrl ?? "").replace(/\/$/, "");
    const overview = () => ({
      coupons: p.coupons.list(userId),
      affiliates: p.affiliates.list(userId).map((a) => ({ ...a, link: referralLink(a.code), commissionText: describeCommission(a.commission) })),
      defaults: { commission: DEFAULT_COMMISSION, holdDays: DEFAULT_HOLD_DAYS },
    });
    if (method === "GET" && path === "/api/owner/promotions") return json(200, overview());
    if (method === "POST" && path === "/api/owner/coupons") { const c = p.coupons.create(userId, body()); return json(201, { coupon: c, ...overview() }); }
    const cEnable = /^\/api\/owner\/coupons\/([\w-]{1,64})\/enabled$/.exec(path);
    if (method === "POST" && cEnable) { p.coupons.setEnabled(userId, cEnable[1]!, body().enabled === true); return json(200, overview()); }
    const cHist = /^\/api\/owner\/coupons\/([\w-]{1,64})\/redemptions$/.exec(path);
    if (method === "GET" && cHist) return json(200, { redemptions: p.coupons.redemptionsOf(userId, cHist[1]!) });
    const cSend = /^\/api\/owner\/coupons\/([\w-]{1,64})\/send$/.exec(path);
    if (method === "POST" && cSend) {
      const to = String(body().to ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new BadRequest("enter a valid email address");
      const c = p.coupons.list(userId).find((x) => x.id === cSend[1]);
      if (!c) return json(404, { error: "coupon not found" });
      await p.email.send({ to, ...couponGiftEmail(c.code, c.summary, `${base}/onboarding.html`, brandFrom(p.cfg)) });
      return json(200, { sent: true });
    }
    if (method === "POST" && path === "/api/owner/affiliates") {
      const a = p.affiliates.create(userId, body());
      // Best effort: the affiliate exists whether or not the email goes out.
      await p.email.send({ to: a.email, ...affiliateWelcomeEmail(a.name, referralLink(a.code), `${base}/affiliate.html`, describeCommission(a.commission), brandFrom(p.cfg)) }).catch((e) => console.error("affiliate email failed:", e));
      return json(201, { affiliate: a, ...overview() });
    }
    const aEnable = /^\/api\/owner\/affiliates\/([\w-]{1,64})\/enabled$/.exec(path);
    if (method === "POST" && aEnable) { p.affiliates.setEnabled(userId, aEnable[1]!, body().enabled === true); return json(200, overview()); }
    const aPaid = /^\/api\/owner\/affiliates\/([\w-]{1,64})\/payout$/.exec(path);
    if (method === "POST" && aPaid) {
      const a = p.affiliates.detailFor(userId, aPaid[1]!);
      const payout = p.affiliates.markPaid(userId, a.id, body().reference);
      await p.email.send({ to: a.email, ...affiliatePaidEmail(a.name, `£${payout.amountGbp.toFixed(2)}`, payout.reference, `${base}/affiliate.html`, brandFrom(p.cfg)) }).catch((e) => console.error("affiliate email failed:", e));
      return json(200, { payout, ...overview() });
    }
    const aOne = /^\/api\/owner\/affiliates\/([\w-]{1,64})$/.exec(path);
    if (method === "GET" && aOne) return json(200, { affiliate: p.affiliates.detailFor(userId, aOne[1]!) });
    return json(404, { error: "not found" });
  }

  /** Prices and packages: the platform owner only. */
  async function ownerPriceRoutes(req: Req, userId: string, body: () => any): Promise<Res> {
    if (!p.isPlatformOwner(userId)) return json(403, { error: "only the MAIZ platform owner can change prices" });
    const { method, path } = req;
    if (method === "GET" && path === "/api/owner/prices") return json(200, p.prices.view(userId));
    if (method === "POST" && path === "/api/owner/prices/changes") {
      const c = p.prices.change(userId, body());
      // The price book keeps its own history (who, when, from, to); client audit logs are per workspace.
      return json(201, { change: c, ...p.prices.view(userId) });
    }
    const m = /^\/api\/owner\/prices\/changes\/([\w-]{1,64})$/.exec(path);
    if (method === "DELETE" && m) {
      p.prices.cancel(userId, m[1]!);
      return json(200, p.prices.view(userId));
    }
    return json(404, { error: "not found" });
  }

  async function integrationRoutes(req: Req, userId: string, orgId: string, body: () => any): Promise<Res | undefined> {
    const { method, path } = req;
    const ig = p.integrations;
    if (method === "GET" && path === "/api/integrations") {
      return json(200, { catalogue: ig.catalogue(), connections: ig.list(userId, orgId), pending: ig.pending(userId, orgId) });
    }
    if (method === "POST" && path === "/api/integrations/post") return json(200, ig.post(userId, orgId));
    const app = /^\/api\/integrations\/apps\/([a-z0-9-]{2,40})\/(connect|import)$/.exec(path);
    if (method === "POST" && app) {
      const [, key, action] = app as unknown as [string, string, string];
      const c = ig.registry.require(key);
      if (action === "import") {
        const b = body();
        if (typeof b.csv !== "string") throw new BadRequest("attach the exported file");
        return json(200, ig.importFile(userId, orgId, key, b.csv, { date: typeof b.date === "string" ? b.date : undefined }));
      }
      if (c.auth.kind === "oauth2") {
        // The nonce is also set as a cookie, so only the browser that started the connection can finish it.
        const nonce = randomBytes(16).toString("hex");
        const state = makeToken(secret, { k: "int-oauth", u: userId, a: key, n: nonce }, OAUTH_STATE_SECONDS, p.now().getTime());
        return { status: 200, body: { url: ig.authorizeUrl(userId, orgId, key, state) }, headers: { "set-cookie": oauthCookie(nonce, OAUTH_STATE_SECONDS, p.cfg.appUrl) } };
      }
      if (c.auth.kind === "api_key") return json(201, { connection: ig.connectWithKey(userId, orgId, key, body().values ?? {}) });
      if (c.auth.kind === "webhook") {
        const { connection, secret: hookSecret } = ig.createWebhook(userId, orgId);
        const base = (p.cfg.appUrl ?? "").replace(/\/$/, "");
        // Shown once. Only a hash is stored, so a lost link is replaced, not recovered.
        return json(201, { connection, url: `${base}/api/integrations/hooks/${connection.id}/${hookSecret}` });
      }
      throw new BadRequest(`${c.name} works by file upload`);
    }
    const conn = /^\/api\/integrations\/connections\/([\w-]{1,64})(?:\/(sync|access))?$/.exec(path);
    if (conn) {
      const [, id, action] = conn as unknown as [string, string, string | undefined];
      if (method === "DELETE" && !action) { ig.disconnect(userId, orgId, id); return json(200, { ok: true }); }
      if (method === "POST" && action === "sync") return json(200, await ig.sync(userId, orgId, id));
      if (method === "POST" && action === "access") {
        const b = body();
        if (!Array.isArray(b.employees)) throw new BadRequest("employees must be a list");
        return json(200, { connection: ig.setAccess(userId, orgId, id, b.employees) });
      }
    }
    return undefined;
  }

  /** Checks an ask and gathers what both ways of asking need. */
  function prepareAsk(userId: string, orgId: string, b: any) {
    const text = String(b.text ?? "").trim();
    if (!text) throw new BadRequest("say what you need");
    if (text.length > 4000) throw new BadRequest("that is too long");
    const emp = p.workforce.team(userId, orgId).find((e) => e.id === b.employeeId);
    if (!emp) throw new BadRequest("pick one of your employees");
    p.identity.require(userId, orgId, "task.create");
    const when: "now" | "tonight" | undefined = b.when === "now" || b.when === "tonight" ? b.when : undefined;
    return { text, emp, when, urgent: b.urgent === true, history: p.conversations.history(userId, orgId, emp.id) };
  }

  /** What the client sees of a finished ask, and the same turn saved to the conversation. */
  function answerBody(userId: string, orgId: string, a: ReturnType<typeof prepareAsk>, task: TaskResult) {
    // Plain words for anything that did not produce an answer, so the screen never shows a blank reply.
    const message = task.status === "no_energy" ? noEnergyMessage(task.reason) : task.status === "failed" ? ASK_FAILED_MESSAGE : undefined;
    const queuedText = "Queued. The answer will appear here when it is done.";
    const reply: Reply = task.status === "ready_for_review" && task.deliverable
      ? { text: task.deliverable, status: "answered", checked: task.checked }
      : task.status === "queued"
        ? { text: queuedText, status: "queued", jobId: task.jobId, runsAt: task.runsAt }
        : { text: message ?? "No answer this time.", status: task.status === "no_energy" ? "no_energy" : "failed" };
    p.conversations.record(userId, orgId, a.emp.id, a.text, reply);
    return { status: task.status, reason: task.reason, answer: task.deliverable, checked: task.checked === true, energyUsed: task.energyUsed, jobId: task.jobId, runsAt: task.runsAt, queueReason: task.queueReason, ...(message ? { message } : {}) };
  }

  return async function handle(req: Req): Promise<Res> {
    try {
      return renewed(req, await route(req));
    } catch (err) {
      if (err instanceof BadRequest || err instanceof SetupError || err instanceof SignupError || err instanceof LedgerError || err instanceof ChannelError || err instanceof IntegrationError || err instanceof ReviewError || err instanceof PeopleError || err instanceof PricingError || err instanceof PromoError || err instanceof PromoterError || err instanceof GrowthError || err instanceof EnergyError || err instanceof SettingsError || err instanceof BatchError || err instanceof PaymentError || err instanceof RotaError) return json(400, { error: err.message });
      if (err instanceof PermissionError) return json(403, { error: "you don't have permission to do that" });
      console.error(`${req.method} ${req.path} failed:`, err);
      return json(500, { error: "something went wrong" });
    }
  };
}

class BadRequest extends Error {}
