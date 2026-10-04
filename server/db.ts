// Firestore-backed persistence layer.
//
// Faithful port of the previous Drizzle/MySQL implementation: every exported
// function keeps its original name, signature, error messages, and return
// shape so routers and tests work unchanged.
//
// Storage mapping:
// - Each collection's documents use the decimal string form of the numeric
//   `id` as the document ID; numeric IDs come from per-collection counters in
//   `meta/counters` (read-increment-write inside transactions).
// - Firestore Timestamps are converted back to `Date` at the boundary.
// - Formerly-unique columns are guarded by claim documents in the `unique`
//   collection so duplicates are impossible even under concurrent writes.

import {
  AggregateField,
  FieldValue,
  Timestamp,
  type CollectionReference,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type Query,
  type Transaction,
} from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { getFirestore } from "./firebase";
import type {
  AdCampaign,
  AdView,
  AuditLog,
  FraudFlag,
  InsertUser,
  LedgerEntry,
  Notification,
  Package,
  PaymentProof,
  PlatformSetting,
  RewardVideo,
  User,
  UserPackage,
  VideoCompletion,
  VideoWatchSession,
  Wallet,
  Withdrawal,
} from "../drizzle/schema";
import { INITIAL_PACKAGES, INITIAL_PLATFORM_SETTINGS } from "../shared/platform";
import {
  calculateWithdrawalQuote,
  evaluateAdCompletion,
  evaluateVideoCompletion,
  getPlatformDayWindow,
  isValidPakistanMobile,
} from "./platformRules";
import { ENV } from "./_core/env";
import { storageGetSignedUrl } from "./storage";
import { assertPendingPaymentDecision } from "./workflowGuards";
import {
  evaluateExternalVideoReturn,
  hashVideoVerificationCode,
  matchesVideoVerificationCode,
  nextVerificationAttemptState,
  validateVideoVerificationCode,
} from "./externalVideoRules";

type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// Firestore plumbing
// ---------------------------------------------------------------------------

let cachedDb: Firestore | null | undefined;

export async function getDb(): Promise<Firestore | null> {
  if (cachedDb === undefined) cachedDb = getFirestore();
  return cachedDb;
}

function requireDatabase(db: Firestore | null): Firestore {
  if (!db) {
    throw new Error("The database is currently unavailable. Please try again shortly.");
  }
  return db;
}

function docRef(db: Firestore, collection: string, id: number | string): DocumentReference {
  return db.collection(collection).doc(String(id));
}

function toStoredValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value;
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (Array.isArray(value)) return value.map(toStoredValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry !== undefined) out[key] = toStoredValue(entry);
    }
    return out;
  }
  return value;
}

/** Convert a plain record to Firestore-safe data (Date -> Timestamp, drop undefined). */
export function toStore<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = toStoredValue(value);
  }
  return out;
}

function fromStoredValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(fromStoredValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = fromStoredValue(entry);
    }
    return out;
  }
  return value;
}

/** Convert a document snapshot to a row with numeric `id`; null when missing. */
function rowFromSnap(snap: DocumentSnapshot): Row | null {
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data) return null;
  const out: Row = { id: Number(snap.id) };
  for (const [key, value] of Object.entries(data)) out[key] = fromStoredValue(value);
  return out;
}

function rowsFromSnaps(snaps: DocumentSnapshot[]): Row[] {
  const out: Row[] = [];
  for (const snap of snaps) {
    const row = rowFromSnap(snap);
    if (row) out.push(row);
  }
  return out;
}

function firstRow(snaps: DocumentSnapshot[]): Row | null {
  return snaps.length ? rowFromSnap(snaps[0]) : null;
}

async function getDoc(db: Firestore, collection: string, id: number | string): Promise<Row | null> {
  return rowFromSnap(await docRef(db, collection, id).get());
}

/** Per-collection numeric ID counters, advanced inside transactions. */
// ---------------------------------------------------------------------------
// Transaction helpers (Firestore-safe)
//
// Firestore transactions require ALL reads to happen before ALL writes.
// To honor that, ID allocation and unique-claim checks are split into a
// read phase and a write phase:
//
//   read phase:  tx.get(...) / readCounters(...) / peekUniqueClaim(...)
//   compute:     allocId(...) / pure checks
//   write phase: writeCounters(...) / tx.set/update/delete / applyUniqueClaim(...)
//                / releaseUnique(...)
//
// Never call a read-phase helper after a write-phase operation.
// ---------------------------------------------------------------------------

interface CounterState {
  ref: DocumentReference;
  counts: Record<string, number>;
}

/** Read phase: fetch the shared counters document once per transaction. */
async function readCounters(tx: Transaction, db: Firestore): Promise<CounterState> {
  const ref = db.collection("meta").doc("counters");
  const snap = await tx.get(ref);
  const data = (snap.exists ? snap.data() : null) as Row | null;
  const counts: Record<string, number> = {};
  if (data) {
    for (const [key, value] of Object.entries(data)) counts[key] = Number(value ?? 0);
  }
  return { ref, counts };
}

/** Compute phase (pure): allocate the next numeric ID for a collection. */
function allocId(counters: CounterState, collection: string): number {
  const next = (counters.counts[collection] ?? 0) + 1;
  counters.counts[collection] = next;
  return next;
}

/** Write phase: persist allocated counter values. */
function writeCounters(tx: Transaction, counters: CounterState): void {
  tx.set(counters.ref, { ...counters.counts }, { merge: true });
}

interface UniqueClaimPeek {
  ref: DocumentReference;
  snap: DocumentSnapshot;
}

/** Read phase: fetch a uniqueness-claim document. */
async function peekUniqueClaim(
  tx: Transaction,
  db: Firestore,
  key: string,
): Promise<UniqueClaimPeek> {
  const ref = db.collection("unique").doc(key);
  const snap = await tx.get(ref);
  return { ref, snap };
}

/**
 * Write phase: claim a uniqueness key for an owner record, using a snapshot
 * fetched with peekUniqueClaim during the read phase. When the key already
 * exists for a different owner, throws conflictMessage instead of creating
 * a duplicate. Re-claiming by the same owner is idempotent (no write).
 */
function applyUniqueClaim(
  tx: Transaction,
  claim: UniqueClaimPeek,
  ownerId: number,
  conflictMessage: string,
): void {
  if (claim.snap.exists) {
    const owner = Number((claim.snap.data() as Row)?.ownerId);
    if (owner !== ownerId) throw new Error(conflictMessage);
    return;
  }
  tx.set(claim.ref, { ownerId, claimedAt: new Date() });
}

/** Unique-claim key (slashes are not allowed in document IDs). */
function ukey(...parts: string[]): string {
  return parts.map((part) => part.replace(/\//g, "_")).join("_");
}

/** Write phase: release a uniqueness key (delete is a write-only operation). */

async function releaseUnique(tx: Transaction, db: Firestore, key: string): Promise<void> {
  tx.delete(db.collection("unique").doc(key));
}

/** Read a unique-claim document and return the owner record id, if any. */
async function uniqueOwner(db: Firestore, key: string): Promise<number | null> {
  const snap = await db.collection("unique").doc(key).get();
  if (!snap.exists) return null;
  return Number((snap.data() as Row)?.ownerId);
}

/** Inner-join semantics: the related row must exist (referential integrity). */
function requiredRow<T>(row: T | null | undefined, message: string): T {
  if (row == null) throw new Error(message);
  return row;
}

async function countWhere(
  db: Firestore,
  collection: string,
  build: (col: CollectionReference) => Query,
): Promise<number> {
  const snap = await build(db.collection(collection)).aggregate({ total: AggregateField.count() }).get();
  return Number(snap.data().total ?? 0);
}

async function sumWhere(
  db: Firestore,
  collection: string,
  field: string,
  build: (col: CollectionReference) => Query,
): Promise<number> {
  const snap = await build(db.collection(collection)).aggregate({ total: AggregateField.sum(field) }).get();
  return Number(snap.data().total ?? 0);
}

async function platformDayWindow(): Promise<ReturnType<typeof getPlatformDayWindow>> {
  const settings = await getSettingMap();
  return getPlatformDayWindow(Date.now(), settings.platform_timezone || "Asia/Karachi");
}

// ---------------------------------------------------------------------------
// Pure helpers (unchanged behavior)
// ---------------------------------------------------------------------------

export const DEFAULT_REWARD_VIDEO_DURATION_SECONDS = 10;

export function normalizePersistentSettingValue(value: string) {
  return value.trim();
}

export function buildPackageRulesUpdateValues(input: {
  pricePaisa: number;
  rewardPerEligibleAdPaisa: number;
  dailyAdLimit: number;
  durationDays: number;
  status: "active" | "inactive";
}) {
  return {
    pricePaisa: input.pricePaisa,
    rewardPerEligibleAdPaisa: input.rewardPerEligibleAdPaisa,
    dailyAdLimit: input.dailyAdLimit,
    durationDays: input.durationDays,
    status: input.status,
  };
}

export function isCampaignEligibleForPackage(campaignPackageId: number | null, memberPackageId: number) {
  return campaignPackageId === null || campaignPackageId === memberPackageId;
}

export function canBeginAssignedVideo(accountStatus: "active" | "suspended" | "review") {
  return accountStatus === "active";
}

export function assertVideoStartEligibility(input: {
  accountStatus: "active" | "suspended" | "review";
  hasActiveMembership: boolean;
  isVideoEnabled: boolean;
  isAssignedToMemberPackage: boolean;
}) {
  if (input.accountStatus === "review")
    throw new Error("Your account is currently under review. Please contact support before starting reward videos.");
  if (input.accountStatus === "suspended")
    throw new Error("Your account is suspended and cannot start reward videos.");
  if (!canBeginAssignedVideo(input.accountStatus))
    throw new Error("Your account cannot start reward videos.");
  if (!input.hasActiveMembership)
    throw new Error("An active membership is required to access package videos.");
  if (!input.isVideoEnabled || !input.isAssignedToMemberPackage)
    throw new Error("This video is not available for your membership.");
}

export function assertExternalVideoClaimEligibility(input: {
  sessionUserId: number;
  requesterUserId: number;
  sessionStatus: string;
  verificationStatus: string;
  rewardStatus: string;
  dailyClaims: number;
  dailyRewardLimit: number;
}) {
  if (input.sessionUserId !== input.requesterUserId)
    throw new Error("This video session does not belong to your account.");
  if (input.rewardStatus === "claimed" || input.sessionStatus === "claimed")
    throw new Error("This video session has already been rewarded.");
  if (input.sessionStatus !== "code_verified" || input.verificationStatus !== "passed")
    throw new Error("Verify the six-digit code after returning from the external video before claiming a reward.");
  if (input.dailyClaims >= input.dailyRewardLimit)
    throw new Error("Reward already claimed for this video today.");
}

export type VideoStartWorkflowDependencies = {
  user: { accountStatus: "active" | "suspended" | "review" };
  membership: { membership: { id: number }; package: { id: number } } | null;
  video: {
    id: number;
    packageId: number;
    status: "enabled" | "disabled";
    requiredDurationSeconds: number;
  } | null;
  episode?: {
    videoEpisodeNumber: number;
    currentEpisodeNumber: number | null;
    claimedAnyEpisodeToday: boolean;
  };
  claimedToday?: boolean;
  externalUrl?: string;
  activeSession?: {
    sessionToken: string;
    requiredDurationSeconds: number;
    status: "started" | "eligible";
  } | null;
  sessionToken?: string;
  createSession?: (input: {
    sessionToken: string;
    userId: number;
    videoId: number;
    membershipId: number;
    requiredDurationSeconds: number;
  }) => Promise<void> | void;
};

async function startVideoWatchSessionWithDependencies(
  input: { userId: number; videoId: number },
  deps: VideoStartWorkflowDependencies,
) {
  assertVideoStartEligibility({
    accountStatus: deps.user.accountStatus,
    hasActiveMembership: Boolean(deps.membership),
    isVideoEnabled: deps.video?.status === "enabled",
    isAssignedToMemberPackage: Boolean(
      deps.video && deps.membership && deps.video.packageId === deps.membership.package.id,
    ),
  });
  if (!deps.membership || !deps.video) throw new Error("This video is not available for your membership.");
  if (deps.episode) assertEpisodeStartEligibility(deps.episode);
  if (deps.activeSession)
    return {
      sessionToken: deps.activeSession.sessionToken,
      requiredDurationSeconds: deps.activeSession.requiredDurationSeconds,
      resumed: true,
      claimAvailable: deps.activeSession.status === "eligible" && !deps.claimedToday,
      claimedToday: Boolean(deps.claimedToday),
      sessionStatus: deps.activeSession.status,
      externalUrl: deps.externalUrl ?? "",
    };
  const sessionToken = deps.sessionToken ?? randomUUID();
  await deps.createSession?.({
    sessionToken,
    userId: input.userId,
    videoId: input.videoId,
    membershipId: deps.membership.membership.id,
    requiredDurationSeconds: deps.video.requiredDurationSeconds,
  });
  return {
    sessionToken,
    requiredDurationSeconds: deps.video.requiredDurationSeconds,
    resumed: false,
    claimAvailable: false,
    claimedToday: Boolean(deps.claimedToday),
    sessionStatus: "started" as const,
    externalUrl: deps.externalUrl ?? "",
  };
}

export function isDesignatedAdminEmail(email?: string | null) {
  return Boolean(
    email?.trim() &&
      process.env.ADMIN_EMAIL?.trim() &&
      email.trim().toLowerCase() === process.env.ADMIN_EMAIL.trim().toLowerCase(),
  );
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: Row = { openId: user.openId };
  const updateSet: Row = {};
  (["name", "email", "loginMethod"] as const).forEach((field) => {
    if (user[field] !== undefined) {
      const value = (user[field] ?? null) as string | null;
      values[field] = value;
      updateSet[field] = value;
    }
  });
  values.lastSignedIn = user.lastSignedIn ?? new Date();
  updateSet.lastSignedIn = values.lastSignedIn;
  if (user.role !== undefined) {
    values.role = user.role;
    updateSet.role = user.role;
  } else if (user.openId === ENV.ownerOpenId || isDesignatedAdminEmail(user.email)) {
    values.role = "admin";
    updateSet.role = "admin";
  }

  await db.runTransaction(async (tx) => {
    // ---- read phase: every tx.get happens before any write ----
    const existing = await tx.get(db.collection("users").where("openId", "==", user.openId).limit(1));
    const counters = await readCounters(tx, db);
    const email =
      typeof values.email === "string" && values.email.trim() ? values.email.trim().toLowerCase() : null;
    const openidClaim = await peekUniqueClaim(tx, db, ukey("user", "openid", user.openId));
    const emailClaim = email ? await peekUniqueClaim(tx, db, ukey("user", "email", email)) : null;
    const prev = existing.empty ? null : (rowFromSnap(existing.docs[0]) as Row);
    const prevEmail = prev && typeof prev.email === "string" ? prev.email : null;
    let nextEmail: string | null | undefined;
    if (!existing.empty && updateSet.email !== undefined) {
      nextEmail =
        typeof updateSet.email === "string" && updateSet.email.trim()
          ? updateSet.email.trim().toLowerCase()
          : null;
    }
    const nextEmailClaim =
      nextEmail !== undefined && nextEmail && nextEmail !== prevEmail
        ? await peekUniqueClaim(tx, db, ukey("user", "email", nextEmail))
        : null;
    // ---- compute phase (pure) ----
    const now = new Date();
    const id = existing.empty ? allocId(counters, "users") : Number(existing.docs[0].id);
    // ---- write phase ----
    writeCounters(tx, counters);
    if (existing.empty) {
      tx.set(
        docRef(db, "users", id),
        toStore({
          id,
          ...values,
          email,
          role: values.role ?? "user",
          accountStatus: user.accountStatus ?? "review",
          phone: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      applyUniqueClaim(tx, openidClaim, id, "An account with this login already exists.");
      if (email && emailClaim) {
        applyUniqueClaim(tx, emailClaim, id, "An account with this email already exists.");
      }
    } else {
      const doc = existing.docs[0];
      if (nextEmail !== undefined) {
        if (nextEmail !== prevEmail) {
          if (prevEmail) releaseUnique(tx, db, ukey("user", "email", prevEmail));
          if (nextEmail && nextEmailClaim) {
            applyUniqueClaim(tx, nextEmailClaim, id, "An account with this email already exists.");
          }
        }
        updateSet.email = nextEmail;
      }
      updateSet.updatedAt = now;
      tx.update(doc.ref, toStore(updateSet));
    }
  });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const snap = await db.collection("users").where("openId", "==", openId).limit(1).get();
  return (firstRow(snap.docs) as User | null) ?? undefined;
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const snap = await db
    .collection("users")
    .where("email", "==", email.trim().toLowerCase())
    .limit(1)
    .get();
  return (firstRow(snap.docs) as User | null) ?? undefined;
}

export async function getUserById(userId: number) {
  const db = requireDatabase(await getDb());
  const user = (await getDoc(db, "users", userId)) as User | null;
  if (!user) throw new Error("Account record not found.");
  return user;
}

export async function getAdminUsers() {
  const db = requireDatabase(await getDb());
  const snaps = await db.collection("users").orderBy("createdAt", "desc").limit(100).get();
  const users = rowsFromSnaps(snaps.docs) as User[];
  return Promise.all(
    users.map(async (user) => {
      const walletId = await uniqueOwner(db, ukey("wallet", String(user.id)));
      const wallet = (walletId != null ? await getDoc(db, "wallets", walletId) : null) as Wallet | null;
      return { user, wallet: wallet ?? null };
    }),
  );
}

export async function updateUserAccountStatus(input: {
  adminUserId: number;
  userId: number;
  accountStatus: "active" | "suspended" | "review";
  reason?: string;
}) {
  const db = requireDatabase(await getDb());
  const target = (await getDoc(db, "users", input.userId)) as User | null;
  if (!target) throw new Error("The member record was not found.");
  if (target.role === "admin") throw new Error("Administrator account status cannot be changed here.");
  await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const auditId = allocId(counters, "auditLogs");
    const notificationId = allocId(counters, "notifications");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(docRef(db, "users", input.userId), {
      accountStatus: input.accountStatus,
      updatedAt: new Date(),
    });
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: `user_status_${input.accountStatus}`,
        entityType: "user",
        entityId: input.userId,
        oldValue: { accountStatus: target.accountStatus },
        newValue: { accountStatus: input.accountStatus, reason: input.reason?.trim() ?? null },
        ipHash: null,
        createdAt: new Date(),
      } satisfies AuditLog),
    );
    tx.set(
      docRef(db, "notifications", notificationId),
      toStore({
        id: notificationId,
        userId: input.userId,
        title: "Account status updated",
        message: input.reason?.trim() || `Your account status is now ${input.accountStatus}.`,
        type: input.accountStatus === "active" ? "success" : "security",
        readAt: null,
        createdAt: new Date(),
      } satisfies Notification),
    );
  });
  return { accountStatus: input.accountStatus };
}

