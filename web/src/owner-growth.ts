// Community growth (owner-growth.html): the platform owner's workbench for the Content Distribution and Community
// Growth Manager. It researches and drafts; the owner approves, publishes by hand, then records the result here.
import "./styles.css";
import { api } from "./api";
import { initNav, toast } from "./common";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { renderNeeds } from "./owner-needs";
import { OWNER_SPECIALISTS } from "../../src/modules/promoter/owner-team";
import type { Account, Approval, GrowthItem, Opportunity, Publication } from "../../src/modules/growth/index";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Pub = Publication & { opportunityName: string };
interface Report { site: string; published: number; pitched: number; verified: number; backlinks: number; dofollow: number; referralVisits: number; engagement: number; leads: number }
interface Overview {
  opportunities: Opportunity[]; items: GrowthItem[]; publications: Pub[]; accounts: Account[]; approvals: Approval[]; followUpsDue: Pub[]; report: Report[];
  role?: string; discovery?: Record<string, { platform: string; query: string }[]>;
}

const SITE: Record<string, string> = { mocktestroom: "Mock Test Room", examutor: "Examutor", maizagents: "MAIZ Agents" };
const PLATFORM: Record<string, string> = { reddit: "Reddit", quora: "Quora", linkedin: "LinkedIn", forum: "Niche forum", blog: "Blog (guest post)", publication: "Publication (guest article)", community: "Other community" };
const COMMERCIAL: Record<string, string> = { yes: "Links welcome", limited: "Links only when relevant", no: "No promotion or self-links", unknown: "Not checked yet" };
const BAND: Record<string, string> = { strong: "Strong", worth_a_try: "Worth a try", skip: "Skip" };
const STATUS: Record<string, string> = { researched: "Researched", shortlisted: "Shortlisted", dropped: "Dropped", banned: "Not allowed there" };
const date = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "–");
const options = (m: Record<string, string>) => Object.entries(m).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("");
const val = (id: string) => ($<HTMLInputElement>(id).value ?? "").trim();
const sel = (id: string) => $<HTMLSelectElement>(id).value;

let data: Overview;
let live = false;
let rulesFor = "";

const DEMO: Overview = { opportunities: [], items: [], publications: [], accounts: [], approvals: [], followUpsDue: [], report: [] };

