import type { Sink } from "../../core/persistence.js";
import { PromoterError, PromoterService, type DraftItem } from "../promoter/index.js";
import { WhatsAppCloud, type Inbound } from "./cloud.js";

/** WhatsApp only allows free-form messages for 24 hours after the person last wrote. A margin keeps us safely inside it. */
export const WINDOW_MS = 24 * 3_600_000;
export const WINDOW_MARGIN_MS = 10 * 60_000;
const MAX_REMEMBERED = 500;

interface State { lastOwnerMessageAt?: string; notified: string[]; seen: string[] }

export interface OwnerBotOptions { ownerUserId: string; now?: () => Date }

const HELP = [
  "What I understand:",
  "LIST: what is waiting for you",
  "SHOW code: the full text",
  "APPROVE code / REJECT code reason",
  "POST code FB, or POST code IG image-link: publish an approved social post",
  "SEND code: send an approved email",
  "Nothing goes out unless you approve it here or on the website.",
].join("\n");

/**
 * The platform owner's WhatsApp line to the promotion agent. It tells the owner what is waiting and lets the
 * owner approve or reject by replying. Only the owner's own number is ever obeyed; every other sender is ignored.
 */
export class OwnerWhatsApp {
  private state: State = { notified: [], seen: [] };
  private sink?: Sink;
  private busy = false;
  private again = false;

  constructor(private readonly wa: WhatsAppCloud, private readonly promoter: PromoterService, private readonly opts: OwnerBotOptions) {}

  useSink(sink: Sink): void { this.sink = sink; }
  restore(data: any): void {
    this.state = { lastOwnerMessageAt: typeof data?.lastOwnerMessageAt === "string" ? data.lastOwnerMessageAt : undefined, notified: Array.isArray(data?.notified) ? data.notified.map(String) : [], seen: Array.isArray(data?.seen) ? data.seen.map(String) : [] };
  }
  /** The line's memory (24-hour window, what was announced), so a rebuilt line after new settings carries on. */
  exportState(): unknown { return { ...this.state }; }
  /** The Connections page's test: free text inside the 24-hour window, otherwise the approved template. */
  async sendTest(): Promise<"text" | "template"> {
    if (this.windowOpen()) {
      await this.wa.sendText("MAIZ Agents: this is a test from your Connections page. Your WhatsApp line to the promotion agent works. Send HELP to see what I understand.");
      return "text";
    }
    await this.wa.sendAlert("test from your Connections page. Your WhatsApp line works. Reply HELLO to see what is waiting.");
    return "template";
  }
  /** A harmless read of the business number, for the test button. */
  phoneInfo() { return this.wa.phoneInfo(); }
  private now(): Date { return this.opts.now?.() ?? new Date(); }
  private save(next: State): void {
    this.state = { ...next, notified: next.notified.slice(-MAX_REMEMBERED), seen: next.seen.slice(-MAX_REMEMBERED) };
    this.sink?.promo("channel", "whatsapp", this.state);
  }
  windowOpen(): boolean {
    const at = this.state.lastOwnerMessageAt ? Date.parse(this.state.lastOwnerMessageAt) : NaN;
    return Number.isFinite(at) && this.now().getTime() - at < WINDOW_MS - WINDOW_MARGIN_MS;
  }
  status(): { connected: true; windowOpen: boolean } { return { connected: true, windowOpen: this.windowOpen() }; }

  handshake(query: URLSearchParams): string | undefined { return this.wa.handshake(query); }
  verifySignature(rawBody: string, header: string | undefined): boolean { return this.wa.verifySignature(rawBody, header); }
  /** A verified webhook body. */
  async handle(payload: unknown): Promise<void> { await this.handleInbound(WhatsAppCloud.inbound(payload)); }

  // ------------------------------------------------------------ outgoing