// ---------------------------------------------------------------------------
// Packages & platform settings
// ---------------------------------------------------------------------------

export async function ensureInitialPlatformData() {
  const db = await getDb();
  if (!db) return;
  await db.runTransaction(async (tx) => {
    // ---- read phase: collect everything missing before any write ----
    const missingPackages: Array<(typeof INITIAL_PACKAGES)[number]> = [];
    for (const item of INITIAL_PACKAGES) {
      const existing = await tx.get(db.collection("packages").where("name", "==", item.name).limit(1));
      if (existing.empty) missingPackages.push(item);
    }
    const missingSettings: Array<[string, string]> = [];
    for (const [settingKey, settingValue] of Object.entries(INITIAL_PLATFORM_SETTINGS)) {
      const existing = await tx.get(db.collection("platformSettings").where("settingKey", "==", settingKey).limit(1));
      if (existing.empty) missingSettings.push([settingKey, settingValue]);
    }
    const counters = await readCounters(tx, db);
    // ---- write phase (counter doc persisted last, after all allocations) ----
    for (const item of missingPackages) {
      const id = allocId(counters, "packages");
      const now = new Date();
      tx.set(
        docRef(db, "packages", id),
        toStore({
          id,
          name: item.name,
          pricePaisa: item.pricePaisa,
          rewardPerEligibleAdPaisa: item.rewardPerEligibleAdPaisa,
          dailyAdLimit: item.dailyAdLimit,
          durationDays: item.durationDays,
          features: [...item.features],
          status: "active",
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    for (const [settingKey, settingValue] of missingSettings) {
      const id = allocId(counters, "platformSettings");
      const now = new Date();
      tx.set(
        docRef(db, "platformSettings", id),
        toStore({
          id,
          settingKey,
          settingValue,
          isSensitive: false,
          updatedByUserId: null,
          updatedAt: now,
        }),
      );
    }
    writeCounters(tx, counters);
  });
}

export async function getPublicPackages() {
  await ensureInitialPlatformData();
  const db = await getDb();
  if (!db) return [];
  const snap = await db.collection("packages").where("status", "==", "active").get();
  const rows = rowsFromSnaps(snap.docs) as Package[];
  rows.sort((a, b) => a.pricePaisa - b.pricePaisa);
  return rows;
}

export async function getAdminPackages() {
  await ensureInitialPlatformData();
  const db = requireDatabase(await getDb());
  const snap = await db.collection("packages").get();
  const rows = rowsFromSnaps(snap.docs) as Package[];
  rows.sort((a, b) => a.pricePaisa - b.pricePaisa);
  return rows;
}

export async function updatePackageRules(input: {
  adminUserId: number;
  packageId: number;
  pricePaisa: number;
  rewardPerEligibleAdPaisa: number;
  dailyAdLimit: number;
  durationDays: number;
  status: "active" | "inactive";
}) {
  const db = requireDatabase(await getDb());
  if (input.pricePaisa <= 0 || input.rewardPerEligibleAdPaisa <= 0 || input.dailyAdLimit < 0 || input.durationDays <= 0)
    throw new Error("Package price, reward, limit, or duration is invalid.");
  const existing = (await getDoc(db, "packages", input.packageId)) as Package | null;
  if (!existing) throw new Error("The package record was not found.");
  const updated = await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(docRef(db, "packages", input.packageId), toStore({
      ...buildPackageRulesUpdateValues(input),
      updatedAt: new Date(),
    }));
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: "package_rules_updated",
        entityType: "package",
        entityId: input.packageId,
        oldValue: {
          pricePaisa: existing.pricePaisa,
          rewardPerEligibleAdPaisa: existing.rewardPerEligibleAdPaisa,
          dailyAdLimit: existing.dailyAdLimit,
          durationDays: existing.durationDays,
          status: existing.status,
        },
        newValue: {
          pricePaisa: input.pricePaisa,
          rewardPerEligibleAdPaisa: input.rewardPerEligibleAdPaisa,
          dailyAdLimit: input.dailyAdLimit,
          durationDays: input.durationDays,
          status: input.status,
        },
        ipHash: null,
        createdAt: new Date(),
      } satisfies AuditLog),
    );
    return { ...existing, ...buildPackageRulesUpdateValues(input) };
  });
  return { success: true, package: updated };
}

export async function getSettingMap() {
  await ensureInitialPlatformData();
  const db = await getDb();
  if (!db) return { ...INITIAL_PLATFORM_SETTINGS };
  const snap = await db.collection("platformSettings").get();
  return rowsFromSnaps(snap.docs).reduce<Record<string, string>>((acc, row) => {
    acc[row.settingKey] = row.settingValue;
    return acc;
  }, {});
}

export async function getAdminSettings() {
  await ensureInitialPlatformData();
  const db = requireDatabase(await getDb());
  const snap = await db.collection("platformSettings").get();
  const rows = rowsFromSnaps(snap.docs) as PlatformSetting[];
  rows.sort((a, b) => a.settingKey.localeCompare(b.settingKey));
  return rows;
}

export async function updatePlatformSetting(input: {
  adminUserId: number;
  settingKey: string;
  settingValue: string;
}) {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("platformSettings").where("settingKey", "==", input.settingKey).limit(1).get();
  const existing = firstRow(snap.docs) as PlatformSetting | null;
  if (!existing) throw new Error("This setting key is not recognized.");
  const nextValue = normalizePersistentSettingValue(input.settingValue);
  await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(docRef(db, "platformSettings", existing.id), {
      settingValue: nextValue,
      updatedByUserId: input.adminUserId,
      updatedAt: new Date(),
    });
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: "platform_setting_updated",
        entityType: "platform_setting",
        entityId: existing.id,
        oldValue: { settingValue: existing.isSensitive ? "[redacted]" : existing.settingValue },
        newValue: { settingValue: existing.isSensitive ? "[redacted]" : nextValue },
        ipHash: null,
        createdAt: new Date(),
      } satisfies AuditLog),
    );
  });
  const saved = (await getDoc(db, "platformSettings", existing.id)) as PlatformSetting | null;
  return { success: true, setting: saved };
}

// ---------------------------------------------------------------------------
// Wallets & memberships
// ---------------------------------------------------------------------------

export async function ensureWallet(userId: number) {
  const db = requireDatabase(await getDb());
  const walletId = await uniqueOwner(db, ukey("wallet", String(userId)));
  if (walletId != null) {
    const wallet = (await getDoc(db, "wallets", walletId)) as Wallet | null;
    if (wallet) return wallet;
  }
  await db.runTransaction(async (tx) => {
    // ---- read phase: every tx.get happens before any write ----
    const walletClaim = await peekUniqueClaim(tx, db, ukey("wallet", String(userId)));
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    // Non-transactional re-check: another request may have created the wallet.
    const ownerId = await uniqueOwner(db, ukey("wallet", String(userId)));
    if (ownerId != null) return;
    const id = allocId(counters, "wallets");
    const now = new Date();
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.set(
      docRef(db, "wallets", id),
      toStore({
        id,
        userId,
        availableBalancePaisa: 0,
        heldBalancePaisa: 0,
        lifetimeEarnedPaisa: 0,
        updatedAt: now,
      } satisfies Wallet),
    );
    applyUniqueClaim(tx, walletClaim, id, "Wallet could not be initialized.");
  });
  const finalId = await uniqueOwner(db, ukey("wallet", String(userId)));
  const wallet = (finalId != null ? await getDoc(db, "wallets", finalId) : null) as Wallet | null;
  if (!wallet) throw new Error("Wallet could not be initialized.");
  return wallet;
}