function renderWaiting(): void {
  const items = data.items.filter((i) => i.status === "awaiting_approval" || i.status === "approved");
  const asks = data.approvals.filter((a) => a.status === "awaiting");
  $("wa-count").textContent = `${items.filter((i) => i.status === "awaiting_approval").length + asks.length} waiting`;
  const due = data.followUpsDue.map((p) => `<p class="status warn"><span class="dot"></span>Follow-up due: ${esc(p.opportunityName)} ${esc(p.followUp?.note ?? "")}</p>`).join("");
  const askCards = asks.map((a) => `<article class="panel" id="${esc(a.id)}"><h3 class="small">Permission: ${esc(a.kind)}${a.platform ? ` on ${esc(PLATFORM[a.platform] ?? a.platform)}` : ""}</h3><p>${esc(a.summary)}</p>
    <div class="acts"><button type="button" class="btn btn-primary btn-sm" data-ap="${esc(a.id)}" data-yes="1">Approve</button><button type="button" class="btn btn-quiet btn-sm" data-ap="${esc(a.id)}">Decline</button></div></article>`).join("");
  const cards = items.map((i) => {
    const flags = i.flags.length ? `<p class="status warn"><span class="dot"></span>Check before approving: ${i.flags.map(esc).join("; ")}</p>` : "";
    const acting = i.status === "awaiting_approval"
      ? `${i.flags.length ? `<label class="small"><input type="checkbox" id="${esc(i.id)}-ack"> ${i.commitment ? "I mean this commitment on the company's behalf" : "I have read the warnings above"}</label>` : ""}
         <div class="acts"><button type="button" class="btn btn-primary btn-sm" data-a="approve" data-id="${esc(i.id)}">Approve</button><button type="button" class="btn btn-quiet btn-sm" data-a="edit" data-id="${esc(i.id)}">Save my edits</button><button type="button" class="btn btn-quiet btn-sm" data-a="reject" data-id="${esc(i.id)}">Reject</button></div>`
      : `<p class="muted small">Approved. ${i.mode === "guest_pitch" ? "Send the pitch yourself, then record it." : "Publish it yourself on the platform, then record the link."}</p>
         <div class="acts"><input class="input" data-url="${esc(i.id)}" type="url" placeholder="${i.mode === "guest_pitch" ? "Link to their page (optional)" : "Link to your published post"}" aria-label="Link for ${esc(i.title)}" style="min-width:260px"><button type="button" class="btn btn-primary btn-sm" data-a="published" data-id="${esc(i.id)}">${i.mode === "guest_pitch" ? "I sent the pitch" : "I published it"}</button></div>`;
    return `<article class="panel" id="${esc(i.id)}" aria-labelledby="${esc(i.id)}-t"><h3 id="${esc(i.id)}-t" class="small">${esc(SITE[i.site] ?? i.site)} · ${esc(PLATFORM[i.platform] ?? i.platform)} · ${esc(i.title)}</h3>
      <p class="muted small">${i.approvalKind === "guest_pitch" ? "Needs your approval to send a pitch" : "Needs your approval to publish promotional content"}${i.threadUrl ? ` · <a href="${esc(i.threadUrl)}" rel="noopener noreferrer">the discussion</a>` : ""} · ${esc(i.writtenBy === "template" ? "Template (no AI model answered)" : `Written by ${i.writtenBy}`)}${i.includesLink ? " · includes a tracked link" : " · no link"}</p>
      ${i.subject !== undefined ? `<div class="field"><label for="${esc(i.id)}-s">Subject</label><input class="input" id="${esc(i.id)}-s" value="${esc(i.subject)}" maxlength="140"></div>` : ""}
      <div class="field"><label for="${esc(i.id)}-b">Draft</label><textarea class="input" id="${esc(i.id)}-b" rows="8" maxlength="8000"${i.status === "approved" ? " readonly" : ""}>${esc(i.body)}</textarea></div>${flags}${acting}</article>`;
  }).join("");
  $("wa-list").innerHTML = due + askCards + cards || `<p class="muted">Nothing is waiting.</p>`;
}

