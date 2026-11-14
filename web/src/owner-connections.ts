// Connections (owner-connections.html): everything the owner's AI team needs, connected from the browser.
// Each card is asked for by the team member who needs it, with the steps in plain words, the boxes to paste into,
// a real test and the result in words. Secrets go to the server once and never come back: a saved secret shows
// only as "saved". Cards for services set on the server show their status and a test.
import "./styles.css";
import { api } from "./api";
import { initNav, toast } from "./common";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { statusBadge, type ConnStatus } from "./owner-needs";
import { CATALOG, type GuideStep } from "../../src/modules/connections/catalog";
import { OWNER_SPECIALISTS } from "../../src/modules/promoter/owner-team";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Field { key: string; label: string; help: string; secret: boolean; required: boolean; placeholder?: string; generate?: boolean; set: boolean; value?: string; fallback?: string }
interface TestResult { ok: boolean; message: string; details: string[]; at: string }
interface Conn {
  key: string; title: string; summary: string; group: "social" | "messaging" | "clients" | "platform"; usedBy: string[];
  editable: boolean; status: ConnStatus; source: "browser" | "server" | "none"; statusText: string; missing: string[];
  canTest: boolean; lastTest?: TestResult; fields: Field[]; guide: GuideStep[];
  webhook?: { callbackUrl: string; verifyToken?: string; seenAt?: string };
  copies?: { label: string; value: string }[]; clientsSee?: string;
}
interface View { connections: Conn[]; persistent: boolean }

/** Who asks for each connection: the owner's own specialists, and the decisions desk (the owner's inbox). */
const PEOPLE: Record<string, { name: string; avatar: string; initials: string }> = {
  ...Object.fromEntries(OWNER_SPECIALISTS.map((s) => [s.key, { name: s.key === "promotion-agent" ? "Promotion agent" : "Community growth manager", avatar: s.avatar, initials: s.key === "promotion-agent" ? "PA" : "CG" }])),
  decisions: { name: "Your decisions desk", avatar: "av-tl", initials: "DD" },
};

let view: View;
let live = false;

const DEMO: View = {
  persistent: true,
  connections: CATALOG.map((c) => ({
    key: c.key, title: c.title, summary: c.summary, group: c.group, usedBy: [...c.usedBy], editable: c.editable, status: "not_connected", source: "none",
    statusText: "Not connected yet.", missing: c.fields.filter((f) => f.required).map((f) => f.label), canTest: true,
    fields: c.fields.map((f) => ({ ...f, set: false })), guide: [...c.guide], clientsSee: c.clientsSee,
    copies: c.copies?.map((x) => ({ label: x.label, value: `${location.origin}${x.path}` })),
    webhook: c.key === "whatsapp" ? { callbackUrl: `${location.origin}/api/whatsapp/webhook` } : undefined,
  })),
};

// ------------------------------------------------------------ remembered ticks (this browser only)
const TICKS = "maiz.connSteps";
const readTicks = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(TICKS) ?? "{}") ?? {}; } catch { return {}; } };
const writeTick = (id: string, on: boolean): void => {
  try { const t = readTicks(); if (on) t[id] = true; else delete t[id]; localStorage.setItem(TICKS, JSON.stringify(t)); } catch { /* storage blocked: ticks just are not remembered */ }
};

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function askers(c: Conn): string {
  const who = c.usedBy.map((k) => PEOPLE[k]).filter(Boolean);
  if (!who.length) return "";
  return `<div class="cx-askers" aria-label="Asked for by ${esc(who.map((w) => w!.name).join(" and "))}">${who.map((w) => `<span class="av av-sm ${esc(w!.avatar)}" aria-hidden="true">${esc(w!.initials)}</span>`).join("")}<span class="small muted">Needed by ${esc(who.map((w) => w!.name).join(" and "))}</span></div>`;
}