export async function getActiveMembership(userId: number) {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("userPackages").where("userId", "==", userId).get();
  const rows = rowsFromSnaps(snap.docs) as UserPackage[];
  const pkgIds = Array.from(new Set(rows.map((row) => row.packageId)));
  const pkgSnaps = pkgIds.length ? await db.getAll(...pkgIds.map((id) => docRef(db, "packages", id))) : [];
  const pkgById = new Map<number, Package>();
  for (const pkgSnap of pkgSnaps) {
    const row = rowFromSnap(pkgSnap);
    if (row) pkgById.set(row.id, row as Package);
  }
  const joined = rows
    .map((membership) => ({ membership, package: pkgById.get(membership.packageId) ?? null }))
    .filter((row): row is { membership: UserPackage; package: Package } => row.package !== null)
    .sort((a, b) => {
      const at = a.membership.createdAt ? new Date(a.membership.createdAt).getTime() : 0;
      const bt = b.membership.createdAt ? new Date(b.membership.createdAt).getTime() : 0;
      return bt - at;
    });
  const now = new Date();
  const current = joined.find(
    (row) =>
      row.membership.status === "active" &&
      (!row.membership.expiresAt || new Date(row.membership.expiresAt) > now),
  );
  return current ?? null;
}

export async function getDashboardOverview(userId: number) {
  const db = requireDatabase(await getDb());
  const user = await getUserById(userId);
  const wallet = await ensureWallet(userId);
  const membership = await getActiveMembership(userId);
  const platformDay = await platformDayWindow();
  const todayStart = Timestamp.fromDate(platformDay.start);
  const todayEarningsPaisa =
    (await sumWhere(db, "ledgerEntries", "amountPaisa", (col) =>
      col
        .where("userId", "==", userId)
        .where("direction", "==", "credit")
        .where("createdAt", ">=", todayStart),
    )) ?? 0;
  const todayViews = await countWhere(db, "adViews", (col) =>
    col.where("userId", "==", userId).where("status", "==", "completed").where("completedAt", ">=", todayStart),
  );
  const todayVideoRewards = await countWhere(db, "videoCompletions", (col) =>
    col.where("userId", "==", userId).where("completedDay", "==", toStoredValue(platformDay.completedDay)),
  );
  const settings = await getSettingMap();
  const pendingWithdrawalsPaisa = await sumWhere(db, "withdrawals", "amountPaisa", (col) =>
    col.where("userId", "==", userId).where("status", "in", ["pending", "processing"]),
  );
  const ledgerSnap = await db.collection("ledgerEntries").where("userId", "==", userId).limit(200).get();
  const recentLedger = (rowsFromSnaps(ledgerSnap.docs) as LedgerEntry[])
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20);
  const notificationSnap = await db.collection("notifications").where("userId", "==", userId).limit(200).get();
  const recentNotifications = (rowsFromSnaps(notificationSnap.docs) as Notification[])
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 20);
  return {
    user,
    wallet,
    membership,
    todayEarningsPaisa,
    todayViews,
    todayVideoRewards,
    platformTimeZone: settings.platform_timezone || "Asia/Karachi",
    pendingWithdrawalsPaisa,
    recentLedger,
    recentNotifications,
  };
}

// ---------------------------------------------------------------------------
// Ad campaigns & views
// ---------------------------------------------------------------------------

export async function getEligibleCampaigns(userId: number) {
  const db = requireDatabase(await getDb());
  const membership = await getActiveMembership(userId);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const completedToday = membership
    ? await countWhere(db, "adViews", (col) =>
        col.where("userId", "==", userId).where("status", "==", "completed").where("completedAt", ">=", Timestamp.fromDate(today)),
      )
    : 0;
  if (!membership) return { membership: null, completedToday, campaigns: [] };
  const snap = await db.collection("adCampaigns").where("status", "==", "active").get();
  const allCampaigns = rowsFromSnaps(snap.docs) as AdCampaign[];
  const now = new Date();
  const eligible = allCampaigns
    .filter(
      (campaign) =>
        isCampaignEligibleForPackage(campaign.eligiblePackageId ?? null, membership.package.id) &&
        new Date(campaign.startAt) <= now &&
        new Date(campaign.endAt) > now &&
        campaign.completedViewsCount < campaign.maxImpressions &&
        campaign.rewardsDistributedPaisa < campaign.budgetPaisa,
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return { membership, completedToday, campaigns: eligible };
}

export async function startAdSession(
  userId: number,
  campaignId: number,
  security: { ipHash?: string; deviceHash?: string },
) {
  const db = requireDatabase(await getDb());
  const membership = await getActiveMembership(userId);
  if (!membership) throw new Error("An active membership is required to watch advertisements.");
  const user = await getUserById(userId);
  if (user.accountStatus === "suspended") throw new Error("Your account is suspended and cannot watch advertisements.");
  const campaign = (await getDoc(db, "adCampaigns", campaignId)) as AdCampaign | null;
  const now = new Date();
  if (
    !campaign ||
    campaign.status !== "active" ||
    !isCampaignEligibleForPackage(campaign.eligiblePackageId ?? null, membership.package.id) ||
    new Date(campaign.startAt) > now ||
    new Date(campaign.endAt) <= now
  )
    throw new Error("This advertisement campaign is not currently available.");
  if (
    campaign.completedViewsCount >= campaign.maxImpressions ||
    campaign.rewardsDistributedPaisa >= campaign.budgetPaisa
  )
    throw new Error("This advertisement campaign is no longer available.");
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const completedToday = await countWhere(db, "adViews", (col) =>
    col.where("userId", "==", userId).where("status", "==", "completed").where("completedAt", ">=", Timestamp.fromDate(today)),
  );
  if (completedToday >= membership.package.dailyAdLimit) throw new Error("You have reached today's advertisement limit.");
  const sessionToken = randomUUID();
  const viewId = await db.runTransaction(async (tx) => {
    // ---- read phase: every tx.get happens before any write ----
    const tokenClaim = await peekUniqueClaim(tx, db, ukey("adsession_token", sessionToken));
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const id = allocId(counters, "adViews");
    const nowTs = new Date();
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.set(
      docRef(db, "adViews", id),
      toStore({
        id,
        userId,
        campaignId,
        sessionToken,
        status: "started",
        rewardPaisa: 0,
        requiredSeconds: campaign.durationSeconds,
        startedAt: nowTs,
        completedAt: null,
        rejectionReason: null,
        ipHash: security.ipHash ?? null,
        deviceHash: security.deviceHash ?? null,
      } satisfies AdView),
    );
    applyUniqueClaim(tx, tokenClaim, id, "Session token collision; please try again.");
    return id;
  });
  return { sessionToken, viewId, requiredSeconds: campaign.durationSeconds };
}

export async function completeAdSession(userId: number, sessionToken: string) {
  const db = requireDatabase(await getDb());
  const viewId = await uniqueOwner(db, ukey("adsession_token", sessionToken));
  const view = (viewId != null ? await getDoc(db, "adViews", viewId) : null) as AdView | null;
  if (!view || view.userId !== userId) throw new Error("The requested advertisement session was not found.");
  if (view.status !== "started") throw new Error("This advertisement session has already been resolved.");
  const campaign = (await getDoc(db, "adCampaigns", view.campaignId)) as AdCampaign | null;
  if (!campaign) throw new Error("The related campaign is no longer available.");
  const active = await getActiveMembership(userId);
  if (!active) throw new Error("An active membership is required to earn advertisement rewards.");
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dailyCompletedViews = await countWhere(db, "adViews", (col) =>
    col.where("userId", "==", userId).where("status", "==", "completed").where("completedAt", ">=", Timestamp.fromDate(today)),
  );
  const check = evaluateAdCompletion({
    startedAtMs: new Date(view.startedAt).getTime(),
    nowMs: Date.now(),
    requiredSeconds: view.requiredSeconds,
    dailyCompletedViews,
    dailyAdLimit: active.package.dailyAdLimit,
    campaignCompletedViews: campaign.completedViewsCount,
    campaignMaxImpressions: campaign.maxImpressions,
    campaignRewardPaisa: campaign.rewardPaisa,
    campaignRemainingBudgetPaisa: campaign.budgetPaisa - campaign.rewardsDistributedPaisa,
  });
  if (!check.eligible) {
    await db.runTransaction(async (tx) => {
      tx.update(docRef(db, "adViews", view.id), { status: "rejected", rejectionReason: check.reason });
    });
    throw new Error(check.reason ?? "This advertisement is not eligible for a reward.");
  }
  const wallet = await ensureWallet(userId);
  const now = new Date();
  const newCompletedViews = campaign.completedViewsCount + 1;
  const newRewardsDistributed = campaign.rewardsDistributedPaisa + campaign.rewardPaisa;
  const newStatus =
    newCompletedViews >= campaign.maxImpressions || newRewardsDistributed >= campaign.budgetPaisa
      ? "complete"
      : "active";
  await db.runTransaction(async (tx) => {
    // ---- read phase: every tx.get happens before any write ----
    const viewSnap = await tx.get(docRef(db, "adViews", view.id));
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    if (!viewSnap.exists || (viewSnap.data() as Row).status !== "started")
      throw new Error("This advertisement session has already been resolved.");
    const ledgerId = allocId(counters, "ledgerEntries");
    const notificationId = allocId(counters, "notifications");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(docRef(db, "adViews", view.id), {
      status: "completed",
      completedAt: now,
      rewardPaisa: campaign.rewardPaisa,
    });
    tx.update(docRef(db, "adCampaigns", campaign.id), {
      completedViewsCount: newCompletedViews,
      rewardsDistributedPaisa: newRewardsDistributed,
      status: newStatus,
    });
    tx.update(docRef(db, "wallets", wallet.id), {
      availableBalancePaisa: wallet.availableBalancePaisa + campaign.rewardPaisa,
      lifetimeEarnedPaisa: wallet.lifetimeEarnedPaisa + campaign.rewardPaisa,
      updatedAt: now,
    });
    tx.set(
      docRef(db, "ledgerEntries", ledgerId),
      toStore({
        id: ledgerId,
        transactionGroupId: randomUUID(),
        userId,
        transactionType: "advertisement_reward",
        direction: "credit",
        amountPaisa: campaign.rewardPaisa,
        previousAvailableBalancePaisa: wallet.availableBalancePaisa,
        newAvailableBalancePaisa: wallet.availableBalancePaisa + campaign.rewardPaisa,
        previousHeldBalancePaisa: wallet.heldBalancePaisa,
        newHeldBalancePaisa: wallet.heldBalancePaisa,
        relatedEntityType: "ad_view",
        relatedEntityId: view.id,
        description: `Validated reward for ${campaign.title}`,
        createdByUserId: null,
        createdAt: now,
      } satisfies LedgerEntry),
    );
    tx.set(
      docRef(db, "notifications", notificationId),
      toStore({
        id: notificationId,
        userId,
        title: "Advertising reward credited",
        message: "A completed advertisement has been validated and recorded in your balance.",
        type: "success",
        readAt: null,
        createdAt: now,
      } satisfies Notification),
    );
  });
  return { rewardPaisa: campaign.rewardPaisa };
}

export async function listCampaigns() {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("adCampaigns").get();
  const rows = rowsFromSnaps(snap.docs) as AdCampaign[];
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rows;
}

export async function createCampaign(
  input: {
    title: string;
    advertiser: string;
    description?: string | null;
    mediaUrl?: string | null;
    callToAction?: string | null;
    targetUrl?: string | null;
    eligiblePackageId?: number | null;
    durationSeconds: number;
    rewardPaisa: number;
    budgetPaisa: number;
    maxImpressions: number;
    startAt: Date;
    endAt: Date;
    status?: AdCampaign["status"];
    completedViewsCount?: number;
    rewardsDistributedPaisa?: number;
  },
  adminUserId: number,
) {
  const db = requireDatabase(await getDb());
  if (
    input.rewardPaisa <= 0 ||
    input.budgetPaisa < input.rewardPaisa ||
    input.maxImpressions <= 0 ||
    input.durationSeconds < 5 ||
    input.endAt <= input.startAt
  )
    throw new Error("Campaign budget, limits, duration, or dates are invalid.");
  const now = new Date();
  const campaignId = await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const id = allocId(counters, "adCampaigns");
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.set(
      docRef(db, "adCampaigns", id),
      toStore({
        id,
        title: input.title,
        advertiser: input.advertiser,
        description: input.description ?? null,
        mediaUrl: input.mediaUrl ?? null,
        callToAction: input.callToAction ?? null,
        targetUrl: input.targetUrl ?? null,
        eligiblePackageId: input.eligiblePackageId ?? null,
        durationSeconds: input.durationSeconds,
        rewardPaisa: input.rewardPaisa,
        budgetPaisa: input.budgetPaisa,
        maxImpressions: input.maxImpressions,
        startAt: input.startAt,
        endAt: input.endAt,
        status: input.status ?? "draft",
        completedViewsCount: 0,
        rewardsDistributedPaisa: 0,
        createdAt: now,
        updatedAt: now,
      }),
    );
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: adminUserId,
        action: "campaign_created",
        entityType: "campaign",
        entityId: id,
        oldValue: null,
        newValue: { title: input.title, budgetPaisa: input.budgetPaisa },
        ipHash: null,
        createdAt: now,
      } satisfies AuditLog),
    );
    return id;
  });
  return { id: campaignId };
}