function renderOpps(): void {
  $("op-count").textContent = `${data.opportunities.length} place${data.opportunities.length === 1 ? "" : "s"}`;
  const usable = data.opportunities.filter((o) => o.status !== "dropped" && o.status !== "banned" && o.band !== "skip");
  $("dr-opp").innerHTML = usable.map((o) => `<option value="${esc(o.id)}">${esc(o.name)} (${esc(SITE[o.site] ?? o.site)})</option>`).join("") || `<option value="">Add a place first</option>`;
  const rows = data.opportunities.map((o) => `<tr><td class="ow-title"><b>${esc(o.name)}</b><span><a href="${esc(o.url)}" rel="noopener noreferrer">${esc(o.url)}</a></span></td>
    <td>${esc(SITE[o.site] ?? o.site)}</td><td>${esc(PLATFORM[o.platform] ?? o.platform)}</td>
    <td class="num"><b>${o.score}</b><br><span class="muted small">${esc(BAND[o.band] ?? o.band)}</span></td>
    <td class="small">${esc(COMMERCIAL[o.commercial] ?? o.commercial)}${o.reasons.length ? `<br><span class="muted">${o.reasons.map(esc).join("; ")}</span>` : ""}</td>
    <td>${o.rulesCheckedAt ? `Read ${esc(date(o.rulesCheckedAt))}` : `<span class="status warn"><span class="dot"></span>Rules not recorded</span>`}</td><td>${esc(STATUS[o.status] ?? o.status)}</td>
    <td><div class="acts"><button type="button" class="btn btn-quiet btn-sm" data-rules="${esc(o.id)}" aria-label="Record the rules of ${esc(o.name)}">Rules</button>
      ${o.status === "dropped" ? "" : `<button type="button" class="btn btn-quiet btn-sm" data-drop="${esc(o.id)}" aria-label="Drop ${esc(o.name)}">Drop</button>`}</div></td></tr>`).join("");
  $("op-table").innerHTML = `<thead><tr><th scope="col">Place</th><th scope="col">Website</th><th scope="col">Kind</th><th scope="col" class="num">Score</th><th scope="col">Links</th><th scope="col">Rules</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="muted">No places yet. Add one above.</td></tr>`}</tbody>`;
  const disc = data.discovery ?? {};
  $("op-disc").innerHTML = Object.entries(disc).map(([k, qs]) => `<h3 class="small">${esc(SITE[k] ?? k)}</h3><ul class="ow-list">${qs.map((q) => `<li>${esc(PLATFORM[q.platform] ?? q.platform)}: <span class="mono">${esc(q.query)}</span></li>`).join("")}</ul>`).join("") || `<p class="muted">Log in as the owner to see search phrases.</p>`;
}

function renderAccounts(): void {
  $("ac-list").innerHTML = data.accounts.length ? `<ul class="ow-list">${data.accounts.map((a) => `<li><b>${esc(PLATFORM[a.platform] ?? a.platform)}</b>: ${esc(a.handle)} (recorded ${esc(date(a.registeredAt))})</li>`).join("")}</ul>` : `<p class="muted">No accounts recorded yet.</p>`;
}

function renderPubs(): void {
  $("pb-count").textContent = `${data.publications.length} record${data.publications.length === 1 ? "" : "s"}`;
  $("rp-kpis").innerHTML = `<div class="tbl-wrap" tabindex="0" role="region" aria-label="Results by website"><table class="tbl"><thead><tr><th scope="col">Website</th><th scope="col" class="num">Published</th><th scope="col" class="num">Pitched</th><th scope="col" class="num">Verified live</th><th scope="col" class="num">Backlinks</th><th scope="col" class="num">Follow links</th><th scope="col" class="num">Visits</th><th scope="col" class="num">Engagement</th><th scope="col" class="num">Leads</th></tr></thead><tbody>${data.report.map((r) => `<tr><th scope="row">${esc(SITE[r.site] ?? r.site)}</th><td class="num">${r.published}</td><td class="num">${r.pitched}</td><td class="num">${r.verified}</td><td class="num">${r.backlinks}</td><td class="num">${r.dofollow}</td><td class="num">${r.referralVisits}</td><td class="num">${r.engagement}</td><td class="num">${r.leads}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">Nothing yet.</td></tr>`}</tbody></table></div>`;
  const rows = data.publications.map((p) => `<tr><td class="ow-title"><b>${esc(p.opportunityName)}</b><span>${esc(SITE[p.site] ?? p.site)} · ${esc(PLATFORM[p.platform] ?? p.platform)}${p.account ? ` · ${esc(p.account)}` : ""}</span></td>
    <td>${p.url ? `<a href="${esc(p.url)}" rel="noopener noreferrer">Open</a>` : "–"}</td><td>${esc(p.kind === "pitched" ? "Pitch sent" : "Published")} ${esc(date(p.at))}</td>
    <td>${p.verifiedAt ? `Live, checked ${esc(date(p.verifiedAt))}` : `<span class="status warn"><span class="dot"></span>Not verified</span>`}</td><td>${esc(p.backlinkStatus)}</td>
    <td><div class="acts"><input class="input" data-v="${esc(p.id)}" type="number" min="0" value="${p.referralVisits}" aria-label="Referral visits for ${esc(p.opportunityName)}" style="width:80px"><input class="input" data-e="${esc(p.id)}" type="number" min="0" value="${p.engagement}" aria-label="Engagement for ${esc(p.opportunityName)}" style="width:80px"><input class="input" data-l="${esc(p.id)}" type="number" min="0" value="${p.leads}" aria-label="Leads for ${esc(p.opportunityName)}" style="width:70px"><button type="button" class="btn btn-quiet btn-sm" data-m="${esc(p.id)}">Save numbers</button></div>
      <div class="acts"><select class="input" data-bl="${esc(p.id)}" aria-label="Backlink type for ${esc(p.opportunityName)}"><option value="none">No backlink</option><option value="unknown">Backlink, type unknown</option><option value="nofollow">Backlink (nofollow)</option><option value="dofollow">Backlink (follow)</option></select><button type="button" class="btn btn-quiet btn-sm" data-ver="${esc(p.id)}" aria-label="I saw it live: ${esc(p.opportunityName)}">I saw it live</button></div>
      ${p.followUp ? `<p class="muted small">Follow-up: ${esc(p.followUp.note)} by ${esc(date(p.followUp.dueAt))}${p.followUp.done ? " (done)" : ` <button type="button" class="btn btn-quiet btn-sm" data-fu="${esc(p.id)}">Done</button>`}</p>` : ""}</td></tr>`).join("");
  $("pb-table").innerHTML = `<thead><tr><th scope="col">Place</th><th scope="col">Link</th><th scope="col">Status</th><th scope="col">Verified</th><th scope="col">Backlink</th><th scope="col">Results and checks</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">Nothing published or pitched yet.</td></tr>`}</tbody>`;
}

