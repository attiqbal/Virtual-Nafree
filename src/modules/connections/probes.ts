/**
 * Harmless checks for the sign-in apps (Google, Microsoft, Slack, Xero, Square). None of them has a free "who am
 * I" call for an app's own keys, so each test trades a made-up sign-in code at the provider's token address. The
 * provider looks at the app's keys before the code: "unknown app" or "wrong secret" means the keys are wrong, and
 * "that code is not valid" means it knows the app and accepted the secret. Nothing is created, installed or connected.
 *
 * Microsoft is different: it rejects a made-up code before it looks at the app (checked live 2026-11-14), so its
 * test asks for an app-only token instead, which names the app first. A token with no permissions is harmless.
 * Google was checked live with made-up keys (it answers invalid_client). Slack, Xero and Square follow their
 * documented error codes and have not been run live from this server.
 */
export interface ProbeResult { ok: boolean; message: string; details: string[] }
export interface ProbeApp { clientId: string; clientSecret: string; redirectUri: string; tenant?: string; baseUrl?: string }
export type ProbeKind = "google" | "microsoft" | "slack" | "xero" | "square";

const MADE_UP_CODE = "maiz-connection-test";
const TIMEOUT_MS = 15_000;
const NAMES: Record<ProbeKind, string> = { google: "Google", microsoft: "Microsoft", slack: "Slack", xero: "Xero", square: "Square" };

export class ProbeUnreachable extends Error {}

