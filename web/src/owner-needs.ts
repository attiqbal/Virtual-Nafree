// "What I need from you": a team member's own request for the connections it depends on, shown at the top of the
// owner's workbench pages (promotion agent, community growth, decisions, my AI team). It reads the same list as the
// Connections page, so a badge here always matches the card there.
import { api } from "./api";
import { esc } from "./owner-common";
import { CATALOG } from "../../src/modules/connections/catalog";

export type ConnStatus = "connected" | "not_connected" | "error";
export interface ConnSummary { key: string; title: string; status: ConnStatus; statusText: string; usedBy: string[]; editable?: boolean; lastTest?: { ok: boolean } }

export const STATUS_LABEL: Record<ConnStatus, string> = { connected: "Connected", not_connected: "Not connected", error: "Error" };
const STATUS_CLASS: Record<ConnStatus, string> = { connected: "good", not_connected: "warn", error: "crit" };

export const statusBadge = (s: ConnStatus): string => `<span class="cx-badge cx-${s}"><span class="dot" aria-hidden="true"></span>${STATUS_LABEL[s]}</span>`;

let cached: Promise<ConnSummary[] | undefined> | undefined;
/** The owner's connections, or undefined when the API is not reachable (example pages then show everything unconnected). */
export function loadConnections(): Promise<ConnSummary[] | undefined> {
  cached ??= api<{ connections: ConnSummary[] }>("/owner/connections").then((r) => (r.ok && r.data ? r.data.connections : undefined));
  return cached;
}

/** Example list for pages shown without the API: everything not connected yet. */
export const exampleConnections = (): ConnSummary[] => CATALOG.map((c) => ({ key: c.key, title: c.title, status: "not_connected", statusText: "Not connected yet.", usedBy: [...c.usedBy], editable: c.editable }));

export interface Speaker { name: string; avatar: string; initials: string; asks: string; /** The face is already shown just above (My AI team), so leave it out here. */ noFace?: boolean }

/**
 * Renders the speaker's request into `el`: their words, then one line per connection they use with its status
 * and a link straight to its card on the Connections page. When everything works it says so in one line.
 */
export async function renderNeeds(el: HTMLElement, agent: string, who: Speaker): Promise<ConnSummary[]> {
  const all = (await loadConnections()) ?? exampleConnections();
  const mine = all.filter((c) => c.usedBy.includes(agent));
  if (!mine.length) { el.hidden = true; return mine; }
  const missing = mine.filter((c) => c.status !== "connected");
  const words = missing.length ? who.asks : "Everything I need is connected and working. Thank you.";
  el.hidden = false;
  el.className = `asks${missing.length ? "" : " asks-done"}${who.noFace ? " asks-noface" : ""}`;
  el.innerHTML = `${who.noFace ? "" : `<span class="av av-lg ${esc(who.avatar)}" aria-hidden="true">${esc(who.initials)}</span>`}
    <div class="ask-bubble">
      <p><b>${esc(who.name)}:</b> ${esc(words)}</p>
      <ul class="ask-list">${mine.map((c) => `<li>${statusBadge(c.status)}<span class="ask-t">${esc(c.title)}</span>
        <a class="btn btn-sm ${c.status === "connected" ? "btn-quiet" : "btn-primary"}" href="/owner-connections.html#c-${esc(c.key)}">${c.status === "connected" ? "Check" : c.status === "error" ? "Fix" : c.editable === false ? "See how" : "Connect"}<span class="sr-only"> ${esc(c.title)}</span></a></li>`).join("")}</ul>
    </div>`;
  return mine;
}
