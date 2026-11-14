import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { createApp } from "./app.js";
import { checkEnv, integrationAppsFromEnv, metaFromEnv, platformOwnersFromEnv, whatsappFromEnv } from "./config.js";
import { loginAppsFromEnv } from "./social-login.js";
import { QueuedEmailSender, ResendEmailSender } from "./email.js";
import { MockPaymentProvider, StripePaymentProvider } from "../modules/payments/index.js";
import { createPlatform } from "./platform.js";
import { clientIp, limitFor, RateLimiter } from "./rate-limit.js";
import { createStatic } from "./static.js";

const env = process.env;
const production = env.NODE_ENV === "production";
const problems = checkEnv(env);
if (problems.length) {
  for (const p of problems) console.error(`config: ${p}`);
  process.exit(1);
}

// Queued: sent at Resend's pace with retries, so a burst of sign-ins does not lose emails to its rate limit.
const mailer = env.RESEND_API_KEY && env.EMAIL_FROM ? new QueuedEmailSender(new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM)) : undefined;
const platform = createPlatform({
  appUrl: env.APP_URL ?? "http://localhost:5173",
  supportEmail: env.SUPPORT_EMAIL || undefined,
  email: mailer,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  anthropicModel: env.ANTHROPIC_MODEL,
  runpod: env.RUNPOD_API_KEY && env.RUNPOD_ENDPOINT_ID ? { apiKey: env.RUNPOD_API_KEY, endpointId: env.RUNPOD_ENDPOINT_ID } : undefined,
  sessionSecret: env.SESSION_SECRET ?? randomBytes(32).toString("hex"),
  allowDevAuth: env.ALLOW_DEV_AUTH === "1",
  slack:
    env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET && env.SLACK_SIGNING_SECRET && env.SLACK_REDIRECT_URI
      ? { clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET, signingSecret: env.SLACK_SIGNING_SECRET, redirectUri: env.SLACK_REDIRECT_URI }
      : undefined,
  integrationApps: integrationAppsFromEnv(env, env.APP_URL ?? "http://localhost:5173"),
  loginApps: loginAppsFromEnv(env),
  platformOwners: platformOwnersFromEnv(env),
  meta: metaFromEnv(env),
  whatsapp: whatsappFromEnv(env),
  // Only to show the owner's Connections page whether each server-set service is set, and to test it. Never sent out.
  connectionEnv: Object.fromEntries(["RESEND_API_KEY", "EMAIL_FROM", "PAYMENTS_PROVIDER", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RUNPOD_API_KEY", "RUNPOD_ENDPOINT_ID", "ANTHROPIC_API_KEY", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET", "SLACK_REDIRECT_URI", "META_GRAPH_VERSION", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_TENANT", "XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "SQUARE_CLIENT_ID", "SQUARE_CLIENT_SECRET", "SQUARE_BASE_URL"].map((k) => [k, env[k]])),
  // The feature flag: unset means checkout is refused and nothing is charged. "mock" (development only) charges nobody.
  payments:
    env.PAYMENTS_PROVIDER === "mock" ? new MockPaymentProvider()
    : env.PAYMENTS_PROVIDER === "stripe" ? new StripePaymentProvider({ secretKey: env.STRIPE_SECRET_KEY!, webhookSecret: env.STRIPE_WEBHOOK_SECRET!, automaticTax: env.STRIPE_AUTOMATIC_TAX === "1", portalConfiguration: env.STRIPE_PORTAL_CONFIGURATION || undefined })
    : undefined,
});

let store: { close(): Promise<void> } | undefined;
if (env.DATABASE_URL) {
  const { PgStore } = await import("../storage/postgres.js");
  const pg = new PgStore({ adminUrl: env.DATABASE_URL, appUrl: env.DATABASE_APP_URL!, tokenKeyHex: env.TOKEN_KEY! });
  const applied = await pg.migrate();
  if (applied.length) console.log("applied migrations:", applied.join(", "));
  await platform.attachStore(pg);
  store = pg;
  console.log("storage: postgres");
} else {
  console.log("storage: memory (data resets on restart)");
}
if (!platform.payments.enabled) console.log("payments: not switched on (checkout is refused, nothing is charged)");
if (!platformOwnersFromEnv(env).length) console.log("quality review: no PLATFORM_OWNER_EMAILS, so specialised tasks wait with no reviewer");
if (!env.ANTHROPIC_API_KEY && !env.RUNPOD_API_KEY) console.log("ai: mock answers (neither ANTHROPIC_API_KEY nor RUNPOD_API_KEY is set)");
else console.log(`ai: ${env.RUNPOD_API_KEY ? "RunPod does the work" : "Claude only (no RunPod)"}${env.ANTHROPIC_API_KEY ? ", Claude supervises" : ", no Claude supervision"}`);