export async function updateCampaign(input: {
  adminUserId: number;
  campaignId: number;
  title: string;
  advertiser: string;
  description?: string;
  mediaUrl?: string;
  callToAction?: string;
  targetUrl?: string;
  eligiblePackageId?: number | null;
  durationSeconds: number;
  rewardPaisa: number;
  budgetPaisa: number;
  maxImpressions: number;
  startAt: Date;
  endAt: Date;
  status: "draft" | "active" | "paused";
}) {
  const db = requireDatabase(await getDb());
  if (
    input.rewardPaisa <= 0 ||
    input.budgetPaisa < input.rewardPaisa ||
    input.maxImpressions <= 0 ||
    input.durationSeconds < 5 ||
    input.endAt <= input.startAt
  )
    throw new Error("Campaign budget, limits, duration, or dates are invalid.");
  const existing = (await getDoc(db, "adCampaigns", input.campaignId)) as AdCampaign | null;
  if (!existing) throw new Error("The campaign record was not found.");
  if (input.eligiblePackageId) {
    const packageRow = await getDoc(db, "packages", input.eligiblePackageId);
    if (!packageRow) throw new Error("The selected package does not exist.");
  }
  if (input.budgetPaisa < existing.rewardsDistributedPaisa)
    throw new Error("Campaign budget cannot be lower than rewards already recorded.");
  await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(
      docRef(db, "adCampaigns", input.campaignId),
      toStore({
        title: input.title,
        advertiser: input.advertiser,
        description: input.description?.trim() || null,
        mediaUrl: input.mediaUrl?.trim() || null,
        callToAction: input.callToAction?.trim() || null,
        targetUrl: input.targetUrl?.trim() || null,
        eligiblePackageId: input.eligiblePackageId ?? null,
        durationSeconds: input.durationSeconds,
        rewardPaisa: input.rewardPaisa,
        budgetPaisa: input.budgetPaisa,
        maxImpressions: input.maxImpressions,
        startAt: input.startAt,
        endAt: input.endAt,
        status: input.status,
        updatedAt: new Date(),
      }),
    );
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: "campaign_updated",
        entityType: "campaign",
        entityId: input.campaignId,
        oldValue: { title: existing.title, status: existing.status, eligiblePackageId: existing.eligiblePackageId },
        newValue: { title: input.title, status: input.status, eligiblePackageId: input.eligiblePackageId ?? null },
        ipHash: null,
        createdAt: new Date(),
      } satisfies AuditLog),
    );
  });
  return { success: true };
}

export async function deleteCampaign(input: { adminUserId: number; campaignId: number }) {
  const db = requireDatabase(await getDb());
  const existing = (await getDoc(db, "adCampaigns", input.campaignId)) as AdCampaign | null;
  if (!existing) throw new Error("The campaign record was not found.");
  const viewSnap = await db.collection("adViews").where("campaignId", "==", input.campaignId).limit(1).get();
  if (!viewSnap.empty)
    throw new Error("Campaigns with recorded viewing activity cannot be deleted; pause them to preserve the audit trail.");
  await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.delete(docRef(db, "adCampaigns", input.campaignId));
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: "campaign_deleted",
        entityType: "campaign",
        entityId: input.campaignId,
        oldValue: { title: existing.title },
        newValue: null,
        ipHash: null,
        createdAt: new Date(),
      } satisfies AuditLog),
    );
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Payment proofs & memberships
// ---------------------------------------------------------------------------

export async function submitPaymentProof(input: {
  userId: number;
  packageId: number;
  paymentMethod: "jazzcash" | "easypaisa" | "bank_transfer";
  amountPaisa: number;
  senderAccount: string;
  transactionId: string;
  screenshotKey?: string;
  screenshotUrl?: string;
  screenshotFileName?: string;
  screenshotMimeType?: string;
  screenshotBytes?: number;
  additionalNote?: string;
}) {
  const db = requireDatabase(await getDb());
  const packageRow = (await getDoc(db, "packages", input.packageId)) as Package | null;
  if (!packageRow || packageRow.status !== "active") throw new Error("This membership is not currently available.");
  if (input.amountPaisa !== packageRow.pricePaisa)
    throw new Error("The submitted amount must match the selected membership price.");
  const proofsSnap = await db.collection("paymentProofs").where("userId", "==", input.userId).get();
  const attempts = rowsFromSnaps(proofsSnap.docs).map((row) => Number(row.attemptNumber ?? 0));
  const attemptNumber = (attempts.length ? Math.max(...attempts) : 0) + 1;
  const proofId = await db.runTransaction(async (tx) => {
    // ---- read phase: every tx.get happens before any write ----
    const txnClaim = await peekUniqueClaim(tx, db, ukey("paymentproof", "txn", input.transactionId.trim()));
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const id = allocId(counters, "paymentProofs");
    const membershipId = allocId(counters, "userPackages");
    const notificationId = allocId(counters, "notifications");
    const now = new Date();
    // ---- write phase ----
    writeCounters(tx, counters);
    applyUniqueClaim(tx, txnClaim, id, "This transaction ID has already been submitted.");
    tx.set(
      docRef(db, "paymentProofs", id),
      toStore({
        id,
        userId: input.userId,
        packageId: input.packageId,
        paymentMethod: input.paymentMethod,
        amountPaisa: input.amountPaisa,
        senderAccount: input.senderAccount,
        transactionId: input.transactionId,
        screenshotKey: input.screenshotKey ?? null,
        screenshotUrl: input.screenshotUrl ?? null,
        screenshotFileName: input.screenshotFileName ?? null,
        screenshotMimeType: input.screenshotMimeType ?? null,
        screenshotBytes: input.screenshotBytes ?? null,
        additionalNote: input.additionalNote ?? null,
        attemptNumber,
        status: "pending",
        rejectionReason: null,
        reviewedByUserId: null,
        reviewedAt: null,
        createdAt: now,
      }),
    );
    tx.set(
      docRef(db, "userPackages", membershipId),
      toStore({
        id: membershipId,
        userId: input.userId,
        packageId: input.packageId,
        paymentProofId: id,
        status: "pending",
        startedAt: null,
        expiresAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    tx.set(
      docRef(db, "notifications", notificationId),
      toStore({
        id: notificationId,
        userId: input.userId,
        title: "Payment verification submitted",
        message: "Your membership payment proof is pending administrative review.",
        type: "info",
        readAt: null,
        createdAt: now,
      } satisfies Notification),
    );
    return id;
  });
  return { id: proofId };
}

export async function getUserPaymentProofs(userId: number) {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("paymentProofs").where("userId", "==", userId).get();
  const proofs = rowsFromSnaps(snap.docs) as PaymentProof[];
  const pkgIds = Array.from(new Set(proofs.map((proof) => proof.packageId)));
  const pkgSnaps = pkgIds.length ? await db.getAll(...pkgIds.map((id) => docRef(db, "packages", id))) : [];
  const pkgById = new Map<number, Package>();
  for (const pkgSnap of pkgSnaps) {
    const row = rowFromSnap(pkgSnap);
    if (row) pkgById.set(row.id, row as Package);
  }
  return proofs
    .map((payment) => ({
      payment,
      package: requiredRow(pkgById.get(payment.packageId), "The related package was not found."),
    }))
    .sort((a, b) => new Date(b.payment.createdAt).getTime() - new Date(a.payment.createdAt).getTime());
}

export async function getAuthorizedPaymentProofUrl(input: {
  requester: Pick<User, "id" | "role">;
  paymentProofId: number;
}) {
  const db = requireDatabase(await getDb());
  const payment = (await getDoc(db, "paymentProofs", input.paymentProofId)) as PaymentProof | null;
  if (!payment?.screenshotKey) throw new Error("No payment screenshot is stored for this record.");
  if (input.requester.role !== "admin" && input.requester.id !== payment.userId)
    throw new Error("You are not allowed to view this payment screenshot.");
  return { url: await storageGetSignedUrl(payment.screenshotKey) };
}

export async function getAdminPaymentProofs() {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("paymentProofs").get();
  const proofs = rowsFromSnaps(snap.docs) as PaymentProof[];
  const pkgIds = Array.from(new Set(proofs.map((proof) => proof.packageId)));
  const userIds = Array.from(new Set(proofs.map((proof) => proof.userId)));
  const pkgSnaps = pkgIds.length ? await db.getAll(...pkgIds.map((id) => docRef(db, "packages", id))) : [];
  const userSnaps = userIds.length ? await db.getAll(...userIds.map((id) => docRef(db, "users", id))) : [];
  const pkgById = new Map<number, Package>();
  for (const pkgSnap of pkgSnaps) {
    const row = rowFromSnap(pkgSnap);
    if (row) pkgById.set(row.id, row as Package);
  }
  const userById = new Map<number, User>();
  for (const userSnap of userSnaps) {
    const row = rowFromSnap(userSnap);
    if (row) userById.set(row.id, row as User);
  }
  return proofs
    .map((payment) => ({
      payment,
      package: requiredRow(pkgById.get(payment.packageId), "The related package was not found."),
      user: requiredRow(userById.get(payment.userId), "The related user was not found."),
    }))
    .sort((a, b) => new Date(b.payment.createdAt).getTime() - new Date(a.payment.createdAt).getTime());
}

export async function reviewPaymentProof(input: {
  adminUserId: number;
  paymentProofId: number;
  action: "approve" | "reject";
  rejectionReason?: string;
}) {
  const db = requireDatabase(await getDb());
  const payment = (await getDoc(db, "paymentProofs", input.paymentProofId)) as PaymentProof | null;
  if (!payment) throw new Error("This payment proof is no longer pending.");
  assertPendingPaymentDecision(payment.status);
  const packageRow = (await getDoc(db, "packages", payment.packageId)) as Package | null;
  if (!packageRow) throw new Error("The related package was not found.");
  const now = new Date();
  if (input.action === "reject") {
    const rejectionReason = input.rejectionReason?.trim();
    if (!rejectionReason) throw new Error("A rejection reason is required.");
    await db.runTransaction(async (tx) => {
      // ---- read phase: every tx.get happens before any write ----
      const membershipSnap = await tx.get(db.collection("userPackages").where("paymentProofId", "==", payment.id));
      const counters = await readCounters(tx, db);
      // ---- compute phase (pure) ----
      const notificationId = allocId(counters, "notifications");
      const auditId = allocId(counters, "auditLogs");
      // ---- write phase ----
      writeCounters(tx, counters);
      tx.update(docRef(db, "paymentProofs", payment.id), {
        status: "rejected",
        rejectionReason,
        reviewedByUserId: input.adminUserId,
        reviewedAt: now,
      });
      for (const doc of membershipSnap.docs) {
        tx.update(doc.ref, { status: "cancelled", updatedAt: now });
      }
      tx.set(
        docRef(db, "notifications", notificationId),
        toStore({
          id: notificationId,
          userId: payment.userId,
          title: "Payment verification rejected",
          message: rejectionReason,
          type: "warning",
          readAt: null,
          createdAt: now,
        } satisfies Notification),
      );
      tx.set(
        docRef(db, "auditLogs", auditId),
        toStore({
          id: auditId,
          actorUserId: input.adminUserId,
          action: "payment_rejected",
          entityType: "payment_proof",
          entityId: payment.id,
          oldValue: null,
          newValue: { reason: rejectionReason },
          ipHash: null,
          createdAt: now,
        } satisfies AuditLog),
      );
    });
    return { status: "rejected" as const };
  }
  const expiry = new Date(Date.now() + packageRow.durationDays * 24 * 60 * 60 * 1000);
  await db.runTransaction(async (tx) => {
    // ---- read phase: every tx.get happens before any write ----
    const membershipSnap = await tx.get(db.collection("userPackages").where("paymentProofId", "==", payment.id));
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const ledgerId = allocId(counters, "ledgerEntries");
    const notificationId = allocId(counters, "notifications");
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(docRef(db, "paymentProofs", payment.id), {
      status: "approved",
      reviewedByUserId: input.adminUserId,
      reviewedAt: now,
    });
    for (const doc of membershipSnap.docs) {
      tx.update(doc.ref, { status: "active", startedAt: now, expiresAt: Timestamp.fromDate(expiry), updatedAt: now });
    }
    tx.set(
      docRef(db, "ledgerEntries", ledgerId),
      toStore({
        id: ledgerId,
        transactionGroupId: randomUUID(),
        userId: payment.userId,
        transactionType: "package_payment",
        direction: "debit",
        amountPaisa: 0,
        previousAvailableBalancePaisa: 0,
        newAvailableBalancePaisa: 0,
        previousHeldBalancePaisa: 0,
        newHeldBalancePaisa: 0,
        relatedEntityType: "payment_proof",
        relatedEntityId: payment.id,
        description: `Membership payment approved for ${packageRow.name}`,
        createdByUserId: input.adminUserId,
        createdAt: now,
      } satisfies LedgerEntry),
    );
    tx.set(
      docRef(db, "notifications", notificationId),
      toStore({
        id: notificationId,
        userId: payment.userId,
        title: "Membership activated",
        message: "Your payment has been verified and your membership is now active.",
        type: "success",
        readAt: null,
        createdAt: now,
      } satisfies Notification),
    );
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: "payment_approved",
        entityType: "payment_proof",
        entityId: payment.id,
        oldValue: null,
        newValue: { packageId: packageRow.id },
        ipHash: null,
        createdAt: now,
      } satisfies AuditLog),
    );
  });
  return { status: "approved" as const };
}

export async function getMemberProfile(userId: number) {
  const user = await getUserById(userId);
  const membership = await getActiveMembership(userId);
  return { user, membership };
}