function render(): void {
  renderWaiting(); renderOpps(); renderAccounts(); renderPubs();
  if (data.role) $("ro-text").textContent = data.role;
  const set = (id: string, html: string) => { const el = $<HTMLSelectElement>(id); if (!el.options.length) el.innerHTML = html; };
  for (const id of ["op-site"]) set(id, options(SITE));
  for (const id of ["op-platform", "ap-platform", "rg-platform"]) set(id, options(PLATFORM));
  set("op-com", options(COMMERCIAL));
  $<HTMLSelectElement>("op-com").value ||= "unknown";
  syncMode();
}

function syncMode(): void {
  const contribution = sel("dr-mode") === "contribution";
  $("dr-turl-f").hidden = !contribution; $("dr-tsum-f").hidden = !contribution;
}

/** Runs an owner call, shows the server's plain-words answer on failure, and refreshes the page on success. */
async function act(path: string, body: unknown, msg: HTMLElement | null): Promise<boolean> {
  if (!live) { toast("This is example data. Log in as the platform owner to use it."); return false; }
  const r = await api<Overview & { error?: string }>(`/owner/growth${path}`, { body });
  if (!r.ok) { const text = (r.data as { error?: string } | undefined)?.error ?? "That did not work. Nothing was changed."; if (msg) msg.textContent = text; else toast(text); return false; }
  data = { ...data, ...(r.data as Overview) };
  if (msg) msg.textContent = "";
  render();
  return true;
}

$("wa-list").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!b) return;
  if (b.dataset.ap) { await act(`/approvals/${b.dataset.ap}/decide`, { approve: b.dataset.yes === "1" }, null); return; }
  const id = b.dataset.id!, a = b.dataset.a;
  const edits = () => ({ body: $<HTMLTextAreaElement>(`${id}-b`).value, ...(document.getElementById(`${id}-s`) ? { subject: val(`${id}-s`) } : {}) });
  if (a === "approve") { if (await act(`/drafts/${id}/edit`, edits(), null)) { const ack = document.getElementById(`${id}-ack`) as HTMLInputElement | null; if (await act(`/drafts/${id}/approve`, { acknowledge: !!ack?.checked }, null)) toast("Approved. Nothing has gone out yet."); } }
  else if (a === "edit") { if (await act(`/drafts/${id}/edit`, edits(), null)) toast("Saved. It still needs your approval."); }
  else if (a === "reject") { if (await act(`/drafts/${id}/reject`, {}, null)) toast("Rejected."); }
  else if (a === "published") { const url = (document.querySelector<HTMLInputElement>(`[data-url="${id}"]`)?.value ?? "").trim(); if (await act(`/drafts/${id}/published`, { url }, null)) toast("Recorded. Now check it is live and verify it below."); }
});

