import { chromium, devices } from "playwright";
// End-to-end flows against a running server: ALLOW_DEV_AUTH=1 PLATFORM_OWNER_EMAILS=owner@maiz.test npm start > api.log, then QA_URL=http://localhost:8787 QA_SERVER_LOG=api.log npm run qa:flows
const B = process.env.QA_URL ?? "http://localhost:8787";
const b = await chromium.launch();
const res = []; const ok = (n, c, d = "") => { res.push([c ? "PASS" : "FAIL", n, d]); };
const errs = [];
const mk = async (opts = {}) => { const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, ...opts }); const p = await ctx.newPage(); p.on("pageerror", e => errs.push(String(e))); if (process.env.QA_DEBUG) p.on("response", r => { if (r.status() >= 400) console.log("HTTP", r.status(), r.url()); }); p.on("console", m => { if (m.type() === "error" && !(p.url().includes("/signin.html") && m.text().includes("400")) && !(p.url().includes("/onboarding.html") && m.text().includes("404")) /* signed in, no team yet: /api/org says 404 */ && !(/\/(review|owner-[a-z]+)\.html/.test(p.url()) && m.text().includes("403"))) errs.push(p.url() + " " + m.text()); }); return p; };

// 1. Link check: every internal link and anchor on every page
{
  const p = await mk(); const seen = new Map();
  const pages = ["/", "/employees.html", "/pricing.html", "/security.html", "/signin.html", "/onboarding.html", "/app.html", "/review.html", "/owner-decisions.html", "/owner-specialists.html", "/owner-clients.html", "/owner-prices.html", "/owner-promotions.html", "/owner-promoter.html", "/owner-growth.html", "/owner-team.html", "/owner-connections.html", "/affiliate.html", "/owner-ai.html", "/404.html"];
  let broken = [];
  for (const pg of pages) {
    await p.goto(B + pg, { waitUntil: "networkidle" });
    const links = await p.$$eval("a[href]", as => as.map(a => a.getAttribute("href")));
    for (const h of new Set(links)) {
      if (/^(mailto:|https?:)/.test(h)) continue;
      const u = new URL(h, B + pg); const key = u.pathname + u.hash;
      if (!seen.has(key)) {
        const r = await p.request.get(u.origin + u.pathname); let good = r.ok();
        if (good && u.hash && !u.pathname.startsWith("/app")) { const html = await r.text(); good = new RegExp(`id="${u.hash.slice(1)}"`).test(html); }
        if (good && u.hash && u.pathname.startsWith("/app") && u.hash !== "#main") { // #main is the skip link target, not a screen
          const html = await r.text(); good = new RegExp(`data-screen="${u.hash.slice(1).split("/")[0]}"`).test(html); } // #desk/<key> opens one employee's dashboard on the desk screen
        seen.set(key, good);
      }
      if (!seen.get(key)) broken.push(pg + " -> " + h);
    }
  }
  ok("links: all internal links and anchors resolve", broken.length === 0, `${seen.size} unique; broken: ${broken.join(", ")}`);
  const r404 = await p.request.get(B + "/nope-page"); ok("unknown page returns 404 page", r404.status() === 404 && (await r404.text()).includes("can't find"), String(r404.status()));
  for (const f of ["/robots.txt", "/sitemap.xml", "/favicon.svg", "/og.png"]) ok("serves " + f, (await p.request.get(B + f)).ok());
  const h = (await p.request.get(B + "/")).headers();
  ok("security headers present", !!h["content-security-policy"] && !!h["x-content-type-options"], Object.keys(h).filter(k => /content-security|x-frame|x-content|referrer|strict|permissions/.test(k)).join(","));
  await p.context().close();
}
// 2. Onboarding -> control center (real API, dev sign-in)
{
  const p = await mk();
  await p.goto(B + "/onboarding.html", { waitUntil: "networkidle" });
  await p.click("#biz-go"); ok("onboarding: no sector or name shows error", await p.isVisible("#biz-err"));
  await p.click('#sectors [data-v="food-drink"]'); await p.fill("#biz", "Example Bakery"); await p.selectOption("#country", "GB"); await p.click("#biz-go");
  ok("onboarding: needs are ticked for the sector", (await p.locator('#needs .chip[aria-pressed="true"]').count()) === 3);
  await p.reload({ waitUntil: "networkidle" });
  ok("onboarding: a refresh keeps your place (step 2)", await p.isVisible('[data-step="2"]'));
  await p.goBack({ waitUntil: "networkidle" }).catch(() => {}); await p.waitForTimeout(200);
  ok("onboarding: browser Back goes to the previous step", await p.isVisible('[data-step="1"]'), p.url());
  await p.goForward({ waitUntil: "networkidle" }).catch(() => {}); await p.waitForTimeout(200);
  await p.click('#needs [data-v="stock"]'); await p.click("#needs-go");
  ok("onboarding: sector apps offered", await p.isVisible('#apps [data-v="square"]'));
  await p.click('#apps [data-v="square"]'); await p.click("#apps-go");
  ok("onboarding: plan leads with the Finance manager", (await p.textContent("#plan-focus .team-row b")) === "Finance manager", await p.textContent("#plan-focus"));
  ok("onboarding: plan offers the stock manager and lists Square", await p.isVisible('[data-addon="supply-chain-manager"]') && (await p.textContent("#plan-apps")).includes("Square"));
  await p.click("#email-go"); ok("onboarding: invalid email shows error", await p.isVisible("#email-err"));
  await p.fill("#email", `owner${Date.now()}@example-bakery.test`); await p.fill("#pw", "short"); await p.click("#email-go"); ok("onboarding: short password explained", /at least 8/.test(await p.textContent("#email-err"))); await p.fill("#pw", "correct horse battery"); await p.click("#email-go");
  await p.waitForSelector('[data-step="5"]:not([hidden])', { timeout: 5000 }).catch(() => {});
  ok("onboarding: reached step 5", await p.isVisible('[data-step="5"]'));
  await p.click('[data-step="5"] [data-next]');
  await p.waitForSelector("#open-app", { state: "visible", timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(2500);
  const token = await p.evaluate(() => localStorage.getItem("maiz.token"));
  ok("onboarding: account created (login stored)", !!token);
  await p.click("#open-app"); await p.waitForURL(/app\.html/); await p.waitForTimeout(800);
  ok("app (signed in): shows the real business name", (await p.textContent("#org-name")) === "Example Bakery", await p.textContent("#org-name"));
  // The overview, team, tasks and energy screens show the client's own records; screens still on example data keep their tag.
  ok("app (signed in): demo bar hidden, real screens untagged, example screens tagged", !(await p.isVisible("#demo-banner")) && (await p.locator('[data-screen="home"] .eg').count()) === 0 && (await p.locator('[data-screen="team"] .eg').count()) === 0 && await p.locator('[data-screen="finance"] .eg').count() === 1);
  await p.fill("#ask-in", "finance: what is my runway?"); await p.press("#ask-in", "Enter");
  await p.waitForSelector("#answer", { timeout: 8000 }).catch(() => {});
  ok("app (signed in): ask bar returns an answer", await p.isVisible("#answer"));
  // Conversations: the question just asked is saved, a follow-up is sent from the conversation screen, and the bell opens.
  await p.click('.rail a[data-nav="chat"]'); await p.waitForSelector("#chat-body:not([hidden])", { timeout: 5000 }).catch(() => {});
  await p.goto(B + "/app.html#chat/business-consultant"); await p.waitForTimeout(600);
  await p.fill("#chat-in", "Make that shorter"); await p.click("#chat-send"); await p.waitForTimeout(1500);
  ok("conversation: the follow-up is saved in the thread", (await p.locator("#chat-thread .turn-you").count()) >= 1 && (await p.locator("#chat-thread .turn-them").count()) >= 1);
  await p.click("#bell-btn"); await p.waitForTimeout(400);
  ok("bell: opens a labelled panel", await p.isVisible("#bell-panel") && (await p.getAttribute("#bell-btn", "aria-expanded")) === "true");
  await p.keyboard.press("Escape");
  ok("bell: Escape closes it", !(await p.isVisible("#bell-panel")));
  await p.goto(B + "/app.html#home"); await p.waitForTimeout(400);
  for (const s of ["approvals", "work", "team", "usage", "store", "finance", "compliance", "apps", "setup", "settings"]) {
    await p.click(`.rail a[data-nav="${s}"]`); await p.waitForTimeout(150);
    ok(`app nav: ${s} screen opens`, await p.isVisible(`[data-screen="${s}"] h1`) && (await p.getAttribute(`.rail a[data-nav="${s}"]`, "aria-current")) === "page");
  }
  await p.click('.rail a[data-nav="store"]'); await p.waitForTimeout(500);
  ok("store (signed in): opens inside the control centre with the picker", p.url().includes("app.html#store") && (await p.locator("#store-pick option").count()) > 1);
  await p.click('.rail a[data-nav="apps"]'); await p.waitForTimeout(400);
  ok("apps (signed in): catalogue from API", (await p.locator("#apps-grid .app-card").count()) >= 5);
  await p.click('.rail a[data-nav="settings"]'); await p.click("[data-signout]"); await p.waitForURL(/signin/);
  ok("sign out returns to log in", true);
  await p.context().close();
}
// 3. Demo control center: dashboards and gates
{
  const p = await mk();
  await p.goto(B + "/app.html", { waitUntil: "networkidle" });
  ok("demo: example bar shown", await p.isVisible("#demo-banner"));
  ok("demo: overview has 6 tiles", (await p.locator("#ov-kpis .tile-kpi").count()) === 6);
  await p.click('#ov-kpis a[href="#compliance"]'); await p.waitForSelector("#cal-list li", { state: "visible", timeout: 3000 }).catch(() => {}); ok("overview tile opens compliance calendar", await p.isVisible("#cal-list li"));
  await p.click('#cal-filter [data-kind="Tax"]'); ok("compliance filter: Tax shows 1", (await p.locator("#cal-list li").count()) === 1);
  await p.goto(B + "/app.html#work"); await p.waitForTimeout(200);
  const so = p.locator(".so-card").first();
  ok("client review: no approve or sign-off button for the client", (await p.locator(".so-card button", { hasText: /sign off|approve/i }).count()) === 0);
  ok("client review: first task waits on the client", (await so.textContent()).includes("needs a few answers from you"));
  await so.locator(".so-brief input").first().fill("Green and cream, kestrel logo"); await so.locator("[data-so-save]").first().click();
  ok("client review: answering moves it to quality review", (await p.locator(".so-card").first().textContent()).includes("In quality review"));
  ok("client review: MAIZ question shown on the second task", (await p.locator(".so-card").nth(1).textContent()).includes("MAIZ quality review asked this"));
  ok("client review: approved task shows the direction MAIZ approved", (await p.locator(".so-card").nth(2).textContent()).includes("Approved, work has started"));
  await p.click('#task-filter [data-who="hr"]'); ok("task filter by employee", (await p.locator("#kan .kcard").count()) === 2);
  await p.goto(B + "/app.html#team"); await p.waitForTimeout(200);
  ok("team table has 6 rows", (await p.locator("#team-table tbody tr").count()) === 6);
  await p.click('#rd-form button[type=submit]'); ok("role designer: thin brief lists problems", (await p.locator(".rd-problems li").count()) === 3);
  await p.fill("#rd-title", "Wholesale account coordinator"); await p.fill("#rd-purpose", "Look after cafes that buy in bulk"); await p.fill("#rd-duties", "Prepare price lists\nChase repeat orders");
  await p.click('#rd-form button[type=submit]'); ok("role designer: drafts a job description", await p.isVisible(".rd-draft") && (await p.locator(".rd-draft").textContent()).includes("Wholesale account coordinator"));
  await p.fill("#rd-title", '<img src=x onerror=alert(1)>'); await p.click('#rd-form button[type=submit]');
  ok("role designer: HTML in input is escaped", (await p.locator(".rd-draft img").count()) === 0);
  await p.goto(B + "/app.html#usage"); await p.waitForTimeout(200);
  ok("usage: chart and table render", (await p.locator("#bars rect").count()) > 20 && (await p.locator("#usage-table tbody tr").count()) === 6);
  await p.goto(B + "/app.html#approvals"); await p.click("#a-ok"); await p.waitForTimeout(400);
  ok("approvals: approving removes the item", (await p.locator("#alist [data-a]:not([hidden])").count()) === 2);
  await p.context().close();
}
// 4. Store and cart
{
  const p = await mk();
  await p.goto(B + "/employees.html", { waitUntil: "networkidle" });
  const opts = await p.locator("#store-pick option").count(); ok("store: picker lists items", opts > 40, String(opts));
  const val = await p.locator('#store-pick option[value*="content-creator"]').first().getAttribute("value");
  await p.selectOption("#store-pick", val); await p.locator("#store-item button").first().click();
  ok("store: item added to cart", (await p.locator("#cart-lines li").count()) >= 1, await p.textContent("#cart-totals"));
  await p.click("#cart-checkout"); ok("store: checkout says payments are not open", /Payments open soon/.test(await p.textContent("#cart-note")));
  ok("blueprint: Creative studio department shown", (await p.textContent("#org-blueprint")).includes("Creative studio"));
  await p.locator(".emp-card .jd summary").first().click(); ok("job description opens", await p.locator(".emp-card .jd-body").first().isVisible());
  await p.context().close();
}
// 5. Sign-in page and mobile menu
{
  const p = await mk();
  await p.goto(B + "/signin.html"); await p.click("#to-link"); await p.fill("#link-email", "someone@example.test"); await p.click("#link-go"); await p.waitForURL(/onboarding|signin/, { timeout: 5000 }).catch(() => {}); await p.waitForTimeout(400);
  ok("sign in (dev API): new email signs straight in and goes to onboarding", p.url().includes("/onboarding.html"), p.url());
  // email and password: sign up in onboarding is covered above; here, log in, wrong password, forgot password
  const pwEmail = `pw${Date.now()}@example.test`;
  const reg = await (await p.request.post(B + "/api/auth/register", { data: { email: pwEmail, password: "correct horse battery" } })).json();
  await p.request.post(B + "/api/auth/confirm", { data: { token: reg.devLink, bind: reg.bind } });
  await p.goto("about:blank"); await p.goto(B + "/signin.html");
  await p.fill("#login-email", pwEmail); await p.fill("#login-pw", "wrong password here"); await p.click("#login-go");
  await p.waitForSelector("#si-err:not([hidden])", { timeout: 5000 }).catch(() => {});
  ok("log in: wrong password explained without saying which part was wrong", /Incorrect email or password/.test(await p.textContent("#si-err")) && p.url().includes("/signin.html"));
  await p.click("[data-pw-toggle=login-pw]"); ok("log in: Show reveals the password", (await p.getAttribute("#login-pw", "type")) === "text");
  await p.fill("#login-pw", "correct horse battery"); await p.click("#login-go"); await p.waitForURL(/onboarding|app\.html/, { timeout: 5000 }).catch(() => {});
  ok("log in: right password signs in", /onboarding|app\.html/.test(p.url()), p.url());
  await p.goto("about:blank"); await p.evaluate(() => 0).catch(() => {}); await p.goto(B + "/signin.html"); await p.evaluate(() => localStorage.clear()); await p.goto(B + "/signin.html#forgot");
  ok("log in: Forgot password opens its own form", await p.isVisible("#forgot-form"));
  await p.fill("#forgot-email", pwEmail); await p.click("#forgot-go");
  await p.waitForSelector("#reset-form:not([hidden])", { timeout: 5000 }).catch(() => {});
  await p.fill("#reset-pw", "a new long phrase"); await p.click("#reset-go"); await p.waitForURL(/onboarding|app\.html/, { timeout: 5000 }).catch(() => {});
  ok("log in: reset link sets a new password and signs in", /onboarding|app\.html/.test(p.url()), p.url());
  await p.goto("about:blank"); await p.goto(B + "/signin.html#token=bogus"); await p.waitForFunction(() => /didn't work/.test(document.getElementById("si-h")?.textContent ?? ""), null, { timeout: 5000 }).catch(() => {});
  ok("sign in: bad link explained, token removed from address bar", /didn't work/.test(await p.textContent("#si-h")) && !p.url().includes("token"));
  await p.context().close();
  const m = await mk({ ...devices["iPhone 13"] });
  await m.goto(B + "/"); await m.click(".nav-toggle"); ok("mobile: menu opens", await m.isVisible("#mobile-menu"));
  await m.keyboard.press("Escape"); ok("mobile: Escape closes menu", !(await m.isVisible("#mobile-menu")));
  await m.goto(B + "/app.html"); await m.click("#menu-btn"); ok("mobile app: rail opens", await m.isVisible('.rail a[data-nav="compliance"]'));
  await m.click('.rail a[data-nav="compliance"]'); await m.waitForTimeout(500); ok("mobile app: navigates and closes rail", await m.isVisible("#cal-list"));
  await m.context().close();
}
// 7. Quality review: a client's specialised task goes to the platform owner (server needs PLATFORM_OWNER_EMAILS=owner@maiz.test)
{
  const OWNER = process.env.QA_OWNER ?? "owner@maiz.test";
  const p = await mk();
  const post = (path, body, token) => p.request.post(B + "/api" + path, { data: body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const client = await (await post("/signup", { email: `client${Date.now()}@example.test`, businessName: "Northside Bikes" })).json();
  const brief = { title: "Investor pitch deck", employee: "Finance and funding consultant", days: 7, design: "A 12-slide deck checked against the books.", brief: [{ label: "How much to raise", value: "£150,000" }], directions: [{ key: "lean", name: "Lean deck", summary: "12 slides." }, { key: "full", name: "Full deck", summary: "20 slides with appendix." }], plan: [{ title: "Outline", energy: 120 }] };
  const made = await (await post("/reviews", brief, client.token)).json();
  ok("owner review: client task enters quality review", made.task?.status === "in_review", JSON.stringify(made).slice(0, 120));
  ok("owner review: client cannot approve", (await post(`/owner/reviews/${made.task?.id}/approve`, { direction: "lean" }, client.token)).status() === 403);
  // The owner never gets a dev shortcut: read the emailed link from the API log (ConsoleEmailSender prints it).
  await p.goto(B + "/signin.html"); await p.click("#to-link"); await p.fill("#link-email", OWNER); await p.click("#link-go"); await p.waitForTimeout(500);
  const log = (await import("node:fs")).readFileSync(process.env.QA_SERVER_LOG ?? "", "utf8");
  const esc = OWNER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = [...log.matchAll(new RegExp(`--- email to ${esc} ---\\nYour MAIZ Agents sign-in link[^#]*#token=(\\S+)`, "g"))].at(-1)?.[1];
  ok("owner review: no dev shortcut for the owner, emailed link required", /Check your email/.test(await p.textContent("#si-h")) && !!link);
  await p.goto("about:blank"); await p.goto(B + "/signin.html#token=" + link); await p.waitForURL(/review\.html/, { timeout: 5000 }).catch(() => {});
  ok("owner review: platform owner lands on the review queue", p.url().includes("/review.html"), p.url());
  const card = p.locator(`[id="${made.task?.id}"]`); await card.waitFor({ timeout: 5000 }).catch(() => {});
  ok("owner review: queue shows the client and age", (await card.textContent() ?? "").includes("Northside Bikes"));
  ok("owner review: approve locked until a direction is picked", await card.locator("[data-rv-approve] button").isDisabled());
  await card.locator("input[type=radio]").nth(1).check();
  await p.locator(`[id="${made.task?.id}"] textarea`).fill("Full deck suits your investors.");
  await p.locator(`[id="${made.task?.id}"] [data-rv-approve] button`).click(); await p.waitForTimeout(400);
  const after = await (await p.request.get(B + "/api/reviews", { headers: { authorization: `Bearer ${client.token}` } })).json();
  ok("owner review: client sees approval and the chosen direction", after.tasks?.[0]?.status === "approved" && after.tasks[0].chosenDirection?.name === "Full deck", JSON.stringify(after.tasks?.[0]?.status));
  // New specialists: the client's custom role waits for the owner, who approves at his own price.
  const sp = await (await post("/specialists", { title: "Wholesale account coordinator", purpose: "Look after cafes that buy in bulk", duties: ["Prepare price lists", "Chase repeat orders"] }, client.token)).json();
  ok("owner specialists: client's custom role goes to MAIZ, not straight to training", sp.request?.status === "in_review", JSON.stringify(sp).slice(0, 120));
  await p.goto(B + "/owner-specialists.html"); const spc = p.locator(`[id="${sp.request?.id}"]`); await spc.waitFor({ timeout: 5000 }).catch(() => {});
  ok("owner specialists: queue shows the client's role", (await spc.textContent() ?? "").includes("Northside Bikes") && await p.locator("#ow-eg").isHidden());
  await spc.locator('input[type="number"]').fill("24"); await spc.locator('[data-decision="approved"]').click(); await p.waitForTimeout(400);
  const mine = await (await p.request.get(B + "/api/specialists", { headers: { authorization: `Bearer ${client.token}` } })).json();
  ok("owner specialists: approved at the owner's price", mine.requests?.[0]?.status === "approved" && mine.requests[0].priceGbp === 24, JSON.stringify(mine.requests?.[0]).slice(0, 120));
  // Clients: every business, with what needs the owner.
  await p.goto(B + "/owner-clients.html"); await p.locator("#cl-table tbody tr").first().waitFor({ timeout: 5000 }).catch(() => {});
  ok("owner clients: table lists real clients", (await p.textContent("#cl-table") ?? "").includes("Northside Bikes") && await p.locator("#ow-eg").isHidden());
  // Prices and packages: change the add-on price, the public store follows.
  await p.goto(B + "/owner-prices.html"); await p.locator("#pr-g-addOnEmployeeMonthlyGbp").waitFor({ timeout: 5000 }).catch(() => {});
  await p.fill("#pr-g-addOnEmployeeMonthlyGbp", "13"); await p.dispatchEvent("#pr-g-addOnEmployeeMonthlyGbp", "change");
  await p.fill("#pr-note", "QA price check"); await p.click("#pr-save"); await p.waitForTimeout(400);
  const store = await (await p.request.get(B + "/api/store")).json();
  ok("owner prices: saved change shows in the store at once", store.prices?.addOnEmployeeMonthlyGbp === 13, JSON.stringify(store.prices));
  ok("owner prices: history records the change", (await p.textContent("#pr-history") ?? "").includes("QA price check"));
  // Connections: the owner pastes Facebook details in the browser; the token is saved but never shown again.
  await p.goto(B + "/owner-connections.html#c-facebook"); await p.locator("#f-facebook-accessToken").waitFor({ timeout: 5000 }).catch(() => {});
  const FAKE = "EAAqaflowtoken1234567890abcdef";
  await p.fill("#f-facebook-accessToken", FAKE); await p.fill("#f-facebook-pageId", "105839201234567");
  await p.click("#c-facebook button[type=submit]"); await p.waitForTimeout(500);
  ok("owner connections: Facebook saved from the page", /Saved/.test(await p.textContent("#m-facebook") ?? "") && (await p.textContent("#c-facebook .cx-badge") ?? "").includes("Connected"));
  ok("owner connections: the saved token never comes back to the browser", !(await p.content()).includes(FAKE));
  const tok = await p.evaluate(() => localStorage.getItem("maiz.token"));
  const ch = await (await p.request.get(B + "/api/owner/promoter/channels", { headers: { authorization: `Bearer ${tok}` } })).json();
  ok("owner connections: the promotion agent can publish at once, no restart", ch.facebook === true, JSON.stringify(ch));
  await p.goto(B + "/owner-promoter.html"); await p.locator("#needs li").first().waitFor({ timeout: 5000 }).catch(() => {});
  ok("owner connections: the agent's page says what it still needs", (await p.textContent("#needs") ?? "").includes("Instagram"));
  ok("owner connections: a client cannot see connections", (await p.request.get(B + "/api/owner/connections", { headers: { authorization: `Bearer ${client.token}` } })).status() === 403);
  await p.context().close();
  const c = await mk();
  await c.goto(B + "/signin.html"); await c.evaluate((t) => localStorage.setItem("maiz.token", t), client.token);
  await c.goto(B + "/review.html"); await c.waitForTimeout(500);
  ok("owner review: a client opening the queue is turned away", /platform owner/.test(await c.textContent("#ow-gate-h")) && (await c.locator(".so-card").count()) === 0);
  await c.context().close();
}
// 8. A country that is not listed, "Continue with" buttons, and first jobs after setup (server needs GOOGLE_CLIENT_ID/SECRET, MICROSOFT_CLIENT_ID/SECRET and APP_URL set to fake values)
{
  const p = await mk();
  const providers = (await (await p.request.get(B + "/api/signin/providers")).json()).providers;
  ok("sign-in providers endpoint lists the switched-on providers", Array.isArray(providers) && providers.length === 2, JSON.stringify(providers));
  for (const k of providers) {
    const r = await p.request.get(B + `/api/signin/oauth/${k}/start`, { maxRedirects: 0 });
    const loc = r.headers()["location"] ?? "";
    ok(`continue with ${k}: start sends the browser to the provider with PKCE`, r.status() === 302 && /accounts\.google\.com|login\.microsoftonline\.com/.test(loc) && loc.includes("code_challenge_method=S256") && !/client_secret/.test(loc), loc.slice(0, 60));
  }
  await p.goto(B + "/signin.html?error=unverified", { waitUntil: "networkidle" });
  ok("log in: a failed Google/Microsoft sign-in is explained in plain words and the address bar is cleaned", /isn't verified/.test(await p.textContent("#si-err")) && !p.url().includes("error"));
  ok("log in: Continue with Google and Microsoft buttons shown", (await p.locator("#social-btns a").count()) === 2 && (await p.getAttribute('#social-btns a:first-child', "href")) === "/api/signin/oauth/google/start");
  await p.goto(B + "/signin.html?error=<script>", { waitUntil: "networkidle" });
  ok("log in: an unknown error code shows nothing", !(await p.isVisible("#si-err")));

  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await p.goto(B + "/onboarding.html", { waitUntil: "networkidle" });
  await p.click('#sectors [data-v="food-drink"]'); await p.fill("#biz", "Casa Cafe");
  await p.selectOption("#country", { label: "Somewhere else" });
  ok("country: Somewhere else asks which country", await p.isVisible("#country-name"));
  await p.click("#biz-go");
  ok("country: continuing without the name shows an error and stays", await p.isVisible("#country-name-err") && await p.isVisible('[data-step="1"]'));
  await p.fill("#country-name", "Brazil<script>"); await p.click("#biz-go");
  ok("country: a name with odd characters is refused", await p.isVisible("#country-name-err"));
  await p.fill("#country-name", "Brazil"); await p.click("#biz-go");
  await p.click("#needs-go"); await p.click("#apps-go");
  ok("plan: shows the typed country and the Admin manager's research as its first job", (await p.textContent("#plan-facts")).includes("Brazil") && /Read up on the business rules in Brazil/.test(await p.textContent("#plan-facts")));
  ok("plan: Continue with Google and Microsoft shown above the email box", (await p.locator("#social-btns a").count()) === 2 && await p.isVisible("#email-f"));
  await p.fill("#email", `ana${Date.now()}@casa-cafe.test`); await p.fill("#pw", "correct horse battery"); await p.click("#email-go");
  await p.waitForSelector('[data-step="5"]:not([hidden])', { timeout: 5000 }).catch(() => {});
  await p.click('[data-step="5"] [data-next]');
  await p.waitForSelector("#open-app", { state: "visible", timeout: 8000 }).catch(() => {});
  const token = await p.evaluate(() => localStorage.getItem("maiz.token"));
  const auth = { authorization: `Bearer ${token}` };
  const answers = { goals: "More subscribers and tidy books", customers: "Home coffee drinkers", tone: "Warm and friendly", financialYearStart: "April", salesTaxRegistered: false, marketingChannels: ["Instagram"], staffCount: 3, hiringSoon: true };
  const setup = await p.request.post(B + "/api/setup", { headers: auth, data: { answers } });
  ok("setup: form accepted", setup.ok() && (await setup.json()).state === "ready");
  let note = "";
  for (let i = 0; i < 40 && !note; i++) {
    const msgs = (await (await p.request.get(B + "/api/setup", { headers: auth })).json()).messages;
    note = msgs.find((m) => /first jobs/.test(m.text))?.text ?? "";
    if (!note) await p.waitForTimeout(250);
  }
  ok("first jobs: the Admin manager says which jobs started, with the country research first", /Admin manager: Rules for doing business in Brazil/.test(note), note.slice(0, 160));
  const tasks = await (await p.request.get(B + "/api/dashboard", { headers: auth })).json();
  ok("first jobs: results are waiting on the task board", JSON.stringify(tasks).includes("Rules for doing business in Brazil") || /done, ready for you to review/.test(note));
  await p.context().close();
}
// 6. Keyboard
{
  const p = await mk(); await p.goto(B + "/"); await p.keyboard.press("Tab");
  ok("keyboard: first Tab is the skip link", (await p.evaluate(() => document.activeElement?.className)) === "skip-link");
  await p.context().close();
}
await b.close();
for (const r of res) console.log(r.join(" | "));
console.log("console errors:", errs.length, errs.slice(0, 8));
console.log(res.filter(r => r[0] === "FAIL").length, "failed of", res.length);
if (res.some((r) => r[0] === "FAIL") || errs.length) process.exit(1);