const handle = createApp(platform);
// One service serves the website and the API on the same address, so sign-in links, cookies-free
// bearer tokens and the website's CSP (connect-src 'self') all work without CORS.
const site = createStatic(env.WEB_DIST ?? join(import.meta.dirname, "../../web/dist"));
if (site) console.log("website: serving web/dist");
const limiter = new RateLimiter();
const trustProxy = env.TRUST_PROXY === "1" || production;
const API_HEADERS = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const MAX_BODY = 1_000_000;

const server = createServer(async (incoming, out) => {
  try {
    const url = new URL(incoming.url ?? "/", "http://localhost");
    const method = incoming.method ?? "GET";
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/r/")) {
      if (!site || (method !== "GET" && method !== "HEAD")) { out.writeHead(404, API_HEADERS).end(); return; }
      const f = site(url.pathname);
      out.writeHead(f.status, f.headers).end(method === "HEAD" ? undefined : f.body);
      return;
    }
    const ip = clientIp(incoming.headers as Record<string, string | undefined>, incoming.socket.remoteAddress, trustProxy);
    const limit = limitFor(method, url.pathname);
    if (limit && !limiter.allow(`${ip} ${url.pathname}`, limit)) {
      out.writeHead(429, { "content-type": "application/json", "Retry-After": "60", ...API_HEADERS }).end(JSON.stringify({ error: "too many requests, try again in a minute" }));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of incoming) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) { out.writeHead(413, API_HEADERS).end(); return; }
      chunks.push(c as Buffer);
    }
    const res = await handle({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: Object.fromEntries(Object.entries(incoming.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])),
      rawBody: Buffer.concat(chunks).toString("utf8"),
    });
    out.writeHead(res.status, { "content-type": "application/json", ...API_HEADERS, ...res.headers });
    if (res.stream) {
      // A live reply: each event is written as soon as it happens. If the person closes the page the work still finishes.
      const send = (event: string, data: unknown) => { if (!out.destroyed) out.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      await res.stream(send);
      out.end();
      if (res.after) res.after().catch((err) => console.error("background task failed:", err));
      return;
    }
    out.end(res.text !== undefined ? res.text : res.body === undefined ? undefined : JSON.stringify(res.body));
    if (res.after) res.after().catch((err) => console.error("background task failed:", err));
  } catch (err) {
    console.error("request failed:", err);
    if (!out.headersSent) out.writeHead(500, { "content-type": "application/json", ...API_HEADERS });
    out.end(JSON.stringify({ error: "something went wrong" }));
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
const port = Number(env.PORT ?? 8787);
server.listen(port, () => console.log(`listening on :${port}`));

// Once a minute: the batch dispatcher, and the nightly books check (each client once, after their own midnight).
// The batch dispatcher: once a minute, runs any client whose closing time has passed or whose queue is big enough.
const BATCH_TICK_MS = 60_000;
const batchTimer = setInterval(() => { void platform.batch.tick(); void platform.reconciliation.tick(); }, BATCH_TICK_MS);
batchTimer.unref();

// Hosts send SIGTERM before replacing the instance: stop taking requests and write pending changes to Postgres.
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  clearInterval(batchTimer);
  server.close();
  try { await store?.close(); } catch (err) { console.error("flush on shutdown failed:", err); }
  // Give waiting emails (sign-in links, owner alerts) a few seconds to go out.
  await Promise.race([Promise.all([mailer?.idle(), platform.email.idle()]), new Promise((r) => setTimeout(r, 5_000))]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => console.error("unhandled rejection:", err));