  /** Tells the owner about anything new that waits for approval. Safe to call often: each item is announced once. */
  async notifyWaiting(): Promise<void> {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do {
        this.again = false;
        const w = this.promoter.waiting(this.opts.ownerUserId);
        const fresh = w.drafts.filter((d) => !this.state.notified.includes(d.id));
        const plans = w.plans.filter((c) => !this.state.notified.includes(c.id));
        if (!fresh.length && !plans.length) continue;
        const summary = [
          ...fresh.map((d) => `${PromoterService.shortCode(d.id)}: ${d.site} ${d.channel}, ${d.title}`),
          ...plans.map((c) => `Campaign plan: ${c.name} (approve on the website)`),
        ];
        try {
          if (this.windowOpen()) await this.wa.sendText(`Waiting for you:\n${summary.join("\n")}\n\nReply SHOW code to read one, APPROVE code or REJECT code. LIST shows everything.`);
          else await this.wa.sendAlert(`${fresh.length + plans.length} waiting for your approval. Reply HELLO to read them. ${summary.slice(0, 3).join(" | ")}`);
        } catch (e) {
          console.error("whatsapp alert failed:", e instanceof Error ? e.message : e);
          return;
        }
        this.save({ ...this.state, notified: [...this.state.notified, ...fresh.map((d) => d.id), ...plans.map((c) => c.id)] });
      } while (this.again);
    } finally { this.busy = false; }
  }

  // ------------------------------------------------------------ incoming

  /** Handles a verified webhook body. Returns how many messages came from the owner. */
  async handleInbound(messages: Inbound[]): Promise<number> {
    let fromOwner = 0;
    for (const m of messages) {
      if (m.from !== this.wa.cfg.ownerNumber) continue; // anyone else: ignored, not even answered
      if (this.state.seen.includes(m.id)) continue; // Meta retries deliveries
      fromOwner++;
      this.save({ ...this.state, lastOwnerMessageAt: this.now().toISOString(), seen: [...this.state.seen, m.id] });
      const reply = m.text === undefined ? "I only read text messages. Send HELP to see what I understand." : await this.command(m.text);
      try { await this.wa.sendText(reply); } catch (e) { console.error("whatsapp reply failed:", e instanceof Error ? e.message : e); }
    }
    return fromOwner;
  }

  private async command(raw: string): Promise<string> {
    const [verbRaw = "", codeRaw = "", ...rest] = raw.trim().split(/\s+/);
    const verb = verbRaw.toLowerCase().replace(/[^a-z?]/g, "");
    const code = codeRaw.toLowerCase();
    const owner = this.opts.ownerUserId;
    const find = (statuses: DraftItem["status"][]): DraftItem | undefined => (code ? this.promoter.findByCode(owner, code, statuses) : undefined);
    try {
      if (["", "hello", "hi", "list", "status", "waiting"].includes(verb)) return this.list();
      if (verb === "help" || verb === "?") return HELP;
      if (verb === "show") {
        const d = find(["awaiting_approval", "approved"]);
        return d ? `${d.site} ${d.channel}${d.subject ? `\nSubject: ${d.subject}` : ""}\n\n${d.body}${d.flags.length ? `\n\nCheck: ${d.flags.join("; ")}` : ""}` : "I could not find that code. Send LIST.";
      }
      if (verb === "approve" || verb === "yes") {
        const d = find(["awaiting_approval"]);
        if (!d) return "I could not find a draft with that code waiting for approval. Send LIST.";
        this.promoter.decide(owner, d.id, true);
        return `Approved ${PromoterService.shortCode(d.id)}. Nothing has gone out yet. ${d.channel === "email" ? `Reply SEND ${code} to send it.` : d.channel === "social" || d.channel === "community" ? `Reply POST ${code} FB (or IG with an image link) to publish it, or publish it yourself.` : "Publish it yourself, then mark it posted on the website."}`;
      }
      if (verb === "reject" || verb === "no") {
        const d = find(["awaiting_approval", "approved"]);
        if (!d) return "I could not find that draft. Send LIST.";
        this.promoter.decide(owner, d.id, false, rest.join(" ") || undefined);
        return `Rejected ${PromoterService.shortCode(d.id)}.`;
      }
      if (verb === "send") {
        const d = find(["approved"]);
        if (!d) return "Only an approved email can be sent. Approve it first.";
        await this.promoter.send(owner, d.id);
        return "Email handed to the mail queue. It goes out within a minute or so.";
      }
      if (verb === "post") {
        const d = find(["approved"]);
        if (!d) return "Only an approved social post can be published. Approve it first.";
        const where = (rest[0] ?? "").toLowerCase();
        const target = ["fb", "facebook"].includes(where) ? "facebook" : ["ig", "instagram"].includes(where) ? "instagram" : undefined;
        if (!target) return `Say where: POST ${code} FB, or POST ${code} IG image-link.`;
        const out = await this.promoter.publishToMeta(owner, d.id, { target, imageUrl: rest[1] });
        return `Published: ${out.postedUrl}`;
      }
      return `I did not understand that.\n\n${HELP}`;
    } catch (e) {
      if (e instanceof PromoterError) return `Not done: ${e.message}`;
      console.error("whatsapp command failed:", e instanceof Error ? e.message : e);
      return "Something went wrong and nothing was changed. Try on the website.";
    }
  }

  private list(): string {
    const w = this.promoter.waiting(this.opts.ownerUserId);
    if (!w.drafts.length && !w.plans.length) return "Nothing is waiting for you.";
    const lines = w.drafts.slice(0, 10).map((d) => `${PromoterService.shortCode(d.id)}: ${d.site} ${d.channel}, ${d.title}${d.flags.length ? " (has warnings: SHOW it first)" : ""}`);
    if (w.drafts.length > 10) lines.push(`...and ${w.drafts.length - 10} more on the website.`);
    if (w.plans.length) lines.push(`${w.plans.length} campaign plan(s) wait on the website: plans and budgets are approved there.`);
    return `Waiting for you:\n${lines.join("\n")}\n\nSHOW code, APPROVE code or REJECT code.`;
  }
}