export async function updateMemberProfile(input: { userId: number; name: string; phone?: string }) {
  const db = requireDatabase(await getDb());
  const name = input.name.trim();
  const phone = input.phone?.trim() || null;
  if (name.length < 2) throw new Error("Enter a valid full name.");
  if (phone && !isValidPakistanMobile(phone)) throw new Error("Enter a valid Pakistani mobile number.");
  const user = await getUserById(input.userId);
  await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(docRef(db, "users", input.userId), { name, phone, updatedAt: new Date() });
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.userId,
        action: "profile_updated",
        entityType: "user",
        entityId: input.userId,
        oldValue: { name: user.name, phone: user.phone ? "[masked]" : null },
        newValue: { name, phone: phone ? "[masked]" : null },
        ipHash: null,
        createdAt: new Date(),
      } satisfies AuditLog),
    );
  });
  return { name, phone };
}

// ---------------------------------------------------------------------------
// Ledger & notifications
// ---------------------------------------------------------------------------

export async function getLedgerHistory(userId: number, period: "today" | "week" | "month" | "all") {
  const db = requireDatabase(await getDb());
  // NOTE: single-field userId query + in-memory date filter on purpose — the
  // (userId, createdAt) composite index does not exist in Firestore, and the
  // result is capped at 200 rows anyway.
  const snap = await db.collection("ledgerEntries").where("userId", "==", userId).get();
  const now = new Date();
  const since = new Date(now);
  if (period === "today") since.setUTCHours(0, 0, 0, 0);
  if (period === "week") since.setUTCDate(since.getUTCDate() - 7);
  if (period === "month") since.setUTCMonth(since.getUTCMonth() - 1);
  const rows = (rowsFromSnaps(snap.docs) as LedgerEntry[]).filter(
    (row) => period === "all" || new Date(row.createdAt).getTime() >= since.getTime(),
  );
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rows.slice(0, 200);
}

export async function getUserNotifications(userId: number) {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("notifications").where("userId", "==", userId).get();
  const rows = rowsFromSnaps(snap.docs) as Notification[];
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rows.slice(0, 100);
}

export async function markNotificationsRead(userId: number, notificationIds?: number[]) {
  const db = requireDatabase(await getDb());
  const now = new Date();
  const ids = notificationIds?.length ? notificationIds : null;
  await db.runTransaction(async (tx) => {
    if (ids) {
      const snaps = await db.getAll(...ids.map((id) => docRef(db, "notifications", id)));
      for (const snap of snaps) {
        const row = rowFromSnap(snap);
        if (row && row.userId === userId) tx.update(snap.ref, { readAt: now });
      }
    } else {
      const snap = await tx.get(db.collection("notifications").where("userId", "==", userId));
      for (const doc of snap.docs) tx.update(doc.ref, { readAt: now });
    }
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

export async function createWithdrawal(input: {
  userId: number;
  amountPaisa: number;
  paymentMethod: "jazzcash" | "easypaisa";
  accountHolderName: string;
  accountNumber: string;
}) {
  const db = requireDatabase(await getDb());
  const settings = await getSettingMap();
  const quote = calculateWithdrawalQuote(
    input.amountPaisa,
    Number(settings.minimum_withdrawal_paisa ?? 200_000),
    Number(settings.withdrawal_fee_paisa ?? 15_000),
    Number(settings.maximum_withdrawal_paisa ?? 0),
  );
  const wallet = await ensureWallet(input.userId);
  if (wallet.availableBalancePaisa < quote.amountPaisa)
    throw new Error("Your available balance is insufficient for this withdrawal.");
  const now = new Date();
  const withdrawalId = await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const id = allocId(counters, "withdrawals");
    const ledgerId = allocId(counters, "ledgerEntries");
    const notificationId = allocId(counters, "notifications");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.set(
      docRef(db, "withdrawals", id),
      toStore({
        id,
        userId: input.userId,
        amountPaisa: quote.amountPaisa,
        feePaisa: quote.feePaisa,
        netAmountPaisa: quote.netAmountPaisa,
        paymentMethod: input.paymentMethod,
        accountHolderName: input.accountHolderName,
        accountNumber: input.accountNumber,
        status: "pending",
        transactionReference: null,
        adminNote: null,
        processedByUserId: null,
        processedAt: null,
        createdAt: now,
        updatedAt: now,
      }),
    );
    tx.update(docRef(db, "wallets", wallet.id), {
      availableBalancePaisa: wallet.availableBalancePaisa - quote.amountPaisa,
      heldBalancePaisa: wallet.heldBalancePaisa + quote.amountPaisa,
      updatedAt: now,
    });
    tx.set(
      docRef(db, "ledgerEntries", ledgerId),
      toStore({
        id: ledgerId,
        transactionGroupId: randomUUID(),
        userId: input.userId,
        transactionType: "withdrawal_hold",
        direction: "hold",
        amountPaisa: quote.amountPaisa,
        previousAvailableBalancePaisa: wallet.availableBalancePaisa,
        newAvailableBalancePaisa: wallet.availableBalancePaisa - quote.amountPaisa,
        previousHeldBalancePaisa: wallet.heldBalancePaisa,
        newHeldBalancePaisa: wallet.heldBalancePaisa + quote.amountPaisa,
        relatedEntityType: "withdrawal",
        relatedEntityId: id,
        description: "Withdrawal request balance hold",
        createdByUserId: null,
        createdAt: now,
      } satisfies LedgerEntry),
    );
    tx.set(
      docRef(db, "notifications", notificationId),
      toStore({
        id: notificationId,
        userId: input.userId,
        title: "Withdrawal submitted",
        message: "Your withdrawal request is pending administrative review.",
        type: "info",
        readAt: null,
        createdAt: now,
      } satisfies Notification),
    );
    return id;
  });
  return { withdrawalId, ...quote };
}

export async function getUserWithdrawals(userId: number) {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("withdrawals").where("userId", "==", userId).get();
  const rows = rowsFromSnaps(snap.docs) as Withdrawal[];
  rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return rows;
}

export async function getAdminWithdrawals() {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("withdrawals").get();
  const withdrawals = rowsFromSnaps(snap.docs) as Withdrawal[];
  const userIds = Array.from(new Set(withdrawals.map((row) => row.userId)));
  const userSnaps = userIds.length ? await db.getAll(...userIds.map((id) => docRef(db, "users", id))) : [];
  const userById = new Map<number, User>();
  for (const userSnap of userSnaps) {
    const row = rowFromSnap(userSnap);
    if (row) userById.set(row.id, row as User);
  }
  return withdrawals
    .map((withdrawal) => ({
      withdrawal,
      user: requiredRow(userById.get(withdrawal.userId), "The related user was not found."),
    }))
    .sort((a, b) => new Date(b.withdrawal.createdAt).getTime() - new Date(a.withdrawal.createdAt).getTime());
}

export async function updateWithdrawalStatus(input: {
  adminUserId: number;
  withdrawalId: number;
  status: "processing" | "paid" | "rejected" | "cancelled";
  transactionReference?: string;
  adminNote?: string;
}) {
  const db = requireDatabase(await getDb());
  const withdrawal = (await getDoc(db, "withdrawals", input.withdrawalId)) as Withdrawal | null;
  if (!withdrawal || !["pending", "processing"].includes(withdrawal.status))
    throw new Error("This withdrawal cannot be updated.");
  if (input.status === "paid" && !input.transactionReference?.trim())
    throw new Error("A payment reference is required before marking a withdrawal paid.");
  const now = new Date();
  if (input.status === "processing") {
    await db.runTransaction(async (tx) => {
      tx.update(docRef(db, "withdrawals", withdrawal.id), {
        status: "processing",
        adminNote: input.adminNote?.trim() ?? null,
        processedByUserId: input.adminUserId,
        processedAt: now,
      });
    });
    return { status: "processing" as const };
  }
  const wallet = await ensureWallet(withdrawal.userId);
  await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const isReturn = input.status === "rejected" || input.status === "cancelled";
    const newAvailable = isReturn ? wallet.availableBalancePaisa + withdrawal.amountPaisa : wallet.availableBalancePaisa;
    const newHeld = Math.max(0, wallet.heldBalancePaisa - withdrawal.amountPaisa);
    const ledgerId = allocId(counters, "ledgerEntries");
    const notificationId = allocId(counters, "notifications");
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(docRef(db, "withdrawals", withdrawal.id), {
      status: input.status,
      adminNote: input.adminNote?.trim() ?? null,
      transactionReference: input.transactionReference?.trim() ?? null,
      processedByUserId: input.adminUserId,
      processedAt: now,
    });
    tx.update(docRef(db, "wallets", wallet.id), {
      availableBalancePaisa: newAvailable,
      heldBalancePaisa: newHeld,
      updatedAt: now,
    });
    tx.set(
      docRef(db, "ledgerEntries", ledgerId),
      toStore({
        id: ledgerId,
        transactionGroupId: randomUUID(),
        userId: withdrawal.userId,
        transactionType: isReturn ? "withdrawal_reversal" : "withdrawal_payment",
        direction: isReturn ? "release" : "debit",
        amountPaisa: withdrawal.amountPaisa,
        previousAvailableBalancePaisa: wallet.availableBalancePaisa,
        newAvailableBalancePaisa: newAvailable,
        previousHeldBalancePaisa: wallet.heldBalancePaisa,
        newHeldBalancePaisa: newHeld,
        relatedEntityType: "withdrawal",
        relatedEntityId: withdrawal.id,
        description: isReturn ? "Withdrawal balance released" : "Withdrawal payment marked paid",
        createdByUserId: input.adminUserId,
        createdAt: now,
      } satisfies LedgerEntry),
    );
    tx.set(
      docRef(db, "notifications", notificationId),
      toStore({
        id: notificationId,
        userId: withdrawal.userId,
        title: `Withdrawal ${input.status}`,
        message:
          input.status === "paid"
            ? "Your withdrawal has been marked paid."
            : "Your withdrawal has been released according to the platform rules.",
        type: input.status === "paid" ? "success" : "warning",
        readAt: null,
        createdAt: now,
      } satisfies Notification),
    );
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: `withdrawal_${input.status}`,
        entityType: "withdrawal",
        entityId: withdrawal.id,
        oldValue: null,
        newValue: { transactionReference: input.transactionReference ?? null, note: input.adminNote ?? null },
        ipHash: null,
        createdAt: now,
      } satisfies AuditLog),
    );
  });
  return { status: input.status };
}

// ---------------------------------------------------------------------------
// Fraud flags
// ---------------------------------------------------------------------------

export async function getAdminFraudFlags() {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("fraudFlags").get();
  const flags = rowsFromSnaps(snap.docs) as FraudFlag[];
  const userIds = Array.from(new Set(flags.map((row) => row.userId)));
  const userSnaps = userIds.length ? await db.getAll(...userIds.map((id) => docRef(db, "users", id))) : [];
  const userById = new Map<number, User>();
  for (const userSnap of userSnaps) {
    const row = rowFromSnap(userSnap);
    if (row) userById.set(row.id, row as User);
  }
  return flags
    .map((flag) => ({ flag, user: requiredRow(userById.get(flag.userId), "The related user was not found.") }))
    .sort((a, b) => new Date(b.flag.createdAt).getTime() - new Date(a.flag.createdAt).getTime())
    .slice(0, 100);
}

export async function createFraudFlag(input: {
  adminUserId: number;
  userId: number;
  severity: "low" | "medium" | "high";
  reason: string;
}) {
  const db = requireDatabase(await getDb());
  const now = new Date();
  const flagId = await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const id = allocId(counters, "fraudFlags");
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.set(
      docRef(db, "fraudFlags", id),
      toStore({
        id,
        userId: input.userId,
        relatedEntityType: null,
        relatedEntityId: null,
        severity: input.severity,
        reason: input.reason.trim(),
        status: "open",
        reviewedByUserId: null,
        createdAt: now,
        reviewedAt: null,
      }),
    );
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: "fraud_flag_created",
        entityType: "fraud_flag",
        entityId: id,
        oldValue: null,
        newValue: { userId: input.userId, severity: input.severity, reason: input.reason.trim() },
        ipHash: null,
        createdAt: now,
      } satisfies AuditLog),
    );
    return id;
  });
  return { id: flagId };
}

/** System-generated fraud flag (no administrator actor, no audit log). */
export async function createSystemFraudFlag(input: {
  userId: number;
  severity: "low" | "medium" | "high";
  reason: string;
  relatedEntityType?: string | null;
  relatedEntityId?: number | null;
}): Promise<{ id: number }> {
  const db = requireDatabase(await getDb());
  const flagId = await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const id = allocId(counters, "fraudFlags");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.set(
      docRef(db, "fraudFlags", id),
      toStore({
        id,
        userId: input.userId,
        relatedEntityType: input.relatedEntityType ?? null,
        relatedEntityId: input.relatedEntityId ?? null,
        severity: input.severity,
        reason: input.reason.trim(),
        status: "open",
        reviewedByUserId: null,
        createdAt: new Date(),
        reviewedAt: null,
      } satisfies FraudFlag),
    );
    return id;
  });
  return { id: flagId };
}

// ---------------------------------------------------------------------------
// Admin summaries & analytics
// ---------------------------------------------------------------------------

