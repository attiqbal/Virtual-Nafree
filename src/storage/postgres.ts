import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import pg from "pg";
import { GENERIC_KINDS, type GenericKind, type PromoKind, type Sink, type Snapshot } from "../core/persistence.js";
import type { AuditEvent } from "../modules/audit/index.js";
import type { Connection } from "../modules/channels/index.js";
import type { EnergyPlan, UsageRecord } from "../modules/energy/index.js";
import type { Role, Workspace } from "../modules/identity/index.js";
import type { AdminMessage, AdminOrgRecord } from "../modules/admin-manager/index.js";
import type { Account, JournalEntry } from "../modules/ledger/index.js";
import type { BusinessProfile, Employee } from "../modules/workforce/index.js";
import type { IntegrationConnection, StoredRecord } from "../modules/integrations/service.js";
import type { ReviewItem } from "../modules/review/index.js";
import type { StaffMember, DeskSettings as PeopleSettings } from "../modules/people/rules.js";
import type { PriceChange } from "../modules/pricing/index.js";
import type { SpecialistRequest } from "../modules/review/specialists.js";
import type { AiRoutingSettings } from "../modules/model-gateway/routing/settings.js";
import type { BatchJob, BatchRunRecord } from "../modules/batch/service.js";
import type { ClientSchedule } from "../modules/batch/schedule.js";
import type { AiDay } from "../modules/model-gateway/routing/ledger.js";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Dates come back as plain "YYYY-MM-DD" strings and bigints as numbers (all our amounts are far below 2^53).
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

/** Connections for client writes; also how many clients are written at the same time. */
const APP_POOL = 8;
/** Waits before retrying a write while the database is unreachable: about 15 seconds in all. */
const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000];

