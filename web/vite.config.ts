import { COMPANY as BASE_COMPANY } from "../src/company";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { defineConfig, type Plugin } from "vite";
import { NEEDS, SECTORS, OTHER_SECTOR } from "../src/modules/onboarding/sectors";

/**
 * Shared page pieces (head, header, footer, logo) live once in web/partials and are pasted in at build time,
 * so every page has the same navigation with no script needed.
 * Usage in a page:  <!--@include header-->   or   <!--@include head title="Pricing" description="..."-->
 */
function partials(): Plugin {
  const read = (name: string) => readFileSync(resolve(__dirname, "partials", `${name}.html`), "utf8");
  const expand = (html: string, depth = 0): string =>
    depth > 3
      ? html
      : html.replace(/<!--@include ([\w-]+)((?:\s+\w+="[^"]*")*)\s*-->/g, (_m, name: string, attrs: string) => {
          let out = read(name);
          for (const [, k, v] of attrs.matchAll(/(\w+)="([^"]*)"/g)) out = out.replaceAll(`{{${k}}}`, v!);
          return expand(out, depth + 1);
        });
  return { name: "partials", transformIndexHtml: { order: "pre", handler: (html) => companyTokens(expand(html)) } };
}


/**
 * The Solutions page says, for every kind of business, which jobs the team starts with. It is built from the
 * same sector data signup uses (../src/modules/onboarding/sectors), so the page and signup never disagree.
 * Usage in a page:  <!--@sectors-->
 */
const EMPLOYEE_TITLE: Record<string, string> = {
  "admin-manager": "Admin manager", "finance-manager": "Finance manager", "marketing-manager": "Marketing manager",
  "business-consultant": "Business consultant", "hr-manager": "HR manager", "compliance-manager": "Compliance manager",
  "supply-chain-manager": "Supply chain manager (add-on)",
};
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
// How each sector reads in a heading ("AI employees for ...").
const SECTOR_PHRASE: Record<string, string> = {
  "food-drink": "cafés, restaurants and bars", shop: "shops and retailers", "online-store": "online stores",
  services: "professional services firms", trades: "trades and construction", "health-beauty": "salons, clinics and gyms",
  tech: "software and tech companies", creative: "creative and media businesses", "education-care": "education and care providers",
  property: "property and hospitality", "making-moving": "manufacturers, wholesalers and couriers", charity: "charities and community groups",
};
function sectorsHtml(): string {
  const list = SECTORS.filter((s) => s.key !== OTHER_SECTOR);
  const chips = list.map((s) => `<a class="team-chip" href="#${s.key}"><b>${escHtml(s.label)}</b><span class="s">${escHtml(s.examples)}</span></a>`).join("");
  const sections = list.map((s) => {
    const jobs = s.needs.map((k) => NEEDS.find((n) => n.key === k)).filter((n) => n !== undefined).map((n) =>
      `<li><b>${escHtml(n.label)}.</b> ${escHtml(n.firstJob)}. <span class="sector-lead">Led by your ${escHtml(EMPLOYEE_TITLE[n.lead] ?? n.lead)}.</span></li>`).join("");
    return `<section class="sector-card" id="${s.key}" aria-labelledby="${s.key}-h"><h2 id="${s.key}-h">AI employees for ${escHtml(SECTOR_PHRASE[s.key] ?? s.label.toLowerCase())}</h2><p class="sector-ex">${escHtml(s.examples)}</p><p>What owners in this sector usually ask for first, and the first job your team does for each:</p><ul class="sector-jobs">${jobs}</ul><p><a class="btn btn-ghost" href="/onboarding.html">Start your free week</a></p></section>`;
  }).join("");
  return `<div class="team-strip" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">${chips}</div><div class="sector-list">${sections}</div>`;
}
function industries(): Plugin {
  return { name: "maiz-sectors", transformIndexHtml: { order: "pre", handler: (html) => html.replace("<!--@sectors-->", sectorsHtml) } };
}

// Public origin of the site, used for canonical links, Open Graph tags, the sitemap and robots.txt.
// Set SITE_URL when building for the real domain (the Dockerfile and Render blueprint pass it in).
const SITE_URL = (process.env.SITE_URL ?? "http://localhost:5173").replace(/\/+$/, "");

/**
 * The legal entity behind MAIZ Agents (see ../src/company.ts). The pages, footer and llms.txt read these values.
 * The contact email is not on any record we hold, so it comes from CONTACT_EMAIL and shows a clearly marked placeholder until set.
 */