export async function getAdminSummary() {
  const db = requireDatabase(await getDb());
  const totalUsers = await countWhere(db, "users", (col) => col);
  const pendingProofs = await countWhere(db, "paymentProofs", (col) => col.where("status", "==", "pending"));
  const approvedPayments = await countWhere(db, "paymentProofs", (col) => col.where("status", "==", "approved"));
  const rejectedPayments = await countWhere(db, "paymentProofs", (col) => col.where("status", "==", "rejected"));
  const totalPaymentSubmissions = await countWhere(db, "paymentProofs", (col) => col);
  const pendingWithdrawals = await countWhere(db, "withdrawals", (col) =>
    col.where("status", "in", ["pending", "processing"]),
  );
  const activeCampaigns = await countWhere(db, "adCampaigns", (col) => col.where("status", "==", "active"));
  const totalVideos = await countWhere(db, "rewardVideos", (col) => col);
  const totalVideoCompletions = await countWhere(db, "videoCompletions", (col) => col);
  const pendingVideoSessions = await countWhere(db, "videoWatchSessions", (col) =>
    col.where("status", "==", "started"),
  );
  const totalExternalVideoSessions = await countWhere(db, "videoWatchSessions", (col) => col);
  const activeExternalVideoSessions = await countWhere(db, "videoWatchSessions", (col) =>
    col.where("status", "in", ["awaiting_return", "duration_verified", "code_verified"]),
  );
  const successfulVideoCodeVerifications = await countWhere(db, "videoWatchSessions", (col) =>
    col.where("verificationStatus", "==", "passed"),
  );
  const claimedVideoRewards = await countWhere(db, "videoWatchSessions", (col) =>
    col.where("rewardStatus", "==", "claimed"),
  );
  const failedVideoVerificationAttempts = await sumWhere(db, "videoWatchSessions", "verificationAttempts", (col) => col);
  const suspiciousVideoSessions = await countWhere(db, "videoWatchSessions", (col) =>
    col.where("suspiciousEventCount", ">", 0),
  );
  const fraudAlerts = await countWhere(db, "fraudFlags", (col) => col.where("status", "==", "open"));
  const rewardsDistributedPaisa = await sumWhere(db, "ledgerEntries", "amountPaisa", (col) =>
    col.where("transactionType", "in", ["advertisement_reward", "video_reward"]),
  );
  const membershipSnap = await db.collection("userPackages").where("status", "==", "active").get();
  const memberships = rowsFromSnaps(membershipSnap.docs) as UserPackage[];
  const pkgIds = Array.from(new Set(memberships.map((row) => row.packageId)));
  const pkgSnaps = pkgIds.length ? await db.getAll(...pkgIds.map((id) => docRef(db, "packages", id))) : [];
  const pkgById = new Map<number, Package>();
  for (const pkgSnap of pkgSnaps) {
    const row = rowFromSnap(pkgSnap);
    if (row) pkgById.set(row.id, row as Package);
  }
  const packageMembers: Record<string, number> = {};
  const seen = new Map<number, Set<number>>();
  for (const membership of memberships) {
    const pkg = pkgById.get(membership.packageId);
    if (!pkg) continue;
    const key = pkg.name.toLowerCase();
    let set = seen.get(pkg.id);
    if (!set) {
      set = new Set();
      seen.set(pkg.id, set);
    }
    if (set.has(membership.userId)) continue;
    set.add(membership.userId);
    packageMembers[key] = (packageMembers[key] ?? 0) + 1;
  }
  return {
    totalUsers,
    pendingProofs,
    pendingWithdrawals,
    approvedPayments,
    rejectedPayments,
    totalPaymentSubmissions,
    platinumUsers: packageMembers.platinum ?? 0,
    goldUsers: packageMembers.gold ?? 0,
    diamondUsers: packageMembers.diamond ?? 0,
    totalVideos,
    totalVideoCompletions,
    pendingVideoSessions,
    totalExternalVideoSessions,
    activeExternalVideoSessions,
    successfulVideoCodeVerifications,
    claimedVideoRewards,
    failedVideoVerificationAttempts,
    suspiciousVideoSessions,
    activeCampaigns,
    fraudAlerts,
    rewardsDistributedPaisa,
  };
}

export async function getAdminExternalVideoAnalytics() {
  const db = requireDatabase(await getDb());
  const platformDay = await platformDayWindow();
  const completionsSnap = await db
    .collection("videoCompletions")
    .where("completedDay", "==", toStoredValue(platformDay.completedDay))
    .get();
  const completions = rowsFromSnaps(completionsSnap.docs) as VideoCompletion[];
  const videoIds = Array.from(new Set(completions.map((row) => row.videoId)));
  const videoSnaps = videoIds.length ? await db.getAll(...videoIds.map((id) => docRef(db, "rewardVideos", id))) : [];
  const videoById = new Map<number, RewardVideo>();
  for (const videoSnap of videoSnaps) {
    const row = rowFromSnap(videoSnap);
    if (row) videoById.set(row.id, row as RewardVideo);
  }
  const pkgIds = Array.from(new Set(Array.from(videoById.values()).map((video) => video.packageId)));
  const pkgSnaps = pkgIds.length ? await db.getAll(...pkgIds.map((id) => docRef(db, "packages", id))) : [];
  const pkgById = new Map<number, Package>();
  for (const pkgSnap of pkgSnaps) {
    const row = rowFromSnap(pkgSnap);
    if (row) pkgById.set(row.id, row as Package);
  }
  const byVideo = new Map<number, { videoId: number; title: string; packageName: string; rewardsClaimed: number; rewardsPaisa: number }>();
  for (const completion of completions) {
    const video = videoById.get(completion.videoId);
    if (!video) continue;
    const pkg = pkgById.get(video.packageId);
    const entry = byVideo.get(completion.videoId) ?? {
      videoId: completion.videoId,
      title: video.title,
      packageName: pkg?.name ?? "Unknown",
      rewardsClaimed: 0,
      rewardsPaisa: 0,
    };
    entry.rewardsClaimed += 1;
    entry.rewardsPaisa += completion.rewardPaisa;
    byVideo.set(completion.videoId, entry);
  }
  const sessionsSnap = await db.collection("videoWatchSessions").get();
  const sessions = rowsFromSnaps(sessionsSnap.docs) as VideoWatchSession[];
  const byUser = new Map<number, { userId: number; failedAttempts: number; suspiciousSessions: number }>();
  for (const session of sessions) {
    const failed = Number(session.verificationAttempts ?? 0);
    const suspicious = Number(session.suspiciousEventCount ?? 0);
    if (failed <= 0 && suspicious <= 0) continue;
    const entry = byUser.get(session.userId) ?? { userId: session.userId, failedAttempts: 0, suspiciousSessions: 0 };
    entry.failedAttempts += failed;
    if (suspicious > 0) entry.suspiciousSessions += 1;
    byUser.set(session.userId, entry);
  }
  return {
    platformDay: platformDay.dayKey,
    dailyByVideo: Array.from(byVideo.values()).sort((a, b) => b.rewardsClaimed - a.rewardsClaimed),
    repeatedVerificationUsers: Array.from(byUser.values()).sort((a, b) => b.failedAttempts - a.failedAttempts).slice(0, 20),
  };
}

// ---------------------------------------------------------------------------
// Reward videos (external video workflow)
// ---------------------------------------------------------------------------

/**
 * Episode sequencing (CINDERWALL daily saga).
 * Videos with episodeNumber >= 1 form the ordered sequence; episodeNumber 0
 * means "outside the sequence" (never shown to members, admin-visible only).
 * A member always resumes at the lowest episode they have not completed, and
 * may claim at most one episode per platform day.
 */
export function resolveCurrentEpisode(episodeNumbers: number[], completedEpisodes: number[]): number | null {
  const done = new Set(completedEpisodes.filter((n) => Number.isInteger(n) && n >= 1));
  const ordered = Array.from(new Set(episodeNumbers.filter((n) => Number.isInteger(n) && n >= 1))).sort((a, b) => a - b);
  for (const ep of ordered) if (!done.has(ep)) return ep;
  return null;
}

export function assertEpisodeStartEligibility(input: {
  videoEpisodeNumber: number;
  currentEpisodeNumber: number | null;
  claimedAnyEpisodeToday: boolean;
}) {
  if (!Number.isInteger(input.videoEpisodeNumber) || input.videoEpisodeNumber < 1)
    throw new Error("This video is not part of the episode sequence.");
  if (input.claimedAnyEpisodeToday)
    throw new Error("You have already claimed today's episode reward. The next episode unlocks tomorrow.");
  if (input.currentEpisodeNumber == null)
    throw new Error("You have completed all available episodes. Check back tomorrow for the next one.");
  if (input.videoEpisodeNumber !== input.currentEpisodeNumber)
    throw new Error("This episode is not unlocked yet. Complete the earlier episodes first.");
}

export async function getMemberEpisodeProgress(userId: number, packageId: number, completedDayValue: unknown) {
  const db = requireDatabase(await getDb());
  const videoSnap = await db
    .collection("rewardVideos")
    .where("packageId", "==", packageId)
    .where("status", "==", "enabled")
    .get();
  const episodes = (rowsFromSnaps(videoSnap.docs) as RewardVideo[]).map((video) => video.episodeNumber ?? 0);
  const historySnap = await db.collection("videoCompletions").where("userId", "==", userId).get();
  const completedEpisodes = (rowsFromSnaps(historySnap.docs) as VideoCompletion[]).map(
    (item) => item.episodeNumber ?? 0,
  );
  const todaySnap = await db
    .collection("videoCompletions")
    .where("userId", "==", userId)
    .where("completedDay", "==", completedDayValue)
    .get();
  return {
    currentEpisodeNumber: resolveCurrentEpisode(episodes, completedEpisodes),
    claimedAnyEpisodeToday: !todaySnap.empty,
  };
}

export async function getMemberRewardVideos(userId: number) {
  const db = requireDatabase(await getDb());
  const membership = await getActiveMembership(userId);
  if (!membership) return { membership: null, videos: [], sequence: null };
  const platformDay = await platformDayWindow();
  const settings = await getSettingMap();
  const videoSnap = await db
    .collection("rewardVideos")
    .where("packageId", "==", membership.package.id)
    .where("status", "==", "enabled")
    .get();
  const allVideos = rowsFromSnaps(videoSnap.docs) as RewardVideo[];
  // Episode sequence: only videos with episodeNumber >= 1 participate.
  const episodes = allVideos.filter((video) => (video.episodeNumber ?? 0) >= 1);
  // Progress is keyed by episode number (not record id) so it survives package changes.
  const historySnap = await db.collection("videoCompletions").where("userId", "==", userId).get();
  const history = rowsFromSnaps(historySnap.docs) as VideoCompletion[];
  const completedEpisodes = history.map((item) => item.episodeNumber ?? 0);
  const todaySnap = await db
    .collection("videoCompletions")
    .where("userId", "==", userId)
    .where("completedDay", "==", toStoredValue(platformDay.completedDay))
    .get();
  const todayCompletions = rowsFromSnaps(todaySnap.docs) as VideoCompletion[];
  const claimedAnyToday = todayCompletions.length > 0;
  const completionMap = new Map(todayCompletions.map((item) => [item.videoId, item]));
  const currentEpisode = resolveCurrentEpisode(
    episodes.map((video) => video.episodeNumber ?? 0),
    completedEpisodes,
  );
  const episodeSet = new Set(episodes.map((video) => video.episodeNumber ?? 0).filter((n) => n >= 1));
  const currentVideo =
    currentEpisode == null
      ? null
      : (episodes
          .filter((video) => (video.episodeNumber ?? 0) === currentEpisode)
          .sort((a, b) => {
            if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          })[0] ?? null);
  const locked = currentVideo != null && claimedAnyToday;
  const sessionSnap = await db.collection("videoWatchSessions").where("userId", "==", userId).get();
  const sessions = (rowsFromSnaps(sessionSnap.docs) as VideoWatchSession[]).sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  const sessionMap = new Map<number, VideoWatchSession>();
  for (const session of sessions) if (!sessionMap.has(session.videoId)) sessionMap.set(session.videoId, session);
  const toEntry = (video: RewardVideo) => ({
    video: {
      id: video.id,
      packageId: video.packageId,
      title: video.title,
      platform: video.platform,
      youtubeUrl: video.youtubeUrl,
      youtubeVideoId: video.youtubeVideoId,
      thumbnailUrl: video.thumbnailUrl,
      description: video.description,
      rewardPaisa: video.rewardPaisa,
      requiredDurationSeconds: video.requiredDurationSeconds,
      dailyRewardLimit: video.dailyRewardLimit,
      verificationConfigured: video.verificationCodeHash != null,
      sortOrder: video.sortOrder,
      episodeNumber: video.episodeNumber ?? 0,
      status: video.status,
    },
    completion: completionMap.get(video.id) ?? null,
    session: sessionMap.get(video.id) ?? null,
    locked,
  });
  return {
    membership,
    platformDay: platformDay.dayKey,
    platformTimeZone: settings.platform_timezone || "Asia/Karachi",
    sequence: {
      currentEpisodeNumber: currentEpisode,
      totalEpisodes: episodeSet.size,
      completedCount: new Set(completedEpisodes.filter((n) => n >= 1)).size,
      lockedUntilTomorrow: locked,
    },
    videos: currentVideo ? [toEntry(currentVideo)] : [],
  };
}

