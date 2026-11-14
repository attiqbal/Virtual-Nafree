import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { verdict } from "../src/modules/connections/probes.js";

// The platform's own keys (email, sign-in apps, Slack, Xero, Square) typed on the Connections page instead of SSH.
const OWNER = "atif@maiz.test";
const now = new Date("2026-11-20T09:00:00Z");
const RESEND_KEY = "re_typedkey_1234567890";
const GOOGLE = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-typedsecret123" };
const MS = { clientId: "1a2b3c4d-1111-2222-3333-444455556666", clientSecret: "ms~Secret.value_12345" };
const SLACK = { clientId: "1234567890.9876543210", clientSecret: "0123456789abcdef0123456789abcdef", signingSecret: "fedcba9876543210fedcba9876543210" };
const XERO = { clientId: "ABCDEF0123456789ABCDEF0123456789", clientSecret: "xero_secret_value_1234567890" };
const SQUARE = { clientId: "sq0idp-abcdefghijkl", clientSecret: "sq0csp-secretsecret123" };

interface Call { url: string; method: string; headers: Record<string, string>; body: string }

function setup(opts: { answer?: (c: Call) => { status?: number; json?: unknown }; env?: Record<string, string>; loginApps?: any } = {}) {
  const calls: Call[] = [];
  const http = (async (url: any, init: any = {}) => {
    const c: Call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: String(init.body ?? "") };
    calls.push(c);
    const a = opts.answer?.(c) ?? { json: {} };
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  const clock = { d: now };
  const platform = createPlatform({ sessionSecret: "s3", allowDevAuth: true, platformOwners: [OWNER], appUrl: "https://maizagents.com", now: () => clock.d, http, connectionEnv: opts.env, loginApps: opts.loginApps });
  const app = createApp(platform);
  const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 86400, now.getTime())}` };
  const call = (method: string, path: string, body?: unknown) =>
    app({ method, path, query: new URLSearchParams(), headers: owner, rawBody: body === undefined ? "" : JSON.stringify(body) } as Req);
  const card = async (key: string) => ((await call("GET", "/api/owner/connections")).body as any).connections.find((c: any) => c.key === key);
  const tick = () => { clock.d = new Date(clock.d.getTime() + 5_000); };
  return { platform, call, calls, card, tick };
}

describe("Platform keys typed on the Connections page", () => {
  it("sends email through Resend with the typed key at once, and never shows the key again", async () => {
    const { platform, call, calls, card } = setup();
    expect((await card("resend")).editable).toBe(true);
    const bad = await call("PUT", "/api/owner/connections/resend", { fields: { apiKey: "not a key", from: "hello" } });
    expect(bad.status).toBe(400);
    expect((bad.body as any).error).toMatch(/re_/);
    const r = await call("PUT", "/api/owner/connections/resend", { fields: { apiKey: RESEND_KEY, from: "MAIZ Agents <hello@maizagents.com>" } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain(RESEND_KEY);
    const c = await card("resend");
    expect(c.status).toBe("connected");
    expect(c.statusText).toMatch(/hello@maizagents.com/);
    await platform.email.send({ to: "client@example.com", subject: "Hi", text: "Hello" });
    await platform.email.idle();
    const sent = calls.find((x) => x.url === "https://api.resend.com/emails");
    expect(sent?.headers.authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(JSON.parse(sent!.body).from).toBe("MAIZ Agents <hello@maizagents.com>");
  });

  it("refuses a From address that could smuggle in extra mail headers", async () => {
    const { call } = setup();
    expect((await call("PUT", "/api/owner/connections/resend", { fields: { apiKey: RESEND_KEY, from: "A <a@b.com>\r\nBcc: x@y.com" } })).status).toBe(400);
  });

  it("switches on Continue with Google as soon as it is saved, and tests it with a made-up code", async () => {
    const { call, calls, card } = setup({ answer: (c) => (c.url.includes("oauth2.googleapis.com") ? { status: 400, json: { error: "invalid_grant", error_description: "Bad Request" } } : { json: {} }) });
    expect(((await call("GET", "/api/signin/providers")).body as any).providers).toEqual([]);
    expect((await call("PUT", "/api/owner/connections/google", { fields: { clientId: "my app", clientSecret: "x" } })).status).toBe(400);
    expect((await call("PUT", "/api/owner/connections/google", { fields: GOOGLE })).status).toBe(200);
    expect(((await call("GET", "/api/signin/providers")).body as any).providers).toEqual(["google"]);
    const start = await call("GET", "/api/signin/oauth/google/start");
    expect(start.status).toBe(302);
    expect(String((start.headers as any).location)).toContain(encodeURIComponent(GOOGLE.clientId));
    const g = await card("google");
    expect(g.copies[0].value).toBe("https://maizagents.com/api/signin/oauth/google/callback");
    await call("POST", "/api/owner/connections/google/test");
    const t = (await card("google")).lastTest;
    expect(t.ok).toBe(true);
    expect(t.details.join(" ")).toMatch(/made-up/);
    const probe = calls.find((c) => c.url.includes("oauth2.googleapis.com"))!;
    expect(probe.method).toBe("POST");
    expect(probe.body).toContain("maiz-connection-test");
    expect(JSON.stringify(await card("google"))).not.toContain(GOOGLE.clientSecret);
  });

  it("tells the owner when Microsoft does not accept the secret", async () => {
    const { call, card, calls } = setup({ answer: () => ({ status: 401, json: { error: "invalid_client", error_description: `AADSTS7000215: Invalid client secret provided. ${MS.clientSecret}`, error_codes: [7000215] } }) });
    await call("PUT", "/api/owner/connections/microsoft", { fields: { ...MS, tenant: "" } });
    await call("POST", "/api/owner/connections/microsoft/test");
    const asked = calls.find((c) => c.url.includes("login.microsoftonline.com"))!;
    expect(asked.url).toContain("/consumers/");
    expect(asked.body).toContain("grant_type=client_credentials");
    const m = await card("microsoft");
    expect(m.status).toBe("error");
    expect(m.lastTest.message).toMatch(/does not accept/);
    expect(JSON.stringify(m)).not.toContain(MS.clientSecret);
    expect(((await call("GET", "/api/signin/providers")).body as any).providers).toEqual(["microsoft"]);
  });

  it("server sign-in settings win over typed ones", async () => {
    const { call, card } = setup({ env: { GOOGLE_CLIENT_ID: "env.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "env-secret" }, loginApps: { google: { clientId: "env.apps.googleusercontent.com", clientSecret: "env-secret" } } });
    const g = await card("google");
    expect(g.editable).toBe(false);
    expect(g.source).toBe("server");
    expect(JSON.stringify(g)).not.toContain("env-secret");
    expect((await call("PUT", "/api/owner/connections/google", { fields: GOOGLE })).status).toBe(400);
  });

  it("makes the Slack app live for clients without a restart", async () => {
    const { platform, call, card, calls } = setup({ answer: (c) => (c.url.includes("slack.com/api/oauth.v2.access") ? { json: { ok: false, error: "invalid_code" } } : { json: {} }) });
    expect(platform.cfg.slack).toBeUndefined();
    await call("PUT", "/api/owner/connections/slack", { fields: SLACK });
    expect(platform.cfg.slack).toEqual({ ...SLACK, redirectUri: "https://maizagents.com/api/slack/callback" });
    const s = await card("slack");
    expect(s.copies.map((c: any) => c.value)).toEqual(["https://maizagents.com/api/slack/callback", "https://maizagents.com/api/slack/events"]);
    await call("POST", "/api/owner/connections/slack/test");
    const t = (await card("slack")).lastTest;
    expect(t.ok).toBe(true);
    expect(t.details.join(" ")).toMatch(/signing secret/);
    expect(calls.some((c) => c.url.includes("chat.postMessage"))).toBe(false);
  });

  it("lets clients connect Xero and Square with one click once their apps are saved", async () => {
    const { platform, call, card, tick } = setup({ answer: (c) => (c.url.includes("identity.xero.com") ? { status: 400, json: { error: "invalid_client" } } : { json: {} }) });
    const mode = (k: string) => platform.integrations.catalogue().find((c) => c.key === k)!.connect;
    expect(mode("xero")).not.toBe("oauth");
    await call("PUT", "/api/owner/connections/xero", { fields: XERO });
    await call("PUT", "/api/owner/connections/square", { fields: SQUARE });
    expect(mode("xero")).toBe("oauth");
    expect(mode("square")).toBe("oauth");
    await call("POST", "/api/owner/connections/xero/test");
    tick();
    expect((await card("xero")).lastTest.message).toMatch(/does not accept/);
    await call("POST", "/api/owner/connections/xero/disconnect");
    expect(mode("xero")).not.toBe("oauth");
  });

  it("spots a Square Sandbox ID before asking Square", async () => {
    const { call, card, calls } = setup();
    await call("PUT", "/api/owner/connections/square", { fields: { clientId: "sandbox-sq0idb-abcdefghijkl", clientSecret: "sandbox-sq0csp-secret12345" } });
    await call("POST", "/api/owner/connections/square/test");
    expect((await card("square")).lastTest.message).toMatch(/Sandbox/);
    expect(calls.some((c) => c.url.includes("squareup"))).toBe(false);
  });

  it("reads each provider's answer to a made-up code", () => {
    expect(verdict("google", 401, { error: "invalid_client" }).v).toBe("bad_keys");
    expect(verdict("google", 400, { error: "redirect_uri_mismatch" }).v).toBe("redirect");
    // Real answers from Microsoft (2026-11-14) to an app-only token request with a made-up app id.
    expect(verdict("microsoft", 400, { error: "unauthorized_client", error_description: "AADSTS700016: Application with identifier 'x' was not found in the directory." }).v).toBe("bad_app");
    expect(verdict("microsoft", 401, { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }).v).toBe("bad_keys");
    expect(verdict("microsoft", 400, { error: "unauthorized_client", error_description: "AADSTS700230: something after the app was found." }).v).toBe("app_known");
    expect(verdict("microsoft", 200, { access_token: "t" }).v).toBe("keys_ok");
    expect(verdict("microsoft", 400, { error: "invalid_request", error_description: "AADSTS90002: Tenant 'x' not found." }).v).toBe("bad_tenant");
    expect(verdict("slack", 200, { ok: false, error: "bad_client_secret" }).v).toBe("bad_keys");
    expect(verdict("xero", 400, { error: "invalid_grant" }).v).toBe("keys_ok");
    expect(verdict("square", 401, { errors: [{ code: "UNAUTHORIZED" }] }).v).toBe("bad_keys");
    expect(verdict("square", 400, { errors: [{ code: "INVALID_REQUEST_ERROR" }] }).v).toBe("keys_ok");
    expect(verdict("google", 500, {}).v).toBe("unknown");
  });
});
