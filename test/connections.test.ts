import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp, makeToken, type Req } from "../src/server/app.js";
import { userIdFor } from "../src/server/identity.js";
import { createPlatform } from "../src/server/platform.js";
import { explainMeta } from "../src/modules/connections/index.js";
import type { Snapshot } from "../src/core/persistence.js";

const OWNER = "atif@maiz.test";
const TOKEN = "EAAtesttoken1234567890";
const APP_SECRET = "0123456789abcdef0123456789abcdef";
const VERIFY = "verify-token-0123456789";
const now = new Date("2026-11-20T09:00:00Z");

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
type Answer = { status?: number; json?: unknown } | "drop";

function setup(opts: { answer?: (c: Call) => Answer; env?: Record<string, string>; meta?: boolean } = {}) {
  const calls: Call[] = [];
  const http = (async (url: any, init: any = {}) => {
    const c: Call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: String(init.body ?? "") };
    calls.push(c);
    const a = opts.answer?.(c) ?? { json: { id: "1" } };
    if (a === "drop") throw new Error("network down");
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 });
  }) as typeof fetch;
  const clock = { d: now };
  const platform = createPlatform({
    sessionSecret: "s3", allowDevAuth: true, platformOwners: [OWNER], appUrl: "https://maizagents.com", now: () => clock.d, http,
    connectionEnv: opts.env, meta: opts.meta ? { accessToken: "EAAfromserver1234567890", pageId: "2000002" } : undefined,
  });
  const app = createApp(platform);
  const owner = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor(OWNER), e: OWNER }, 86400, now.getTime())}` };
  const stranger = { authorization: `Bearer ${makeToken("s3", { k: "session", u: userIdFor("x@y.test"), e: "x@y.test" }, 86400, now.getTime())}` };
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = owner, query = "") =>
    app({ method, path, query: new URLSearchParams(query), headers, rawBody: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body) } as Req);
  const card = async (key: string) => ((await call("GET", "/api/owner/connections")).body as any).connections.find((c: any) => c.key === key);
  const tick = () => { clock.d = new Date(clock.d.getTime() + 5_000); };
  return { platform, call, owner, stranger, calls, card, clock, tick };
}

describe("Connections page API", () => {
  it("is for the platform owner only", async () => {
    const { call, stranger } = setup();
    expect((await call("GET", "/api/owner/connections", undefined, stranger)).status).toBe(403);
    expect((await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } }, stranger)).status).toBe(403);
    expect((await call("GET", "/api/owner/connections", undefined, {})).status).toBe(401);
  });

  it("lists every connection with a guide, and starts not connected", async () => {
    const { call } = setup();
    const r = await call("GET", "/api/owner/connections");
    const keys = (r.body as any).connections.map((c: any) => c.key);
    expect(keys).toEqual(["facebook", "instagram", "whatsapp", "resend", "google", "microsoft", "slack", "xero", "square", "stripe", "runpod", "anthropic"]);
    for (const c of (r.body as any).connections) { expect(c.guide.length).toBeGreaterThan(1); expect(c.status).toBe("not_connected"); }
    expect((r.body as any).persistent).toBe(false);
  });

  it("saves a token but never sends it back, and the promotion agent can publish at once", async () => {
    const { call, card, platform, calls } = setup({ answer: (c) => ({ json: c.url.includes("/feed") ? { id: "1000001_5" } : { id: "1" } }) });
    const save = await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001", appSecret: APP_SECRET } });
    expect(save.status).toBe(200);
    expect(JSON.stringify(save.body)).not.toContain(TOKEN);
    expect(JSON.stringify(save.body)).not.toContain(APP_SECRET);
    const fb = await card("facebook");
    expect(fb.status).toBe("connected");
    expect(fb.source).toBe("browser");
    expect(fb.fields.find((f: any) => f.key === "accessToken")).toMatchObject({ set: true, secret: true });
    expect(fb.fields.find((f: any) => f.key === "accessToken").value).toBeUndefined();
    expect(fb.fields.find((f: any) => f.key === "pageId").value).toBe("1000001");
    // No restart: the agent sees Facebook and publishes with the saved token.
    const ownerId = userIdFor(OWNER);
    expect(platform.promoter.channels(ownerId).facebook).toBe(true);
    const d = await platform.promoter.draft(ownerId, { site: "examutor", channel: "social", brief: "tip" });
    platform.promoter.decide(ownerId, d.id, true);
    const out = await platform.promoter.publishToMeta(ownerId, d.id, { target: "facebook" });
    expect(out.postedUrl).toBe("https://www.facebook.com/1000001_5");
    const post = calls.find((c) => c.url.includes("/feed"))!;
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.url).not.toContain(TOKEN);
    expect(post.body).toContain(`appsecret_proof=${createHmac("sha256", APP_SECRET).update(TOKEN).digest("hex")}`);
  });

  it("keeps a saved secret when its box is left empty, and refuses badly shaped values with how to fix them", async () => {
    const { call, card } = setup();
    await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } });
    await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: "", pageId: "1000002" } });
    const fb = await card("facebook");
    expect(fb.fields.find((f: any) => f.key === "accessToken").set).toBe(true);
    expect(fb.fields.find((f: any) => f.key === "pageId").value).toBe("1000002");
    const bad = await call("PUT", "/api/owner/connections/facebook", { fields: { pageId: "My Page" } });
    expect(bad.status).toBe(400);
    expect((bad.body as any).error).toMatch(/number/);
    expect((await call("PUT", "/api/owner/connections/whatsapp", { fields: { ownerNumber: "call me" } })).status).toBe(400);
    expect((await call("PUT", "/api/owner/connections/stripe", { fields: {} })).status).toBe(400);
    expect((await call("PUT", "/api/owner/connections/nothing", { fields: {} })).status).toBe(400);
  });

  it("tests Facebook with a harmless read and shows the Page's name", async () => {
    const { call, card, calls } = setup({ answer: (c) => ({ json: c.url.includes("/me/permissions") ? { data: [{ permission: "pages_manage_posts", status: "granted" }, { permission: "pages_read_engagement", status: "granted" }] } : { name: "Examutor", id: "1000001" } }) });
    await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } });
    await call("POST", "/api/owner/connections/facebook/test");
    const fb = await card("facebook");
    expect(fb.lastTest.ok).toBe(true);
    expect(fb.lastTest.message).toContain('"Examutor"');
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.every((c) => !c.url.includes(TOKEN))).toBe(true);
  });

  it("marks the card Error with a plain fix when Meta refuses, or the token lacks publishing rights", async () => {
    const refused = setup({ answer: () => ({ status: 400, json: { error: { message: "Error validating access token: Session has expired" } } }) });
    await refused.call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } });
    await refused.call("POST", "/api/owner/connections/facebook/test");
    const a = await refused.card("facebook");
    expect(a.status).toBe("error");
    expect(a.lastTest.message).toMatch(/Never/);
    const weak = setup({ answer: (c) => ({ json: c.url.includes("/me/permissions") ? { data: [{ permission: "pages_show_list", status: "granted" }] } : { name: "P" } }) });
    await weak.call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } });
    await weak.call("POST", "/api/owner/connections/facebook/test");
    const b = await weak.card("facebook");
    expect(b.status).toBe("error");
    expect(b.lastTest.message).toMatch(/pages_manage_posts/);
  });

  it("reuses the Facebook token for Instagram and tests the account", async () => {
    const { call, card } = setup({ answer: (c) => ({ json: c.url.includes("/me/permissions") ? { data: [] } : { username: "examutor" } }) });
    let ig = await card("instagram");
    expect(ig.missing.join(" ")).toMatch(/Facebook Page card/);
    await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN } });
    await call("PUT", "/api/owner/connections/instagram", { fields: { instagramId: "17841400000000000" } });
    ig = await card("instagram");
    expect(ig.status).toBe("connected");
    expect((await card("facebook")).status).toBe("not_connected"); // token alone, no Page
    await call("POST", "/api/owner/connections/instagram/test");
    ig = await card("instagram");
    expect(ig.status).toBe("error"); // Meta listed no instagram_content_publish permission
    expect(ig.lastTest.message).toMatch(/@examutor/);
  });

  it("connects WhatsApp from the page: webhook handshake, signed deliveries and a test message", async () => {
    const sent: any[] = [];
    const { call, card, platform } = setup({ answer: (c) => {
      if (c.url.endsWith("/messages")) { sent.push(JSON.parse(c.body)); return { json: { messages: [{ id: "wamid.1" }] } }; }
      return { json: { display_phone_number: "+44 20 0000 0000", verified_name: "MAIZ Agents", quality_rating: "GREEN" } };
    } });
    expect((await call("GET", "/api/whatsapp/webhook", undefined, {}, `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`)).status).toBe(503);
    await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001", appSecret: APP_SECRET } });
    await call("PUT", "/api/owner/connections/whatsapp", { fields: { phoneNumberId: "109876543210987", ownerNumber: "+44 7700 900123", verifyToken: VERIFY } });
    let wa = await card("whatsapp");
    expect(wa.status).toBe("connected");
    expect(wa.webhook.callbackUrl).toBe("https://maizagents.com/api/whatsapp/webhook");
    expect(wa.webhook.verifyToken).toBe(VERIFY);
    expect(wa.fields.find((f: any) => f.key === "accessToken").fallback).toMatch(/Facebook/);
    expect(wa.fields.find((f: any) => f.key === "ownerNumber").value).toBe("+447700900123");
    // Meta's handshake now works with the saved token, and is recorded.
    const hs = await call("GET", "/api/whatsapp/webhook", undefined, {}, `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=42`);
    expect(hs.status).toBe(200);
    expect(hs.text).toBe("42");
    expect((await card("whatsapp")).webhook.seenAt).toBeTruthy();
    // Deliveries are checked against the saved app secret.
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.in", from: "447700900123", type: "text", text: { body: "hello" } }] } }] }] });
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
    const del = await call("POST", "/api/whatsapp/webhook", raw, { "x-hub-signature-256": sig });
    expect(del.status).toBe(200);
    await del.after?.();
    expect(sent.at(-1).type).toBe("text");
    // The test button reads the number; the send-test button sends a real message (text: the window is open).
    await call("POST", "/api/owner/connections/whatsapp/test");
    wa = await card("whatsapp");
    expect(wa.lastTest.ok).toBe(true);
    expect(wa.lastTest.message).toContain("MAIZ Agents");
    const st = await call("POST", "/api/owner/connections/whatsapp/send-test");
    expect(st.status).toBe(200);
    expect((st.body as any).sent).toBe("text");
    expect(sent.at(-1).to).toBe("447700900123");
    expect(platform.ownerWhatsApp!.windowOpen()).toBe(true);
  });

  it("explains why a test message failed", async () => {
    const { call, tick } = setup({ answer: (c) => (c.url.endsWith("/messages") ? { status: 400, json: { error: { message: "(#132001) Template name does not exist in the translation" } } } : { json: {} }) });
    await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, appSecret: APP_SECRET } });
    await call("PUT", "/api/owner/connections/whatsapp", { fields: { phoneNumberId: "109876543210987", ownerNumber: "+447700900123", verifyToken: VERIFY } });
    tick();
    const r = await call("POST", "/api/owner/connections/whatsapp/send-test");
    expect(r.status).toBe(400);
    expect((r.body as any).error).toMatch(/template is probably not approved/);
  });

  it("disconnects, and the agent stops using it", async () => {
    const { call, card, platform } = setup();
    await call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } });
    await call("POST", "/api/owner/connections/facebook/disconnect");
    expect((await card("facebook")).status).toBe("not_connected");
    expect(platform.promoter.channels(userIdFor(OWNER)).facebook).toBe(false);
  });

  it("lets server settings win, and shows them as set on the server", async () => {
    const { call, card } = setup({ meta: true });
    const fb = await card("facebook");
    expect(fb.status).toBe("connected");
    expect(fb.source).toBe("server");
    expect(fb.editable).toBe(false);
    expect(JSON.stringify(fb)).not.toContain("EAAfromserver");
    expect((await call("PUT", "/api/owner/connections/facebook", { fields: { pageId: "1000001" } })).status).toBe(400);
  });

  it("tests the server-set services with harmless reads and never returns their keys", async () => {
    const env = { RESEND_API_KEY: "re_secret_123456", EMAIL_FROM: "MAIZ Agents <hello@maizagents.com>", PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "rk_live_abcdef", STRIPE_WEBHOOK_SECRET: "whsec_x", RUNPOD_API_KEY: "rp_key", RUNPOD_ENDPOINT_ID: "abc123", ANTHROPIC_API_KEY: "sk-ant-xyz" };
    const { call, card, calls, tick } = setup({ env, answer: (c) => {
      if (c.url.includes("resend.com")) return { json: { data: [{ name: "maizagents.com", status: "verified" }] } };
      if (c.url.includes("stripe.com")) return { json: { available: [] } };
      if (c.url.includes("runpod.ai")) return { json: { workers: { idle: 0, ready: 1, running: 0 } } };
      return { json: { data: [] } };
    } });
    for (const k of ["resend", "stripe", "runpod", "anthropic"]) { await call("POST", `/api/owner/connections/${k}/test`); tick(); }
    expect((await card("resend")).lastTest.message).toMatch(/maizagents.com is verified/);
    expect((await card("stripe")).lastTest.message).toMatch(/LIVE/);
    expect((await card("runpod")).lastTest.ok).toBe(true);
    expect((await card("anthropic")).lastTest.ok).toBe(true);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    const all = JSON.stringify((await call("GET", "/api/owner/connections")).body);
    for (const v of ["re_secret_123456", "rk_live_abcdef", "whsec_x", "rp_key", "sk-ant-xyz"]) expect(all).not.toContain(v);
    // Set on the server, so the page shows it but cannot change it.
    expect((await card("resend")).editable).toBe(false);
    expect((await call("PUT", "/api/owner/connections/resend", { fields: { from: "x@y.com" } })).status).toBe(400);
  });

  it("flags an unverified Resend domain", async () => {
    const { call, card } = setup({ env: { RESEND_API_KEY: "re_k", EMAIL_FROM: "hello@maizagents.com" }, answer: () => ({ json: { data: [{ name: "maizagents.com", status: "pending" }] } }) });
    await call("POST", "/api/owner/connections/resend/test");
    const r = await card("resend");
    expect(r.status).toBe("error");
    expect(r.lastTest.message).toMatch(/not verified/);
  });

  it("stores details encrypted through the store and restores them after a restart", async () => {
    const writes: [string, string][] = [];
    const store = new Proxy({} as any, {
      get: (_t, prop) => {
        if (prop === "load") return async () => ({ workspaces: [], memberships: [], employees: [], profiles: [], training: [], accounts: [], entries: [], usage: [], plans: [], audit: [], connections: [], links: [], adminOrgs: [], adminMessages: [], slackTokens: [] }) as Snapshot;
        if (prop === "flush") return async () => {};
        if (prop === "connectionSecret") return (k: string, s: string) => writes.push([k, s]);
        if (prop === "then") return undefined;
        return () => {};
      },
    });
    const a = setup();
    await a.platform.attachStore(store);
    await a.call("PUT", "/api/owner/connections/facebook", { fields: { accessToken: TOKEN, pageId: "1000001" } });
    expect(writes.at(-1)![0]).toBe("facebook");
    expect(JSON.parse(writes.at(-1)![1])).toMatchObject({ accessToken: TOKEN, pageId: "1000001" });
    expect(((await a.call("GET", "/api/owner/connections")).body as any).persistent).toBe(true);

    const restored = new Proxy(store, { get: (t, prop) => (prop === "load" ? async () => ({ ...(await t.load()), connectionSecrets: [{ key: "facebook", secret: writes.at(-1)![1] }] }) : t[prop]) });
    const b = setup();
    await b.platform.attachStore(restored);
    expect((await b.card("facebook")).status).toBe("connected");
    expect(b.platform.promoter.channels(userIdFor(OWNER)).facebook).toBe(true);
  });

  it("does not let tests be hammered", async () => {
    const { call } = setup({ env: { ANTHROPIC_API_KEY: "sk-ant-1" } });
    expect((await call("POST", "/api/owner/connections/anthropic/test")).status).toBe(200);
    expect((await call("POST", "/api/owner/connections/anthropic/test")).status).toBe(400);
  });
});

describe("explainMeta", () => {
  it("adds a plain next step to Meta's common errors", () => {
    expect(explainMeta("Meta said no: Invalid OAuth access token")).toMatch(/Copy it again/);
    expect(explainMeta("Meta said no: (#100) Object with ID '1' does not exist")).toMatch(/assigned to your system user/);
    expect(explainMeta("something else")).toBe("something else");
  });
});