function result(c: Conn): string {
  const t = c.lastTest;
  if (!t) return c.status === "connected" ? `<p class="cx-result cx-untested" role="status">Saved, not tested yet. Press <b>Test connection</b> to check it with ${c.group === "social" || c.group === "messaging" ? "Meta" : "the service"}.</p>` : `<p class="cx-result" role="status" hidden></p>`;
  return `<div class="cx-result ${t.ok ? "cx-ok" : "cx-bad"}" role="status"><p><b>${t.ok ? "It works." : "Not working yet."}</b> ${esc(t.message)}</p>
    ${t.details.length ? `<ul>${t.details.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}<p class="small muted">Tested ${esc(when(t.at))}</p></div>`;
}

function steps(c: Conn): string {
  const ticks = readTicks();
  return `<ol class="cx-steps">${c.guide.map((g, i) => {
    const id = `${c.key}:${i}`;
    return `<li><label class="cx-tick"><input type="checkbox" data-step="${esc(id)}"${ticks[id] ? " checked" : ""}><span class="cx-n" aria-hidden="true">${i + 1}</span><span class="cx-txt">${esc(g.text)}</span></label>
      ${g.link ? `<a class="cx-link" href="${esc(g.link.href)}" target="_blank" rel="noopener noreferrer">${esc(g.link.label)}<span class="sr-only"> (opens in a new tab)</span> ↗</a>` : ""}</li>`;
  }).join("")}</ol>`;
}

function fieldHtml(c: Conn, f: Field): string {
  const id = `f-${c.key}-${f.key}`;
  const saved = f.secret && f.set;
  const ph = saved ? "Saved. Leave empty to keep it" : f.fallback ?? f.placeholder ?? "";
  return `<div class="field${f.key === "verifyToken" ? " cx-wide" : ""}"><label for="${id}">${esc(f.label)}${f.required ? "" : ' <span class="muted">(optional)</span>'}${saved ? ' <span class="cx-saved">Saved</span>' : ""}</label>
    <div class="cx-inrow"><input class="input" id="${id}" name="${esc(f.key)}" ${f.secret ? 'type="password" autocomplete="new-password"' : 'type="text" autocomplete="off"'} spellcheck="false" ${f.value ? `value="${esc(f.value)}"` : ""} placeholder="${esc(ph)}" aria-describedby="${id}-h" maxlength="1000"${c.editable ? "" : " disabled"}>
    ${f.generate && c.editable ? `<button type="button" class="btn btn-ghost btn-sm" data-gen="${id}">Make one for me</button>` : ""}
    ${saved && !f.required && c.editable ? `<button type="button" class="btn btn-quiet btn-sm" data-clear="${esc(c.key)}:${esc(f.key)}">Remove</button>` : ""}</div>
    <span class="hint" id="${id}-h">${esc(f.help)}</span></div>`;
}

function webhookBox(c: Conn): string {
  const w = c.webhook;
  if (!w) return "";
  const row = (label: string, value: string | undefined, id: string) => `<div class="cx-copy"><span class="cx-copy-k">${esc(label)}</span>
    ${value ? `<code id="${id}">${esc(value)}</code><button type="button" class="btn btn-ghost btn-sm" data-copy="${id}">Copy<span class="sr-only"> ${esc(label)}</span></button>` : `<span class="muted small">Save a verify token above first, then copy it from here.</span>`}</div>`;
  return `<div class="cx-hook"><h3 class="small">For Meta's webhook screen (step 7)</h3>
    ${row("Callback URL", w.callbackUrl, `wh-url`)}${c.source === "server" ? `<p class="small muted">The verify token is set on the server.</p>` : row("Verify token", w.verifyToken, `wh-tok`)}
    <p class="small ${w.seenAt ? "cx-ok-t" : "muted"}">${w.seenAt ? `Meta reached the webhook at ${esc(when(w.seenAt))}.` : "Meta has not reached the webhook since the server last started."}</p></div>`;
}

/** Addresses to paste into the provider's own screens (redirect URLs and the like). */
function copiesBox(c: Conn): string {
  if (!c.copies?.length) return "";
  return `<div class="cx-hook"><h3 class="small">Paste into ${esc(c.title.replace(/^Sign in with /, "").replace(/ \(.*\)$/, ""))}'s settings</h3>
    ${c.copies.map((x, i) => `<div class="cx-copy"><span class="cx-copy-k">${esc(x.label)}</span><code id="cp-${esc(c.key)}-${i}">${esc(x.value)}</code><button type="button" class="btn btn-ghost btn-sm" data-copy="cp-${esc(c.key)}-${i}">Copy<span class="sr-only"> ${esc(x.label)}</span></button></div>`).join("")}</div>`;
}

const GROUPS: { id: string; groups: Conn["group"][] }[] = [
  { id: "cx-team", groups: ["social", "messaging"] },
  { id: "cx-clients", groups: ["clients"] },
  { id: "cx-platform", groups: ["platform"] },
];
const inGroup = (gs: Conn["group"][]) => view.connections.filter((c) => gs.includes(c.group));

function card(c: Conn): string {
  const open = c.status !== "connected" && c.editable;
  const done = c.guide.filter((_, i) => readTicks()[`${c.key}:${i}`]).length;
  const actions = `<div class="acts">
      ${c.editable ? `<button type="submit" class="btn btn-primary">Save</button>` : ""}
      ${c.canTest && c.status !== "not_connected" ? `<button type="button" class="btn ${c.editable ? "btn-ghost" : "btn-primary"}" data-test="${esc(c.key)}">Test connection</button>` : ""}
      ${c.key === "whatsapp" && c.status !== "not_connected" ? `<button type="button" class="btn btn-ghost" data-sendtest="1">Send test WhatsApp message</button>` : ""}
      ${c.editable && c.source === "browser" ? `<button type="button" class="btn btn-quiet" data-disconnect="${esc(c.key)}">Disconnect</button>` : ""}
      <span class="muted small" id="m-${esc(c.key)}" role="status"></span></div>`;
  return `<section class="panel cx-card" id="c-${esc(c.key)}" aria-labelledby="c-${esc(c.key)}-h" tabindex="-1">
    <div class="cx-top"><div class="cx-title"><h2 id="c-${esc(c.key)}-h">${esc(c.title)}</h2><p class="muted">${esc(c.summary)}</p></div>${statusBadge(c.status)}</div>
    ${askers(c)}
    ${c.clientsSee ? `<p class="cx-sees small"><b>What your clients get:</b> ${esc(c.clientsSee)}</p>` : ""}
    <p class="cx-state">${esc(c.statusText)}${c.missing.length && c.status === "not_connected" ? ` Still needed: ${esc(c.missing.join(", "))}.` : ""}${c.source === "server" && c.editable === false && CATALOG.find((d) => d.key === c.key)?.editable ? " To manage it here instead, remove those settings from the server." : ""}</p>
    ${result(c)}
    <details class="cx-setup"${open ? " open" : ""}><summary>${c.editable ? (c.status === "not_connected" ? "Set it up, step by step" : "Steps and details") : "Where this is set, and how"} <span class="muted small">${c.guide.length} steps${done ? `, ${done} ticked` : ""}</span></summary>
      ${steps(c)}
    </details>
    ${c.editable || c.fields.length ? `<form class="cx-form" data-form="${esc(c.key)}" novalidate>
      ${c.fields.length ? `<div class="ow-grid cx-fields">${c.fields.map((f) => fieldHtml(c, f)).join("")}</div>` : ""}
      ${copiesBox(c)}
      ${webhookBox(c)}
      ${actions}</form>` : actions}
  </section>`;
}

function summary(): void {
  const [team, clients, platform] = GROUPS.map((g) => inGroup(g.groups)) as [Conn[], Conn[], Conn[]];
  const ok = team.filter((c) => c.status === "connected").length;
  const cOk = clients.filter((c) => c.status === "connected").length;
  const pOk = platform.filter((c) => c.status === "connected").length;
  $("cx-progress").innerHTML = `<div class="cx-meter" role="img" aria-label="${ok} of ${team.length} connected"><span style="width:${Math.round((ok / Math.max(1, team.length)) * 100)}%"></span></div>
    <p><b class="tnum">${ok} of ${team.length}</b> things your team asked for are connected. <span class="muted">For your clients: <span class="tnum">${cOk} of ${clients.length}</span>. Platform services: <span class="tnum">${pOk} of ${platform.length}</span> working.</span></p>
    <ul class="cx-jump">${view.connections.map((c) => `<li><a href="#c-${esc(c.key)}">${statusBadge(c.status)}<span>${esc(c.title)}</span></a></li>`).join("")}</ul>`;
  $("cx-temp").hidden = !live || view.persistent;
}

function render(): void {
  summary();
  for (const g of GROUPS) $(g.id).innerHTML = inGroup(g.groups).map(card).join("");
}

/** New data from the server. Cards with half-typed changes are left alone, except the one just acted on. */
function setView(v: View, acted: string): void {
  view = v;
  summary();
  for (const c of v.connections) {
    const el = document.getElementById(`c-${c.key}`);
    if (!el) continue;
    if (c.key !== acted && el.querySelector("form[data-dirty]")) continue;
    const wasOpen = el.querySelector("details")?.open;
    el.outerHTML = card(c);
    if (wasOpen) document.getElementById(`c-${c.key}`)?.querySelector("details")?.setAttribute("open", "");
  }
}

const msg = (key: string, text: string) => { const el = document.getElementById(`m-${key}`); if (el) el.textContent = text; };
function focusCard(key: string): void { document.getElementById(`c-${key}`)?.focus({ preventScroll: true }); }

async function call(path: string, key: string, init: { method?: string; body?: unknown }, busy: string): Promise<{ ok: boolean; data?: any }> {
  if (!live) { toast("This is example data. Log in as the platform owner to connect for real."); return { ok: false }; }
  msg(key, busy);
  const r = await api<View & { error?: string; message?: string }>(path, init);
  if (r.status === 0) { msg(key, "The server could not be reached. Nothing was changed."); return { ok: false }; }
  if (!r.ok) { msg(key, r.data?.error ?? "That did not work. Nothing was changed."); return { ok: false, data: r.data }; }
  if (r.data?.connections) { setView(r.data, key); focusCard(key); }
  return { ok: true, data: r.data };
}

document.addEventListener("submit", async (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const key = form.dataset.form!;
  const fields: Record<string, string> = {};
  form.querySelectorAll<HTMLInputElement>("input[name]").forEach((i) => { fields[i.name] = i.value; });
  const r = await call(`/owner/connections/${key}`, key, { method: "PUT", body: { fields } }, "Saving…");
  if (r.ok) {
    const c = view.connections.find((x) => x.key === key);
    msg(key, c?.status === "connected" ? "Saved. Now press Test connection." : `Saved. Still needed: ${c?.missing.join(", ")}.`);
  }
});

document.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLButtonElement>("button");
  if (!btn) return;
  if (btn.dataset.test) {
    const key = btn.dataset.test;
    btn.disabled = true;
    await call(`/owner/connections/${key}/test`, key, { method: "POST", body: {} }, "Testing with a harmless read…");
    btn.disabled = false;
  } else if (btn.dataset.disconnect) {
    const key = btn.dataset.disconnect;
    const c = view.connections.find((x) => x.key === key);
    if (btn.dataset.sure !== "1") { btn.dataset.sure = "1"; btn.textContent = `Yes, disconnect ${c?.title ?? ""}`; msg(key, "Press again to remove the saved details. The agent stops using them at once."); return; }
    const r = await call(`/owner/connections/${key}/disconnect`, key, { method: "POST", body: {} }, "Removing…");
    if (r.ok) msg(key, "Disconnected. The saved details were removed.");
  } else if (btn.dataset.sendtest) {
    const r = await call("/owner/connections/whatsapp/send-test", "whatsapp", { method: "POST", body: {} }, "Sending…");
    if (r.ok) msg("whatsapp", r.data?.message ?? "Sent.");
  } else if (btn.dataset.clear) {
    const [key, field] = btn.dataset.clear.split(":");
    const r = await call(`/owner/connections/${key}`, key!, { method: "PUT", body: { fields: {}, clear: [field] } }, "Removing…");
    if (r.ok) msg(key!, "Removed.");
  } else if (btn.dataset.gen) {
    const input = $<HTMLInputElement>(btn.dataset.gen);
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const bytes = crypto.getRandomValues(new Uint8Array(28));
    input.value = Array.from(bytes, (b) => abc[b % abc.length]).join("");
    input.focus();
  } else if (btn.dataset.copy) {
    const text = document.getElementById(btn.dataset.copy)?.textContent ?? "";
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; } catch { toast("Copy did not work here. Select the text and copy it."); }
    setTimeout(() => { btn.textContent = "Copy"; }, 1800);
  }
});

document.addEventListener("input", (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>("form[data-form]");
  if (form) form.dataset.dirty = "1";
});

document.addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  if (box.dataset.step) writeTick(box.dataset.step, box.checked);
});

void (async () => {
  const loaded = await ownerLoad<View>("/owner/connections");
  if (loaded === undefined) return;
  if (loaded === "demo") { view = DEMO; markDemo(); } else { view = loaded; live = true; }
  render();
  const hash = location.hash.slice(1);
  if (hash) { const el = document.getElementById(hash); if (el) { el.scrollIntoView(); el.focus({ preventScroll: true }); el.querySelector("details")?.setAttribute("open", ""); } }
})();
