# Promotion agent (owner only)

An agent on maizagents.com, in the platform owner's admin (`/owner-promoter.html`, menu item "Promotion agent"), that promotes the owner's three websites: **Mock Test Room** (mocktestroom.com), **Examutor** (examutor.com) and **MAIZ Agents** (maizagents.com). It is not a client-facing product and is not in the store. Every `/api/owner/promoter/*` route answers 403 to anyone but the platform owner (`PLATFORM_OWNER_EMAILS`), and the service checks again.

Code: `src/modules/promoter` (`knowledge.ts`, `rules.ts`, `service.ts`). Tests: `test/promoter.test.ts`.

## What it knows

`knowledge.ts` holds a profile per site, researched from the live sites on 14 November 2026: offer, audiences and the message for each, pricing, strengths, search and sharing set-up with gaps, what must never be claimed, tone and the main conversion. Each pricing fact is marked `seen`, `owner` or `to_confirm`. Anything `to_confirm` (Mock Test Room's package prices, which could not be read: its /packages path returned an error) is marked "NOT CONFIRMED: do not state" in the prompt. The owner adds or confirms facts on the page; they are stored and used in every later draft.

Not visible from outside, so the owner must supply them: Search Console and Bing data (rankings, indexed pages), real customer numbers, results, reviews, and Mock Test Room's prices.

## What it does

- **Campaign plans** (`planCampaign`): a deterministic plan from site, goal, budget, weeks and start date. Channel mix with budget that adds up exactly, a week-by-week calendar, a message per audience, and KPIs. Targets are left open until two weeks of real results exist (any number before that would be invented). Paid ads are only planned from £150 and capped at 40% of the budget. £0 plans free channels only.
- **Drafts**: social posts, articles, partner pitches, affiliate invitations, SEO fixes, ad copy and one-to-one emails, written through the Model Gateway (`taskType: "promoter"`, standard tier, so RunPod first and the Claude spot-check and redo from `docs/AI-ROUTING.md` apply). With no model, or on a model error, it falls back to a template and says so. Tracking links (`utm_source=maiz-promoter`, `utm_medium`, `utm_campaign`) are added to every draft.
- **Outreach**: a list of named people, each with a lawful basis and a source. Follow-up sequence of at most two, at least five days apart, stopping on a reply or an opt-out.
- **Tracking**: the owner records spend (never beyond the approved budget) and results (visits, sign-ups, replies) per campaign; the report shows totals and cost per result.

## The sign-off gate

Everything outward-facing waits for the owner. New drafts and campaign plans appear on the owner **Decisions** page (kind "Promotion") and count in the same email digest as quality reviews. A draft goes `awaiting_approval` to `approved` only when the owner presses Approve; editing sends it back. The agent never publishes or spends on its own: the owner publishes posts, articles and ads (or presses "Publish for me" for Facebook and Instagram once connected) and marks them posted. Only emails are sent from the platform, one at a time, by the owner pressing "Send email now" on an approved draft. The agent cannot approve its own work.

## Anti-spam rules (UK PECR and UK GDPR)

Enforced in code (`rules.ts`), and re-checked at the moment of sending:

- No bought, scraped or harvested contacts: a source containing those words is refused. Every lead needs a stated source and a lawful basis.
- Individuals (including sole traders and partnerships) are only emailed with consent, as existing customers of a similar product who were offered an opt-out (soft opt-in), or when they wrote first. Company contacts may be emailed without consent only at a company address (not webmail), with a stated reason why it matters to their job.
- Every email is to one named person (no bulk blasts), carries the sender name and postal address (MAIZ AI Ltd, registered office) and an unsubscribe link. The link opens `/unsubscribe.html`, which asks before it acts (so a mail scanner cannot unsubscribe anyone). An opt-out applies to the address across all three sites and the person can never be added again.
- Subject lines cannot pretend to be a reply or a forward. At most 2 follow-ups, 5 days apart, none after a reply. At most 50 emails a day, and 20 first-contact business emails a day (a deliverability and conduct limit, not a legal one).
- Copy flags (shown beside the draft, they do not block): guarantees, "official" or partnership claims about IELTS, PTE, TOEFL, SAT or the College Board, user numbers and testimonials that must be real, income promises, pressure wording and anything aimed at under-13s.

Not legal advice. A solicitor should review the outreach rules and the lawful bases before the first campaign; affiliate terms are not written yet (see `docs/PROMOTIONS.md`), so the agent makes no payout promises.

Sending notes: a draft is marked `sending` before the provider is called, so two presses at once cannot both send, and a person gets each step of the sequence once, in order. Production email goes through the retrying mail queue, so "sent" means handed to the queue: if the provider still refuses after its retries, it is only logged. Check the Resend dashboard for bounces. Lead name, company and reason are included in the prompt sent to the model provider; keep that in mind for the privacy policy. Mail has no `List-Unsubscribe` header yet (the footer link works); add it before sending at volume.

## Storage

Platform records (`platform_records`, kinds `promo_campaign`, `promo_draft`, `promo_lead`, `promo_optout`, `promo_fact`), restricted like coupons and affiliates. No migration. The unsubscribe token is never returned by the owner API.

## What Atif needs to supply

No new keys for drafting: it uses the existing `RUNPOD_*` and `ANTHROPIC_API_KEY` settings.

- **Sending email** uses the existing Resend sender (`EMAIL_FROM`, `RESEND_API_KEY`). The sending domain must be verified in Resend (already an open item), and `CONTACT_EMAIL`/`SUPPORT_EMAIL` should be set so replies reach a person.
- **Google Search Console and Bing Webmaster** access for all three sites, or an export of queries, pages and indexing, so SEO work can start from real numbers.
- **Mock Test Room package prices**, real student results and any reviews you are happy to quote.
- **Facebook, Instagram and WhatsApp** can be connected (optional): approved posts publish from the page, and the agent messages you on WhatsApp so you can approve by replying. Connect them on the owner's Connections page (`/owner-connections.html`), which walks you through each step and tests it; details are in `docs/META-WHATSAPP.md`. Other platforms, ads and partner accounts are not connected: you publish those yourself.
- Domain tracking: the links use UTM parameters, so each site's analytics will show them with no setup.
