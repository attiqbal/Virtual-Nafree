import type { AuditEvent } from "../modules/audit/index.js";
import type { Workspace, Role } from "../modules/identity/index.js";
import type { Employee, BusinessProfile } from "../modules/workforce/index.js";
import type { Account, JournalEntry } from "../modules/ledger/index.js";
import type { EnergyPlan, UsageRecord } from "../modules/energy/index.js";
import type { Connection } from "../modules/channels/index.js";
import type { AdminMessage, AdminOrgRecord } from "../modules/admin-manager/index.js";
import type { IntegrationConnection, StoredRecord } from "../modules/integrations/service.js";
import type { ReviewItem } from "../modules/review/index.js";
import type { PriceChange } from "../modules/pricing/index.js";
import type { SpecialistRequest } from "../modules/review/specialists.js";
import type { AiRoutingSettings } from "../modules/model-gateway/routing/settings.js";
import type { AiDay } from "../modules/model-gateway/routing/ledger.js";
import type { BatchJob, BatchRunRecord } from "../modules/batch/service.js";
import type { ClientSchedule } from "../modules/batch/schedule.js";
import type { StaffMember, DeskSettings as PeopleSettings } from "../modules/people/rules.js";

/**
 * Where services report every change so it can be stored. Services stay fast and
 * synchronous in memory; the sink writes behind them, in order. Methods must not throw.
 */
export interface Sink {
  workspace(w: Workspace): void;
  membership(workspaceId: string, userId: string, role: Role): void;
  employee(e: Employee): void;
  profile(workspaceId: string, p: BusinessProfile): void;
  /** notes undefined means the training was cleared. */
  training(workspaceId: string, employeeId: string, notes: string | undefined): void;
  account(workspaceId: string, a: Account): void;
  entry(e: JournalEntry): void;
  usage(u: UsageRecord): void;
  plan(workspaceId: string, p: EnergyPlan): void;
  audit(e: AuditEvent): void;
  connection(c: Connection): void;
  link(workspaceId: string, key: string, userId: string): void;
  adminOrg(workspaceId: string, record: AdminOrgRecord): void;
  adminMessage(m: AdminMessage): void;
  slackToken(workspaceId: string, team: string, token: string): void;
  integration(c: IntegrationConnection): void;
  /** Credentials for a connected app as JSON. The store must encrypt it. Empty string means removed. */
  integrationSecret(workspaceId: string, connectionId: string, secret: string): void;
  integrationRecord(r: StoredRecord): void;
  /** A specialised task in MAIZ quality review, replaced on every change. */
  review(r: ReviewItem): void;
  /** A custom specialist waiting for (or past) the platform owner's review. */
  specialistRequest(r: SpecialistRequest): void;
  /** Platform-level (no workspace): a price change by the platform owner. removed = a scheduled change was cancelled. */
  priceChange(c: PriceChange, removed?: boolean): void;
  /** Platform-level: the owner's AI routing settings (models, thresholds, caps). Replaced on every change. */
  aiSettings(s: AiRoutingSettings): void;
  /** Platform-level: one day of AI routing spend and savings, replaced on every call. */
  aiDay(d: AiDay): void;
  /** One queued or finished batch job, replaced on every change. */
  batchJob(j: BatchJob): void;
  /** A client's batch schedule (closing time, timezone). */
  batchSchedule(workspaceId: string, s: ClientSchedule): void;
  /** Platform-level: one batch run summary, replaced on every call. */
  batchRun(r: BatchRunRecord): void;
  /** A client's record of a newer kind (orders, rota, reconciliation reports), replaced on every change. */
  record(workspaceId: string, kind: GenericKind, id: string, data: unknown): void;
  /** One member of a client's staff (HR desk), replaced on every change. removed = deleted for good. The store must encrypt it. */
  staff(m: StaffMember, removed?: boolean): void;
  /** A client's HR desk settings (sector, leave year). */
  peopleSettings(workspaceId: string, s: PeopleSettings): void;
  /** Platform-level: a person's password hash (never the password), keyed by user id. */
  credential(userId: string, rec: { hash: string; changedAt: string }): void;
  /** Platform-level: a coupon, redemption, affiliate, referral, commission or payout, replaced on every change. */
  promo(kind: PromoKind, id: string, data: unknown): void;
  /** Platform-level: the owner's details for one connection (Facebook, Instagram, WhatsApp) as JSON. The store must encrypt it. Empty string means removed. */
  connectionSecret(key: string, secret: string): void;
}

export const PROMO_KINDS = ["coupon", "redemption", "affiliate", "referral", "accrual", "payout", "campaign", "draft", "lead", "optout", "fact", "opportunity", "post", "publication", "account", "approval", "channel"] as const;
export type PromoKind = (typeof PROMO_KINDS)[number];

/** Kinds stored through Sink.record. The database accepts any kind; this list is what load() hands back. */
export const GENERIC_KINDS = ["order", "rota_staff", "rota_shift", "rota_settings", "recon", "task", "conversation", "notices"] as const;
export type GenericKind = (typeof GENERIC_KINDS)[number];
export interface GenericRecord { workspaceId: string; kind: GenericKind; id: string; data: any }

/** Everything stored, in the order it must be restored. */
export interface Snapshot {
  workspaces: Workspace[];
  memberships: { workspaceId: string; userId: string; role: Role }[];
  employees: Employee[];
  profiles: { workspaceId: string; profile: BusinessProfile }[];
  training: { workspaceId: string; employeeId: string; notes: string }[];
  accounts: { workspaceId: string; account: Account }[];
  entries: JournalEntry[];
  usage: UsageRecord[];
  plans: { workspaceId: string; plan: EnergyPlan }[];
  audit: AuditEvent[];
  connections: Connection[];
  links: { workspaceId: string; key: string; userId: string }[];
  adminOrgs: AdminOrgRecord[];
  adminMessages: AdminMessage[];
  slackTokens: { team: string; token: string }[];
  integrations?: IntegrationConnection[];
  integrationSecrets?: { connectionId: string; secret: string }[];
  integrationRecords?: StoredRecord[];
  reviews?: ReviewItem[];
  priceChanges?: PriceChange[];
  specialistRequests?: SpecialistRequest[];
  aiSettings?: unknown;
  aiDays?: AiDay[];
  batchJobs?: BatchJob[];
  batchSchedules?: { workspaceId: string; schedule: ClientSchedule }[];
  staff?: StaffMember[];
  peopleSettings?: { workspaceId: string; settings: PeopleSettings }[];
  batchRuns?: BatchRunRecord[];
  records?: GenericRecord[];
  credentials?: { userId: string; hash: string; changedAt: string }[];
  promoRecords?: { kind: PromoKind; id: string; data: any }[];
  connectionSecrets?: { key: string; secret: string }[];
}