const COMPANY = {
  name: BASE_COMPANY.name,
  number: BASE_COMPANY.number,
  registeredIn: BASE_COMPANY.registeredIn,
  incorporated: BASE_COMPANY.incorporated,
  incorporatedIso: BASE_COMPANY.incorporatedIso,
  office: BASE_COMPANY.registeredOffice,
  email: (process.env.CONTACT_EMAIL ?? "").trim() || "[contact email to be added]",
};
const companyTokens = (html: string): string =>
  html
    .replaceAll("%COMPANY_NAME%", COMPANY.name)
    .replaceAll("%COMPANY_NUMBER%", COMPANY.number)
    .replaceAll("%COMPANY_REGISTERED_IN%", COMPANY.registeredIn)
    .replaceAll("%COMPANY_INCORPORATED%", COMPANY.incorporated)
    .replaceAll("%REGISTERED_OFFICE%", COMPANY.office)
    .replaceAll("%CONTACT_EMAIL%", COMPANY.email);

/** Public, indexable pages. App and onboarding pages are noindex and stay out of the sitemap. */
const INDEXED_PAGES = ["/", "/employees.html", "/how-it-works.html", "/control-centre.html", "/pricing.html", "/security.html", "/faq.html", "/energy.html", "/industries.html", "/terms.html", "/privacy.html", "/cookies.html"];

// Optional search-engine verification codes, set at build time (Google Search Console, Bing Webmaster Tools).
// DNS verification needs neither; these are for the "HTML tag" method.
const GOOGLE_VERIFY = (process.env.GOOGLE_SITE_VERIFICATION ?? "").replace(/[^\w-]/g, "");
const BING_VERIFY = (process.env.BING_SITE_VERIFICATION ?? "").replace(/[^\w-]/g, "");
const BUILT = new Date().toISOString().slice(0, 10);
// The version in the link changes whenever og.png changes, so WhatsApp, LinkedIn, Slack and others fetch the new
// picture instead of showing the one they cached before.
const OG_VERSION = createHash("sha256").update(readFileSync(resolve(__dirname, "public", "og.png"))).digest("hex").slice(0, 8);
const OG_IMAGE = `${SITE_URL}/og.png?v=${OG_VERSION}`;
const OG_ALT = "MAIZ Agents: hire a team, not another tool. Six illustrated AI employees, £150 a month for the whole team, 7 days free.";

const decode = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const pick = (html: string, re: RegExp) => decode(html.match(re)?.[1] ?? "");

/** Open Graph and X (Twitter) card tags, built from the page's own title, description and canonical link. */
function socialTags(html: string): string {
  const title = pick(html, /<title>([\s\S]*?)<\/title>/);
  const desc = pick(html, /<meta name="description" content="([^"]*)"/);
  const url = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? `${SITE_URL}/`;
  const ogTitle = title.replace(/\s*·\s*MAIZ Agents$/, "");
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="MAIZ Agents">`,
    `<meta property="og:locale" content="en_GB">`,
    `<meta property="og:title" content="${attr(ogTitle)}">`,
    `<meta property="og:description" content="${attr(desc)}">`,
    `<meta property="og:url" content="${attr(url)}">`,
    `<meta property="og:image" content="${OG_IMAGE}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${attr(OG_ALT)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${attr(ogTitle)}">`,
    `<meta name="twitter:description" content="${attr(desc)}">`,
    `<meta name="twitter:image" content="${OG_IMAGE}">`,
    `<meta name="twitter:image:alt" content="${attr(OG_ALT)}">`,
  ].join("\n");
}

/** BreadcrumbList from the visible breadcrumb line (<p class="crumbs"><a href="/">Front page</a> / Name</p>). */
function breadcrumbs(html: string, url: string): object | undefined {
  const m = html.match(/<p class="crumbs">([\s\S]*?)<\/p>/);
  if (!m) return undefined;
  const last = decode(m[1]!.split("/").pop() ?? "");
  return {
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE_URL}/` },
      { "@type": "ListItem", position: 2, name: last, item: url },
    ],
  };
}

const ORG = {
  "@type": "Organization", "@id": `${SITE_URL}/#org`, name: "MAIZ Agents", legalName: COMPANY.name, url: `${SITE_URL}/`,
  foundingDate: COMPANY.incorporatedIso,
  identifier: { "@type": "PropertyValue", propertyID: "Companies House company number", value: COMPANY.number },
  logo: { "@type": "ImageObject", url: `${SITE_URL}/logo.png`, width: 512, height: 512 },
  description: "AI employees for small businesses: a Finance, Marketing, HR and Compliance manager and a Business consultant, run by a free Admin manager. You approve before anything goes out.",
};
/** The Team package, exactly as the pricing page shows it. Keep in step with src/modules/pricing. */
const TEAM_OFFER = {
  "@type": "Product", "@id": `${SITE_URL}/pricing.html#team`, name: "MAIZ Agents Team package", brand: { "@id": `${SITE_URL}/#org` },
  description: "Five AI employees (Finance, Marketing, Business consultant, HR and Compliance) and a free Admin manager, with 8,000 energy a week shared by the team. 7-day free trial, no card.",
  image: OG_IMAGE,
  offers: {
    "@type": "Offer", url: `${SITE_URL}/pricing.html`, price: "150", priceCurrency: "GBP", availability: "https://schema.org/InStock",
    priceSpecification: { "@type": "UnitPriceSpecification", price: "150", priceCurrency: "GBP", unitText: "MONTH", referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "MON" } },
  },
};

