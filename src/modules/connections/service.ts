import type { Sink } from "../../core/persistence.js";
import { MetaGraph, MetaRejected, MetaUncertain, type MetaConfig } from "../meta/index.js";
import { normalizeNumber, WhatsAppError, type WhatsAppConfig } from "../whatsapp/index.js";
import type { OAuthApp } from "../integrations/index.js";
import { CATALOG, defOf, type ConnDef, type ConnKey, type GuideStep } from "./catalog.js";
import { probeApp, ProbeUnreachable, type ProbeKind } from "./probes.js";

/**
 * The platform owner's connections (Facebook, Instagram, WhatsApp, and the status of the server-set services).
 * Details typed on the Connections page are kept here and handed to the store, which encrypts them. Secrets are
 * never returned to the browser, never logged and never put in an error. Server environment variables still win:
 * when a group is set there, the page shows it as "set on the server" and cannot change it.
 */
export class ConnectionsError extends Error {}

export type Status = "connected" | "not_connected" | "error";
export interface TestResult { ok: boolean; message: string; details: string[]; at: string }
export interface FieldView { key: string; label: string; help: string; secret: boolean; required: boolean; placeholder?: string; generate?: boolean; set: boolean; value?: string; fallback?: string }
export interface ConnectionView {
  key: ConnKey; title: string; summary: string; group: ConnDef["group"]; usedBy: string[];
  /** The owner can type details here (false: set on the server, or a server-only service). */
  editable: boolean;
  status: Status;
  /** Where the working settings come from. */
  source: "browser" | "server" | "none";
  /** One plain sentence: what is connected, or what is still missing. */
  statusText: string;
  missing: string[];
  canTest: boolean;
  lastTest?: TestResult;
  fields: FieldView[];
  guide: GuideStep[];
  webhook?: { callbackUrl: string; verifyToken?: string; seenAt?: string };
  /** Addresses to paste into the provider's screens. */
  copies?: { label: string; value: string }[];
  clientsSee?: string;
}

/** The owner's WhatsApp line, as far as the Connections page needs it. */
export interface WhatsAppLine { phoneInfo(): Promise<{ number?: string; name?: string; quality?: string; nameStatus?: string }>; sendTest(): Promise<"text" | "template"> }

export interface ConnectionsOptions {
  now: () => Date;
  http?: typeof fetch;
  appUrl: string;
  /** Settings from server environment variables. A complete group here overrides what was typed on the page. */
  envMeta?: MetaConfig;
  envWhatsApp?: WhatsAppConfig;
  /** The server-set services' variables, only to say whether they are set and to run their test. Never shown. */
  env?: Record<string, string | undefined>;
  /** Called after a change, so the platform rebuilds its Facebook/Instagram client and WhatsApp line. */
  onChange?: () => void;
  /** The WhatsApp line now in use (from the server's settings or this page's). */
  whatsapp?: () => WhatsAppLine | undefined;
}

type Stored = Partial<Record<ConnKey, Record<string, string>>>;

/** "Continue with Google / Microsoft" apps, in the shape sign-in uses. */
export interface StoredLoginApps { google?: { clientId: string; clientSecret: string }; microsoft?: { clientId: string; clientSecret: string; tenant: string } }
export interface StoredSlackApp { clientId: string; clientSecret: string; signingSecret: string; redirectUri: string }

/**
 * The server variables behind each browser-editable platform card. When every required one is set on the server,
 * the server's values win and the card says so; otherwise what was typed on the page is used.
 */
