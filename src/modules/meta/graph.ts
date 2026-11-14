import { createHmac } from "node:crypto";

/**
 * Meta Graph API client for the owner's own Facebook Page and Instagram professional account.
 * It only publishes what it is told to; the approval gate lives in the promoter service. The token comes
 * from the server's environment and goes in an Authorization header, never in a URL, a log line or an error.
 */
export type MetaTarget = "facebook" | "instagram";

export interface MetaConfig {
  accessToken: string;
  pageId?: string;
  instagramId?: string;
  /** The Meta app secret. When set, every call carries appsecret_proof so a leaked token alone is not enough. */
  appSecret?: string;
  version?: string;
}

/** Meta refused the request in words (a definite "no": nothing was published). */
export class MetaRejected extends Error {}
/** The call may or may not have reached Meta (timeout, dropped connection). Check the page before trying again. */
export class MetaUncertain extends Error {}

export interface PublishInput { target: MetaTarget; message: string; imageUrl?: string; linkUrl?: string; scheduleAt?: Date }
export interface Published { id: string; url: string; scheduledFor?: string }
export interface PostStats { likes: number; comments: number; shares?: number; fetchedAt: string }

export const FACEBOOK_MAX = 20_000;
export const INSTAGRAM_MAX = 2_200;
export const MIN_SCHEDULE_MS = 10 * 60_000;
export const MAX_SCHEDULE_MS = 30 * 86_400_000;