export async function getAdminRewardVideos() {
  const db = requireDatabase(await getDb());
  const snap = await db.collection("rewardVideos").get();
  const videos = rowsFromSnaps(snap.docs) as RewardVideo[];
  const pkgIds = Array.from(new Set(videos.map((video) => video.packageId)));
  const pkgSnaps = pkgIds.length ? await db.getAll(...pkgIds.map((id) => docRef(db, "packages", id))) : [];
  const pkgById = new Map<number, Package>();
  for (const pkgSnap of pkgSnaps) {
    const row = rowFromSnap(pkgSnap);
    if (row) pkgById.set(row.id, row as Package);
  }
  const rows = videos
    .map((video) => {
      const { verificationCodeHash, ...safeVideo } = video;
      return {
        video: { ...safeVideo, hasVerificationCode: Boolean(verificationCodeHash) },
        package: requiredRow(pkgById.get(video.packageId), "The related package was not found."),
      };
    })
    .sort((a, b) => {
      const priceA = a.package?.pricePaisa ?? 0;
      const priceB = b.package?.pricePaisa ?? 0;
      if (priceA !== priceB) return priceA - priceB;
      if (a.video.sortOrder !== b.video.sortOrder) return a.video.sortOrder - b.video.sortOrder;
      return new Date(b.video.createdAt).getTime() - new Date(a.video.createdAt).getTime();
    });
  return rows;
}

export function buildRewardVideoUpdateValues(
  input: {
    adminUserId: number;
    packageId: number;
    title: string;
    platform: "youtube" | "tiktok";
    youtubeUrl: string;
    youtubeVideoId: string;
    thumbnailUrl?: string;
    description?: string;
    rewardPaisa: number;
    requiredDurationSeconds?: number;
    dailyRewardLimit: number;
    verificationCode?: string;
    sortOrder: number;
    episodeNumber: number;
    status: "enabled" | "disabled";
  },
  existing: Pick<RewardVideo, "requiredDurationSeconds">,
) {
  const fallbackThumbnail =
    input.platform === "youtube" ? `https://i.ytimg.com/vi/${input.youtubeVideoId}/hqdefault.jpg` : null;
  return {
    packageId: input.packageId,
    title: input.title,
    platform: input.platform,
    youtubeUrl: input.youtubeUrl,
    youtubeVideoId: input.youtubeVideoId,
    thumbnailUrl: input.thumbnailUrl?.trim() || fallbackThumbnail,
    description: input.description?.trim() || null,
    rewardPaisa: input.rewardPaisa,
    requiredDurationSeconds: input.requiredDurationSeconds ?? existing.requiredDurationSeconds,
    dailyRewardLimit: input.dailyRewardLimit,
    ...(input.verificationCode
      ? {
          verificationCodeHash: hashVideoVerificationCode(input.verificationCode),
          verificationCodeUpdatedAt: new Date(),
        }
      : {}),
    sortOrder: input.sortOrder,
    episodeNumber: input.episodeNumber,
    status: input.status,
    updatedByUserId: input.adminUserId,
  };
}

export async function createRewardVideo(input: {
  adminUserId: number;
  packageId: number;
  title: string;
  platform: "youtube" | "tiktok";
  youtubeUrl: string;
  youtubeVideoId: string;
  thumbnailUrl?: string;
  description?: string;
  rewardPaisa: number;
  requiredDurationSeconds?: number;
  dailyRewardLimit?: number;
  verificationCode: string;
  sortOrder?: number;
  episodeNumber?: number;
}) {
  const db = requireDatabase(await getDb());
  const packageRow = await getDoc(db, "packages", input.packageId);
  if (!packageRow) throw new Error("The selected package does not exist.");
  const fallbackThumbnail =
    input.platform === "youtube" ? `https://i.ytimg.com/vi/${input.youtubeVideoId}/hqdefault.jpg` : null;
  const { verificationCode, ...videoInput } = input;
  const now = new Date();
  const videoId = await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const id = allocId(counters, "rewardVideos");
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.set(
      docRef(db, "rewardVideos", id),
      toStore({
        id,
        ...videoInput,
        adminUserId: undefined,
        requiredDurationSeconds: input.requiredDurationSeconds ?? DEFAULT_REWARD_VIDEO_DURATION_SECONDS,
        dailyRewardLimit: input.dailyRewardLimit ?? 1,
        verificationCodeHash: hashVideoVerificationCode(verificationCode),
        verificationCodeUpdatedAt: now,
        episodeNumber: input.episodeNumber ?? 0,
        thumbnailUrl: input.thumbnailUrl?.trim() || fallbackThumbnail,
        description: input.description?.trim() || null,
        sortOrder: input.sortOrder ?? 0,
        status: "enabled",
        createdByUserId: input.adminUserId,
        updatedByUserId: input.adminUserId,
        createdAt: now,
        updatedAt: now,
      }),
    );
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: "reward_video_created",
        entityType: "reward_video",
        entityId: id,
        oldValue: null,
        newValue: {
          packageId: input.packageId,
          title: input.title,
          youtubeVideoId: input.youtubeVideoId,
          rewardPaisa: input.rewardPaisa,
        },
        ipHash: null,
        createdAt: now,
      } satisfies AuditLog),
    );
    return id;
  });
  return { id: videoId };
}

export async function updateRewardVideo(input: {
  adminUserId: number;
  videoId: number;
  packageId: number;
  title: string;
  platform: "youtube" | "tiktok";
  youtubeUrl: string;
  youtubeVideoId: string;
  thumbnailUrl?: string;
  description?: string;
  rewardPaisa: number;
  requiredDurationSeconds?: number;
  dailyRewardLimit: number;
  verificationCode?: string;
  sortOrder: number;
  episodeNumber: number;
  status: "enabled" | "disabled";
}) {
  const db = requireDatabase(await getDb());
  const existing = (await getDoc(db, "rewardVideos", input.videoId)) as RewardVideo | null;
  if (!existing) throw new Error("The video record was not found.");
  const packageRow = await getDoc(db, "packages", input.packageId);
  if (!packageRow) throw new Error("The selected package does not exist.");
  await db.runTransaction(async (tx) => {
    // ---- read phase ----
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(docRef(db, "rewardVideos", input.videoId), toStore({
      ...buildRewardVideoUpdateValues(input, existing),
      updatedAt: new Date(),
    }));
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: "reward_video_updated",
        entityType: "reward_video",
        entityId: input.videoId,
        oldValue: {
          title: existing.title,
          status: existing.status,
          rewardPaisa: existing.rewardPaisa,
          sortOrder: existing.sortOrder,
        },
        newValue: { title: input.title, status: input.status, rewardPaisa: input.rewardPaisa, sortOrder: input.sortOrder },
        ipHash: null,
        createdAt: new Date(),
      } satisfies AuditLog),
    );
  });
  return { success: true };
}

export async function deleteRewardVideo(input: { adminUserId: number; videoId: number }) {
  const db = requireDatabase(await getDb());
  const existing = (await getDoc(db, "rewardVideos", input.videoId)) as RewardVideo | null;
  if (!existing) throw new Error("The video record was not found.");
  const completionSnap = await db.collection("videoCompletions").where("videoId", "==", input.videoId).limit(1).get();
  if (!completionSnap.empty)
    throw new Error("Videos with completed rewards cannot be deleted; disable them to preserve the audit trail.");
  await db.runTransaction(async (tx) => {
    // ---- read phase: every tx.get happens before any write ----
    const sessionSnap = await tx.get(db.collection("videoWatchSessions").where("videoId", "==", input.videoId));
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const auditId = allocId(counters, "auditLogs");
    // ---- write phase ----
    writeCounters(tx, counters);
    for (const doc of sessionSnap.docs) tx.delete(doc.ref);
    tx.delete(docRef(db, "rewardVideos", input.videoId));
    tx.set(
      docRef(db, "auditLogs", auditId),
      toStore({
        id: auditId,
        actorUserId: input.adminUserId,
        action: "reward_video_deleted",
        entityType: "reward_video",
        entityId: input.videoId,
        oldValue: { title: existing.title, packageId: existing.packageId },
        newValue: null,
        ipHash: null,
        createdAt: new Date(),
      } satisfies AuditLog),
    );
  });
  return { success: true };
}

export async function startVideoWatchSession(
  input: { userId: number; videoId: number; ipHash?: string; deviceHash?: string },
  testDependencies?: VideoStartWorkflowDependencies,
) {
  if (testDependencies) return startVideoWatchSessionWithDependencies(input, testDependencies);
  const db = requireDatabase(await getDb());

  const now = new Date();
  const user = await getUserById(input.userId);
  const membership = await getActiveMembership(input.userId);
  const video = (await getDoc(db, "rewardVideos", input.videoId)) as RewardVideo | null;
  assertVideoStartEligibility({
    accountStatus: user?.accountStatus ?? "review",
    hasActiveMembership: Boolean(membership),
    isVideoEnabled: video?.status === "enabled",
    isAssignedToMemberPackage: Boolean(video && membership && membership.package.id === video.packageId),
  });
  if (!membership || !video) throw new Error("This video is no longer available for your membership.");
  if (!video.verificationCodeHash) throw new Error("This video is awaiting administrator verification-code configuration and cannot be rewarded yet.");
  const settings = await getSettingMap();
  const platformDay = getPlatformDayWindow(now.getTime(), settings.platform_timezone || "Asia/Karachi");
  const completion = (
    await db
      .collection("videoCompletions")
      .where("userId", "==", input.userId)
      .where("videoId", "==", input.videoId)
      .where("completedDay", "==", toStoredValue(platformDay.completedDay))
      .limit(1)
      .get()
  ).docs[0] ?? null;
  if (completion) throw new Error("You have already claimed this video's reward today.");
  const episodeProgress = await getMemberEpisodeProgress(
    input.userId,
    video.packageId,
    toStoredValue(platformDay.completedDay),
  );
  assertEpisodeStartEligibility({
    videoEpisodeNumber: video.episodeNumber ?? 0,
    currentEpisodeNumber: episodeProgress.currentEpisodeNumber,
    claimedAnyEpisodeToday: episodeProgress.claimedAnyEpisodeToday,
  });
  const activeSnap = await db
    .collection("videoWatchSessions")
    .where("userId", "==", input.userId)
    .where("videoId", "==", input.videoId)
    .where("status", "in", ["started", "awaiting_return", "duration_verified", "code_verified"])
    .get();
  const activeRows = rowsFromSnaps(activeSnap.docs) as VideoWatchSession[];
  const active = activeRows.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null;
  if (active) {
    return {
      sessionToken: active.sessionToken,
      requiredDurationSeconds: active.requiredDurationSeconds,
      resumed: true,
      claimAvailable: active.status === "code_verified" && !completion,
      claimedToday: Boolean(completion),
      sessionStatus: active.status,
      externalUrl: video.youtubeUrl,
    };
  }
  const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
  // NOTE: single-field userId query + in-memory filter on purpose — the
  // (userId, videoId, startedAt) composite index does not exist in Firestore,
  // and a member's own session docs are few enough to filter locally.
  const userSessionSnap = await db.collection("videoWatchSessions").where("userId", "==", input.userId).get();
  const recentStarts = (rowsFromSnaps(userSessionSnap.docs) as VideoWatchSession[]).filter(
    (row) => row.videoId === input.videoId && new Date(row.startedAt).getTime() > fifteenMinutesAgo.getTime(),
  ).length;
  if (recentStarts >= 5) {
    await createSystemFraudFlag({
      userId: input.userId,
      severity: "medium",
      reason: "Rapid repeated external video session starts detected.",
      relatedEntityType: "video",
      relatedEntityId: video.id,
    });
    throw new Error("Too many recent starts for this video. Please wait before starting another session.");
  }
  const sessionToken = randomUUID();
  const sessionId = await db.runTransaction(async (tx) => {
    // ---- read phase: every tx.get happens before any write ----
    const tokenClaim = await peekUniqueClaim(tx, db, ukey("vwsession_token", sessionToken));
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    const id = allocId(counters, "videoWatchSessions");
    const nowTs = new Date();
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.set(
      docRef(db, "videoWatchSessions", id),
      toStore({
        id,
        sessionToken,
        userId: input.userId,
        videoId: video.id,
        membershipId: membership.membership.id,
        requiredDurationSeconds: video.requiredDurationSeconds,
        lastProgressSeconds: 0,
        maxProgressSeconds: 0,
        lastHeartbeatAt: null,
        startedAt: nowTs,
        externalOpenedAt: nowTs,
        returnedAt: null,
        completedAt: null,
        status: "awaiting_return",
        verificationStatus: "pending",
        rewardStatus: "pending",
        verificationAttempts: 0,
        lastVerificationAt: null,
        verificationLockedAt: null,
        suspiciousEventCount: 0,
        interruptionReason: null,
        ipHash: input.ipHash ?? null,
        deviceHash: input.deviceHash ?? null,
      } satisfies VideoWatchSession),
    );
    applyUniqueClaim(tx, tokenClaim, id, "Session token collision; please try again.");
    return id;
  });
  void sessionId;
  return {
    sessionToken,
    requiredDurationSeconds: video.requiredDurationSeconds,
    resumed: false,
    claimAvailable: false,
    claimedToday: false,
    sessionStatus: "awaiting_return" as const,
    externalUrl: video.youtubeUrl,
  };
}