/**
 * SEO plugin (ECC `seo` skill): fills %SITE_URL%, adds social preview tags and JSON-LD built from what each page
 * actually shows (the FAQ schema comes from the FAQ markup and breadcrumbs from the breadcrumb line, so they cannot
 * drift), and emits robots.txt, sitemap.xml and llms.txt.
 */
function seo(): Plugin {
  return {
    name: "maiz-seo",
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        let out = companyTokens(html.replaceAll("%SITE_URL%", SITE_URL));
        const page = "/" + (ctx.filename.split("/").pop() ?? "");
        const path = page === "/index.html" ? "/" : page;
        if (!INDEXED_PAGES.includes(path)) return out;
        const url = `${SITE_URL}${path}`;
        const isHome = path === "/";
        const faqs = path === "/faq.html"
          ? [...out.matchAll(/<details><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map(([, q = "", a = ""]) => ({
              "@type": "Question", name: decode(q), acceptedAnswer: { "@type": "Answer", text: decode(a) },
            }))
          : [];
        const crumbs = breadcrumbs(out, url);
        const graph = [
          ...(isHome ? [ORG, { "@type": "WebSite", "@id": `${SITE_URL}/#site`, name: "MAIZ Agents", url: `${SITE_URL}/`, publisher: { "@id": `${SITE_URL}/#org` }, inLanguage: "en-GB" }] : []),
          { "@type": "WebPage", "@id": `${url}#page`, url, name: pick(out, /<title>([\s\S]*?)<\/title>/), description: pick(out, /<meta name="description" content="([^"]*)"/), isPartOf: { "@id": `${SITE_URL}/#site` }, inLanguage: "en-GB", primaryImageOfPage: OG_IMAGE },
          ...(path === "/pricing.html" || isHome ? [TEAM_OFFER] : []),
          ...(faqs.length ? [{ "@type": "FAQPage", "@id": `${url}#faq`, mainEntity: faqs }] : []),
          ...(crumbs ? [crumbs] : []),
        ];
        const json = JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
        const verify = [
          GOOGLE_VERIFY && isHome ? `<meta name="google-site-verification" content="${GOOGLE_VERIFY}">` : "",
          BING_VERIFY && isHome ? `<meta name="msvalidate.01" content="${BING_VERIFY}">` : "",
        ].filter(Boolean).join("\n");
        const robots = `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">`;
        return out.replace("</head>", `${robots}\n${socialTags(out)}\n${verify ? verify + "\n" : ""}<script type="application/ld+json">${json}</script>\n</head>`);
      },
    },
    generateBundle() {
      // Search engines and AI answer engines are welcome on the public pages. The API is private.
      const bots = ["Googlebot", "Bingbot", "Google-Extended", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User", "Applebot", "Applebot-Extended", "DuckDuckBot", "CCBot"];
      const robotsTxt = [
        ...bots.map((b) => `User-agent: ${b}\nAllow: /\nDisallow: /api/\n`),
        `User-agent: *\nAllow: /\nDisallow: /api/\n`,
        `# App, onboarding and owner pages carry a noindex meta tag; they stay crawlable so the tag is seen.`,
        `Sitemap: ${SITE_URL}/sitemap.xml`,
        ``,
      ].join("\n");
      this.emitFile({ type: "asset", fileName: "robots.txt", source: robotsTxt });
      const urls = INDEXED_PAGES.map((p) => `  <url><loc>${SITE_URL}${p}</loc><lastmod>${BUILT}</lastmod><priority>${p === "/" ? "1.0" : p === "/pricing.html" || p === "/employees.html" ? "0.9" : "0.7"}</priority></url>`).join("\n");
      this.emitFile({ type: "asset", fileName: "sitemap.xml", source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n` });
      this.emitFile({ type: "asset", fileName: "llms.txt", source: llmsTxt() });
    },
  };
}

/** A plain summary for AI assistants and answer engines (llmstxt.org format). Keep it factual. */
function llmsTxt(): string {
  const u = (p: string) => `${SITE_URL}${p}`;
  return `# MAIZ Agents

> MAIZ Agents gives a small business a team of AI employees: a Finance manager, Marketing manager, Business consultant, HR manager and Compliance manager, run by a free Admin manager. They draft the work; the owner approves before anything is sent, published or paid. Built for owners with no AI knowledge. English only, available worldwide, prices in GBP.

## Key facts

- Team package: £150 a month for the whole team (five employees plus the free Admin manager), with 8,000 energy a week shared by the team. No per-seat fees.
- Free trial: 7 days, 3,000 energy, no card needed.
- Optional add-ons: an extra ready-made employee £25 a month, a specialist £35 a month (each adds 2,000 energy a week), and consultant passes for 7 or 30 days.
- Energy is the team's weekly allowance. Each task shows its energy cost before it starts; redoing a task returns its energy. It refills every Monday.
- Control: nothing leaves the business without the owner's approval. Finance figures come from tested accounting code, not AI guesses; estimates are labelled.
- Works in Slack and in the MAIZ control centre (web). Accounting connections such as Xero and Square are coming soon.
- Security: each business's data is kept apart at the database level, sign-in uses one-time email links, and every action is written to an audit trail. No outside security audit or certification yet.

## Pages

- [Home](${u("/")}): what MAIZ Agents is, in one page.
- [AI employees](${u("/employees.html")}): the six employees, their job descriptions and the add-on roles.
- [How it works](${u("/how-it-works.html")}): set up in about three minutes, Slack, approvals.
- [Control centre](${u("/control-centre.html")}): the screen where the owner approves work and sees energy.
- [Pricing](${u("/pricing.html")}): the £150 Team package, add-ons and a compare-with-hiring calculator.
- [Energy explained](${u("/energy.html")}): how the weekly allowance works.
- [Solutions by industry](${u("/industries.html")}): what the team does for each kind of business.
- [Security and privacy](${u("/security.html")}): what is in place today and what is still to come.
- [FAQs](${u("/faq.html")}): short answers to common questions.
- [Terms of service](${u("/terms.html")}): the agreement between a business and ${COMPANY.name}.
- [Privacy policy](${u("/privacy.html")}): how ${COMPANY.name} uses personal data under UK GDPR.
- [Cookies](${u("/cookies.html")}): the few cookies and browser storage the site uses.

## Who runs it

- MAIZ Agents is a product of ${COMPANY.name}, a private company limited by shares, registered in ${COMPANY.registeredIn}, company number ${COMPANY.number}, incorporated ${COMPANY.incorporated}.
`;
}

// Multi-page static site: landing, onboarding flow and the control center.
export default defineConfig({
  plugins: [partials(), industries(), seo()],
  // In development the website talks to the API started with `npm run dev:api` in the repo root.
  // The setup form and Admin manager messages are imported from the backend's pure modules (../src).
  server: { proxy: { "/api": "http://localhost:8787" }, fs: { allow: [".."] } },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        onboarding: resolve(__dirname, "onboarding.html"),
        app: resolve(__dirname, "app.html"),
        signin: resolve(__dirname, "signin.html"),
        staffForm: resolve(__dirname, "staff-form.html"),
        review: resolve(__dirname, "review.html"),
        ownerDecisions: resolve(__dirname, "owner-decisions.html"),
        ownerSpecialists: resolve(__dirname, "owner-specialists.html"),
        ownerClients: resolve(__dirname, "owner-clients.html"),
        ownerPrices: resolve(__dirname, "owner-prices.html"),
        ownerPromotions: resolve(__dirname, "owner-promotions.html"),
        affiliate: resolve(__dirname, "affiliate.html"),
        ownerTeam: resolve(__dirname, "owner-team.html"),
        ownerConnections: resolve(__dirname, "owner-connections.html"),
        ownerGrowth: resolve(__dirname, "owner-growth.html"),
        ownerPromoter: resolve(__dirname, "owner-promoter.html"),
        unsubscribe: resolve(__dirname, "unsubscribe.html"),
        ownerAi: resolve(__dirname, "owner-ai.html"),
        employees: resolve(__dirname, "employees.html"),
        pricing: resolve(__dirname, "pricing.html"),
        security: resolve(__dirname, "security.html"),
        howItWorks: resolve(__dirname, "how-it-works.html"),
        controlCentre: resolve(__dirname, "control-centre.html"),
        faq: resolve(__dirname, "faq.html"),
        terms: resolve(__dirname, "terms.html"),
        privacy: resolve(__dirname, "privacy.html"),
        cookies: resolve(__dirname, "cookies.html"),
        energy: resolve(__dirname, "energy.html"),
        industries: resolve(__dirname, "industries.html"),
        notFound: resolve(__dirname, "404.html"),
      },
    },
  },
});
