// My AI team (owner-team.html): the platform owner's own AI specialists, met as people. Each one introduces itself,
// says what it is doing now and what waits for you, asks for whatever it still needs connected, and keeps its job
// description one click away. They are not store products and never appear in a client's package.
import "./styles.css";
import { initNav } from "./common";
import { jdHtml } from "./jd";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { renderNeeds } from "./owner-needs";
import { OWNER_SPECIALISTS, type OwnerSpecialist } from "../../src/modules/promoter/owner-team";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Row = OwnerSpecialist & { status?: { waiting: number; doing: string; due: number } };
const INITIALS: Record<string, string> = { "promotion-agent": "PA", "community-growth-manager": "CG" };
const SHORT: Record<string, string> = { "promotion-agent": "Promotion agent", "community-growth-manager": "Community growth manager" };

function render(rows: Row[]): void {
  $("tm-list").innerHTML = rows.map((s) => {
    const waiting = s.status?.waiting ?? 0;
    return `<section class="panel" aria-labelledby="${esc(s.key)}-h">
    <div class="intro"><span class="av av-xl ${esc(s.avatar)}" aria-hidden="true">${esc(INITIALS[s.key] ?? "AI")}</span>
      <div class="ow-stack" style="gap:8px"><h2 id="${esc(s.key)}-h" class="cx-group-h" style="margin:0">${esc(s.title)}</h2>
      <p>"${esc(s.intro)}"</p></div></div>
    ${s.status ? `<div class="kpis kpis-3">
      <div class="tile-kpi"><span class="l">Waiting for your yes</span><span class="v tnum">${waiting}</span><span class="dl">${waiting ? "Open my workbench to decide" : "Nothing needs you"}</span></div>
      <div class="tile-kpi"><span class="l">What I am working on</span><span class="v" style="font-size:18px">${esc(s.status.doing)}</span></div>
      <div class="tile-kpi"><span class="l">Follow-ups due</span><span class="v tnum">${s.status.due}</span><span class="dl">${s.status.due ? "Drafted, waiting for you" : "None due"}</span></div></div>` : ""}
    <div class="asks" id="needs-${esc(s.key)}" hidden role="region" aria-label="What the ${esc(SHORT[s.key] ?? s.title)} needs from you"></div>
    <div class="acts"><a class="btn btn-primary" href="${esc(s.page)}">${waiting ? `See the ${waiting} waiting` : "Open my workbench"}<span class="sr-only"> for ${esc(s.title)}</span></a></div>
    <details><summary>My job description</summary>${jdHtml(s.jobDescription, 3)}</details></section>`;
  }).join("");
  for (const s of rows) void renderNeeds($(`needs-${s.key}`), s.key, { name: SHORT[s.key] ?? s.title, avatar: s.avatar, initials: INITIALS[s.key] ?? "AI", asks: s.asks, noFace: true });
}

void (async () => {
  const loaded = await ownerLoad<{ specialists: Row[] }>("/owner/team");
  if (loaded === undefined) return;
  if (loaded === "demo") markDemo();
  render(loaded === "demo" ? [...OWNER_SPECIALISTS] : loaded.specialists);
})();
