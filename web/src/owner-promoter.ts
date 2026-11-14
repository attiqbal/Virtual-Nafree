// Promotion agent (owner-promoter.html): the platform owner's workbench for promoting the three websites.
// Everything the agent writes lands in "Waiting for your approval". Emails go out one person at a time from
// here after approval; posts go to Facebook or Instagram from here when connected (otherwise by hand, then marked posted).
import "./styles.css";
import { api } from "./api";
import { initNav, toast } from "./common";
import { esc, gbp, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { renderNeeds } from "./owner-needs";
import { OWNER_SPECIALISTS } from "../../src/modules/promoter/owner-team";
import type { Campaign, DraftItem, SiteProfile } from "../../src/modules/promoter/index";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Draft = DraftItem & { leadEmail?: string };
interface LeadRow { id: string; email: string; name?: string; company?: string; site: string; kind: string; basis: string; source: string; status: string; sent: number }
interface Overview {
  campaigns: Campaign[]; drafts: Draft[]; leads: LeadRow[];
  followUpsDue: { lead: string; email: string; site: string; nextStep: number }[];
  knowledge: (SiteProfile & { ownerFacts: string[] })[];
}

const SITE_NAME: Record<string, string> = { mocktestroom: "Mock Test Room", examutor: "Examutor", maizagents: "MAIZ Agents" };
const BASIS: Record<string, string> = { consent: "Asked to hear from us", soft_opt_in: "Existing customer", b2b_legitimate_interest: "Company contact", existing_contact: "Wrote to us first" };
const CAMPAIGN_STATUS: Record<string, string> = { plan_ready: "Plan ready: waiting for you", approved: "Approved", paused: "Paused", done: "Finished" };
const date = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");
const optionsOf = (names: Record<string, string>) => Object.entries(names).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");

let data: Overview;
let live = false;
let channels = { facebook: false, instagram: false };

const DEMO: Overview = {
  campaigns: [], drafts: [], leads: [], followUpsDue: [],
  knowledge: (["mocktestroom", "examutor", "maizagents"] as const).map((key) => ({
    key, name: SITE_NAME[key]!, url: `https://${key}.com`, oneLine: "Example: sign in as the platform owner to see what the agent knows.", offer: [], audiences: [], pricing: [], strengths: [],
    seo: { state: [], gaps: [] }, doNotClaim: [], conversion: "", tone: "", researchedAt: "2026-11-14", ownerFacts: [],
  })),
};

function renderKnowledge(): void {
  $("kb-list").innerHTML = data.knowledge.map((s) => `<details class="panel"><summary><b>${esc(s.name)}</b> <span class="muted small">${esc(s.url)}</span></summary>
    <p>${esc(s.oneLine)}</p>
    ${s.offer.length ? `<h3 class="small">What it offers</h3><ul class="ow-list">${s.offer.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${s.audiences.length ? `<h3 class="small">Who it is for, and what to say</h3><ul class="ow-list">${s.audiences.map((a) => `<li><b>${esc(a.name)}.</b> ${esc(a.need)} <i>${esc(a.message)}</i></li>`).join("")}</ul>` : ""}
    ${s.pricing.length ? `<h3 class="small">Pricing</h3><ul class="ow-list">${s.pricing.map((f) => `<li>${esc(f.text)}${f.status === "to_confirm" ? ` <span class="status warn"><span class="dot"></span>Confirm</span>` : ""}</li>`).join("")}</ul>` : ""}
    ${s.seo.state.length ? `<h3 class="small">Search and sharing today</h3><ul class="ow-list">${s.seo.state.map((x) => `<li>${esc(x)}</li>`).join("")}</ul><h3 class="small">Gaps</h3><ul class="ow-list">${s.seo.gaps.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${s.doNotClaim.length ? `<h3 class="small">Never claimed in a draft</h3><ul class="ow-list">${s.doNotClaim.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${s.ownerFacts.length ? `<h3 class="small">Facts you added</h3><ul class="ow-list">${s.ownerFacts.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  </details>`).join("");
}

function draftCard(d: Draft): string {
  const flags = d.flags.length ? `<p class="status warn"><span class="dot"></span>Check before approving: ${d.flags.map(esc).join("; ")}</p>` : "";
  const to = d.leadEmail ? `To ${esc(d.leadEmail)} · ` : "";
  const buttons = d.status === "awaiting_approval"
    ? `<button type="button" class="btn btn-primary btn-sm" data-act="approve" data-id="${esc(d.id)}">Approve</button>
       <button type="button" class="btn btn-quiet btn-sm" data-act="save" data-id="${esc(d.id)}">Save my edits</button>
       <button type="button" class="btn btn-quiet btn-sm" data-act="reject" data-id="${esc(d.id)}">Reject</button>`
    : d.status === "approved"
      ? (d.channel === "email"
        ? `<button type="button" class="btn btn-primary btn-sm" data-act="send" data-id="${esc(d.id)}">Send email now</button><button type="button" class="btn btn-quiet btn-sm" data-act="preview" data-id="${esc(d.id)}">Preview with footer</button>`
        : (d.channel === "social" || d.channel === "community") && (channels.facebook || channels.instagram)
          ? `<select class="input" data-target="${esc(d.id)}" aria-label="Where to publish ${esc(d.title)}">${channels.facebook ? `<option value="facebook">Facebook Page</option>` : ""}${channels.instagram ? `<option value="instagram">Instagram</option>` : ""}</select>
             <input class="input" data-image="${esc(d.id)}" placeholder="Image link (https://, needed for Instagram)" aria-label="Image link for ${esc(d.title)}" style="min-width:220px">
             <label class="small">Schedule (Facebook only, optional) <input class="input" type="datetime-local" data-when="${esc(d.id)}"></label>
             <button type="button" class="btn btn-primary btn-sm" data-act="publish" data-id="${esc(d.id)}">Publish for me</button>
             <button type="button" class="btn btn-quiet btn-sm" data-act="posted" data-id="${esc(d.id)}">I published it myself</button>`
          : `${d.channel === "social" || d.channel === "community" ? `<a class="btn btn-primary btn-sm" href="/owner-connections.html#c-facebook">Connect Facebook or Instagram so I can publish this</a>` : ""}<input class="input" data-url="${esc(d.id)}" placeholder="Link to the published post (optional)" aria-label="Link to the published post for ${esc(d.title)}" style="min-width:220px"><button type="button" class="btn ${d.channel === "social" || d.channel === "community" ? "btn-ghost" : "btn-primary"} btn-sm" data-act="posted" data-id="${esc(d.id)}">I published it myself</button>`)
      : "";
  return `<article class="panel" id="${esc(d.id)}" aria-labelledby="${esc(d.id)}-t">
    <h3 id="${esc(d.id)}-t" class="small">${esc(SITE_NAME[d.site] ?? d.site)} · ${esc(d.channel)} · ${esc(d.title)}</h3>
    <p class="muted small">${to}${esc(d.writtenBy === "template" ? "Template (no AI model answered)" : `Written by ${d.writtenBy}`)}${d.step ? ` · follow-up ${d.step}` : ""}</p>
    ${d.subject !== undefined ? `<div class="field"><label for="${esc(d.id)}-s">Subject</label><input class="input" id="${esc(d.id)}-s" value="${esc(d.subject)}" maxlength="140"></div>` : ""}
    <div class="field"><label for="${esc(d.id)}-b">Draft</label><textarea class="input" id="${esc(d.id)}-b" rows="7" maxlength="6000">${esc(d.body)}</textarea></div>
    ${flags}<div class="acts">${buttons}</div><pre class="mono small" id="${esc(d.id)}-pv" hidden style="white-space:pre-wrap"></pre></article>`;
}

function renderDrafts(): void {
  const waiting = data.drafts.filter((d) => d.status === "awaiting_approval");
  const approved = data.drafts.filter((d) => d.status === "approved");
  const recent = data.drafts.filter((d) => ["sent", "posted", "failed", "rejected"].includes(d.status)).slice(0, 8);
  $("dr-count").textContent = `${waiting.length} waiting`;
  const plans = data.campaigns.filter((c) => c.status === "plan_ready");
  $("dr-list").innerHTML = [
    ...plans.map((c) => `<p class="status info"><span class="dot"></span>A campaign plan is waiting: <a href="#${esc(c.id)}">${esc(c.name)}</a></p>`),
    ...waiting.map(draftCard), ...approved.map(draftCard),
    recent.length ? `<h3 class="small">Recently done</h3><ul class="ow-list">${recent.map((d) => `<li>${esc(d.title)} · ${esc(d.status)}${d.error ? ` (${esc(d.error)})` : ""}${d.sentAt ? ` · ${esc(date(d.sentAt))}` : ""}${d.scheduledFor ? ` · goes live ${esc(date(d.scheduledFor))}` : ""}${d.postedUrl && /^https:\/\//.test(d.postedUrl) ? ` · <a href="${esc(d.postedUrl)}" rel="noopener noreferrer">view</a>` : ""}${d.stats ? ` · ${d.stats.likes} likes, ${d.stats.comments} comments` : ""}${d.externalId ? ` · <button type="button" class="btn btn-quiet btn-sm" data-act="stats" data-id="${esc(d.id)}">Refresh numbers</button>` : ""}</li>`).join("")}</ul>` : "",
  ].join("") || `<p class="muted">Nothing is waiting. Write a draft below.</p>`;
}

function renderCampaigns(): void {
  $("cm-count").textContent = `${data.campaigns.length} campaign${data.campaigns.length === 1 ? "" : "s"}`;
  $("nd-campaign").innerHTML = `<option value="">None</option>` + data.campaigns.filter((c) => c.status !== "done").map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
  $("cm-list").innerHTML = data.campaigns.map((c) => {
    const spent = c.spend.reduce((s, x) => s + x.amountGbp, 0);
    return `<details class="panel" id="${esc(c.id)}"${c.status === "plan_ready" ? " open" : ""}><summary><b>${esc(c.name)}</b> · ${esc(SITE_NAME[c.site] ?? c.site)} · ${esc(CAMPAIGN_STATUS[c.status] ?? c.status)} · ${gbp(spent)} of ${gbp(c.budgetGbp)}</summary>
      <p class="muted small">Goal: ${esc(c.goal)} · ${c.weeks} weeks from ${esc(date(c.startDate))}</p>
      <h3 class="small">Where the budget goes</h3><ul class="ow-list">${c.plan.channels.map((ch) => `<li><b>${esc(ch.channel)}</b> ${ch.sharePercent}% (${gbp(ch.budgetGbp)}). ${esc(ch.why)}</li>`).join("")}</ul>
      <h3 class="small">Calendar</h3><ul class="ow-list">${c.plan.calendar.map((w) => `<li><b>Week ${w.week}</b> (${esc(date(w.startsOn))}): ${esc(w.theme)}. ${w.activities.map((a) => esc(a.what)).join(" ")}</li>`).join("")}</ul>
      <h3 class="small">What we measure</h3><ul class="ow-list">${c.plan.kpis.map((k) => `<li><b>${esc(k.metric)}.</b> ${esc(k.measuredBy)}. Target: ${esc(k.target)}</li>`).join("")}</ul>
      <ul class="ow-list">${c.plan.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      <div class="acts">${c.status === "plan_ready" || c.status === "paused" ? `<button type="button" class="btn btn-primary btn-sm" data-cs="approved" data-id="${esc(c.id)}">Approve plan and budget</button>` : ""}
        ${c.status === "approved" ? `<button type="button" class="btn btn-quiet btn-sm" data-cs="paused" data-id="${esc(c.id)}">Pause</button>` : ""}
        ${c.status !== "done" ? `<button type="button" class="btn btn-quiet btn-sm" data-cs="done" data-id="${esc(c.id)}">Finish</button>` : ""}</div>
      ${c.status === "approved" ? `<div class="acts"><input class="input" data-spend="${esc(c.id)}" type="number" min="0" step="0.01" placeholder="£ spent" aria-label="Pounds spent on ${esc(c.name)}" style="width:110px"><button type="button" class="btn btn-quiet btn-sm" data-act="spend" data-id="${esc(c.id)}">Record spend</button>
        <input class="input" data-metric="${esc(c.id)}" placeholder="Result (for example sign-ups)" aria-label="Result name for ${esc(c.name)}" style="width:200px"><input class="input" data-value="${esc(c.id)}" type="number" min="0" step="1" placeholder="How many" aria-label="Result count for ${esc(c.name)}" style="width:110px"><button type="button" class="btn btn-quiet btn-sm" data-act="result" data-id="${esc(c.id)}">Record result</button></div>` : ""}
      ${c.results.length ? `<p class="muted small">Results so far: ${esc(Object.entries(c.results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.metric]: (m[r.metric] ?? 0) + r.value }), {})).map(([k, v]) => `${k} ${v}`).join(", "))}</p>` : ""}
    </details>`;
  }).join("") || `<p class="muted">No campaigns yet. Plan one above.</p>`;
}

function renderLeads(): void {
  $("ld-count").textContent = `${data.leads.length} ${data.leads.length === 1 ? "person" : "people"}${data.followUpsDue.length ? ` · ${data.followUpsDue.length} follow-up${data.followUpsDue.length === 1 ? "" : "s"} due` : ""}`;
  const optLead = data.leads.filter((l) => l.status === "active").map((l) => `<option value="${esc(l.id)}">${esc(l.name ?? l.email)} (${esc(SITE_NAME[l.site] ?? l.site)})</option>`).join("");
  $("nd-lead").innerHTML = optLead || `<option value="">No one on the list yet</option>`;
  const rows = data.leads.map((l) => {
    const due = data.followUpsDue.find((f) => f.lead === l.id);
    return `<tr><td class="ow-title"><b>${esc(l.name ?? l.email)}</b><span>${esc(l.email)}${l.company ? ` · ${esc(l.company)}` : ""}</span></td><td>${esc(SITE_NAME[l.site] ?? l.site)}</td><td>${esc(BASIS[l.basis] ?? l.basis)}</td><td>${esc(l.source)}</td><td class="num">${l.sent}</td>
      <td>${esc(l.status === "opted_out" ? "Opted out" : l.status === "replied" ? "Replied" : due ? `Follow-up ${due.nextStep} due` : "Active")}</td>
      <td>${l.status === "active" ? `<button type="button" class="btn btn-quiet btn-sm" data-act="replied" data-id="${esc(l.id)}" aria-label="Mark ${esc(l.email)} as replied">Replied</button>` : ""}</td></tr>`;
  }).join("");
  $("ld-table").innerHTML = `<thead><tr><th scope="col">Person</th><th scope="col">Website</th><th scope="col">Why we may email</th><th scope="col">Source</th><th scope="col" class="num">Sent</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="7" class="muted">No one yet.</td></tr>`}</tbody>`;
}

function render(): void {
  renderKnowledge(); renderDrafts(); renderCampaigns(); renderLeads();
  for (const id of ["nd-site", "cm-site", "ld-site", "kb-site"]) { const el = $<HTMLSelectElement>(id); if (!el.options.length) el.innerHTML = optionsOf(SITE_NAME); }
}

/** Runs an owner call, shows the server's plain-words answer on failure, and refreshes the page data on success. */
async function act(path: string, body: unknown, msg: HTMLElement | null, method?: string): Promise<boolean> {
  if (!live) { toast("This is example data. Log in as the platform owner to use it."); return false; }
  const r = await api<Overview & { error?: string }>(`/owner/promoter${path}`, { body, method });
  if (!r.ok) { const text = (r.data as { error?: string } | undefined)?.error ?? "That did not work. Nothing was changed."; if (msg) msg.textContent = text; else toast(text); return false; }
  data = { ...data, ...(r.data as Overview) };
  data.knowledge = r.data?.knowledge ?? data.knowledge;
  if (msg) msg.textContent = "";
  render();
  return true;
}

const val = (id: string) => ($<HTMLInputElement>(id).value ?? "").trim();

$("dr-list").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
  if (!b) return;
  const id = b.dataset.id!, act_ = b.dataset.act!;
  const text = () => ({ body: ($<HTMLTextAreaElement>(`${id}-b`)).value, ...(document.getElementById(`${id}-s`) ? { subject: val(`${id}-s`) } : {}) });
  if (act_ === "approve") { if (await act(`/drafts/${id}/edit`, text(), null)) { if (await act(`/drafts/${id}/approve`, {}, null)) toast("Approved. Nothing has been sent yet."); } }
  else if (act_ === "save") { if (await act(`/drafts/${id}/edit`, text(), null)) toast("Saved. It still needs your approval."); }
  else if (act_ === "reject") { if (await act(`/drafts/${id}/reject`, {}, null)) toast("Rejected."); }
  else if (act_ === "send") { b.disabled = true; if (await act(`/drafts/${id}/send`, {}, null)) toast("Email handed to the mail queue. It goes out within a minute or so."); b.disabled = false; }
  else if (act_ === "publish") {
    b.disabled = true;
    const when = val_(`[data-when="${id}"]`);
    const ok = await act(`/drafts/${id}/publish`, { target: val_(`[data-target="${id}"]`), imageUrl: val_(`[data-image="${id}"]`), scheduleAt: when ? new Date(when).toISOString() : undefined }, null);
    if (ok) toast(when ? "Scheduled." : "Published."); else b.disabled = false;
  }
  else if (act_ === "stats") { if (await act(`/drafts/${id}/stats`, {}, null)) toast("Numbers updated."); }
  else if (act_ === "posted") { if (await act(`/drafts/${id}/posted`, { url: val_(`[data-url="${id}"]`) }, null)) toast("Marked as posted."); }
  else if (act_ === "preview") {
    const r = await api<{ preview: string }>(`/owner/promoter/drafts/${id}/preview`);
    const pv = $(`${id}-pv`); pv.textContent = r.data?.preview ?? "No preview."; pv.hidden = false;
  }
});
const val_ = (sel: string) => (document.querySelector<HTMLInputElement>(sel)?.value ?? "").trim();

$("cm-list").addEventListener("click", async (e) => {
  const t = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!t) return;
  const id = t.dataset.id!;
  if (t.dataset.cs) await act(`/campaigns/${id}/status`, { status: t.dataset.cs }, null);
  else if (t.dataset.act === "spend") await act(`/campaigns/${id}/spend`, { amountGbp: Number(val_(`[data-spend="${id}"]`)), note: "Recorded on the promotion page" }, null);
  else if (t.dataset.act === "result") await act(`/campaigns/${id}/results`, { metric: val_(`[data-metric="${id}"]`), value: Number(val_(`[data-value="${id}"]`)) }, null);
});

$("ld-table").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-act='replied']");
  if (b) await act(`/leads/${b.dataset.id}/replied`, {}, null);
});

$("nd-channel").addEventListener("change", () => {
  const email = $<HTMLSelectElement>("nd-channel").value === "email";
  $("nd-lead-f").hidden = !email; $("nd-step-f").hidden = !email;
});

$("nd-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const channel = $<HTMLSelectElement>("nd-channel").value;
  const msg = $("nd-msg"), go = $<HTMLButtonElement>("nd-go");
  msg.textContent = "Writing…"; go.disabled = true;
  const ok = await act("/drafts", { site: $<HTMLSelectElement>("nd-site").value, channel, campaignId: $<HTMLSelectElement>("nd-campaign").value || undefined, brief: val("nd-brief"), ...(channel === "email" ? { leadId: $<HTMLSelectElement>("nd-lead").value, step: Number($<HTMLSelectElement>("nd-step").value) } : {}) }, msg);
  go.disabled = false;
  if (ok) { msg.textContent = "Draft ready above, waiting for you."; $<HTMLInputElement>("nd-brief").value = ""; }
});

$("cm-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await act("/campaigns", { site: $<HTMLSelectElement>("cm-site").value, goal: val("cm-goal"), budgetGbp: Number(val("cm-budget") || 0), weeks: Number(val("cm-weeks")), startDate: val("cm-start") }, $("cm-msg"))) { $("cm-msg").textContent = "Plan ready for your approval."; $<HTMLInputElement>("cm-goal").value = ""; }
});

$("ld-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { site: $<HTMLSelectElement>("ld-site").value, email: val("ld-email"), name: val("ld-name"), company: val("ld-company"), kind: $<HTMLSelectElement>("ld-kind").value, basis: $<HTMLSelectElement>("ld-basis").value, source: val("ld-source"), relevance: val("ld-rel") };
  if (await act("/leads", body, $("ld-msg"))) { $("ld-msg").textContent = "Added."; for (const id of ["ld-email", "ld-name", "ld-company", "ld-source", "ld-rel"]) $<HTMLInputElement>(id).value = ""; }
});

$("kb-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("kb-msg");
  if (!live) { toast("This is example data."); return; }
  const r = await api<{ facts?: string[]; error?: string }>("/owner/promoter/facts", { body: { site: $<HTMLSelectElement>("kb-site").value, text: val("kb-text") } });
  if (!r.ok) { msg.textContent = r.data?.error ?? "That did not work."; return; }
  const full = await ownerLoad<Overview>("/owner/promoter");
  if (full && full !== "demo") data = full;
  $<HTMLInputElement>("kb-text").value = ""; msg.textContent = "Saved. Drafts use it from now on."; render();
});

void (async () => {
  const startInput = $<HTMLInputElement>("cm-start");
  const nextMonday = new Date(); nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
  startInput.value = nextMonday.toISOString().slice(0, 10);
  const loaded = await ownerLoad<Overview>("/owner/promoter");
  if (loaded === undefined) return;
  if (loaded === "demo") { data = DEMO; markDemo(); } else { data = loaded; live = true; }
  if (live) { const c = await api<{ facebook: boolean; instagram: boolean }>("/owner/promoter/channels"); if (c.ok && c.data) channels = c.data; }
  render();
  const me = OWNER_SPECIALISTS.find((s) => s.key === "promotion-agent")!;
  void renderNeeds($("needs"), "promotion-agent", { name: "Promotion agent", avatar: me.avatar, initials: "PA", asks: me.asks });
  if (location.hash.length > 1) document.getElementById(location.hash.slice(1))?.scrollIntoView();
})();