/** Why this cannot be published, in plain words. Empty when it can. Checked before anything is sent. */
export function publishProblems(i: PublishInput, now: Date): string[] {
  const out: string[] = [];
  if (!i.message.trim()) out.push("the post has no text");
  if (i.target === "instagram") {
    if (!i.imageUrl) out.push("Instagram posts need a picture: add an image link");
    if (i.message.length > INSTAGRAM_MAX) out.push(`Instagram captions are at most ${INSTAGRAM_MAX} characters`);
    if ((i.message.match(/#\w+/g) ?? []).length > 30) out.push("Instagram allows at most 30 hashtags");
    if (i.scheduleAt) out.push("Instagram posts cannot be scheduled from here. Publish now, or schedule on Facebook");
  } else if (i.message.length > FACEBOOK_MAX) out.push(`Facebook posts are at most ${FACEBOOK_MAX} characters`);
  for (const [label, u] of [["image", i.imageUrl], ["link", i.linkUrl]] as const) {
    if (u !== undefined && !/^https:\/\/[^\s]{3,1000}$/.test(u)) out.push(`the ${label} address must start with https://`);
  }
  if (i.scheduleAt) {
    const ahead = i.scheduleAt.getTime() - now.getTime();
    if (!Number.isFinite(ahead) || ahead < MIN_SCHEDULE_MS) out.push("a scheduled time must be at least 10 minutes from now");
    else if (ahead > MAX_SCHEDULE_MS) out.push("a scheduled time must be within 30 days");
  }
  return out;
}

export class MetaGraph {
  constructor(private readonly cfg: MetaConfig, private readonly http: typeof fetch = fetch) {}

  /** Which targets are connected, for the owner's page. Never includes a secret. */
  status(): { facebook: boolean; instagram: boolean } {
    return { facebook: !!this.cfg.pageId, instagram: !!this.cfg.instagramId };
  }

  private base(): string { return `https://graph.facebook.com/${this.cfg.version ?? "v23.0"}`; }

  private async call(method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<any> {
    const all: Record<string, string> = { ...params };
    if (this.cfg.appSecret) all.appsecret_proof = createHmac("sha256", this.cfg.appSecret).update(this.cfg.accessToken).digest("hex");
    const qs = new URLSearchParams(all).toString();
    let res: Response;
    try {
      res = await this.http(method === "GET" ? `${this.base()}${path}?${qs}` : `${this.base()}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.cfg.accessToken}`, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
        body: method === "POST" ? qs : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new MetaUncertain("Meta did not answer, so it is not known whether this went out. Check the page before trying again.");
    }
    let json: any;
    try { json = await res.json(); } catch { json = undefined; }
    if (!res.ok || json?.error) {
      const reason = String(json?.error?.error_user_msg ?? json?.error?.message ?? `error ${res.status}`).replace(this.cfg.accessToken, "[token]").slice(0, 300);
      // A server fault after we sent a write is unclear; a 4xx with a Graph error is a definite refusal.
      if (res.status >= 500 && method === "POST") throw new MetaUncertain(`Meta had a fault (${reason}). Check the page before trying again.`);
      throw new MetaRejected(`Meta said no: ${reason}`);
    }
    return json;
  }

  /** A harmless read of one object (a Page or an Instagram account) for the Connections page's test button. */
  async lookup(id: string, fields: string): Promise<Record<string, unknown>> {
    if (!/^\d{5,25}$/.test(id)) throw new MetaRejected("that id is not a number");
    return (await this.call("GET", `/${id}`, { fields })) ?? {};
  }

  /** The token's own permissions, when Meta will say. Undefined when it will not (not every token can read this). */
  async scopes(): Promise<string[] | undefined> {
    try {
      const r = await this.call("GET", "/me/permissions");
      return Array.isArray(r?.data) ? r.data.filter((p: any) => p?.status === "granted").map((p: any) => String(p.permission)) : undefined;
    } catch {
      return undefined;
    }
  }

  async publish(i: PublishInput): Promise<Published> {
    return i.target === "facebook" ? this.publishFacebook(i) : this.publishInstagram(i);
  }

  private async publishFacebook(i: PublishInput): Promise<Published> {
    const pageId = this.cfg.pageId;
    if (!pageId) throw new MetaRejected("Facebook is not connected yet: add your Page on the Connections page");
    const scheduled: Record<string, string> = i.scheduleAt ? { published: "false", scheduled_publish_time: String(Math.floor(i.scheduleAt.getTime() / 1000)) } : {};
    const r = i.imageUrl
      ? await this.call("POST", `/${pageId}/photos`, { url: i.imageUrl, caption: i.message, ...scheduled })
      : await this.call("POST", `/${pageId}/feed`, { message: i.message, ...(i.linkUrl ? { link: i.linkUrl } : {}), ...scheduled });
    const id = String(r?.post_id ?? r?.id ?? "");
    if (!id) throw new MetaUncertain("Meta accepted the request but returned no post id. Check the page before trying again.");
    return { id, url: `https://www.facebook.com/${id}`, scheduledFor: i.scheduleAt?.toISOString() };
  }

  private async publishInstagram(i: PublishInput): Promise<Published> {
    const igId = this.cfg.instagramId;
    if (!igId) throw new MetaRejected("Instagram is not connected yet: add your account on the Connections page");
    // Two steps: make the media container, then publish it. A failure at step one publishes nothing.
    const container = await this.call("POST", `/${igId}/media`, { image_url: i.imageUrl!, caption: i.message });
    const published = await this.call("POST", `/${igId}/media_publish`, { creation_id: String(container?.id) });
    const id = String(published?.id ?? "");
    if (!id) throw new MetaUncertain("Meta accepted the request but returned no post id. Check the account before trying again.");
    let url = "https://www.instagram.com/";
    try { const m = await this.call("GET", `/${id}`, { fields: "permalink" }); if (typeof m?.permalink === "string" && m.permalink.startsWith("https://")) url = m.permalink; } catch { /* the post is live; the link is a nicety */ }
    return { id, url };
  }

  /** Basic engagement for one published post: likes, comments, shares. */
  async stats(target: MetaTarget, id: string, now: Date): Promise<PostStats> {
    if (!/^[\w-]{1,80}$/.test(id)) throw new MetaRejected("that post id is not valid");
    if (target === "instagram") {
      const r = await this.call("GET", `/${id}`, { fields: "like_count,comments_count" });
      return { likes: Number(r.like_count ?? 0), comments: Number(r.comments_count ?? 0), fetchedAt: now.toISOString() };
    }
    const r = await this.call("GET", `/${id}`, { fields: "reactions.summary(true).limit(0),comments.summary(true).limit(0),shares" });
    return { likes: Number(r.reactions?.summary?.total_count ?? 0), comments: Number(r.comments?.summary?.total_count ?? 0), shares: Number(r.shares?.count ?? 0), fetchedAt: now.toISOString() };
  }
}