export async function verifyExternalVideoReturn(input: { userId: number; sessionToken: string }) {
  const db = requireDatabase(await getDb());
  const sessionId = await uniqueOwner(db, ukey("vwsession_token", input.sessionToken));
  const session = (sessionId != null ? await getDoc(db, "videoWatchSessions", sessionId) : null) as VideoWatchSession | null;
  if (!session || session.userId !== input.userId) throw new Error("This video session does not belong to your account.");
  if (session.status === "verification_locked") throw new Error("This verification session is locked. Start a fresh session to try again.");
  if (session.status === "claimed") return { durationVerified: true, claimAvailable: false, message: "Reward already claimed today." };
  if (!["awaiting_return", "started", "duration_verified", "code_verified"].includes(session.status))
    throw new Error("This video session is no longer available.");
  const now = new Date();
  const result = evaluateExternalVideoReturn({
    startedAtMs: new Date(session.startedAt).getTime(),
    returnedAtMs: now.getTime(),
    requiredDurationSeconds: session.requiredDurationSeconds,
  });
  if (!result.eligible) {
    await db
      .collection("videoWatchSessions")
      .doc(String(session.id))
      .update({
        returnedAt: Timestamp.fromDate(now),
        status: "rejected",
        rewardStatus: "not_eligible",
        interruptionReason: result.reason,
        suspiciousEventCount: (session.suspiciousEventCount ?? 0) + 1,
      });
    return {
      durationVerified: false,
      claimAvailable: false,
      message: result.reason,
      elapsedSeconds: result.elapsedSeconds,
      requiredDurationSeconds: session.requiredDurationSeconds,
    };
  }
  if (session.status === "awaiting_return" || session.status === "started") {
    await db
      .collection("videoWatchSessions")
      .doc(String(session.id))
      .update({ returnedAt: Timestamp.fromDate(now), status: "duration_verified" });
  }
  return {
    durationVerified: true,
    claimAvailable: session.status === "code_verified",
    message: "Duration verified. Enter the six-digit code shown in the external video.",
    elapsedSeconds: result.elapsedSeconds,
    requiredDurationSeconds: session.requiredDurationSeconds,
  };
}

export async function verifyExternalVideoCode(input: { userId: number; sessionToken: string; code: string }) {
  const db = requireDatabase(await getDb());
  const submittedCode = validateVideoVerificationCode(input.code);
  const sessionId = await uniqueOwner(db, ukey("vwsession_token", input.sessionToken));
  const session = (sessionId != null ? await getDoc(db, "videoWatchSessions", sessionId) : null) as VideoWatchSession | null;
  if (!session || session.userId !== input.userId) throw new Error("This video session does not belong to your account.");
  if (session.status === "verification_locked" || session.verificationStatus === "locked")
    throw new Error("Too many incorrect verification attempts. Start a fresh session to try again.");
  if (!["duration_verified", "code_verified"].includes(session.status))
    throw new Error("Return after the required watch duration before entering the verification code.");
  const video = (await getDoc(db, "rewardVideos", session.videoId)) as RewardVideo | null;
  if (!video?.verificationCodeHash) throw new Error("This video does not have an active verification code. Please contact support.");
  const membership = await getActiveMembership(input.userId);
  if (!membership || membership.membership.id !== session.membershipId || membership.package.id !== video.packageId)
    throw new Error("Your membership is no longer eligible for this video.");
  const matched = matchesVideoVerificationCode(submittedCode, video.verificationCodeHash);
  const next = nextVerificationAttemptState(session.verificationAttempts, matched);
  const now = new Date();
  if (!matched) {
    await db
      .collection("videoWatchSessions")
      .doc(String(session.id))
      .update({
        verificationAttempts: next.attempts,
        verificationStatus: next.status,
        status: next.locked ? "verification_locked" : "duration_verified",
        verificationLockedAt: next.locked ? Timestamp.fromDate(now) : null,
        lastVerificationAt: Timestamp.fromDate(now),
        suspiciousEventCount: (session.suspiciousEventCount ?? 0) + 1,
      });
    if (next.locked) {
      await createSystemFraudFlag({
        userId: input.userId,
        severity: "medium",
        reason: "Video verification locked after repeated incorrect code attempts.",
        relatedEntityType: "video_session",
        relatedEntityId: session.id,
      });
    }
    return {
      codeVerified: false,
      locked: next.locked,
      attemptsRemaining: Math.max(0, 5 - next.attempts),
      message: next.locked
        ? "Too many incorrect verification attempts. Start a fresh session to try again."
        : `The verification code is incorrect. You have ${Math.max(0, 5 - next.attempts)} attempts remaining.`,
    };
  }
  await db
    .collection("videoWatchSessions")
    .doc(String(session.id))
    .update({ verificationStatus: "passed", status: "code_verified", lastVerificationAt: Timestamp.fromDate(now) });
  return {
    codeVerified: true,
    locked: false,
    attemptsRemaining: Math.max(0, 5 - session.verificationAttempts),
    message: "Code verified. You can now claim the reward.",
  };
}

export async function heartbeatVideoWatchSession(input: {
  userId: number;
  sessionToken: string;
  progressSeconds: number;
}) {
  const db = requireDatabase(await getDb());
  const sessionSnap = await db
    .collection("videoWatchSessions")
    .where("sessionToken", "==", input.sessionToken)
    .where("userId", "==", input.userId)
    .limit(1)
    .get();
  const firstDoc = sessionSnap.docs[0];
  const session = (firstDoc ? rowFromSnap(firstDoc) : null) as VideoWatchSession | null;
  if (!session || session.status !== "started") throw new Error("This video session is no longer active.");
  const progress = Math.max(0, Math.floor(input.progressSeconds));
  const now = new Date();
  const anchor = session.lastHeartbeatAt ?? session.startedAt;
  const elapsedSinceHeartbeat = Math.max(0, (now.getTime() - new Date(anchor).getTime()) / 1000);
  if (progress + 2 < session.maxProgressSeconds || progress > session.maxProgressSeconds + elapsedSinceHeartbeat + 5) {
    await db.collection("videoWatchSessions").doc(String(session.id)).update({
      status: "rejected",
      interruptionReason: "Playback progress could not be validated.",
    });
    throw new Error("Video session interrupted because playback progress could not be validated.");
  }
  const maxProgressSeconds = Math.max(session.maxProgressSeconds, progress);
  const membership = await getActiveMembership(input.userId);
  const settings = await getSettingMap();
  const platformDay = getPlatformDayWindow(now.getTime(), settings.platform_timezone || "Asia/Karachi");
  const dailyClaim = await countWhere(db, "videoCompletions", (col) =>
    col
      .where("userId", "==", input.userId)
      .where("videoId", "==", session.videoId)
      .where("completedDay", "==", toStoredValue(platformDay.completedDay)),
  );
  const video = (await getDoc(db, "rewardVideos", session.videoId)) as RewardVideo | null;
  const check = evaluateVideoCompletion({
    startedAtMs: new Date(session.startedAt).getTime(),
    nowMs: now.getTime(),
    requiredSeconds: session.requiredDurationSeconds,
    maxProgressSeconds,
    dailyClaims: Number(dailyClaim ?? 0),
    dailyRewardLimit: video?.dailyRewardLimit ?? 0,
    belongsToActivePackage: Boolean(
      video && membership && membership.membership.id === session.membershipId && membership.package.id === video.packageId,
    ),
  });
  const claimAvailable = check.eligible;
  await db
    .collection("videoWatchSessions")
    .doc(String(session.id))
    .update({
      lastProgressSeconds: progress,
      maxProgressSeconds,
      lastHeartbeatAt: Timestamp.fromDate(now),
      ...(claimAvailable ? { status: "eligible" as const } : {}),
    });
  return {
    maxProgressSeconds,
    requiredDurationSeconds: session.requiredDurationSeconds,
    claimAvailable,
    claimedToday: Number(dailyClaim ?? 0) >= (video?.dailyRewardLimit ?? 1),
  };
}

export async function interruptVideoWatchSession(input: { userId: number; sessionToken: string; reason: string }) {
  const db = requireDatabase(await getDb());
  const sessionSnap = await db
    .collection("videoWatchSessions")
    .where("sessionToken", "==", input.sessionToken)
    .where("userId", "==", input.userId)
    .where("status", "==", "started")
    .limit(1)
    .get();
  const doc = sessionSnap.docs[0];
  if (doc) {
    await db.collection("videoWatchSessions").doc(doc.id).update({
      status: "interrupted",
      interruptionReason: input.reason.slice(0, 255),
    });
  }
  return { success: true };
}

export async function claimVideoWatchSession(input: { userId: number; sessionToken: string }) {
  const db = requireDatabase(await getDb());
  const sessionId = await uniqueOwner(db, ukey("vwsession_token", input.sessionToken));
  const session = (sessionId != null ? await getDoc(db, "videoWatchSessions", sessionId) : null) as VideoWatchSession | null;
  if (!session) throw new Error("This video session is no longer available.");
  const video = (await getDoc(db, "rewardVideos", session.videoId)) as RewardVideo | null;
  if (!video || video.status !== "enabled") throw new Error("This video is no longer eligible for rewards.");
  const membership = await getActiveMembership(input.userId);
  if (!membership || membership.membership.id !== session.membershipId || membership.package.id !== video.packageId)
    throw new Error("Your membership is no longer eligible for this video.");
  const settings = await getSettingMap();
  const platformDay = getPlatformDayWindow(Date.now(), settings.platform_timezone || "Asia/Karachi");
  const dailyClaim = await countWhere(db, "videoCompletions", (col) =>
    col
      .where("userId", "==", input.userId)
      .where("videoId", "==", video.id)
      .where("completedDay", "==", toStoredValue(platformDay.completedDay)),
  );
  assertExternalVideoClaimEligibility({
    sessionUserId: session.userId,
    requesterUserId: input.userId,
    sessionStatus: session.status,
    verificationStatus: session.verificationStatus,
    rewardStatus: session.rewardStatus,
    dailyClaims: Number(dailyClaim ?? 0),
    dailyRewardLimit: video.dailyRewardLimit,
  });
  const durationCheck = evaluateExternalVideoReturn({
    startedAtMs: new Date(session.startedAt).getTime(),
    returnedAtMs: Date.now(),
    requiredDurationSeconds: session.requiredDurationSeconds,
  });
  if (!durationCheck.eligible) throw new Error(durationCheck.reason ?? "The required watch duration has not elapsed.");
  const wallet = await ensureWallet(input.userId);
  const now = new Date();
  await db.runTransaction(async (tx) => {
    // ---- read phase: every tx.get happens before any write ----
    const sessionRef = docRef(db, "videoWatchSessions", session.id);
    const sessionSnap = await tx.get(sessionRef);
    const dailyClaim = await peekUniqueClaim(
      tx,
      db,
      ukey("videocompletion", String(input.userId), String(video.id), platformDay.dayKey),
    );
    const sessionClaim = await peekUniqueClaim(tx, db, ukey("videocompletion_session", String(session.id)));
    const counters = await readCounters(tx, db);
    // ---- compute phase (pure) ----
    if (!sessionSnap.exists) throw new Error("This video session is no longer available.");
    const current = rowFromSnap(sessionSnap) as VideoWatchSession | null;
    if (!current) throw new Error("This video session is no longer available.");
    if (current.status !== "code_verified" || current.verificationStatus !== "passed")
      throw new Error("This video session has already been resolved.");
    const completionId = allocId(counters, "videoCompletions");
    const ledgerId = allocId(counters, "ledgerEntries");
    const notificationId = allocId(counters, "notifications");
    // ---- write phase ----
    writeCounters(tx, counters);
    tx.update(sessionRef, { status: "claimed", rewardStatus: "claimed", completedAt: Timestamp.fromDate(now) });
    applyUniqueClaim(tx, dailyClaim, completionId, "Reward already claimed for this video today.");
    applyUniqueClaim(tx, sessionClaim, completionId, "This video session has already been resolved.");
    tx.set(
      docRef(db, "videoCompletions", completionId),
      toStore({
        id: completionId,
        userId: input.userId,
        videoId: video.id,
        episodeNumber: video.episodeNumber ?? 0,
        watchSessionId: session.id,
        rewardPaisa: video.rewardPaisa,
        completedDay: platformDay.completedDay,
        completedAt: now,
      } satisfies VideoCompletion),
    );
    tx.update(docRef(db, "wallets", wallet.id), {
      availableBalancePaisa: wallet.availableBalancePaisa + video.rewardPaisa,
      lifetimeEarnedPaisa: wallet.lifetimeEarnedPaisa + video.rewardPaisa,
    });
    tx.set(
      docRef(db, "ledgerEntries", ledgerId),
      toStore({
        id: ledgerId,
        transactionGroupId: randomUUID(),
        userId: input.userId,
        transactionType: "video_reward",
        direction: "credit",
        amountPaisa: video.rewardPaisa,
        previousAvailableBalancePaisa: wallet.availableBalancePaisa,
        newAvailableBalancePaisa: wallet.availableBalancePaisa + video.rewardPaisa,
        previousHeldBalancePaisa: wallet.heldBalancePaisa,
        newHeldBalancePaisa: wallet.heldBalancePaisa,
        relatedEntityType: "video_completion",
        relatedEntityId: completionId,
        description: `Validated video reward for ${video.title}`,
        createdByUserId: null,
        createdAt: now,
      } satisfies LedgerEntry),
    );
    tx.set(
      docRef(db, "notifications", notificationId),
      toStore({
        id: notificationId,
        userId: input.userId,
        title: "Video reward credited",
        message: "Your video completion was validated and the reward was added to your balance.",
        type: "success",
        readAt: null,
        createdAt: now,
      } satisfies Notification),
    );
  });
  return { rewardPaisa: video.rewardPaisa };
}

export const completeVideoWatchSession = claimVideoWatchSession;
