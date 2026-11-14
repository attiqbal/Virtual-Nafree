// Browser QA (ECC `browser-qa` skill): console errors, failed requests, horizontal overflow,
// full-page screenshots at 375/768/1440 and an axe-core WCAG 2.2 AA scan.
// Usage: npm run build && npm run qa   (serves dist/ with `vite preview` on port 4173)
// Set QA_URL to test an already running server instead. Writes qa/out/.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const OUT = join(import.meta.dirname, "out");
const PAGES = ["/", "/how-it-works.html", "/control-centre.html", "/faq.html", "/terms.html", "/privacy.html", "/cookies.html", "/energy.html", "/industries.html", "/employees.html", "/pricing.html", "/security.html", "/signin.html", "/404.html", "/onboarding.html", "/app.html", "/app.html#approvals", "/app.html#apps/accounting", "/app.html#slack", "/app.html#work", "/app.html#team", "/app.html#usage", "/app.html#finance", "/app.html#compliance", "/app.html#apps", "/app.html#setup", "/app.html#settings", "/app.html#people", "/app.html#desk/hr-manager", "/app.html#desk/finance-manager", "/app.html#desk/admin-manager", "/app.html#desk/marketing-manager", "/app.html#desk/business-consultant", "/app.html#desk/compliance-manager", "/app.html#desk/growth-consultant", "/staff-form.html#demo", "/review.html", "/owner-decisions.html", "/owner-specialists.html", "/owner-clients.html", "/owner-prices.html", "/owner-promotions.html", "/owner-promoter.html", "/owner-growth.html", "/owner-team.html", "/owner-connections.html", "/unsubscribe.html", "/affiliate.html", "/owner-ai.html"];
const VIEWPORTS = [[375, 812], [768, 1024], [1440, 900]];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa", "best-practice"];

let server;
let base = process.env.QA_URL;
if (!base) {
  base = "http://localhost:4173";
  server = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base)).ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const report = {};
let failures = 0;
try {
  for (const path of PAGES) {
    for (const [width, height] of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width, height }, bypassCSP: true }) // axe is injected inline, which the production CSP rightly blocks;
      const page = await ctx.newPage();
      const consoleErrors = [];
      const failedRequests = [];
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      page.on("pageerror", (e) => consoleErrors.push(String(e)));
      page.on("response", (r) => { if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url()}`); });
      await page.goto(base + path, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      const overflowPx = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const name = `${(path.replace(/^\//, "").replace(/[/#.]/g, "_") || "home")}-${width}`;
      // Scroll through the page so scroll-reveal sections and the demo stage have run before the full-page shot.
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo({ top: y, behavior: "instant" }); await new Promise((r) => setTimeout(r, 120)); } window.scrollTo({ top: 0, behavior: "instant" }); });
      await page.waitForTimeout(6500 * Number(path === "/"));
      await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async (tags) => {
        const r = await globalThis.axe.run(document, { runOnly: tags });
        return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")) }));
      }, AXE_TAGS);
      // The API is optional in the static preview; only count API failures as noise.
      const realFailures = failedRequests.filter((u) => !u.includes("/api/"));
      const realErrors = consoleErrors.filter((t) => !/api|Failed to load resource/i.test(t));
      const pass = realErrors.length === 0 && realFailures.length === 0 && overflowPx <= 0 && violations.length === 0;
      if (!pass) failures++;
      report[name] = { path, viewport: `${width}x${height}`, pass, overflowPx, consoleErrors, failedRequests, violations };
      console.log(`${pass ? "PASS" : "FAIL"} ${name.padEnd(24)} overflow=${overflowPx} errors=${realErrors.length} requests=${realFailures.length} axe=${violations.map((v) => `${v.id}(${v.impact})`).join(",") || 0}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server?.kill();
}
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(failures ? `\n${failures} checks failed. See qa/out/report.json` : "\nAll checks passed. Now look at the screenshots in qa/out/.");
process.exitCode = failures ? 1 : 0;
