import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * WhatsApp Business Cloud API client for talking to the platform owner. Secrets come from the server's
 * environment and travel only in an Authorization header; nothing here logs a token or a message body.
 */
export interface WhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  /** The Meta app secret: signs every webhook call. Required, so unsigned calls can never be accepted. */
  appSecret: string;
  /** The string you typed into Meta's webhook setup page. */
  verifyToken: string;
  /** The owner's own number, digits only with country code. The only number that may command the agent. */
  ownerNumber: string;
  /** Pre-approved template for messages sent outside the 24-hour window (one body variable). */
  alertTemplate: { name: string; language: string };
  version?: string;
}

export class WhatsAppError extends Error {}

export interface Inbound { id: string; from: string; type: string; text?: string }

/** Digits only, 8 to 15 of them (E.164 without the plus). Undefined when it is not a phone number. */
export function normalizeNumber(v: string): string | undefined {
  const d = v.replace(/[\s()+.-]/g, "");
  return /^\d{8,15}$/.test(d) ? d : undefined;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class WhatsAppCloud {
  constructor(readonly cfg: WhatsAppConfig, private readonly http: typeof fetch = fetch) {}

  /** The X-Hub-Signature-256 header is an HMAC of the exact request bytes. */
  verifySignature(rawBody: string, header: string | undefined): boolean {
    if (!header?.startsWith("sha256=")) return false;
    return same(header.slice(7), createHmac("sha256", this.cfg.appSecret).update(rawBody).digest("hex"));
  }

  /** Meta's one-time GET handshake when you save the webhook. Returns the challenge to echo, or undefined to refuse. */
  handshake(query: URLSearchParams): string | undefined {
    const challenge = query.get("hub.challenge");
    if (query.get("hub.mode") !== "subscribe" || !challenge || !same(query.get("hub.verify_token") ?? "", this.cfg.verifyToken)) return undefined;
    return challenge.slice(0, 200);
  }

  /** Text messages (and a marker for other kinds) from a webhook body. Delivery receipts and the rest are ignored. */
  static inbound(payload: unknown): Inbound[] {
    const out: Inbound[] = [];
    const entries = (payload as any)?.entry;
    if (!Array.isArray(entries)) return out;
    for (const e of entries) for (const c of Array.isArray(e?.changes) ? e.changes : []) {
      for (const m of Array.isArray(c?.value?.messages) ? c.value.messages : []) {
        if (typeof m?.id !== "string" || typeof m?.from !== "string") continue;
        out.push({ id: m.id, from: m.from.replace(/\D/g, ""), type: String(m.type ?? ""), text: m.type === "text" && typeof m.text?.body === "string" ? m.text.body.slice(0, 2000) : undefined });
      }
    }
    return out;
  }

  /** A harmless read of the business number, for the Connections page's test button. */
  async phoneInfo(): Promise<{ number?: string; name?: string; quality?: string; nameStatus?: string }> {
    let res: Response;
    try {
      res = await this.http(`https://graph.facebook.com/${this.cfg.version ?? "v23.0"}/${this.cfg.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,name_status`, {
        headers: { authorization: `Bearer ${this.cfg.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new WhatsAppError("WhatsApp could not be reached");
    }
    let j: any;
    try { j = await res.json(); } catch { j = undefined; }
    if (!res.ok || j?.error) throw new WhatsAppError(`Meta said no: ${String(j?.error?.message ?? `error ${res.status}`).replace(this.cfg.accessToken, "[token]").slice(0, 200)}`);
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 80) : undefined);
    return { number: str(j?.display_phone_number), name: str(j?.verified_name), quality: str(j?.quality_rating), nameStatus: str(j?.name_status) };
  }

  private async send(body: Record<string, unknown>): Promise<void> {
    let res: Response;
    try {
      res = await this.http(`https://graph.facebook.com/${this.cfg.version ?? "v23.0"}/${this.cfg.phoneNumberId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.cfg.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: this.cfg.ownerNumber, ...body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new WhatsAppError("WhatsApp could not be reached");
    }
    if (!res.ok) {
      let reason = `error ${res.status}`;
      try { reason = String(((await res.json()) as any)?.error?.message ?? reason).replace(this.cfg.accessToken, "[token]").slice(0, 200); } catch { /* keep the status */ }
      throw new WhatsAppError(`WhatsApp refused the message: ${reason}`);
    }
  }

  /** Free-form text. Only allowed inside the 24 hours after the owner last wrote. */
  sendText(text: string): Promise<void> {
    return this.send({ type: "text", text: { body: text.slice(0, 4000), preview_url: false } });
  }

  /** The approved alert template, which is the only thing WhatsApp lets us start a conversation with. */
  sendAlert(summary: string): Promise<void> {
    const oneLine = summary.replace(/[\n\r\t]+/g, " ").replace(/ {5,}/g, "    ").slice(0, 900);
    return this.send({ type: "template", template: { name: this.cfg.alertTemplate.name, language: { code: this.cfg.alertTemplate.language }, components: [{ type: "body", parameters: [{ type: "text", text: oneLine }] }] } });
  }
}