const ENV: Partial<Record<ConnKey, { vars: Record<string, string>; required: string[]; extra?: string[] }>> = {
  resend: { vars: { apiKey: "RESEND_API_KEY", from: "EMAIL_FROM" }, required: ["apiKey", "from"] },
  google: { vars: { clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET" }, required: ["clientId", "clientSecret"] },
  microsoft: { vars: { clientId: "MICROSOFT_CLIENT_ID", clientSecret: "MICROSOFT_CLIENT_SECRET", tenant: "MICROSOFT_TENANT" }, required: ["clientId", "clientSecret"] },
  slack: { vars: { clientId: "SLACK_CLIENT_ID", clientSecret: "SLACK_CLIENT_SECRET", signingSecret: "SLACK_SIGNING_SECRET" }, required: ["clientId", "clientSecret", "signingSecret"], extra: ["SLACK_REDIRECT_URI"] },
  xero: { vars: { clientId: "XERO_CLIENT_ID", clientSecret: "XERO_CLIENT_SECRET" }, required: ["clientId", "clientSecret"] },
  square: { vars: { clientId: "SQUARE_CLIENT_ID", clientSecret: "SQUARE_CLIENT_SECRET" }, required: ["clientId", "clientSecret"] },
};
/** Secrets set only on the server, so a test message can never carry one back. */
const SERVER_SECRETS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RUNPOD_API_KEY", "ANTHROPIC_API_KEY"];
const PROBED: readonly ConnKey[] = ["google", "microsoft", "slack", "xero", "square"];
/** What each sign-in or client card says when it works, and when it does not. */
const APP_TEXT: Partial<Record<ConnKey, [string, string]>> = {
  google: ["Clients see a Continue with Google button.", "Not set: the Google button is hidden from sign-up and log-in."],
  microsoft: ["Clients see a Continue with Microsoft button.", "Not set: the Microsoft button is hidden from sign-up and log-in."],
  slack: ["Clients can add their AI team to Slack.", "Not set: clients cannot add Slack yet."],
  xero: ["Clients can connect Xero with one click.", "Not set: clients cannot connect Xero with one click yet."],
  square: ["Clients can connect Square with one click.", "Not set: clients cannot connect Square with one click yet."],
};

const TEST_GAP_MS = 2_000;
/** A real WhatsApp message each time: kept rare so a slip (or a stolen login) cannot spam the number. */
const SEND_GAP_MS = 30_000;
/** Removes every copy of each secret from a message before it is shown. */
const redact = (msg: string, ...secrets: (string | undefined)[]): string => secrets.reduce<string>((m, s) => (s && s.length >= 6 ? m.split(s).join("[key]") : m), msg);
const MAX_FIELD = 1_000;

/** Each field's shape, checked before anything is saved. The message says how to fix it. */
const RULES: Record<string, [RegExp, string]> = {
  accessToken: [/^[A-Za-z0-9_\-.|]{20,1000}$/, "That does not look like an access token. It is one long code with no spaces, usually starting EAA. Copy it again in full."],
  appSecret: [/^[A-Za-z0-9]{16,64}$/, "The app secret is a code of letters and numbers (usually 32). Copy it from App settings, Basic."],
  pageId: [/^\d{5,25}$/, "The Page ID is a number (only digits), not the Page's name or web address."],
  instagramId: [/^\d{5,25}$/, "The Instagram account ID is a long number, not the @username."],
  phoneNumberId: [/^\d{5,25}$/, "The Phone number ID is a long number from Meta's API Setup screen, not the phone number itself."],
  verifyToken: [/^[A-Za-z0-9._~-]{16,100}$/, "Use 16 to 100 letters and numbers, no spaces. Press Make one for me."],
  alertTemplate: [/^[a-z0-9_]{1,100}$/, "Template names are lower-case letters, numbers and underscores, for example maiz_owner_alert."],
  templateLanguage: [/^[a-z]{2,3}(_[A-Z]{2})?$/, "Use a language code such as en_GB or en_US."],
  clientSecret: [/^[\x21-\x7e]{8,300}$/, "The secret is one code with no spaces. Copy it again in full."],
  "resend.apiKey": [/^re_[A-Za-z0-9_]{8,200}$/, "A Resend key starts with re_ and has no spaces. Copy it again in full."],
  "resend.from": [/^(?:[\p{L}\p{N} .,'&()-]{1,80} <[^\s@<>]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}>|[^\s@<>]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24})$/u, "Write it as a name and an address, for example: MAIZ Agents <hello@maizagents.com>"],
  "google.clientId": [/^[\w-]{5,150}\.apps\.googleusercontent\.com$/, "A Google client ID ends in .apps.googleusercontent.com. Copy it again in full."],
  "microsoft.clientId": [/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i, "The Application (client) ID is a long id with dashes, from the app's Overview page."],
  "microsoft.tenant": [/^(common|organizations|consumers|[a-z0-9][a-z0-9.-]{0,79})$/i, "Leave it empty, or use common, organizations, consumers, or your tenant's id or domain."],
  "slack.clientId": [/^\d{4,20}\.\d{4,20}$/, "The Slack client ID is two numbers with a dot between them."],
  "slack.clientSecret": [/^[a-f0-9]{16,64}$/i, "The Slack client secret is a code of letters a to f and numbers. Press Show in App credentials and copy it again."],
  "slack.signingSecret": [/^[a-f0-9]{16,64}$/i, "The signing secret is a code of letters a to f and numbers. Press Show in App credentials and copy it again."],
  "xero.clientId": [/^[A-Za-z0-9]{20,64}$/, "The Xero client id is one code of letters and numbers, from the app's Configuration page."],
  "square.clientId": [/^(sandbox-)?sq0id[a-z]-[\w-]{8,100}$/, "The Square Application ID starts with sq0idp-. Copy it again in full."],
  "square.clientSecret": [/^(sandbox-)?sq0csp-[\w-]{8,200}$/, "The Square Application secret starts with sq0csp-. Press Show on the OAuth page and copy it again."],
};
const ruleFor = (key: string, field: string): [RegExp, string] | undefined => RULES[`${key}.${field}`] ?? RULES[field];

async function getJson(http: typeof fetch, url: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await http(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ConnectionsError("could not be reached. Try again in a minute.");
  }
  let json: any;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, json };
}

/** Meta's error, plus what to do about it in plain words. */
export function explainMeta(message: string): string {
  const hint =
    /expired/i.test(message) ? "The token has expired. Generate a new one with the expiry set to Never (Facebook card, step 4)."
    : /invalid oauth|malformed access token|invalid access token|cannot parse access token|error validating access token/i.test(message) ? "The access token is not right. Copy it again in full (Facebook card, step 4)."
    : /does not exist|missing permissions|unsupported get request|cannot be loaded/i.test(message) ? "Meta cannot see that ID with this token. Check the number, and that the Page or account is assigned to your system user with Full control (step 3)."
    : /permission|\(#200\)|\(#10\)/i.test(message) ? "The token is missing a permission. Generate it again with all the boxes in step 4 ticked."
    : "";
  return hint ? `${message} ${hint}` : message;
}

export class ConnectionsService {
  private stored: Stored = {};
  private tests = new Map<ConnKey, TestResult>();
  private lastRun = new Map<string, number>();
  private webhookSeenAt?: string;
  private sink?: Sink;

  constructor(private readonly isOwner: (userId: string) => boolean, private readonly opts: ConnectionsOptions) {}

  useSink(sink: Sink): void { this.sink = sink; }
  /** Stored details for one connection, as the store decrypted them. */
  restore(key: string, secret: string): void {
    if (!defOf(key)?.editable || !secret) return;
    try {
      const v = JSON.parse(secret);
      if (!v || typeof v !== "object") return;
      // Stored values are checked again: anything that would not be accepted today is dropped, not trusted.
      const known = new Set(defOf(key)!.fields.map((f) => f.key));
      const ok = (f: string, x: unknown): x is string => typeof x === "string" && known.has(f) && (f === "ownerNumber" ? !!normalizeNumber(x) : !ruleFor(key, f) || ruleFor(key, f)![0].test(x));
      this.stored[key as ConnKey] = Object.fromEntries(Object.entries(v).filter(([f, x]) => ok(f, x))) as Record<string, string>;
    } catch { /* an unreadable record is treated as not connected */ }
  }
  /** True when something is stored for this connection (used by tests and the platform). */
  hasStored(key: ConnKey): boolean { return !!this.stored[key] && Object.keys(this.stored[key]!).length > 0; }

  private require(userId: string): void {
    if (!this.isOwner(userId)) throw new ConnectionsError("only the MAIZ platform owner can manage connections");
  }
  private get http(): typeof fetch { return this.opts.http ?? fetch; }
  private env(k: string): string | undefined { return this.opts.env?.[k] || undefined; }
  private field(key: ConnKey, f: string): string | undefined { return this.stored[key]?.[f] || undefined; }

  // ------------------------------------------------------------ the settings the platform uses

  /** Facebook/Instagram settings now in force: the server's when set there, otherwise what was typed here. */
  metaConfig(): MetaConfig | undefined {
    if (this.opts.envMeta) return this.opts.envMeta;
    const accessToken = this.field("facebook", "accessToken");
    const pageId = this.field("facebook", "pageId");
    const instagramId = this.field("instagram", "instagramId");
    if (!accessToken || (!pageId && !instagramId)) return undefined;
    return { accessToken, pageId, instagramId, appSecret: this.field("facebook", "appSecret"), version: this.graphVersion() };
  }

  private graphVersion(): string | undefined { const v = this.env("META_GRAPH_VERSION"); return v && /^v\d{1,3}\.\d{1,2}$/.test(v) ? v : undefined; }

  /** WhatsApp settings now in force, or undefined until every part is there. */
  whatsappConfig(): WhatsAppConfig | undefined {
    if (this.opts.envWhatsApp) return this.opts.envWhatsApp;
    const w = (f: string) => this.field("whatsapp", f);
    const accessToken = w("accessToken") ?? this.field("facebook", "accessToken") ?? this.opts.envMeta?.accessToken;
    const appSecret = w("appSecret") ?? this.field("facebook", "appSecret") ?? this.opts.envMeta?.appSecret;
    const owner = normalizeNumber(w("ownerNumber") ?? "");
    const phoneNumberId = w("phoneNumberId"), verifyToken = w("verifyToken");
    if (!accessToken || !appSecret || !owner || !phoneNumberId || !verifyToken) return undefined;
    return { accessToken, appSecret, phoneNumberId, verifyToken, ownerNumber: owner, alertTemplate: { name: w("alertTemplate") ?? "maiz_owner_alert", language: w("templateLanguage") ?? "en_GB" }, version: this.graphVersion() };
  }

  /** True when every required server variable for this card is set, so the server's values are used. */
  private envSet(key: ConnKey): boolean {
    const e = ENV[key];
    return !!e && e.required.every((f) => this.env(e.vars[f]!)) && (e.extra ?? []).every((k) => this.env(k));
  }
  /** The values in force for an env-backed card: the server's when set there, otherwise the page's. */
  private values(key: ConnKey): Record<string, string | undefined> {
    const e = ENV[key];
    if (e && this.envSet(key)) return Object.fromEntries(Object.entries(e.vars).map(([f, k]) => [f, this.env(k)]));
    return { ...(this.stored[key] ?? {}) };
  }
  /** The values when every required field is there, otherwise undefined. */
  private complete(key: ConnKey): Record<string, string | undefined> | undefined {
    const v = this.values(key);
    return defOf(key)!.fields.filter((f) => f.required).every((f) => v[f.key]) ? v : undefined;
  }
  /** Typed on this page (the server's own settings are used directly by the platform). */
  private typed(key: ConnKey): Record<string, string> | undefined {
    return this.envSet(key) ? undefined : (this.complete(key) as Record<string, string> | undefined);
  }

  /** Email settings typed on this page, or undefined (then the server's, or the log, are used). */
  emailSettings(): { apiKey: string; from: string } | undefined {
    const v = this.typed("resend");
    return v ? { apiKey: v.apiKey!, from: v.from! } : undefined;
  }
  /** Sign-in apps typed on this page. */
  loginApps(): StoredLoginApps {
    const g = this.typed("google"), m = this.typed("microsoft");
    return {
      ...(g ? { google: { clientId: g.clientId!, clientSecret: g.clientSecret! } } : {}),
      ...(m ? { microsoft: { clientId: m.clientId!, clientSecret: m.clientSecret!, tenant: m.tenant || "common" } } : {}),
    };
  }
  /** The platform's Slack app as typed on this page. */
  slackApp(): StoredSlackApp | undefined {
    const v = this.typed("slack");
    return v ? { clientId: v.clientId!, clientSecret: v.clientSecret!, signingSecret: v.signingSecret!, redirectUri: `${this.base}/api/slack/callback` } : undefined;
  }
  /** Client connector apps (Xero, Square) typed on this page, by connector key. */
  integrationApps(): Record<string, OAuthApp> {
    const out: Record<string, OAuthApp> = Object.create(null);
    for (const k of ["xero", "square"] as const) {
      const v = this.typed(k);
      if (v) out[k] = { clientId: v.clientId!, clientSecret: v.clientSecret!, redirectUri: `${this.base}/api/integrations/callback` };
    }
    return out;
  }
  private get base(): string { return this.opts.appUrl.replace(/\/$/, ""); }

  /** Meta reached the webhook (a good handshake or a signed delivery). Shown on the WhatsApp card. */
  noteWebhook(): void { this.webhookSeenAt = this.opts.now().toISOString(); }

  // ------------------------------------------------------------ what the page shows

  private serverSet(key: ConnKey): boolean {
    if (key === "facebook" || key === "instagram") return !!this.opts.envMeta;
    if (key === "whatsapp") return !!this.opts.envWhatsApp;
    return this.envSet(key);
  }

  private configured(key: ConnKey): { ok: boolean; missing: string[]; text: string } {
    const v = this.env.bind(this);
    switch (key) {
      case "facebook": {
        const m = this.metaConfig();
        const missing = [...(m?.accessToken ? [] : ["Access token"]), ...(m?.pageId ? [] : ["Facebook Page ID"])];
        return { ok: !!m?.pageId, missing, text: m?.pageId ? `Page ${m.pageId} is set up for publishing.` : "Not connected yet." };
      }
      case "instagram": {
        const m = this.metaConfig();
        const token = !!(m?.accessToken ?? this.field("facebook", "accessToken"));
        const missing = [...(token ? [] : ["the access token on the Facebook Page card"]), ...(m?.instagramId ?? this.field("instagram", "instagramId") ? [] : ["Instagram account ID"])];
        return { ok: !!m?.instagramId, missing, text: m?.instagramId ? `Account ${m.instagramId} is set up for publishing.` : "Not connected yet." };
      }
      case "whatsapp": {
        const c = this.whatsappConfig();
        if (c) return { ok: true, missing: [], text: `Messages go to +${c.ownerNumber}.` };
        const w = (f: string) => this.field("whatsapp", f);
        const missing = [
          ...(w("phoneNumberId") ? [] : ["Phone number ID"]),
          ...(normalizeNumber(w("ownerNumber") ?? "") ? [] : ["Your own WhatsApp number"]),
          ...(w("verifyToken") ? [] : ["Webhook verify token"]),
          ...(w("accessToken") ?? this.field("facebook", "accessToken") ?? this.opts.envMeta?.accessToken ? [] : ["an access token (here or on the Facebook card)"]),
          ...(w("appSecret") ?? this.field("facebook", "appSecret") ?? this.opts.envMeta?.appSecret ? [] : ["the app secret (here or on the Facebook card)"]),
        ];
        return { ok: false, missing, text: "Not connected yet." };
      }
      case "resend": {
        const c = this.complete("resend");
        return { ok: !!c, missing: this.missingOf(key), text: c ? `Emails are sent from ${c.from!.slice(0, 120)}.` : "Not set: emails are only written to the server log." };
      }
      case "stripe": {
        const key = v("STRIPE_SECRET_KEY") ?? "";
        const ok = v("PAYMENTS_PROVIDER") === "stripe" && !!key;
        return { ok, missing: ok ? [] : ["PAYMENTS_PROVIDER=stripe and the Stripe keys on the server"], text: ok ? `Taking payments with a ${/_live_/.test(key) ? "LIVE" : "test"} key.` : "Not set: checkout is switched off." };
      }
      case "runpod": {
        const ok = !!(v("RUNPOD_API_KEY") && v("RUNPOD_ENDPOINT_ID"));
        return { ok, missing: ok ? [] : ["RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID on the server"], text: ok ? "The AI engine is set up." : "Not set: agents use Claude only, or example answers." };
      }
      case "anthropic": {
        const ok = !!v("ANTHROPIC_API_KEY");
        return { ok, missing: ok ? [] : ["ANTHROPIC_API_KEY on the server"], text: ok ? "Claude is set up." : "Not set: no quality checking by Claude." };
      }
      case "google": case "microsoft": case "slack": case "xero": case "square": {
        const ok = !!this.complete(key);
        return { ok, missing: this.missingOf(key), text: APP_TEXT[key]![ok ? 0 : 1] };
      }
    }
  }

  private missingOf(key: ConnKey): string[] {
    const v = this.values(key);
    return defOf(key)!.fields.filter((f) => f.required && !v[f.key]).map((f) => f.label);
  }

  private viewOf(def: ConnDef): ConnectionView {
    const c = this.configured(def.key);
    const server = this.serverSet(def.key);
    const last = this.tests.get(def.key);
    const status: Status = !c.ok ? "not_connected" : last && !last.ok ? "error" : "connected";
    const source = !c.ok && !this.hasStored(def.key) ? "none" : !def.editable || server ? (c.ok ? "server" : "none") : "browser";
    const fbToken = !!this.field("facebook", "accessToken") || !!this.opts.envMeta?.accessToken;
    const fbSecret = !!this.field("facebook", "appSecret") || !!this.opts.envMeta?.appSecret;
    const fields: FieldView[] = def.fields.map((f) => {
      const value = this.field(def.key, f.key);
      const fallback = def.key === "whatsapp" && !value && ((f.key === "accessToken" && fbToken) || (f.key === "appSecret" && fbSecret)) ? "Using the one from the Facebook Page card" : undefined;
      return { key: f.key, label: f.label, help: f.help, secret: f.secret, required: f.required, placeholder: f.placeholder, generate: f.generate, set: !!value, value: f.secret ? undefined : value, fallback };
    });
    const wa = def.key === "whatsapp" ? this.whatsappConfig() : undefined;
    return {
      key: def.key, title: def.title, summary: def.summary, group: def.group, usedBy: def.usedBy,
      editable: def.editable && !server, status, source,
      statusText: server && c.ok ? `${c.text} Set on the server, so it cannot be changed here.` : c.text,
      missing: c.missing,
      canTest: true,
      lastTest: last, fields, guide: def.guide,
      copies: def.copies?.map((c) => ({ label: c.label, value: `${this.base}${c.path}` })),
      clientsSee: def.clientsSee,
      webhook: def.key === "whatsapp" ? { callbackUrl: `${this.opts.appUrl.replace(/\/$/, "")}/api/whatsapp/webhook`, verifyToken: server ? undefined : (wa?.verifyToken ?? this.field("whatsapp", "verifyToken")), seenAt: this.webhookSeenAt } : undefined,
    };
  }

  list(userId: string): ConnectionView[] {
    this.require(userId);
    return CATALOG.map((d) => this.viewOf(d));
  }

  /** The connections an owner's agent depends on that are not working yet, for "connect" prompts on other pages. */
  needsFor(userId: string, agent: string): { key: ConnKey; title: string; status: Status }[] {
    this.require(userId);
    return CATALOG.filter((d) => d.usedBy.includes(agent)).map((d) => this.viewOf(d)).filter((v) => v.status !== "connected").map((v) => ({ key: v.key, title: v.title, status: v.status }));
  }

  /** Saves what the owner typed. An empty secret box keeps the saved secret; `clear` removes named fields. */
  save(userId: string, key: string, raw: unknown): ConnectionView {
    this.require(userId);
    const def = defOf(key);
    if (!def) throw new ConnectionsError("unknown connection");
    if (!def.editable) throw new ConnectionsError(`${def.title} is set on the server, not on this page`);
    if (this.serverSet(def.key)) throw new ConnectionsError(`${def.title} is set on the server, so it cannot be changed here. Remove the server setting first if you want to manage it on this page.`);
    const body = (raw ?? {}) as Record<string, unknown>;
    const input = (body.fields ?? {}) as Record<string, unknown>;
    const clear = Array.isArray(body.clear) ? body.clear.map(String) : [];
    const next: Record<string, string> = { ...(this.stored[def.key] ?? {}) };
    const problems: string[] = [];
    for (const f of def.fields) {
      if (clear.includes(f.key)) { delete next[f.key]; continue; }
      const v = input[f.key];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") { problems.push(`${f.label}: type it as text`); continue; }
      let s = v.trim();
      if (!s) { if (!f.secret) delete next[f.key]; continue; }
      if (s.length > MAX_FIELD) { problems.push(`${f.label}: too long`); continue; }
      if (f.key === "ownerNumber") {
        const n = normalizeNumber(s);
        if (!n) { problems.push(`${f.label}: use the full number with country code, for example +447700900123`); continue; }
        s = `+${n}`;
      } else if (f.key === "pageId" || f.key === "instagramId" || f.key === "phoneNumberId") {
        s = s.replace(/\s+/g, "");
      }
      const rule = ruleFor(def.key, f.key);
      if (rule && !rule[0].test(s)) { problems.push(`${f.label}: ${rule[1]}`); continue; }
      next[f.key] = s;
    }
    if (problems.length) throw new ConnectionsError(problems.join(" "));
    this.stored = { ...this.stored, [def.key]: next };
    this.tests.delete(def.key);
    // The Facebook token and app secret are shared with Instagram and WhatsApp, so their last tests are stale too.
    if (def.key === "facebook") { this.tests.delete("instagram"); this.tests.delete("whatsapp"); }
    this.sink?.connectionSecret(def.key, Object.keys(next).length ? JSON.stringify(next) : "");
    this.opts.onChange?.();
    return this.viewOf(def);
  }

  disconnect(userId: string, key: string): ConnectionView {
    this.require(userId);
    const def = defOf(key);
    if (!def?.editable) throw new ConnectionsError("this connection is set on the server, not on this page");
    if (this.serverSet(def.key)) throw new ConnectionsError(`${def.title} is set on the server, so it cannot be removed here`);
    const { [def.key]: _gone, ...rest } = this.stored;
    this.stored = rest;
    this.tests.delete(def.key);
    if (def.key === "facebook") { this.tests.delete("instagram"); this.tests.delete("whatsapp"); }
    this.sink?.connectionSecret(def.key, "");
    this.opts.onChange?.();
    return this.viewOf(def);
  }

  private throttle(what: string, gap = TEST_GAP_MS): void {
    const now = this.opts.now().getTime();
    const last = this.lastRun.get(what) ?? 0;
    if (now - last < gap) throw new ConnectionsError(gap > TEST_GAP_MS ? "a test message was sent less than 30 seconds ago. Check your phone, then try again" : "one moment: that test has just run");
    this.lastRun.set(what, now);
  }

  /** Makes one real, harmless call (a read, never a post or a payment) and says what it found. */
  async test(userId: string, key: string): Promise<ConnectionView> {
    this.require(userId);
    const def = defOf(key);
    if (!def) throw new ConnectionsError("unknown connection");
    this.throttle(`test:${def.key}`);
    let result: Omit<TestResult, "at">;
    try {
      result = await this.run(def.key);
    } catch (e) {
      // A test only reads, so "did it go out?" never applies: an unanswered call just means try again.
      const msg = e instanceof MetaUncertain ? "Meta could not be reached, or had a fault. Nothing was changed. Try again in a minute."
        : e instanceof MetaRejected ? explainMeta(e.message)
        : e instanceof WhatsAppError ? explainMeta(e.message)
        : e instanceof ConnectionsError || e instanceof ProbeUnreachable ? `${def.title} ${e.message}`
        : "The test failed unexpectedly. Nothing was changed.";
      if (!(e instanceof MetaRejected || e instanceof MetaUncertain || e instanceof WhatsAppError || e instanceof ConnectionsError || e instanceof ProbeUnreachable)) console.error("connection test failed:", def.key, e instanceof Error ? e.name : "error");
      result = { ok: false, message: msg, details: [] };
    }
    const secrets = this.allSecrets();
    result = { ...result, message: redact(result.message, ...secrets), details: result.details.map((d) => redact(d, ...secrets)) };
    this.tests.set(def.key, { ...result, at: this.opts.now().toISOString() });
    return this.viewOf(def);
  }

  /** Every secret this service knows, typed or from the server, so none can appear in a message. */
  private allSecrets(): string[] {
    const out: (string | undefined)[] = [];
    for (const d of CATALOG) for (const f of d.fields) if (f.secret) { out.push(this.field(d.key, f.key)); const k = ENV[d.key]?.vars[f.key]; if (k) out.push(this.env(k)); }
    for (const k of SERVER_SECRETS) out.push(this.env(k));
    const m = this.opts.envMeta, w = this.opts.envWhatsApp;
    out.push(m?.accessToken, m?.appSecret, w?.accessToken, w?.appSecret);
    return out.filter((x): x is string => !!x);
  }

  private notReady(def: ConnKey): Omit<TestResult, "at"> {
    const c = this.configured(def);
    return { ok: false, message: `Not connected yet. Still needed: ${c.missing.join(", ") || "the details above"}.`, details: [] };
  }

  private async run(key: ConnKey): Promise<Omit<TestResult, "at">> {
    switch (key) {
      case "facebook": {
        const cfg = this.metaConfig();
        if (!cfg?.pageId) return this.notReady(key);
        const g = new MetaGraph(cfg, this.http);
        const page = await g.lookup(cfg.pageId, "name");
        const scopes = await g.scopes();
        const want = ["pages_manage_posts", "pages_read_engagement"];
        const lacking = scopes ? want.filter((s) => !scopes.includes(s)) : [];
        return {
          ok: lacking.length === 0,
          message: lacking.length ? `Meta knows your Page "${String(page.name ?? cfg.pageId)}", but the token cannot publish yet: it is missing ${lacking.join(" and ")}. Generate the token again with those ticked (step 4).` : `Connected to the Facebook Page "${String(page.name ?? cfg.pageId)}".`,
          details: [scopes ? "Permissions checked with Meta." : "Meta did not list the token's permissions, so publishing rights could not be checked in advance. The first post will tell."],
        };
      }
      case "instagram": {
        const cfg = this.metaConfig();
        if (!cfg?.instagramId) return this.notReady(key);
        const g = new MetaGraph(cfg, this.http);
        const acc = await g.lookup(cfg.instagramId, "username");
        const scopes = await g.scopes();
        const lacking = scopes ? ["instagram_basic", "instagram_content_publish"].filter((s) => !scopes.includes(s)) : [];
        const who = acc.username ? `@${String(acc.username)}` : cfg.instagramId;
        return {
          ok: lacking.length === 0,
          message: lacking.length ? `Meta knows ${who}, but the token is missing ${lacking.join(" and ")}. Generate the Facebook token again with those ticked.` : `Connected to Instagram ${who}.`,
          details: [scopes ? "Permissions checked with Meta." : "Meta did not list the token's permissions, so publishing rights could not be checked in advance."],
        };
      }
      case "whatsapp": {
        const line = this.opts.whatsapp?.();
        if (!this.whatsappConfig() || !line) return this.notReady(key);
        const info = await line.phoneInfo();
        const details = [
          this.webhookSeenAt ? `Meta reached your webhook at ${new Date(this.webhookSeenAt).toLocaleString("en-GB", { timeZone: "Europe/London" })}.` : "Meta has not reached the webhook since the server last started. If you have not done step 7 yet, do it now; otherwise send \"hello\" from your phone and test again.",
          ...(info.quality ? [`Number quality: ${info.quality.toLowerCase()}.`] : []),
          ...(info.nameStatus && info.nameStatus !== "APPROVED" ? [`Display name status: ${info.nameStatus.toLowerCase().replace(/_/g, " ")}.`] : []),
        ];
        return { ok: true, message: `Connected to the WhatsApp business number ${info.number ?? ""}${info.name ? ` (${info.name})` : ""}.`.replace("  ", " "), details };
      }
      case "resend": {
        const c = this.complete("resend");
        const k = c?.apiKey, from = c?.from;
        if (!k || !from) return this.notReady(key);
        const r = await getJson(this.http, "https://api.resend.com/domains", { authorization: `Bearer ${k}` });
        const domain = /@([^>\s]+)>?\s*$/.exec(from)?.[1]?.toLowerCase();
        if (r.status === 401 && r.json?.name === "restricted_api_key") return { ok: true, message: "Resend accepted the key. It is a sending-only key, which is safest, so the domain could not be checked from here.", details: [`Check that ${domain ?? "your domain"} shows Verified at resend.com/domains.`] };
        if (r.status !== 200) return { ok: false, message: `Resend said no: ${redact(String(r.json?.message ?? `error ${r.status}`), k).slice(0, 200)}`, details: [] };
        const list: any[] = Array.isArray(r.json?.data) ? r.json.data : [];
        const d = list.find((x) => String(x?.name).toLowerCase() === domain);
        if (!d) return { ok: false, message: `Resend accepted the key, but ${domain ?? "the From domain"} is not added in Resend, so emails will be refused. Add and verify it at resend.com/domains.`, details: [] };
        return d.status === "verified"
          ? { ok: true, message: `Resend accepted the key and ${domain} is verified.`, details: [] }
          : { ok: false, message: `Resend accepted the key, but ${domain} is "${String(d.status)}", not verified. Add the DNS records Resend shows and press Verify there.`, details: [] };
      }
      case "stripe": {
        const k = this.env("STRIPE_SECRET_KEY");
        if (!k || this.env("PAYMENTS_PROVIDER") !== "stripe") return this.notReady(key);
        const r = await getJson(this.http, "https://api.stripe.com/v1/balance", { authorization: `Bearer ${k}` });
        const details = [this.env("STRIPE_WEBHOOK_SECRET") ? "The webhook secret is set." : "The webhook secret is missing: payments will not be confirmed."];
        if (r.status === 200) return { ok: true, message: `Stripe accepted the ${/_live_/.test(k) ? "LIVE" : "test"} key.`, details };
        if (r.status === 403) return { ok: true, message: "Stripe accepted the key. It is a restricted key without balance access, which is fine for taking payments.", details };
        return { ok: false, message: `Stripe said no: ${redact(String(r.json?.error?.message ?? `error ${r.status}`), k).slice(0, 200)}`, details };
      }
      case "runpod": {
        const k = this.env("RUNPOD_API_KEY"), id = this.env("RUNPOD_ENDPOINT_ID");
        if (!k || !id) return this.notReady(key);
        if (!/^[\w-]{1,64}$/.test(id)) return { ok: false, message: "RUNPOD_ENDPOINT_ID on the server does not look like an endpoint id.", details: [] };
        const r = await getJson(this.http, `https://api.runpod.ai/v2/${id}/health`, { authorization: `Bearer ${k}` });
        if (r.status !== 200) return { ok: false, message: `RunPod said no (error ${r.status}). Check the key and the endpoint id.`, details: [] };
        const w = r.json?.workers ?? {};
        return { ok: true, message: "The RunPod endpoint answered.", details: [`Workers ready: ${Number(w.ready ?? 0) + Number(w.idle ?? 0)}, busy: ${Number(w.running ?? 0)}. Asleep with none ready is normal: it wakes on the first job.`] };
      }
      case "anthropic": {
        const k = this.env("ANTHROPIC_API_KEY");
        if (!k) return this.notReady(key);
        const r = await getJson(this.http, "https://api.anthropic.com/v1/models?limit=1", { "x-api-key": k, "anthropic-version": "2023-06-01" });
        if (r.status === 200) return { ok: true, message: "Claude accepted the key.", details: [] };
        return { ok: false, message: `Anthropic said no: ${redact(String(r.json?.error?.message ?? `error ${r.status}`), k).slice(0, 200)}`, details: [] };
      }
      case "google": case "microsoft": case "slack": case "xero": case "square":
        return this.probe(key);
    }
  }

  /** Checks a sign-in app's keys with the provider, using a made-up code (see probes.ts). */
  private async probe(key: ConnKey & ProbeKind): Promise<Omit<TestResult, "at">> {
    const v = this.complete(key);
    if (!v) return this.notReady(key);
    const redirectUri = key === "slack" && this.envSet("slack") ? this.env("SLACK_REDIRECT_URI")! : `${this.base}${defOf(key)!.copies![0]!.path}`;
    let baseUrl: string | undefined;
    if (key === "square") {
      const b = this.env("SQUARE_BASE_URL");
      baseUrl = b && /^https:\/\/connect\.squareup(sandbox)?\.com$/.test(b) ? b : "https://connect.squareup.com";
      if (v.clientId!.startsWith("sandbox-") && !baseUrl.includes("sandbox")) return { ok: false, message: "That is a Sandbox application ID. Switch to Production at the top of the Square Developer page and copy the Production ID and secret.", details: [] };
    }
    const r = await probeApp(key, { clientId: v.clientId!, clientSecret: v.clientSecret!, redirectUri, tenant: v.tenant || undefined, baseUrl }, this.http);
    if (key === "slack" && r.ok) return { ...r, details: [...r.details, "The signing secret cannot be checked this way. Slack checks it when you turn on Event subscriptions (step 4): Verified there means it is right."] };
    return r;
  }

  /** Sends the owner one real WhatsApp message to prove the line works end to end. */
  async sendWhatsAppTest(userId: string): Promise<{ sent: "text" | "template"; message: string }> {
    this.require(userId);
    this.throttle("whatsapp-send", SEND_GAP_MS);
    const line = this.opts.whatsapp?.();
    if (!line) throw new ConnectionsError("WhatsApp is not connected yet: fill in the WhatsApp card and save it first");
    try {
      const sent = await line.sendTest();
      return { sent, message: sent === "text" ? "Sent. Check your phone." : "Sent using your approved template, because you have not written to the business number in the last 24 hours. Check your phone, and reply to open the conversation." };
    } catch (e) {
      if (!(e instanceof WhatsAppError)) console.error("whatsapp test failed:", e instanceof Error ? e.name : "error");
      const m = e instanceof WhatsAppError ? redact(e.message, this.whatsappConfig()?.accessToken, this.whatsappConfig()?.appSecret) : "The message could not be sent. Nothing else was changed.";
      const hint = /template|132001|132000|does not exist/i.test(m) ? " The alert template is probably not approved yet (WhatsApp card, step 6), or its name or language does not match."
        : /131030|not in allowed list|recipient/i.test(m) ? " In Development mode your number must be on the allowed list (step 8)." : "";
      throw new ConnectionsError(`${explainMeta(m)}${hint}`);
    }
  }
}