type BulkTable = "state" | "audit" | "usage";
/** Rows per multi-row statement (Postgres allows 65,535 parameters in one). */
const BULK_ROWS = 1_000;
const BULK_SQL: Record<BulkTable, (values: string) => string> = {
  // updated_at is the statement's clock plus the row's place in it, so rows load back in the order they were made.
  state: (v) => `INSERT INTO state_records(workspace_id, kind, id, data, updated_at) VALUES ${v} ON CONFLICT (workspace_id, kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
  audit: (v) => `INSERT INTO audit_log(workspace_id, at, actor, action, target, data, event_id) VALUES ${v}`,
  usage: (v) => `INSERT INTO energy_usage(workspace_id, employee_id, day, provider, input_tokens, output_tokens, cost_micro, energy, overtime) VALUES ${v}`,
};

/** One multi-row INSERT per busy table, rows in the order they were made. */
async function writeBulk(c: pg.PoolClient, writes: PendingWrite[]): Promise<void> {
  for (const table of ["state", "audit", "usage"] as BulkTable[]) {
    const rows = writes.filter((w) => w.bulk?.table === table).map((w) => w.bulk!.row);
    for (let at = 0; at < rows.length; at += BULK_ROWS) {
      const params: unknown[] = [];
      const values = rows.slice(at, at + BULK_ROWS).map((row, i) => {
        const ph = row.map((v) => { params.push(v); return `$${params.length}`; });
        if (table === "state") ph.push(`clock_timestamp() + ${i} * interval '1 microsecond'`);
        return `(${ph.join(",")})`;
      });
      await c.query(BULK_SQL[table](values.join(",")), params);
    }
  }
}

interface PendingWrite {
  /** Client writes: run inside that client's transaction. */
  workspaceId?: string;
  fn?: (c: pg.PoolClient) => Promise<void>;
  /** Upserts of the same record: only the last one in a round needs writing. */
  key?: string;
  /** A plain row for one of the busy tables, sent with others of its kind as one multi-row statement. */
  bulk?: { table: BulkTable; row: unknown[] };
  /** Platform writes: run in order on the platform connection, alongside client writes unless a barrier. */
  run?: () => Promise<void>;
  barrier?: boolean;
}

/** Keeps every write, except that of several upserts of the same record only the last is kept (in its place). */
function latestPerKey(writes: PendingWrite[]): PendingWrite[] {
  const last = new Map<string, number>();
  writes.forEach((w, i) => { if (w.key) last.set(w.key, i); });
  return writes.filter((w, i) => !w.key || last.get(w.key) === i);
}

/** The database could not be reached or dropped the connection: worth another try. */
function isConnectionError(e: unknown): boolean {
  const code = (e as { code?: string } | undefined)?.code ?? "";
  const msg = e instanceof Error ? e.message : "";
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "53300"].includes(code) || code.startsWith("08") || /Connection terminated|connection timeout/i.test(msg);
}

export interface PgConfig {
  /** Platform role: creates customers and loads everything at start. Bypasses row-level security. */
  adminUrl: string;
  /** Customer role (app_user): every write runs inside one workspace and cannot touch another. */
  appUrl: string;
  /** 32 bytes as 64 hex characters. Encrypts chat bot tokens at rest. */
  tokenKeyHex: string;
}

/** Stores every change in order, behind the in-memory services. A failed write marks the store unhealthy. */
export class PgStore implements Sink {
  private admin: pg.Pool;
  private app: pg.Pool;
  private key: Buffer;
  lastError?: Error;

  constructor(cfg: PgConfig) {
    this.admin = new pg.Pool({ connectionString: cfg.adminUrl, max: 4 });
    this.app = new pg.Pool({ connectionString: cfg.appUrl, max: APP_POOL });
    // An idle connection the database closes (a restart, Neon suspending, a network blip) is reported here.
    // Without a listener Node treats it as an uncaught error and the whole server exits. The pool drops
    // that connection and opens a new one on the next query, so logging it is enough.
    for (const pool of [this.admin, this.app]) pool.on("error", (e) => console.error("storage idle connection lost:", e.message));
    this.key = Buffer.from(cfg.tokenKeyHex, "hex");
    if (this.key.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes as 64 hex characters");
  }

  get healthy(): boolean {
    return !this.lastError;
  }

  /** Waits until everything queued so far is written. */
  async flush(): Promise<void> {
    while (this.active) await this.draining;
  }

  async close(): Promise<void> {
    await this.flush();
    await Promise.all([this.admin.end(), this.app.end()]);
  }

  /** Applies db/*.sql files not yet applied, in name order. */
  async migrate(dir = join(import.meta.dirname, "../../db")): Promise<string[]> {
    await this.admin.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await this.admin.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
    const applied: string[] = [];
    for (const f of readdirSync(dir).filter((n) => /^\d+_.*\.sql$/.test(n)).sort()) {
      if (done.has(f)) continue;
      const c = await this.admin.connect();
      try {
        await c.query("BEGIN");
        await c.query(readFileSync(join(dir, f), "utf8"));
        await c.query("INSERT INTO schema_migrations(name) VALUES ($1)", [f]);
        await c.query("COMMIT");
        applied.push(f);
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
    return applied;
  }

  // ---------- writing ----------
  //
  // Writes are kept in order and sent in rounds. In one round every client's waiting writes go in one
  // transaction for that client, and up to APP_POOL clients are written at the same time. A platform write
  // (a new workspace, a price change) is a barrier: everything queued before it is written first.
  // One transaction per write, one after another, managed about 850 writes a second on a local database and
  // fell far behind with network delay (4 round trips a write); a burst of signups left minutes of writes
  // waiting, which a restart would lose.

  private pending: PendingWrite[] = [];
  private draining?: Promise<void>;

  /**
   * A platform write. `key` marks an upsert (only the last of a round is written). `barrier` makes everything
   * queued before it go first: needed only for a new workspace row, which a client's own writes refer to.
   */
  private queue(job: () => Promise<void>, opts: { key?: string; barrier?: boolean } = {}): void {
    this.push({ run: job, key: opts.key, barrier: opts.barrier });
  }

  /** Runs inside one transaction with the workspace declared, so row-level security applies. */
  private scoped(workspaceId: string, fn: (c: pg.PoolClient) => Promise<void>): void {
    this.push({ workspaceId, fn });
  }

  private bulk(workspaceId: string, table: BulkTable, row: unknown[], key?: string): void {
    this.push({ workspaceId, bulk: { table, row }, key });
  }

  private push(w: PendingWrite): void {
    this.pending.push(w);
    if (!this.active) {
      this.active = true;
      this.draining = this.drain();
    }
  }

  /** True while the drain loop runs; cleared in the same step it sees nothing pending, so no write is stranded. */
  private active = false;

  private async drain(): Promise<void> {
    while (this.pending.length) {
      const round = this.pending;
      this.pending = [];
      let segment: PendingWrite[] = [];
      for (const w of round) {
        if (w.barrier) {
          await this.writeSegment(segment);
          segment = [];
          await this.attempt(w.run!);
        } else segment.push(w);
      }
      await this.writeSegment(segment);
    }
    this.active = false;
  }

  /** Writes a run of client writes: grouped by client, in order within each client, several clients at once. */
  private async writeSegment(segment: PendingWrite[]): Promise<void> {
    if (!segment.length) return;
    const platform = latestPerKey(segment.filter((w) => w.run));
    const platformLane = (async () => { for (const w of platform) await this.attempt(w.run!); })();
    const groups = new Map<string, PendingWrite[]>();
    for (const w of segment) if (!w.run) (groups.get(w.workspaceId!) ?? groups.set(w.workspaceId!, []).get(w.workspaceId!)!).push(w);
    const list = [...groups.entries()].map(([ws, writes]) => [ws, latestPerKey(writes)] as const);
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const [ws, writes] = list[next++]!;
        // All of a client's writes in one transaction; if that fails, each write alone, so one bad row loses only itself.
        const ok = await this.attempt(() => this.transaction(ws, writes), false);
        if (!ok) for (const w of writes) await this.attempt(() => this.transaction(ws, [w]));
      }
    };
    await Promise.all([platformLane, ...Array.from({ length: Math.min(APP_POOL, list.length) }, worker)]);
  }

  private async transaction(workspaceId: string, writes: PendingWrite[]): Promise<void> {
    const c = await this.app.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      for (const w of writes) if (w.fn) await w.fn(c);
      await writeBulk(c, writes);
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
      throw e;
    }
    try {
      await c.query("COMMIT");
    } catch (e) {
      // The commit may have happened before the connection dropped: never retry it, or rows would be written twice.
      if (e && typeof e === "object") (e as { afterCommit?: boolean }).afterCommit = true;
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * Runs a write, retrying while the database is briefly unreachable (a restart, a dropped connection).
   * A write that still fails is logged and marks the store unhealthy. Returns false only when the caller should
   * try the writes one by one (a bad row, with `record` off).
   */
  private async attempt(job: () => Promise<void>, record = true): Promise<boolean> {
    for (let i = 0; ; i++) {
      try {
        await job();
        return true;
      } catch (e) {
        if ((e as { afterCommit?: boolean } | undefined)?.afterCommit) {
          // Unknown whether it was saved: do not write it again. Marked unhealthy so the host restarts and reloads.
          this.lastError = e instanceof Error ? e : new Error(String(e));
          console.error("storage commit not confirmed:", this.lastError.message);
          return true;
        }
        const down = isConnectionError(e);
        if (down && i < RETRY_DELAYS_MS.length) { await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i])); continue; }
        // A bad row is retried alone by the caller; a database that stays unreachable is not, as that would only wait longer.
        if (!record && !down) return false;
        this.lastError = e instanceof Error ? e : new Error(String(e));
        console.error("storage write failed:", this.lastError.message);
        return !record && down; // true stops the caller retrying row by row against a database that is down
      }
    }
  }

  /** Writes waiting to go to the database (for the health check and the shutdown log). */
  get backlog(): number {
    return this.pending.length;
  }

  private state(workspaceId: string, kind: string, id: string, data: unknown): void {
    // Captured now, so later changes to the object cannot slip into an earlier write.
    this.bulk(workspaceId, "state", [workspaceId, kind, id, JSON.stringify(data)], `${kind}\u0000${id}`);
  }

  workspace(w: Workspace): void {
    this.queue(async () => {
      await this.admin.query(
        "INSERT INTO workspaces(id, name, type, language, base_currency, time_zone, owner_email) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING",
        [w.id, w.name, w.type, w.language, w.baseCurrency, w.timeZone, w.ownerEmail ?? null],
      );
    }, { barrier: true });
  }
  membership(workspaceId: string, userId: string, role: Role): void {
    this.scoped(workspaceId, async (c) => {
      await c.query(
        "INSERT INTO memberships(workspace_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        [workspaceId, userId, role],
      );
    });
  }
  employee(e: Employee): void {
    this.scoped(e.workspaceId, async (c) => {
      await c.query("INSERT INTO employees(id, workspace_id, template_key, name) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING", [e.id, e.workspaceId, e.templateKey, e.name]);
    });
  }
  profile(workspaceId: string, p: BusinessProfile): void {
    this.state(workspaceId, "profile", "main", p);
  }
  adminOrg(workspaceId: string, r: AdminOrgRecord): void {
    this.state(workspaceId, "admin_org", "main", r);
  }
  adminMessage(m: AdminMessage): void {
    this.state(m.workspaceId, "admin_msg", m.id, m);
  }
  training(workspaceId: string, employeeId: string, notes: string | undefined): void {
    this.state(workspaceId, "training", employeeId, { notes: notes ?? null });
  }
  account(workspaceId: string, a: Account): void {
    this.state(workspaceId, "account", a.code, a);
  }
  plan(workspaceId: string, p: EnergyPlan): void {
    this.state(workspaceId, "plan", "main", p);
  }
  connection(c: Connection): void {
    this.state(c.workspaceId, "connection", `${c.channel}:${c.externalWorkspace}`, c);
  }
  link(workspaceId: string, key: string, userId: string): void {
    this.state(workspaceId, "link", key, { userId });
  }
  slackToken(workspaceId: string, team: string, token: string): void {
    this.state(workspaceId, "slack_token", team, { enc: this.encrypt(token) });
  }
  integration(c: IntegrationConnection): void {
    this.state(c.workspaceId, "integration", c.id, c);
  }
  integrationSecret(workspaceId: string, connectionId: string, secret: string): void {
    // Same AES-256-GCM as chat bot tokens. A removed secret is stored as an empty value.
    this.state(workspaceId, "int_secret", connectionId, { enc: secret ? this.encrypt(secret) : "" });
  }
  integrationRecord(r: StoredRecord): void {
    this.state(r.workspaceId, "int_record", r.id, r);
  }
  review(r: ReviewItem): void {
    // Stored under the client's workspace, so row-level security keeps one client's tasks from another.
    this.state(r.workspaceId, "review", r.id, r);
  }
  record(workspaceId: string, kind: GenericKind, id: string, data: unknown): void {
    this.state(workspaceId, kind, id, data);
  }
  specialistRequest(r: SpecialistRequest): void {
    this.state(r.workspaceId, "specialist_req", r.id, r);
  }
  /** Platform records belong to no client: written with the platform role, never readable by app_user. */
  priceChange(c: PriceChange, removed = false): void {
    const json = JSON.stringify(c);
    this.queue(async () => {
      if (removed) await this.admin.query("DELETE FROM platform_records WHERE kind = 'price_change' AND id = $1", [c.id]);
      else await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('price_change', $1, $2)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
        [c.id, json],
      );
    }, { key: `price_change\u0000${c.id}` });
  }
  aiSettings(s: AiRoutingSettings): void {
    const json = JSON.stringify(s);
    this.queue(async () => {
      await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('ai_settings', 'current', $1)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
        [json],
      );
    }, { key: "ai_settings" });
  }
  aiDay(d: AiDay): void {
    const json = JSON.stringify(d);
    this.queue(async () => {
      await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('ai_day', $1, $2)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
        [d.day, json],
      );
    }, { key: `ai_day\u0000${d.day}` });
  }
  /** A password hash belongs to no client: platform role only, like price changes. */
  credential(userId: string, rec: { hash: string; changedAt: string }): void {
    const json = JSON.stringify(rec);
    this.queue(async () => {
      await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('credential', $1, $2)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
        [userId, json],
      );
    }, { key: `credential\u0000${userId}` });
  }
  /** Coupons and affiliate records belong to no client: platform role only. Stored as promo_<kind>. */
  promo(kind: PromoKind, id: string, data: unknown): void {
    const json = JSON.stringify(data);
    this.queue(async () => {
      await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ($1, $2, $3)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
        [`promo_${kind}`, id, json],
      );
    }, { key: `promo_${kind}\u0000${id}` });
  }
  /** The owner's connection details (tokens, ids): platform role only, encrypted like app credentials. */
  connectionSecret(key: string, secret: string): void {
    const json = JSON.stringify({ enc: secret ? this.encrypt(secret) : "" });
    this.queue(async () => {
      await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('connection_secret', $1, $2)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
        [key, json],
      );
    }, { key: `connection_secret\u0000${key}` });
  }
  batchJob(j: BatchJob): void {
    this.state(j.workspaceId, "batch_job", j.id, j);
  }
  /** Staff records are personal data: encrypted like app credentials. A deleted record keeps an empty value. */
  staff(m: StaffMember, removed = false): void {
    this.state(m.workspaceId, "staff", m.id, { enc: removed ? "" : this.encrypt(JSON.stringify(m)) });
  }
  peopleSettings(workspaceId: string, s: PeopleSettings): void {
    this.state(workspaceId, "people_settings", "current", s);
  }
  batchSchedule(workspaceId: string, s: ClientSchedule): void {
    this.state(workspaceId, "batch_schedule", "current", s);
  }
  batchRun(r: BatchRunRecord): void {
    const json = JSON.stringify(r);
    this.queue(async () => {
      await this.admin.query(
        `INSERT INTO platform_records(kind, id, data) VALUES ('batch_run', $1, $2)
         ON CONFLICT (kind, id) DO UPDATE SET data = EXCLUDED.data, updated_at = clock_timestamp()`,
        [r.id, json],
      );
    }, { key: `batch_run\u0000${r.id}` });
  }
  entry(e: JournalEntry): void {
    this.scoped(e.workspaceId, async (c) => {
      await c.query("INSERT INTO journal_entries(id, workspace_id, entry_date, memo, source, reverses) VALUES ($1,$2,$3,$4,$5,$6)", [e.id, e.workspaceId, e.date, e.memo, e.source ?? null, e.reverses ?? null]);
      // All lines in one statement: one round trip, not one per line.
      const params = e.lines.flatMap((l, n) => [e.id, e.workspaceId, l.account, l.debit, l.credit, n]);
      const values = e.lines.map((_, n) => `($${n * 6 + 1},$${n * 6 + 2},$${n * 6 + 3},$${n * 6 + 4},$${n * 6 + 5},$${n * 6 + 6})`).join(",");
      if (e.lines.length) await c.query(`INSERT INTO journal_lines(entry_id, workspace_id, account, debit, credit, line_no) VALUES ${values}`, params);
    });
  }
  usage(u: UsageRecord): void {
    this.bulk(u.workspaceId, "usage", [u.workspaceId, u.employeeId, u.day, u.provider, u.inputTokens, u.outputTokens, u.costMicro, u.energy, u.overtime]);
  }
  audit(e: AuditEvent): void {
    this.bulk(e.workspaceId, "audit", [e.workspaceId, e.at, e.actor, e.action, e.target ?? null, e.data ? JSON.stringify(e.data) : null, e.id]);
  }

  async load(): Promise<Snapshot> {
    await this.flush();
    const q = async (sql: string) => (await this.admin.query(sql)).rows;
    const states = await q("SELECT workspace_id, kind, id, data FROM state_records ORDER BY updated_at, id");
    const of = (kind: string) => states.filter((s) => s.kind === kind);
    const lines = await q("SELECT entry_id, account, debit, credit FROM journal_lines ORDER BY entry_id, line_no");
    const byEntry = new Map<string, { account: string; debit: number; credit: number }[]>();
    for (const l of lines) (byEntry.get(l.entry_id) ?? byEntry.set(l.entry_id, []).get(l.entry_id)!).push({ account: l.account, debit: l.debit, credit: l.credit });
    return {
      workspaces: (await q("SELECT * FROM workspaces ORDER BY created_at")).map((r) => ({ id: r.id, name: r.name, type: r.type, language: r.language, baseCurrency: r.base_currency, timeZone: r.time_zone, ...(r.owner_email ? { ownerEmail: r.owner_email } : {}), ...(r.created_at ? { createdAt: new Date(r.created_at).toISOString() } : {}) })),
      memberships: (await q("SELECT * FROM memberships")).map((r) => ({ workspaceId: r.workspace_id, userId: r.user_id, role: r.role })),
      employees: (await q("SELECT * FROM employees")).map((r) => ({ id: r.id, workspaceId: r.workspace_id, templateKey: r.template_key, name: r.name })),
      profiles: of("profile").map((s) => ({ workspaceId: s.workspace_id, profile: s.data })),
      adminOrgs: of("admin_org").map((s) => s.data),
      adminMessages: of("admin_msg").map((s) => s.data).sort((a, b) => a.at.localeCompare(b.at)),
      training: of("training").filter((s) => s.data.notes !== null).map((s) => ({ workspaceId: s.workspace_id, employeeId: s.id, notes: s.data.notes })),
      accounts: of("account").map((s) => ({ workspaceId: s.workspace_id, account: s.data })),
      entries: (await q("SELECT * FROM journal_entries ORDER BY created_at, id")).map((r) => ({
        id: r.id, workspaceId: r.workspace_id, date: r.entry_date, memo: r.memo, source: r.source ?? undefined, reverses: r.reverses ?? undefined, lines: byEntry.get(r.id) ?? [],
      })),
      usage: (await q("SELECT * FROM energy_usage ORDER BY id")).map((r) => ({
        workspaceId: r.workspace_id, employeeId: r.employee_id, day: r.day, provider: r.provider, inputTokens: r.input_tokens, outputTokens: r.output_tokens, costMicro: r.cost_micro, energy: r.energy, overtime: r.overtime,
      })),
      plans: of("plan").map((s) => ({ workspaceId: s.workspace_id, plan: s.data })),
      audit: (await q("SELECT * FROM audit_log ORDER BY id")).map((r) => ({
        id: r.event_id, workspaceId: r.workspace_id, actor: r.actor, action: r.action, target: r.target ?? undefined, data: r.data ?? undefined, at: r.at,
      })) as AuditEvent[],
      connections: of("connection").map((s) => s.data),
      links: of("link").map((s) => ({ workspaceId: s.workspace_id, key: s.id, userId: s.data.userId })),
      slackTokens: of("slack_token").map((s) => ({ team: s.id, token: this.decrypt(s.data.enc) })),
      integrations: of("integration").map((s) => s.data),
      integrationSecrets: of("int_secret").filter((s) => s.data.enc).map((s) => ({ connectionId: s.id, secret: this.decrypt(s.data.enc) })),
      integrationRecords: of("int_record").map((s) => s.data),
      reviews: of("review").map((s) => s.data),
      specialistRequests: of("specialist_req").map((s) => s.data),
      records: states.filter((s) => (GENERIC_KINDS as readonly string[]).includes(s.kind)).map((s) => ({ workspaceId: s.workspace_id, kind: s.kind, id: s.id, data: s.data })),
      priceChanges: (await q("SELECT data FROM platform_records WHERE kind = 'price_change' ORDER BY updated_at, id")).map((r) => r.data),
      aiSettings: (await q("SELECT data FROM platform_records WHERE kind = 'ai_settings' AND id = 'current'"))[0]?.data,
      batchJobs: of("batch_job").map((s) => s.data),
      staff: of("staff").filter((s) => s.data.enc).map((s) => JSON.parse(this.decrypt(s.data.enc))),
      peopleSettings: of("people_settings").map((s) => ({ workspaceId: s.workspace_id, settings: s.data })),
      batchSchedules: of("batch_schedule").map((s) => ({ workspaceId: s.workspace_id, schedule: s.data })),
      batchRuns: (await q("SELECT data FROM platform_records WHERE kind = 'batch_run' ORDER BY updated_at, id")).map((r) => r.data),
      credentials: (await q("SELECT id, data FROM platform_records WHERE kind = 'credential'")).map((r) => ({ userId: r.id, ...r.data })),
      promoRecords: (await q("SELECT kind, id, data FROM platform_records WHERE kind LIKE 'promo\\_%' ORDER BY updated_at, id")).map((r) => ({ kind: String(r.kind).slice(6) as PromoKind, id: r.id, data: r.data })),
      connectionSecrets: (await q("SELECT id, data FROM platform_records WHERE kind = 'connection_secret' ORDER BY id")).filter((r) => r.data?.enc).map((r) => ({ key: r.id, secret: this.decrypt(r.data.enc) })),
      aiDays: (await q("SELECT data FROM platform_records WHERE kind = 'ai_day' ORDER BY id")).map((r) => r.data),
    } as Snapshot;
  }

  // ---------- chat bot tokens: AES-256-GCM ----------
  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
  }
  private decrypt(enc: string): string {
    const [iv, tag, ct] = enc.split(".").map((p) => Buffer.from(p, "base64"));
    const d = createDecipheriv("aes-256-gcm", this.key, iv!);
    d.setAuthTag(tag!);
    return Buffer.concat([d.update(ct!), d.final()]).toString("utf8");
  }
}