$("op-table").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!b) return;
  if (b.dataset.drop) { await act(`/opportunities/${b.dataset.drop}/update`, { status: "dropped" }, null); return; }
  if (b.dataset.rules) {
    rulesFor = b.dataset.rules;
    const o = data.opportunities.find((x) => x.id === rulesFor)!;
    $("op-rules-h").textContent = `Rules of ${o.name}`;
    $<HTMLTextAreaElement>("op-rules-text").value = o.rulesSummary ?? "";
    $("op-rules-box").hidden = false;
    $("op-rules-text").focus();
  }
});
$("op-rules-close").addEventListener("click", () => { $("op-rules-box").hidden = true; });
$("op-rules-save").addEventListener("click", async () => {
  if (await act(`/opportunities/${rulesFor}/update`, { rulesSummary: $<HTMLTextAreaElement>("op-rules-text").value }, $("op-rules-msg"))) $("op-rules-box").hidden = true;
});

$("pb-table").addEventListener("click", async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!b) return;
  const q = (sel_: string) => document.querySelector<HTMLInputElement>(sel_)?.value ?? "";
  if (b.dataset.m) await act(`/publications/${b.dataset.m}/metrics`, { referralVisits: Number(q(`[data-v="${b.dataset.m}"]`)), engagement: Number(q(`[data-e="${b.dataset.m}"]`)), leads: Number(q(`[data-l="${b.dataset.m}"]`)) }, null);
  else if (b.dataset.ver) await act(`/publications/${b.dataset.ver}/verify`, { live: true, backlinkStatus: document.querySelector<HTMLSelectElement>(`[data-bl="${b.dataset.ver}"]`)?.value ?? "none" }, null);
  else if (b.dataset.fu) await act(`/publications/${b.dataset.fu}/follow-up`, { done: true }, null);
});

$("dr-mode").addEventListener("change", syncMode);
$("op-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await act("/opportunities", { site: sel("op-site"), platform: sel("op-platform"), name: val("op-name"), url: val("op-url"), audienceNote: val("op-aud"), audienceFit: Number(val("op-fit")), domainQuality: Number(val("op-dom")), rulesFit: Number(val("op-rules")), commercial: sel("op-com") }, $("op-msg"))) {
    $("op-msg").textContent = "Added and scored."; for (const id of ["op-name", "op-url", "op-aud"]) $<HTMLInputElement>(id).value = "";
  }
});
$("dr-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("dr-msg"), go = $<HTMLButtonElement>("dr-go");
  msg.textContent = "Writing…"; go.disabled = true;
  const mode = sel("dr-mode");
  const ok = await act("/drafts", { opportunityId: sel("dr-opp"), mode, brief: val("dr-brief"), ...(mode === "contribution" ? { threadUrl: val("dr-turl"), threadSummary: val("dr-tsum") } : {}) }, msg);
  go.disabled = false;
  if (ok) { msg.textContent = "Draft ready above, waiting for you."; $<HTMLInputElement>("dr-brief").value = ""; }
});
$("ap-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await act("/approvals", { kind: sel("ap-kind"), platform: sel("ap-kind") === "account" ? sel("ap-platform") : undefined, summary: val("ap-sum") }, $("ap-msg"))) { $("ap-msg").textContent = "Request added above for your decision."; $<HTMLInputElement>("ap-sum").value = ""; }
});
$("rg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (await act("/accounts", { platform: sel("rg-platform"), handle: val("rg-handle") }, $("rg-msg"))) { $("rg-msg").textContent = "Recorded."; $<HTMLInputElement>("rg-handle").value = ""; }
});

void (async () => {
  const loaded = await ownerLoad<Overview>("/owner/growth");
  if (loaded === undefined) return;
  if (loaded === "demo") { data = DEMO; markDemo(); } else { data = loaded; live = true; }
  render();
  const me = OWNER_SPECIALISTS.find((s) => s.key === "community-growth-manager")!;
  void renderNeeds($("needs"), "community-growth-manager", { name: "Community growth manager", avatar: me.avatar, initials: "CG", asks: me.asks });
  if (location.hash.length > 1) document.getElementById(location.hash.slice(1))?.scrollIntoView();
})();
