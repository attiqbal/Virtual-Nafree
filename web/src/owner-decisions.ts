// Decisions (owner-decisions.html): everything waiting for the platform owner in one list. The email button
// lands here. Without an API the page shows two labelled examples.
import "./styles.css";
import { initNav } from "./common";
import { esc, initOwnerNav, markDemo, ownerLoad } from "./owner-common";
import { renderNeeds } from "./owner-needs";

initNav();
initOwnerNav();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface Decision { kind: "review" | "specialist" | "promotion"; id: string; title: string; clientName: string; ageHours: number; link: string }

const DEMO: Decision[] = [
  { kind: "specialist", id: "eg-s", title: "Wholesale account coordinator", clientName: "Kestrel Coffee", ageHours: 30, link: "/owner-specialists.html" },
  { kind: "review", id: "eg-r", title: "Brand kit for the autumn range", clientName: "Northside Bikes", ageHours: 3, link: "/review.html" },
];
const KIND = { review: "Quality review", specialist: "New specialist", promotion: "Promotion" } as const;
const age = (h: number) => (h < 1 ? "under an hour" : h < 48 ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.floor(h / 24)} days`);

function render(items: Decision[]): void {
  const reviews = items.filter((i) => i.kind === "review").length;
  const promos = items.filter((i) => i.kind === "promotion").length;
  const tile = (label: string, value: string, note: string) => `<div class="tile-kpi"><span class="l">${esc(label)}</span><span class="v">${esc(value)}</span><span class="dl">${esc(note)}</span></div>`;
  $("dc-kpis").innerHTML = [
    tile("Waiting for you", String(items.length), items.length ? "Oldest first" : "Nothing needs you"),
    tile("Quality reviews", String(reviews), "Specialised tasks to sign off"),
    tile("New specialists", String(items.length - reviews - promos), "Roles to check and price"),
    tile("Promotion", String(promos), "Drafts and plans for your websites"),
  ].join("");
  $("dc-table").innerHTML = items.length
    ? `<thead><tr><th scope="col">Request</th><th scope="col">Type</th><th scope="col">Client</th><th scope="col">Waiting</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead><tbody>${items.map((i) => `<tr><td>${esc(i.title)}</td><td>${KIND[i.kind]}</td><td>${esc(i.clientName)}</td><td class="mono">${age(i.ageHours)}</td><td><a class="btn btn-ghost" href="${esc(i.link)}">Decide<span class="sr-only"> on ${esc(i.title)}</span></a></td></tr>`).join("")}</tbody>`
    : `<tbody><tr><td class="muted">Nothing is waiting for you.</td></tr></tbody>`;
}

void (async () => {
  const data = await ownerLoad<{ items: Decision[] }>("/owner/decisions");
  if (!data) return;
  void renderNeeds($("needs"), "decisions", { name: "Your decisions desk", avatar: "av-tl", initials: "DD", asks: "I tell you when something waits for your yes: a daily email, and a WhatsApp message if you connect it. Email needs the sending service working; WhatsApp needs your line connected." });
  if (data === "demo") { markDemo(); render(DEMO); return; }
  render(data.items);
})();