async function post(http: typeof fetch, url: string, init: { body: string; headers: Record<string, string> }): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    // No redirects: the secret must only ever go to the provider's own token address.
    res = await http(url, { method: "POST", redirect: "error", body: init.body, headers: init.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProbeUnreachable("could not be reached. Try again in a minute.");
  }
  let json: any;
  try { json = await res.json(); } catch { json = undefined; }
  return { status: res.status, json };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
/** A provider's error code, only when it looks like one (never free text that could carry a secret back). */
const code = (v: unknown): string => (typeof v === "string" && /^[\w.:-]{1,80}$/.test(v) ? v : "");

async function ask(kind: ProbeKind, app: ProbeApp, http: typeof fetch): Promise<{ status: number; json: any }> {
  const common = { code: MADE_UP_CODE, redirect_uri: app.redirectUri, grant_type: "authorization_code" };
  switch (kind) {
    case "google":
      return post(http, "https://oauth2.googleapis.com/token", { headers: FORM, body: form({ ...common, client_id: app.clientId, client_secret: app.clientSecret }) });
    case "microsoft": {
      // "common" and "organizations" do not issue app-only tokens; the personal-accounts tenant does look the app up.
      const t = !app.tenant || /^(common|organizations|consumers)$/i.test(app.tenant) ? "consumers" : app.tenant;
      return post(http, `https://login.microsoftonline.com/${encodeURIComponent(t)}/oauth2/v2.0/token`, { headers: FORM, body: form({ grant_type: "client_credentials", client_id: app.clientId, client_secret: app.clientSecret, scope: "https://graph.microsoft.com/.default" }) });
    }
    case "slack":
      return post(http, "https://slack.com/api/oauth.v2.access", { headers: FORM, body: form({ code: MADE_UP_CODE, redirect_uri: app.redirectUri, client_id: app.clientId, client_secret: app.clientSecret }) });
    case "xero":
      return post(http, "https://identity.xero.com/connect/token", { headers: { ...FORM, authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}` }, body: form(common) });
    case "square":
      return post(http, `${app.baseUrl ?? "https://connect.squareup.com"}/oauth2/token`, { headers: { "content-type": "application/json", accept: "application/json", "square-version": "2025-01-23" }, body: JSON.stringify({ ...common, client_id: app.clientId, client_secret: app.clientSecret }) });
  }
}

type Verdict = "bad_keys" | "bad_app" | "bad_tenant" | "redirect" | "keys_ok" | "app_known" | "unknown";

/** Reads the provider's answer to a made-up code. Exported for tests. */
export function verdict(kind: ProbeKind, status: number, json: any): { v: Verdict; code: string } {
  const err = code(json?.error), desc = typeof json?.error_description === "string" ? json.error_description : "";
  const aad = /AADSTS(\d+)/.exec(desc)?.[1] ?? (Array.isArray(json?.error_codes) ? String(json.error_codes[0] ?? "") : "");
  switch (kind) {
    case "google":
      if (err === "invalid_client" || err === "unauthorized_client") return { v: "bad_keys", code: err };
      if (err === "redirect_uri_mismatch") return { v: "redirect", code: err };
      if (err === "invalid_grant") return { v: "keys_ok", code: err };
      break;
    case "microsoft":
      if (status === 200 && json?.access_token) return { v: "keys_ok", code: "" };
      if (aad === "90002" || aad === "900023") return { v: "bad_tenant", code: `AADSTS${aad}` };
      if (aad === "700016") return { v: "bad_app", code: `AADSTS${aad}` };
      if (["7000215", "7000222", "7000218"].includes(aad) || err === "invalid_client") return { v: "bad_keys", code: aad ? `AADSTS${aad}` : err };
      // Any other Microsoft code comes after it found the app; the secret is proved on the first real sign-in.
      if (aad) return { v: "app_known", code: `AADSTS${aad}` };
      break;
    case "slack":
      if (["invalid_client_id", "bad_client_secret", "invalid_client"].includes(err)) return { v: "bad_keys", code: err };
      if (err === "bad_redirect_uri") return { v: "redirect", code: err };
      if (err === "invalid_code" || err === "code_already_used") return { v: "keys_ok", code: err };
      break;
    case "xero":
      if (err === "invalid_client" || err === "unauthorized_client" || status === 401) return { v: "bad_keys", code: err || String(status) };
      if (err === "invalid_grant") return { v: "keys_ok", code: err };
      break;
    case "square": {
      const sq = Array.isArray(json?.errors) ? json.errors.map((e: any) => code(e?.code)).filter(Boolean) : [];
      const first = sq[0] ?? code(json?.type) ?? "";
      if (status === 401 || sq.some((c: string) => /UNAUTHORIZED|INVALID_CLIENT|ACCESS_TOKEN|FORBIDDEN/.test(c))) return { v: "bad_keys", code: first || String(status) };
      if (status === 400 && sq.some((c: string) => /INVALID|BAD_REQUEST|NOT_FOUND/.test(c))) return { v: "keys_ok", code: first };
      break;
    }
  }
  return { v: "unknown", code: err || (aad ? `AADSTS${aad}` : String(status)) };
}

const MADE_UP = "This test sent a made-up sign-in code, so nothing was created, installed or connected.";
const MADE_UP_MS = "This test asked Microsoft for a token with no permissions, so nothing was created, installed or connected.";

/** Asks the provider about the app and says, in plain words, what it found. */
export async function probeApp(kind: ProbeKind, app: ProbeApp, http: typeof fetch): Promise<ProbeResult> {
  const name = NAMES[kind];
  const r = await ask(kind, app, http);
  const { v, code: c } = verdict(kind, r.status, r.json);
  const ref = c ? ` (${name} said ${c})` : "";
  const note = kind === "microsoft" ? MADE_UP_MS : MADE_UP;
  switch (v) {
    case "keys_ok":
      return { ok: true, message: `${name} knows your app and accepted the secret.`, details: [note, `Make sure the redirect address in the box above is saved in ${name}, then try it once yourself.`] };
    case "bad_keys":
      return { ok: false, message: `${name} does not accept these details${ref}. Copy the client ID and secret again; a secret is often only shown once, so make a new one if you need to.`, details: [note] };
    case "bad_app":
      return { ok: false, message: `Microsoft does not know that Application ID for personal accounts${ref}. Check the ID, and that Supported account types includes personal Microsoft accounts (step 1).`, details: [MADE_UP_MS] };
    case "app_known":
      return { ok: true, message: `Microsoft knows your app${ref}. It does not say whether the secret is right without a real sign-in, so try Continue with Microsoft once yourself.`, details: [MADE_UP_MS] };
    case "bad_tenant":
      return { ok: false, message: `Microsoft does not know that tenant${ref}. Leave "Who can sign in" empty to allow any Microsoft account.`, details: [note] };
    case "redirect":
      return { ok: false, message: `${name} knows your app, but the redirect address is not saved there yet${ref}. Paste the address from the box above into ${name}'s app settings.`, details: [MADE_UP] };
    default:
      return { ok: false, message: `${name} answered in a way this test does not recognise${ref}, so it could not tell whether the details are right.`, details: [note, "Try signing in or connecting once yourself to be sure."] };
  }
}
