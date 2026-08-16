import { and, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { randomUUID } from "node:crypto";
import {
  adCampaigns,
  adViews,
  auditLogs,
  fraudFlags,
  ledgerEntries,
  notifications,
  packages,
  paymentProofs,
  platformSettings,
  rewardVideos,
  type InsertUser,
  type User,
  userPackages,
  users,
  videoCompletions,
  videoWatchSessions,
  wallets,
  withdrawals,
} from "../drizzle/schema";
import { INITIAL_PACKAGES, INITIAL_PLATFORM_SETTINGS } from "../shared/platform";
import { calculateWithdrawalQuote, evaluateAdCompletion, evaluateVideoCompletion, getPlatformDayWindow, isValidPakistanMobile } from "./platformRules";
import { ENV } from "./_core/env";
import { storageGetSignedUrl } from "./storage";
import { assertPendingPaymentDecision, assertVideoRewardNotClaimed, assertVideoSessionAuthorization } from "./workflowGuards";
import { evaluateExternalVideoReturn, hashVideoVerificationCode, matchesVideoVerificationCode, nextVerificationAttemptState, validateVideoVerificationCode } from "./externalVideoRules";

export const DEFAULT_REWARD_VIDEO_DURATION_SECONDS = 10;

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

function requireDatabase<T>(db: T | null): T {
  if (!db) throw new Error("The database is currently unavailable. Please try again shortly.");
  return db;
}

export function normalizePersistentSettingValue(value: string) {
  return value.trim();
}

export function buildPackageRulesUpdateValues(input: { pricePaisa: number; rewardPerEligibleAdPaisa: number; dailyAdLimit: number; durationDays: number; status: "active" | "inactive" }) {
  return { pricePaisa: input.pricePaisa, rewardPerEligibleAdPaisa: input.rewardPerEligibleAdPaisa, dailyAdLimit: input.dailyAdLimit, durationDays: input.durationDays, status: input.status };
}

export function isCampaignEligibleForPackage(campaignPackageId: number | null, memberPackageId: number) {
  return campaignPackageId === null || campaignPackageId === memberPackageId;
}

export function canBeginAssignedVideo(accountStatus: "active" | "suspended" | "review") {
  return accountStatus === "active";
}

export function assertVideoStartEligibility(input: { accountStatus: "active" | "suspended" | "review"; hasActiveMembership: boolean; isVideoEnabled: boolean; isAssignedToMemberPackage: boolean }) {
  if (input.accountStatus === "review") throw new Error("Your account is currently under review. Please contact support before starting reward videos.");
  if (input.accountStatus === "suspended") throw new Error("Your account is suspended and cannot start reward videos.");
  if (!canBeginAssignedVideo(input.accountStatus)) throw new Error("Your account cannot start reward videos.");
  if (!input.hasActiveMembership) throw new Error("An active membership is required to access package videos.");
  if (!input.isVideoEnabled || !input.isAssignedToMemberPackage) throw new Error("This video is not available for your membership.");
}

export function assertExternalVideoClaimEligibility(input: { sessionUserId: number; requesterUserId: number; sessionStatus: string; verificationStatus: string; rewardStatus: string; dailyClaims: number; dailyRewardLimit: number }) {
  if (input.sessionUserId !== input.requesterUserId) throw new Error("This video session does not belong to your account.");
  if (input.rewardStatus === "claimed" || input.sessionStatus === "claimed") throw new Error("This video session has already been rewarded.");
  if (input.sessionStatus !== "code_verified" || input.verificationStatus !== "passed") throw new Error("Verify the six-digit code after returning from the external video before claiming a reward.");
  if (input.dailyClaims >= input.dailyRewardLimit) throw new Error("Reward already claimed for this video today.");
}

export type VideoStartWorkflowDependencies = {
  user: { accountStatus: "active" | "suspended" | "review" };
  membership: { membership: { id: number }; package: { id: number } } | null;
  video: { id: number; packageId: number; status: "enabled" | "disabled"; requiredDurationSeconds: number } | null;
  claimedToday?: boolean;
  externalUrl?: string;
  activeSession?: { sessionToken: string; requiredDurationSeconds: number; status: "started" | "eligible" } | null;
  sessionToken?: string;
  createSession?: (input: { sessionToken: string; userId: number; videoId: number; membershipId: number; requiredDurationSeconds: number }) => Promise<void> | void;
};

async function startVideoWatchSessionWithDependencies(input: { userId: number; videoId: number }, deps: VideoStartWorkflowDependencies) {
  assertVideoStartEligibility({ accountStatus: deps.user.accountStatus, hasActiveMembership: Boolean(deps.membership), isVideoEnabled: deps.video?.status === "enabled", isAssignedToMemberPackage: Boolean(deps.video && deps.membership && deps.video.packageId === deps.membership.package.id) });
  if (!deps.membership || !deps.video) throw new Error("This video is not available for your membership.");
  if (deps.activeSession) return { sessionToken: deps.activeSession.sessionToken, requiredDurationSeconds: deps.activeSession.requiredDurationSeconds, resumed: true, claimAvailable: deps.activeSession.status === "eligible" && !deps.claimedToday, claimedToday: Boolean(deps.claimedToday), sessionStatus: deps.activeSession.status, externalUrl: deps.externalUrl ?? "" };
  const sessionToken = deps.sessionToken ?? randomUUID();
  await deps.createSession?.({ sessionToken, userId: input.userId, videoId: input.videoId, membershipId: deps.membership.membership.id, requiredDurationSeconds: deps.video.requiredDurationSeconds });
  return { sessionToken, requiredDurationSeconds: deps.video.requiredDurationSeconds, resumed: false, claimAvailable: false, claimedToday: Boolean(deps.claimedToday), sessionStatus: "started" as const, externalUrl: deps.externalUrl ?? "" };
}

export function isDesignatedAdminEmail(email?: string | null) {
  return Boolean(email?.trim() && process.env.ADMIN_EMAIL?.trim() && email.trim().toLowerCase() === process.env.ADMIN_EMAIL.trim().toLowerCase());
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  (['name', 'email', 'loginMethod'] as const).forEach(field => {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
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

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  return result[0];
}

export async function ensureInitialPlatformData() {
  const db = await getDb();
  if (!db) return;

  for (const item of INITIAL_PACKAGES) {
    await db.insert(packages).values({ ...item, features: [...item.features], status: "active" }).onDuplicateKeyUpdate({
      set: { name: sql`name` },
    });
  }

  for (const [settingKey, settingValue] of Object.entries(INITIAL_PLATFORM_SETTINGS)) {
    await db.insert(platformSettings).values({ settingKey, settingValue }).onDuplicateKeyUpdate({
      set: { settingValue: sql`settingValue` },
    });
  }
}

export async function getPublicPackages() {
  await ensureInitialPlatformData();
  const db = await getDb();
  if (!db) return [];
  return db.select().from(packages).where(eq(packages.status, "active")).orderBy(packages.pricePaisa);
}

export async function getSettingMap() {
  await ensureInitialPlatformData();
  const db = await getDb();
  if (!db) return { ...INITIAL_PLATFORM_SETTINGS };
  const rows = await db.select().from(platformSettings);
  return rows.reduce<Record<string, string>>((acc, row) => {
    acc[row.settingKey] = row.settingValue;
    return acc;
  }, {});
}

export async function getUserById(userId: number) {
  const db = requireDatabase(await getDb());
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new Error("Account record not found.");
  return user;
}

export async function ensureWallet(userId: number) {
  const db = requireDatabase(await getDb());
  await db.insert(wallets).values({ userId }).onDuplicateKeyUpdate({ set: { userId } });
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  if (!wallet) throw new Error("Wallet could not be initialized.");
  return wallet;
}

export async function getActiveMembership(userId: number) {
  const db = requireDatabase(await getDb());
  const rows = await db
    .select({ membership: userPackages, package: packages })
    .from(userPackages)
    .innerJoin(packages, eq(userPackages.packageId, packages.id))
    .where(eq(userPackages.userId, userId))
    .orderBy(desc(userPackages.createdAt));
  const current = rows.find(row => row.membership.status === "active" && (!row.membership.expiresAt || row.membership.expiresAt > new Date()));
  return current ?? null;
}

export async function getDashboardOverview(userId: number) {
  const db = requireDatabase(await getDb());
  const wallet = await ensureWallet(userId);
  const membership = await getActiveMembership(userId);
  const settings = await getSettingMap();
  const platformDay = getPlatformDayWindow(Date.now(), settings.platform_timezone || "Asia/Karachi");
  const [todayRewards] = await db
    .select({ amount: sql<number>`coalesce(sum(${ledgerEntries.amountPaisa}), 0)` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.userId, userId), inArray(ledgerEntries.transactionType, ["advertisement_reward", "video_reward"]), gte(ledgerEntries.createdAt, platformDay.start)));
  const [todayViews] = await db
    .select({ count: sql<number>`count(*)` })
    .from(adViews)
    .where(and(eq(adViews.userId, userId), eq(adViews.status, "completed"), gte(adViews.completedAt, platformDay.start)));
  const [todayVideoRewards] = await db.select({ count: sql<number>`count(*)` }).from(videoCompletions).where(and(eq(videoCompletions.userId, userId), eq(videoCompletions.completedDay, platformDay.completedDay)));
  const [pendingWithdrawals] = await db
    .select({ amount: sql<number>`coalesce(sum(${withdrawals.amountPaisa}), 0)` })
    .from(withdrawals)
    .where(and(eq(withdrawals.userId, userId), inArray(withdrawals.status, ["pending", "processing"])));
  const recentLedger = await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, userId)).orderBy(desc(ledgerEntries.createdAt)).limit(8);
  const recentNotifications = await db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(5);
  return {
    wallet,
    membership,
    todayEarningsPaisa: Number(todayRewards?.amount ?? 0),
    todayViews: Number(todayViews?.count ?? 0),
    todayVideoRewards: Number(todayVideoRewards?.count ?? 0),
    platformTimeZone: settings.platform_timezone || "Asia/Karachi",
    pendingWithdrawalsPaisa: Number(pendingWithdrawals?.amount ?? 0),
    recentLedger,
    recentNotifications,
  };
}

export async function getEligibleCampaigns(userId: number) {
  const db = requireDatabase(await getDb());
  const membership = await getActiveMembership(userId);
  if (!membership) return { membership: null, campaigns: [], completedToday: 0 };
  const now = new Date();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const completed = await db
    .select({ campaignId: adViews.campaignId })
    .from(adViews)
    .where(and(eq(adViews.userId, userId), eq(adViews.status, "completed"), gte(adViews.completedAt, today)));
  const [count] = await db.select({ total: sql<number>`count(*)` }).from(adViews).where(and(eq(adViews.userId, userId), eq(adViews.status, "completed"), gte(adViews.completedAt, today)));
  const campaigns = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.status, "active"), lte(adCampaigns.startAt, now), gte(adCampaigns.endAt, now), or(isNull(adCampaigns.eligiblePackageId), eq(adCampaigns.eligiblePackageId, membership.package.id))))
    .orderBy(desc(adCampaigns.createdAt));
  const completedIds = new Set(completed.map(row => row.campaignId));
  return {
    membership,
    completedToday: Number(count?.total ?? 0),
    campaigns: campaigns.filter(campaign => isCampaignEligibleForPackage(campaign.eligiblePackageId, membership.package.id) && !completedIds.has(campaign.id) && campaign.rewardsDistributedPaisa + campaign.rewardPaisa <= campaign.budgetPaisa && campaign.completedViewsCount < campaign.maxImpressions),
  };
}

export async function startAdSession(userId: number, campaignId: number, security: { ipHash?: string; deviceHash?: string }) {
  const db = requireDatabase(await getDb());
  const user = await getUserById(userId);
  if (user.accountStatus !== "active") throw new Error("Your account is not eligible to begin advertisements.");
  const eligible = await getEligibleCampaigns(userId);
  if (!eligible.membership) throw new Error("An active membership is required to access eligible advertisements.");
  if (eligible.completedToday >= eligible.membership.package.dailyAdLimit) throw new Error("Your daily advertisement limit has been reached.");
  const campaign = eligible.campaigns.find(item => item.id === campaignId);
  if (!campaign) throw new Error("This campaign is no longer available.");
  const [priorView] = await db.select({ id: adViews.id }).from(adViews).where(and(eq(adViews.userId, userId), eq(adViews.campaignId, campaignId))).limit(1);
  if (priorView) throw new Error("You have already started or completed this campaign.");
  const sessionToken = randomUUID();
  const [view] = await db.insert(adViews).values({
    sessionToken,
    userId,
    campaignId,
    requiredSeconds: campaign.durationSeconds,
    ipHash: security.ipHash,
    deviceHash: security.deviceHash,
  }).$returningId();
  return { sessionToken, viewId: view?.id, requiredSeconds: campaign.durationSeconds };
}

export async function completeAdSession(userId: number, sessionToken: string) {
  const db = requireDatabase(await getDb());
  const [view] = await db.select().from(adViews).where(and(eq(adViews.sessionToken, sessionToken), eq(adViews.userId, userId))).limit(1);
  if (!view) throw new Error("The advertisement session was not found.");
  if (view.status !== "started") throw new Error("This advertisement session has already been resolved.");
  const [campaign] = await db.select().from(adCampaigns).where(eq(adCampaigns.id, view.campaignId)).limit(1);
  if (!campaign || campaign.status !== "active") throw new Error("This campaign is no longer eligible for reward.");
  const active = await getActiveMembership(userId);
  if (!active) throw new Error("An active membership is required to receive this reward.");
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const [count] = await db.select({ total: sql<number>`count(*)` }).from(adViews).where(and(eq(adViews.userId, userId), eq(adViews.status, "completed"), gte(adViews.completedAt, today)));
  const check = evaluateAdCompletion({
    startedAtMs: view.startedAt.getTime(),
    nowMs: Date.now(),
    requiredSeconds: view.requiredSeconds,
    dailyCompletedViews: Number(count?.total ?? 0),
    dailyAdLimit: active.package.dailyAdLimit,
    campaignCompletedViews: campaign.completedViewsCount,
    campaignMaxImpressions: campaign.maxImpressions,
    campaignRewardPaisa: campaign.rewardPaisa,
    campaignRemainingBudgetPaisa: campaign.budgetPaisa - campaign.rewardsDistributedPaisa,
  });
  if (!check.eligible) {
    await db.update(adViews).set({ status: "rejected", rejectionReason: check.reason }).where(eq(adViews.id, view.id));
    throw new Error(check.reason ?? "This advertisement is not eligible for a reward.");
  }

  const wallet = await ensureWallet(userId);
  const now = new Date();
  await db.transaction(async tx => {
    const updateResult = await tx.update(adViews).set({ status: "completed", completedAt: now, rewardPaisa: campaign.rewardPaisa }).where(and(eq(adViews.id, view.id), eq(adViews.status, "started")));
    const affectedRows = (updateResult as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
    if (affectedRows !== 1) throw new Error("This advertisement session has already been resolved.");
    await tx.update(adCampaigns).set({
      completedViewsCount: campaign.completedViewsCount + 1,
      rewardsDistributedPaisa: campaign.rewardsDistributedPaisa + campaign.rewardPaisa,
      status: campaign.completedViewsCount + 1 >= campaign.maxImpressions || campaign.rewardsDistributedPaisa + campaign.rewardPaisa >= campaign.budgetPaisa ? "complete" : "active",
    }).where(eq(adCampaigns.id, campaign.id));
    await tx.update(wallets).set({
      availableBalancePaisa: wallet.availableBalancePaisa + campaign.rewardPaisa,
      lifetimeEarnedPaisa: wallet.lifetimeEarnedPaisa + campaign.rewardPaisa,
    }).where(eq(wallets.id, wallet.id));
    await tx.insert(ledgerEntries).values({
      transactionGroupId: randomUUID(), userId, transactionType: "advertisement_reward", direction: "credit", amountPaisa: campaign.rewardPaisa,
      previousAvailableBalancePaisa: wallet.availableBalancePaisa, newAvailableBalancePaisa: wallet.availableBalancePaisa + campaign.rewardPaisa,
      previousHeldBalancePaisa: wallet.heldBalancePaisa, newHeldBalancePaisa: wallet.heldBalancePaisa,
      relatedEntityType: "ad_view", relatedEntityId: view.id, description: `Validated reward for ${campaign.title}`,
    });
    await tx.insert(notifications).values({ userId, title: "Advertising reward credited", message: "A completed advertisement has been validated and recorded in your balance.", type: "success" });
  });
  return { rewardPaisa: campaign.rewardPaisa };
}

export async function submitPaymentProof(input: {
  userId: number; packageId: number; paymentMethod: "jazzcash" | "easypaisa" | "bank_transfer"; amountPaisa: number; senderAccount: string; transactionId: string; screenshotKey?: string; screenshotUrl?: string; screenshotFileName?: string; screenshotMimeType?: string; screenshotBytes?: number; additionalNote?: string;
}) {
  const db = requireDatabase(await getDb());
  const [packageRow] = await db.select().from(packages).where(and(eq(packages.id, input.packageId), eq(packages.status, "active"))).limit(1);
  if (!packageRow) throw new Error("This membership is not currently available.");
  if (input.amountPaisa !== packageRow.pricePaisa) throw new Error("The submitted amount must match the selected membership price.");
  const [latest] = await db.select({ attemptNumber: paymentProofs.attemptNumber }).from(paymentProofs).where(eq(paymentProofs.userId, input.userId)).orderBy(desc(paymentProofs.attemptNumber)).limit(1);
  const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
  const [record] = await db.insert(paymentProofs).values({ ...input, attemptNumber }).$returningId();
  await db.insert(userPackages).values({ userId: input.userId, packageId: input.packageId, paymentProofId: record?.id, status: "pending" });
  await db.insert(notifications).values({ userId: input.userId, title: "Payment verification submitted", message: "Your membership payment proof is pending administrative review.", type: "info" });
  return record;
}

export async function getUserPaymentProofs(userId: number) {
  const db = requireDatabase(await getDb());
  return db.select({ payment: paymentProofs, package: packages }).from(paymentProofs).innerJoin(packages, eq(paymentProofs.packageId, packages.id)).where(eq(paymentProofs.userId, userId)).orderBy(desc(paymentProofs.createdAt));
}

export async function getAuthorizedPaymentProofUrl(input: { requester: Pick<User, "id" | "role">; paymentProofId: number }) {
  const db = requireDatabase(await getDb());
  const [payment] = await db.select().from(paymentProofs).where(eq(paymentProofs.id, input.paymentProofId)).limit(1);
  if (!payment?.screenshotKey) throw new Error("No payment screenshot is stored for this record.");
  if (input.requester.role !== "admin" && input.requester.id !== payment.userId) throw new Error("You are not allowed to view this payment screenshot.");
  return { url: await storageGetSignedUrl(payment.screenshotKey) };
}

export async function getLedgerHistory(userId: number, period: "today" | "week" | "month" | "all") {
  const db = requireDatabase(await getDb());
  const now = new Date();
  const since = new Date(now);
  if (period === "today") since.setUTCHours(0, 0, 0, 0);
  if (period === "week") since.setUTCDate(since.getUTCDate() - 7);
  if (period === "month") since.setUTCMonth(since.getUTCMonth() - 1);
  return db.select().from(ledgerEntries).where(period === "all" ? eq(ledgerEntries.userId, userId) : and(eq(ledgerEntries.userId, userId), gte(ledgerEntries.createdAt, since))).orderBy(desc(ledgerEntries.createdAt)).limit(200);
}

export async function getUserNotifications(userId: number) {
  const db = requireDatabase(await getDb());
  return db.select().from(notifications).where(eq(notifications.userId, userId)).orderBy(desc(notifications.createdAt)).limit(100);
}

export async function markNotificationsRead(userId: number, notificationIds?: number[]) {
  const db = requireDatabase(await getDb());
  const now = new Date();
  const target = notificationIds?.length ? and(eq(notifications.userId, userId), inArray(notifications.id, notificationIds)) : eq(notifications.userId, userId);
  await db.update(notifications).set({ readAt: now }).where(target);
  return { success: true };
}

export async function createWithdrawal(input: { userId: number; amountPaisa: number; paymentMethod: "jazzcash" | "easypaisa"; accountHolderName: string; accountNumber: string; }) {
  const db = requireDatabase(await getDb());
  const settings = await getSettingMap();
  const quote = calculateWithdrawalQuote(input.amountPaisa, Number(settings.minimum_withdrawal_paisa ?? 200_000), Number(settings.withdrawal_fee_paisa ?? 15_000));
  const wallet = await ensureWallet(input.userId);
  if (wallet.availableBalancePaisa < quote.amountPaisa) throw new Error("Your available balance is insufficient for this withdrawal.");
  const [record] = await db.insert(withdrawals).values({ ...input, ...quote }).$returningId();
  await db.transaction(async tx => {
    await tx.update(wallets).set({ availableBalancePaisa: wallet.availableBalancePaisa - quote.amountPaisa, heldBalancePaisa: wallet.heldBalancePaisa + quote.amountPaisa }).where(eq(wallets.id, wallet.id));
    await tx.insert(ledgerEntries).values({
      transactionGroupId: randomUUID(), userId: input.userId, transactionType: "withdrawal_hold", direction: "hold", amountPaisa: quote.amountPaisa,
      previousAvailableBalancePaisa: wallet.availableBalancePaisa, newAvailableBalancePaisa: wallet.availableBalancePaisa - quote.amountPaisa,
      previousHeldBalancePaisa: wallet.heldBalancePaisa, newHeldBalancePaisa: wallet.heldBalancePaisa + quote.amountPaisa,
      relatedEntityType: "withdrawal", relatedEntityId: record?.id, description: "Withdrawal request balance hold",
    });
    await tx.insert(notifications).values({ userId: input.userId, title: "Withdrawal submitted", message: "Your withdrawal request is pending administrative review.", type: "info" });
  });
  return { withdrawalId: record?.id, ...quote };
}

export async function getUserWithdrawals(userId: number) {
  const db = requireDatabase(await getDb());
  return db.select().from(withdrawals).where(eq(withdrawals.userId, userId)).orderBy(desc(withdrawals.createdAt));
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
  await db.transaction(async tx => {
    await tx.update(users).set({ name, phone }).where(eq(users.id, input.userId));
    await tx.insert(auditLogs).values({ actorUserId: input.userId, action: "profile_updated", entityType: "user", entityId: input.userId, oldValue: { name: user.name, phone: user.phone ? "[masked]" : null }, newValue: { name, phone: phone ? "[masked]" : null } });
  });
  return { name, phone };
}

export async function getAdminSummary() {
  const db = requireDatabase(await getDb());
  const [userCount] = await db.select({ count: sql<number>`count(*)` }).from(users);
  const [pendingProofCount] = await db.select({ count: sql<number>`count(*)` }).from(paymentProofs).where(eq(paymentProofs.status, "pending"));
  const [approvedProofCount] = await db.select({ count: sql<number>`count(*)` }).from(paymentProofs).where(eq(paymentProofs.status, "approved"));
  const [rejectedProofCount] = await db.select({ count: sql<number>`count(*)` }).from(paymentProofs).where(eq(paymentProofs.status, "rejected"));
  const [paymentCount] = await db.select({ count: sql<number>`count(*)` }).from(paymentProofs);
  const [pendingWithdrawalCount] = await db.select({ count: sql<number>`count(*)` }).from(withdrawals).where(inArray(withdrawals.status, ["pending", "processing"]));
  const [activeCampaignCount] = await db.select({ count: sql<number>`count(*)` }).from(adCampaigns).where(eq(adCampaigns.status, "active"));
  const [videoCount] = await db.select({ count: sql<number>`count(*)` }).from(rewardVideos);
  const [videoCompletionCount] = await db.select({ count: sql<number>`count(*)` }).from(videoCompletions);
  const [pendingVideoSessionCount] = await db.select({ count: sql<number>`count(*)` }).from(videoWatchSessions).where(eq(videoWatchSessions.status, "started"));
  const [externalVideoSessionCount] = await db.select({ count: sql<number>`count(*)` }).from(videoWatchSessions);
  const [externalActiveSessionCount] = await db.select({ count: sql<number>`count(*)` }).from(videoWatchSessions).where(inArray(videoWatchSessions.status, ["awaiting_return", "duration_verified", "code_verified"]));
  const [externalVerifiedCount] = await db.select({ count: sql<number>`count(*)` }).from(videoWatchSessions).where(eq(videoWatchSessions.verificationStatus, "passed"));
  const [externalClaimedCount] = await db.select({ count: sql<number>`count(*)` }).from(videoWatchSessions).where(eq(videoWatchSessions.rewardStatus, "claimed"));
  const [externalFailedAttempts] = await db.select({ count: sql<number>`coalesce(sum(${videoWatchSessions.verificationAttempts}), 0)` }).from(videoWatchSessions);
  const [suspiciousSessionCount] = await db.select({ count: sql<number>`count(*)` }).from(videoWatchSessions).where(sql`${videoWatchSessions.suspiciousEventCount} > 0`);
  const [fraudAlertCount] = await db.select({ count: sql<number>`count(*)` }).from(fraudFlags).where(eq(fraudFlags.status, "open"));
  const [rewards] = await db.select({ amount: sql<number>`coalesce(sum(${ledgerEntries.amountPaisa}), 0)` }).from(ledgerEntries).where(inArray(ledgerEntries.transactionType, ["advertisement_reward", "video_reward"]));
  const membershipCounts = await db.select({ packageName: packages.name, count: sql<number>`count(distinct ${userPackages.userId})` }).from(userPackages).innerJoin(packages, eq(userPackages.packageId, packages.id)).where(eq(userPackages.status, "active")).groupBy(packages.name);
  const packageMembers = Object.fromEntries(membershipCounts.map(row => [row.packageName.toLowerCase(), Number(row.count)]));
  return {
    totalUsers: Number(userCount?.count ?? 0), pendingProofs: Number(pendingProofCount?.count ?? 0), pendingWithdrawals: Number(pendingWithdrawalCount?.count ?? 0),
    approvedPayments: Number(approvedProofCount?.count ?? 0), rejectedPayments: Number(rejectedProofCount?.count ?? 0), totalPaymentSubmissions: Number(paymentCount?.count ?? 0),
    platinumUsers: packageMembers.platinum ?? 0, goldUsers: packageMembers.gold ?? 0, diamondUsers: packageMembers.diamond ?? 0,
    totalVideos: Number(videoCount?.count ?? 0), totalVideoCompletions: Number(videoCompletionCount?.count ?? 0), pendingVideoSessions: Number(pendingVideoSessionCount?.count ?? 0), totalExternalVideoSessions: Number(externalVideoSessionCount?.count ?? 0), activeExternalVideoSessions: Number(externalActiveSessionCount?.count ?? 0), successfulVideoCodeVerifications: Number(externalVerifiedCount?.count ?? 0), claimedVideoRewards: Number(externalClaimedCount?.count ?? 0), failedVideoVerificationAttempts: Number(externalFailedAttempts?.count ?? 0), suspiciousVideoSessions: Number(suspiciousSessionCount?.count ?? 0),
    activeCampaigns: Number(activeCampaignCount?.count ?? 0), fraudAlerts: Number(fraudAlertCount?.count ?? 0), rewardsDistributedPaisa: Number(rewards?.amount ?? 0),
  };
}

export async function getAdminExternalVideoAnalytics() {
  const db = requireDatabase(await getDb());
  const settings = await getSettingMap();
  const platformDay = getPlatformDayWindow(Date.now(), settings.platform_timezone || "Asia/Karachi");
  const dailyByVideo = await db.select({ videoId: rewardVideos.id, title: rewardVideos.title, packageName: packages.name, rewardsClaimed: sql<number>`count(${videoCompletions.id})`, rewardsPaisa: sql<number>`coalesce(sum(${videoCompletions.rewardPaisa}), 0)` }).from(videoCompletions).innerJoin(rewardVideos, eq(videoCompletions.videoId, rewardVideos.id)).innerJoin(packages, eq(rewardVideos.packageId, packages.id)).where(eq(videoCompletions.completedDay, platformDay.completedDay)).groupBy(rewardVideos.id, rewardVideos.title, packages.name).orderBy(desc(sql`count(${videoCompletions.id})`));
  const repeatedVerificationUsers = await db.select({ userId: videoWatchSessions.userId, failedAttempts: sql<number>`coalesce(sum(${videoWatchSessions.verificationAttempts}), 0)`, suspiciousSessions: sql<number>`sum(case when ${videoWatchSessions.suspiciousEventCount} > 0 then 1 else 0 end)` }).from(videoWatchSessions).where(sql`${videoWatchSessions.verificationAttempts} > 0 or ${videoWatchSessions.suspiciousEventCount} > 0`).groupBy(videoWatchSessions.userId).orderBy(desc(sql`coalesce(sum(${videoWatchSessions.verificationAttempts}), 0)`)).limit(20);
  return { platformDay: platformDay.dayKey, dailyByVideo: dailyByVideo.map(row => ({ ...row, rewardsClaimed: Number(row.rewardsClaimed), rewardsPaisa: Number(row.rewardsPaisa) })), repeatedVerificationUsers: repeatedVerificationUsers.map(row => ({ ...row, failedAttempts: Number(row.failedAttempts), suspiciousSessions: Number(row.suspiciousSessions) })) };
}

export async function getAdminPaymentProofs() {
  const db = requireDatabase(await getDb());
  return db.select({ payment: paymentProofs, package: packages, user: users }).from(paymentProofs).innerJoin(packages, eq(paymentProofs.packageId, packages.id)).innerJoin(users, eq(paymentProofs.userId, users.id)).orderBy(desc(paymentProofs.createdAt));
}

export async function reviewPaymentProof(input: { adminUserId: number; paymentProofId: number; action: "approve" | "reject"; rejectionReason?: string; }) {
  const db = requireDatabase(await getDb());
  const [payment] = await db.select().from(paymentProofs).where(eq(paymentProofs.id, input.paymentProofId)).limit(1);
  if (!payment) throw new Error("This payment proof is no longer pending.");
  assertPendingPaymentDecision(payment.status);
  const [packageRow] = await db.select().from(packages).where(eq(packages.id, payment.packageId)).limit(1);
  if (!packageRow) throw new Error("The related package was not found.");
  const now = new Date();
  if (input.action === "reject") {
    const rejectionReason = input.rejectionReason?.trim();
    if (!rejectionReason) throw new Error("A rejection reason is required.");
    await db.transaction(async tx => {
      await tx.update(paymentProofs).set({ status: "rejected", rejectionReason, reviewedByUserId: input.adminUserId, reviewedAt: now }).where(eq(paymentProofs.id, payment.id));
      await tx.update(userPackages).set({ status: "cancelled" }).where(eq(userPackages.paymentProofId, payment.id));
      await tx.insert(notifications).values({ userId: payment.userId, title: "Payment verification rejected", message: rejectionReason, type: "warning" });
      await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "payment_rejected", entityType: "payment_proof", entityId: payment.id, newValue: { reason: rejectionReason } });
    });
    return { status: "rejected" as const };
  }
  const expiry = new Date(now.getTime() + packageRow.durationDays * 24 * 60 * 60 * 1000);
  await db.transaction(async tx => {
    await tx.update(paymentProofs).set({ status: "approved", reviewedByUserId: input.adminUserId, reviewedAt: now }).where(eq(paymentProofs.id, payment.id));
    await tx.update(userPackages).set({ status: "active", startedAt: now, expiresAt: expiry }).where(eq(userPackages.paymentProofId, payment.id));
    await tx.insert(ledgerEntries).values({ transactionGroupId: randomUUID(), userId: payment.userId, transactionType: "package_payment", direction: "debit", amountPaisa: 0, previousAvailableBalancePaisa: 0, newAvailableBalancePaisa: 0, previousHeldBalancePaisa: 0, newHeldBalancePaisa: 0, relatedEntityType: "payment_proof", relatedEntityId: payment.id, description: `Membership payment approved for ${packageRow.name}`, createdByUserId: input.adminUserId });
    await tx.insert(notifications).values({ userId: payment.userId, title: "Membership activated", message: "Your payment has been verified and your membership is now active.", type: "success" });
    await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "payment_approved", entityType: "payment_proof", entityId: payment.id, newValue: { packageId: packageRow.id } });
  });
  return { status: "approved" as const };
}

export async function getAdminWithdrawals() {
  const db = requireDatabase(await getDb());
  return db.select({ withdrawal: withdrawals, user: users }).from(withdrawals).innerJoin(users, eq(withdrawals.userId, users.id)).orderBy(desc(withdrawals.createdAt));
}

export async function updateWithdrawalStatus(input: { adminUserId: number; withdrawalId: number; status: "processing" | "paid" | "rejected" | "cancelled"; transactionReference?: string; adminNote?: string; }) {
  const db = requireDatabase(await getDb());
  const [withdrawal] = await db.select().from(withdrawals).where(eq(withdrawals.id, input.withdrawalId)).limit(1);
  if (!withdrawal || !["pending", "processing"].includes(withdrawal.status)) throw new Error("This withdrawal cannot be updated.");
  if (input.status === "paid" && !input.transactionReference?.trim()) throw new Error("A payment reference is required before marking a withdrawal paid.");
  const now = new Date();
  if (input.status === "processing") {
    await db.update(withdrawals).set({ status: "processing", adminNote: input.adminNote?.trim() ?? null, processedByUserId: input.adminUserId, processedAt: now }).where(eq(withdrawals.id, withdrawal.id));
    return { status: "processing" as const };
  }
  const wallet = await ensureWallet(withdrawal.userId);
  await db.transaction(async tx => {
    const isReturn = input.status === "rejected" || input.status === "cancelled";
    await tx.update(withdrawals).set({ status: input.status, adminNote: input.adminNote?.trim() ?? null, transactionReference: input.transactionReference?.trim() ?? null, processedByUserId: input.adminUserId, processedAt: now }).where(eq(withdrawals.id, withdrawal.id));
    await tx.update(wallets).set({ availableBalancePaisa: isReturn ? wallet.availableBalancePaisa + withdrawal.amountPaisa : wallet.availableBalancePaisa, heldBalancePaisa: Math.max(0, wallet.heldBalancePaisa - withdrawal.amountPaisa) }).where(eq(wallets.id, wallet.id));
    await tx.insert(ledgerEntries).values({
      transactionGroupId: randomUUID(), userId: withdrawal.userId, transactionType: isReturn ? "withdrawal_reversal" : "withdrawal_payment", direction: isReturn ? "release" : "debit", amountPaisa: withdrawal.amountPaisa,
      previousAvailableBalancePaisa: wallet.availableBalancePaisa, newAvailableBalancePaisa: isReturn ? wallet.availableBalancePaisa + withdrawal.amountPaisa : wallet.availableBalancePaisa,
      previousHeldBalancePaisa: wallet.heldBalancePaisa, newHeldBalancePaisa: Math.max(0, wallet.heldBalancePaisa - withdrawal.amountPaisa),
      relatedEntityType: "withdrawal", relatedEntityId: withdrawal.id, description: isReturn ? "Withdrawal balance released" : "Withdrawal payment marked paid", createdByUserId: input.adminUserId,
    });
    await tx.insert(notifications).values({ userId: withdrawal.userId, title: `Withdrawal ${input.status}`, message: input.status === "paid" ? "Your withdrawal has been marked paid." : "Your withdrawal has been released according to the platform rules.", type: input.status === "paid" ? "success" : "warning" });
    await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: `withdrawal_${input.status}`, entityType: "withdrawal", entityId: withdrawal.id, newValue: { transactionReference: input.transactionReference ?? null, note: input.adminNote ?? null } });
  });
  return { status: input.status };
}

export async function listCampaigns() {
  const db = requireDatabase(await getDb());
  return db.select().from(adCampaigns).orderBy(desc(adCampaigns.createdAt));
}

export async function createCampaign(input: Omit<typeof adCampaigns.$inferInsert, "id" | "createdAt" | "updatedAt" | "completedViewsCount" | "rewardsDistributedPaisa">, adminUserId: number) {
  const db = requireDatabase(await getDb());
  if (input.rewardPaisa <= 0 || input.budgetPaisa < input.rewardPaisa || input.maxImpressions <= 0 || input.durationSeconds < 5 || input.endAt <= input.startAt) throw new Error("Campaign budget, limits, duration, or dates are invalid.");
  const [campaign] = await db.insert(adCampaigns).values(input).$returningId();
  await db.insert(auditLogs).values({ actorUserId: adminUserId, action: "campaign_created", entityType: "campaign", entityId: campaign?.id, newValue: { title: input.title, budgetPaisa: input.budgetPaisa } });
  return campaign;
}

export async function updateCampaign(input: { adminUserId: number; campaignId: number; title: string; advertiser: string; description?: string; mediaUrl?: string; callToAction?: string; targetUrl?: string; eligiblePackageId?: number | null; durationSeconds: number; rewardPaisa: number; budgetPaisa: number; maxImpressions: number; startAt: Date; endAt: Date; status: "draft" | "active" | "paused" }) {
  const db = requireDatabase(await getDb());
  if (input.rewardPaisa <= 0 || input.budgetPaisa < input.rewardPaisa || input.maxImpressions <= 0 || input.durationSeconds < 5 || input.endAt <= input.startAt) throw new Error("Campaign budget, limits, duration, or dates are invalid.");
  const [existing] = await db.select().from(adCampaigns).where(eq(adCampaigns.id, input.campaignId)).limit(1);
  if (!existing) throw new Error("The campaign record was not found.");
  if (input.eligiblePackageId) {
    const [packageRow] = await db.select({ id: packages.id }).from(packages).where(eq(packages.id, input.eligiblePackageId)).limit(1);
    if (!packageRow) throw new Error("The selected package does not exist.");
  }
  if (input.budgetPaisa < existing.rewardsDistributedPaisa) throw new Error("Campaign budget cannot be lower than rewards already recorded.");
  await db.transaction(async tx => {
    await tx.update(adCampaigns).set({ title: input.title, advertiser: input.advertiser, description: input.description?.trim() || null, mediaUrl: input.mediaUrl?.trim() || null, callToAction: input.callToAction?.trim() || null, targetUrl: input.targetUrl?.trim() || null, eligiblePackageId: input.eligiblePackageId ?? null, durationSeconds: input.durationSeconds, rewardPaisa: input.rewardPaisa, budgetPaisa: input.budgetPaisa, maxImpressions: input.maxImpressions, startAt: input.startAt, endAt: input.endAt, status: input.status }).where(eq(adCampaigns.id, input.campaignId));
    await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "campaign_updated", entityType: "campaign", entityId: input.campaignId, oldValue: { title: existing.title, status: existing.status, eligiblePackageId: existing.eligiblePackageId }, newValue: { title: input.title, status: input.status, eligiblePackageId: input.eligiblePackageId ?? null } });
  });
  return { success: true };
}

export async function deleteCampaign(input: { adminUserId: number; campaignId: number }) {
  const db = requireDatabase(await getDb());
  const [existing] = await db.select().from(adCampaigns).where(eq(adCampaigns.id, input.campaignId)).limit(1);
  if (!existing) throw new Error("The campaign record was not found.");
  const [view] = await db.select({ id: adViews.id }).from(adViews).where(eq(adViews.campaignId, input.campaignId)).limit(1);
  if (view) throw new Error("Campaigns with recorded viewing activity cannot be deleted; pause them to preserve the audit trail.");
  await db.transaction(async tx => {
    await tx.delete(adCampaigns).where(eq(adCampaigns.id, input.campaignId));
    await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "campaign_deleted", entityType: "campaign", entityId: input.campaignId, oldValue: { title: existing.title } });
  });
  return { success: true };
}

export async function getAdminUsers() {
  const db = requireDatabase(await getDb());
  return db.select({ user: users, wallet: wallets }).from(users).leftJoin(wallets, eq(users.id, wallets.userId)).orderBy(desc(users.createdAt)).limit(100);
}

export async function updateUserAccountStatus(input: { adminUserId: number; userId: number; accountStatus: "active" | "suspended" | "review"; reason?: string }) {
  const db = requireDatabase(await getDb());
  const [target] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!target) throw new Error("The member record was not found.");
  if (target.role === "admin") throw new Error("Administrator account status cannot be changed here.");
  await db.transaction(async tx => {
    await tx.update(users).set({ accountStatus: input.accountStatus }).where(eq(users.id, input.userId));
    await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: `user_status_${input.accountStatus}`, entityType: "user", entityId: input.userId, oldValue: { accountStatus: target.accountStatus }, newValue: { accountStatus: input.accountStatus, reason: input.reason?.trim() ?? null } });
    await tx.insert(notifications).values({ userId: input.userId, title: "Account status updated", message: input.reason?.trim() || `Your account status is now ${input.accountStatus}.`, type: input.accountStatus === "active" ? "success" : "security" });
  });
  return { accountStatus: input.accountStatus };
}

export async function getAdminFraudFlags() {
  const db = requireDatabase(await getDb());
  return db.select({ flag: fraudFlags, user: users }).from(fraudFlags).innerJoin(users, eq(fraudFlags.userId, users.id)).orderBy(desc(fraudFlags.createdAt)).limit(100);
}

export async function createFraudFlag(input: { adminUserId: number; userId: number; severity: "low" | "medium" | "high"; reason: string }) {
  const db = requireDatabase(await getDb());
  const [record] = await db.insert(fraudFlags).values({ userId: input.userId, severity: input.severity, reason: input.reason.trim() }).$returningId();
  await db.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "fraud_flag_created", entityType: "fraud_flag", entityId: record?.id, newValue: { userId: input.userId, severity: input.severity, reason: input.reason.trim() } });
  return record;
}

export async function getAdminSettings() {
  await ensureInitialPlatformData();
  const db = requireDatabase(await getDb());
  return db.select().from(platformSettings).orderBy(platformSettings.settingKey);
}

export async function updatePlatformSetting(input: { adminUserId: number; settingKey: string; settingValue: string }) {
  const db = requireDatabase(await getDb());
  const [existing] = await db.select().from(platformSettings).where(eq(platformSettings.settingKey, input.settingKey)).limit(1);
  if (!existing) throw new Error("This setting key is not recognized.");
  await db.transaction(async tx => {
    await tx.update(platformSettings).set({ settingValue: normalizePersistentSettingValue(input.settingValue), updatedByUserId: input.adminUserId }).where(eq(platformSettings.id, existing.id));
    await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "platform_setting_updated", entityType: "platform_setting", entityId: existing.id, oldValue: { settingValue: existing.isSensitive ? "[redacted]" : existing.settingValue }, newValue: { settingValue: existing.isSensitive ? "[redacted]" : normalizePersistentSettingValue(input.settingValue) } });
  });
  const [saved] = await db.select().from(platformSettings).where(eq(platformSettings.id, existing.id)).limit(1);
  return { success: true, setting: saved };
}

export async function getAdminPackages() {
  await ensureInitialPlatformData();
  const db = requireDatabase(await getDb());
  return db.select().from(packages).orderBy(packages.pricePaisa);
}

export async function updatePackageRules(input: { adminUserId: number; packageId: number; pricePaisa: number; rewardPerEligibleAdPaisa: number; dailyAdLimit: number; durationDays: number; status: "active" | "inactive" }) {
  const db = requireDatabase(await getDb());
  if (input.pricePaisa <= 0 || input.rewardPerEligibleAdPaisa <= 0 || input.dailyAdLimit < 0 || input.durationDays <= 0) throw new Error("Package price, reward, limit, or duration is invalid.");
  const [existing] = await db.select().from(packages).where(eq(packages.id, input.packageId)).limit(1);
  if (!existing) throw new Error("The package record was not found.");
  await db.transaction(async tx => {
    await tx.update(packages).set(buildPackageRulesUpdateValues(input)).where(eq(packages.id, input.packageId));
    await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "package_rules_updated", entityType: "package", entityId: input.packageId, oldValue: { pricePaisa: existing.pricePaisa, rewardPerEligibleAdPaisa: existing.rewardPerEligibleAdPaisa, dailyAdLimit: existing.dailyAdLimit, durationDays: existing.durationDays, status: existing.status }, newValue: { pricePaisa: input.pricePaisa, rewardPerEligibleAdPaisa: input.rewardPerEligibleAdPaisa, dailyAdLimit: input.dailyAdLimit, durationDays: input.durationDays, status: input.status } });
  });
  const [saved] = await db.select().from(packages).where(eq(packages.id, input.packageId)).limit(1);
  return { success: true, package: saved };
}

export async function getMemberRewardVideos(userId: number) {
  const db = requireDatabase(await getDb());
  const membership = await getActiveMembership(userId);
  if (!membership) return { membership: null, videos: [] };
  const settings = await getSettingMap();
  const platformDay = getPlatformDayWindow(Date.now(), settings.platform_timezone || "Asia/Karachi");
  const rows = await db.select({ id: rewardVideos.id, packageId: rewardVideos.packageId, title: rewardVideos.title, platform: rewardVideos.platform, youtubeUrl: rewardVideos.youtubeUrl, youtubeVideoId: rewardVideos.youtubeVideoId, thumbnailUrl: rewardVideos.thumbnailUrl, description: rewardVideos.description, rewardPaisa: rewardVideos.rewardPaisa, requiredDurationSeconds: rewardVideos.requiredDurationSeconds, dailyRewardLimit: rewardVideos.dailyRewardLimit, verificationConfigured: sql<boolean>`${rewardVideos.verificationCodeHash} is not null`, sortOrder: rewardVideos.sortOrder, status: rewardVideos.status }).from(rewardVideos).where(and(eq(rewardVideos.packageId, membership.package.id), eq(rewardVideos.status, "enabled"))).orderBy(rewardVideos.sortOrder, desc(rewardVideos.createdAt));
  const completed = await db.select({ videoId: videoCompletions.videoId, completedAt: videoCompletions.completedAt, rewardPaisa: videoCompletions.rewardPaisa }).from(videoCompletions).where(and(eq(videoCompletions.userId, userId), eq(videoCompletions.completedDay, platformDay.completedDay)));
  const sessions = await db.select().from(videoWatchSessions).where(eq(videoWatchSessions.userId, userId)).orderBy(desc(videoWatchSessions.startedAt));
  const completionMap = new Map(completed.map(item => [item.videoId, item]));
  const sessionMap = new Map<number, typeof sessions[number]>();
  for (const session of sessions) if (!sessionMap.has(session.videoId)) sessionMap.set(session.videoId, session);
  return { membership, platformDay: platformDay.dayKey, platformTimeZone: settings.platform_timezone || "Asia/Karachi", videos: rows.map(video => ({ video, completion: completionMap.get(video.id) ?? null, session: sessionMap.get(video.id) ?? null })) };
}

export async function getAdminRewardVideos() {
  const db = requireDatabase(await getDb());
  const rows = await db.select({ video: rewardVideos, package: packages }).from(rewardVideos).innerJoin(packages, eq(rewardVideos.packageId, packages.id)).orderBy(packages.pricePaisa, rewardVideos.sortOrder, desc(rewardVideos.createdAt));
  return rows.map(({ video, package: packageRow }) => {
    const { verificationCodeHash, ...safeVideo } = video;
    return { video: { ...safeVideo, hasVerificationCode: Boolean(verificationCodeHash) }, package: packageRow };
  });
}

export function buildRewardVideoUpdateValues(input: { adminUserId: number; packageId: number; title: string; platform: "youtube" | "tiktok"; youtubeUrl: string; youtubeVideoId: string; thumbnailUrl?: string; description?: string; rewardPaisa: number; requiredDurationSeconds?: number; dailyRewardLimit: number; verificationCode?: string; sortOrder: number; status: "enabled" | "disabled" }, existing: Pick<typeof rewardVideos.$inferSelect, "requiredDurationSeconds">) {
  const fallbackThumbnail = input.platform === "youtube" ? `https://i.ytimg.com/vi/${input.youtubeVideoId}/hqdefault.jpg` : null;
  return { packageId: input.packageId, title: input.title, platform: input.platform, youtubeUrl: input.youtubeUrl, youtubeVideoId: input.youtubeVideoId, thumbnailUrl: input.thumbnailUrl?.trim() || fallbackThumbnail, description: input.description?.trim() || null, rewardPaisa: input.rewardPaisa, requiredDurationSeconds: input.requiredDurationSeconds ?? existing.requiredDurationSeconds, dailyRewardLimit: input.dailyRewardLimit, ...(input.verificationCode ? { verificationCodeHash: hashVideoVerificationCode(input.verificationCode), verificationCodeUpdatedAt: new Date() } : {}), sortOrder: input.sortOrder, status: input.status, updatedByUserId: input.adminUserId };
}

export async function createRewardVideo(input: { adminUserId: number; packageId: number; title: string; platform: "youtube" | "tiktok"; youtubeUrl: string; youtubeVideoId: string; thumbnailUrl?: string; description?: string; rewardPaisa: number; requiredDurationSeconds?: number; dailyRewardLimit?: number; verificationCode: string; sortOrder?: number }) {
  const db = requireDatabase(await getDb());
  const [packageRow] = await db.select().from(packages).where(eq(packages.id, input.packageId)).limit(1);
  if (!packageRow) throw new Error("The selected package does not exist.");
  const fallbackThumbnail = input.platform === "youtube" ? `https://i.ytimg.com/vi/${input.youtubeVideoId}/hqdefault.jpg` : null;
  const { verificationCode, ...videoInput } = input;
  const [record] = await db.insert(rewardVideos).values({ ...videoInput, requiredDurationSeconds: input.requiredDurationSeconds ?? DEFAULT_REWARD_VIDEO_DURATION_SECONDS, dailyRewardLimit: input.dailyRewardLimit ?? 1, verificationCodeHash: hashVideoVerificationCode(verificationCode), verificationCodeUpdatedAt: new Date(), thumbnailUrl: input.thumbnailUrl?.trim() || fallbackThumbnail, description: input.description?.trim() || null, sortOrder: input.sortOrder ?? 0, createdByUserId: input.adminUserId, updatedByUserId: input.adminUserId }).$returningId();
  await db.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "reward_video_created", entityType: "reward_video", entityId: record?.id, newValue: { packageId: input.packageId, title: input.title, youtubeVideoId: input.youtubeVideoId, rewardPaisa: input.rewardPaisa } });
  return record;
}

export async function updateRewardVideo(input: { adminUserId: number; videoId: number; packageId: number; title: string; platform: "youtube" | "tiktok"; youtubeUrl: string; youtubeVideoId: string; thumbnailUrl?: string; description?: string; rewardPaisa: number; requiredDurationSeconds?: number; dailyRewardLimit: number; verificationCode?: string; sortOrder: number; status: "enabled" | "disabled" }) {
  const db = requireDatabase(await getDb());
  const [existing] = await db.select().from(rewardVideos).where(eq(rewardVideos.id, input.videoId)).limit(1);
  if (!existing) throw new Error("The video record was not found.");
  const [packageRow] = await db.select({ id: packages.id }).from(packages).where(eq(packages.id, input.packageId)).limit(1);
  if (!packageRow) throw new Error("The selected package does not exist.");
  await db.transaction(async tx => {
    await tx.update(rewardVideos).set(buildRewardVideoUpdateValues(input, existing)).where(eq(rewardVideos.id, input.videoId));
    await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "reward_video_updated", entityType: "reward_video", entityId: input.videoId, oldValue: { title: existing.title, status: existing.status, rewardPaisa: existing.rewardPaisa, sortOrder: existing.sortOrder }, newValue: { title: input.title, status: input.status, rewardPaisa: input.rewardPaisa, sortOrder: input.sortOrder } });
  });
  return { success: true };
}

export async function deleteRewardVideo(input: { adminUserId: number; videoId: number }) {
  const db = requireDatabase(await getDb());
  const [existing] = await db.select().from(rewardVideos).where(eq(rewardVideos.id, input.videoId)).limit(1);
  if (!existing) throw new Error("The video record was not found.");
  const [completion] = await db.select({ id: videoCompletions.id }).from(videoCompletions).where(eq(videoCompletions.videoId, input.videoId)).limit(1);
  if (completion) throw new Error("Videos with completed rewards cannot be deleted; disable them to preserve the audit trail.");
  await db.transaction(async tx => {
    await tx.delete(videoWatchSessions).where(eq(videoWatchSessions.videoId, input.videoId));
    await tx.delete(rewardVideos).where(eq(rewardVideos.id, input.videoId));
    await tx.insert(auditLogs).values({ actorUserId: input.adminUserId, action: "reward_video_deleted", entityType: "reward_video", entityId: input.videoId, oldValue: { title: existing.title, packageId: existing.packageId } });
  });
  return { success: true };
}

export async function startVideoWatchSession(input: { userId: number; videoId: number; ipHash?: string; deviceHash?: string }, testDependencies?: VideoStartWorkflowDependencies) {
  if (testDependencies) return startVideoWatchSessionWithDependencies(input, testDependencies);
  const db = requireDatabase(await getDb());
  const user = await getUserById(input.userId);
  const membership = await getActiveMembership(input.userId);
  const [video] = await db.select().from(rewardVideos).where(eq(rewardVideos.id, input.videoId)).limit(1);
  assertVideoStartEligibility({ accountStatus: user.accountStatus, hasActiveMembership: Boolean(membership), isVideoEnabled: video?.status === "enabled", isAssignedToMemberPackage: Boolean(video && membership && video.packageId === membership.package.id) });
  if (!membership || !video) throw new Error("This video is not available for your membership.");
  if (!video.verificationCodeHash) throw new Error("This video is awaiting administrator verification-code configuration and cannot be rewarded yet.");
  const settings = await getSettingMap();
  const platformDay = getPlatformDayWindow(Date.now(), settings.platform_timezone || "Asia/Karachi");
  const [completion] = await db.select({ id: videoCompletions.id }).from(videoCompletions).where(and(eq(videoCompletions.userId, input.userId), eq(videoCompletions.videoId, input.videoId), eq(videoCompletions.completedDay, platformDay.completedDay))).limit(1);
  const [active] = await db.select().from(videoWatchSessions).where(and(eq(videoWatchSessions.userId, input.userId), eq(videoWatchSessions.videoId, input.videoId), inArray(videoWatchSessions.status, ["started", "awaiting_return", "duration_verified", "code_verified"]))).orderBy(desc(videoWatchSessions.startedAt)).limit(1);
  if (active) return { sessionToken: active.sessionToken, requiredDurationSeconds: active.requiredDurationSeconds, resumed: true, claimAvailable: active.status === "code_verified" && !completion, claimedToday: Boolean(completion), sessionStatus: active.status, externalUrl: video.youtubeUrl };
  const now = new Date();
  const [rapidStarts] = await db.select({ count: sql<number>`count(*)` }).from(videoWatchSessions).where(and(eq(videoWatchSessions.userId, input.userId), eq(videoWatchSessions.videoId, input.videoId), gte(videoWatchSessions.startedAt, new Date(now.getTime() - 15 * 60 * 1000))));
  if (Number(rapidStarts?.count ?? 0) >= 5) {
    await db.insert(fraudFlags).values({ userId: input.userId, severity: "medium", reason: "Rapid repeated external video session starts detected.", relatedEntityType: "video", relatedEntityId: input.videoId });
    throw new Error("Too many recent starts for this video. Please wait before starting another session.");
  }
  const sessionToken = randomUUID();
  await db.insert(videoWatchSessions).values({ sessionToken, userId: input.userId, videoId: input.videoId, membershipId: membership.membership.id, requiredDurationSeconds: video.requiredDurationSeconds, startedAt: now, externalOpenedAt: now, status: "awaiting_return", ipHash: input.ipHash, deviceHash: input.deviceHash });
  return { sessionToken, requiredDurationSeconds: video.requiredDurationSeconds, resumed: false, claimAvailable: false, claimedToday: Boolean(completion), sessionStatus: "awaiting_return" as const, externalUrl: video.youtubeUrl };
}

export async function verifyExternalVideoReturn(input: { userId: number; sessionToken: string }) {
  const db = requireDatabase(await getDb());
  const [session] = await db.select().from(videoWatchSessions).where(and(eq(videoWatchSessions.sessionToken, input.sessionToken), eq(videoWatchSessions.userId, input.userId))).limit(1);
  if (!session) throw new Error("This video session does not belong to your account.");
  if (session.status === "verification_locked") throw new Error("This verification session is locked. Start a fresh session to try again.");
  if (session.status === "claimed") return { durationVerified: true, claimAvailable: false, message: "Reward already claimed today." };
  if (!["awaiting_return", "started", "duration_verified", "code_verified"].includes(session.status)) throw new Error("This video session is no longer available.");
  const now = new Date();
  const result = evaluateExternalVideoReturn({ startedAtMs: session.startedAt.getTime(), returnedAtMs: now.getTime(), requiredDurationSeconds: session.requiredDurationSeconds });
  if (!result.eligible) {
    await db.update(videoWatchSessions).set({ returnedAt: now, status: "rejected", rewardStatus: "not_eligible", interruptionReason: result.reason, suspiciousEventCount: session.suspiciousEventCount + 1 }).where(eq(videoWatchSessions.id, session.id));
    return { durationVerified: false, claimAvailable: false, message: result.reason, elapsedSeconds: result.elapsedSeconds, requiredDurationSeconds: session.requiredDurationSeconds };
  }
  if (session.status === "awaiting_return" || session.status === "started") await db.update(videoWatchSessions).set({ returnedAt: now, status: "duration_verified" }).where(eq(videoWatchSessions.id, session.id));
  return { durationVerified: true, claimAvailable: session.status === "code_verified", message: "Duration verified. Enter the six-digit code shown in the external video.", elapsedSeconds: result.elapsedSeconds, requiredDurationSeconds: session.requiredDurationSeconds };
}

export async function verifyExternalVideoCode(input: { userId: number; sessionToken: string; code: string }) {
  const db = requireDatabase(await getDb());
  const submittedCode = validateVideoVerificationCode(input.code);
  const [session] = await db.select().from(videoWatchSessions).where(and(eq(videoWatchSessions.sessionToken, input.sessionToken), eq(videoWatchSessions.userId, input.userId))).limit(1);
  if (!session) throw new Error("This video session does not belong to your account.");
  if (session.status === "verification_locked" || session.verificationStatus === "locked") throw new Error("Too many incorrect verification attempts. Start a fresh session to try again.");
  if (session.status !== "duration_verified" && session.status !== "code_verified") throw new Error("Return after the required watch duration before entering the verification code.");
  const [video] = await db.select().from(rewardVideos).where(eq(rewardVideos.id, session.videoId)).limit(1);
  if (!video || !video.verificationCodeHash) throw new Error("This video does not have an active verification code. Please contact support.");
  const membership = await getActiveMembership(input.userId);
  if (!membership || membership.membership.id !== session.membershipId || membership.package.id !== video.packageId) throw new Error("Your membership is no longer eligible for this video.");
  const matched = matchesVideoVerificationCode(submittedCode, video.verificationCodeHash);
  const next = nextVerificationAttemptState(session.verificationAttempts, matched);
  const now = new Date();
  if (!matched) {
    await db.update(videoWatchSessions).set({ verificationAttempts: next.attempts, verificationStatus: next.status, status: next.locked ? "verification_locked" : "duration_verified", verificationLockedAt: next.locked ? now : null, lastVerificationAt: now, suspiciousEventCount: session.suspiciousEventCount + 1 }).where(eq(videoWatchSessions.id, session.id));
    if (next.locked) await db.insert(fraudFlags).values({ userId: input.userId, severity: "medium", reason: "Video verification locked after repeated incorrect code attempts.", relatedEntityType: "video_session", relatedEntityId: session.id });
    return { codeVerified: false, locked: next.locked, attemptsRemaining: Math.max(0, 5 - next.attempts), message: next.locked ? "Too many incorrect verification attempts. Start a fresh session to try again." : "Incorrect verification code. Please watch the assigned video and enter the code shown in it." };
  }
  await db.update(videoWatchSessions).set({ verificationStatus: "passed", status: "code_verified", lastVerificationAt: now }).where(eq(videoWatchSessions.id, session.id));
  return { codeVerified: true, locked: false, attemptsRemaining: Math.max(0, 5 - session.verificationAttempts), message: "Code verified. You can now claim the reward." };
}

export async function heartbeatVideoWatchSession(input: { userId: number; sessionToken: string; progressSeconds: number }) {
  const db = requireDatabase(await getDb());
  const [session] = await db.select().from(videoWatchSessions).where(and(eq(videoWatchSessions.sessionToken, input.sessionToken), eq(videoWatchSessions.userId, input.userId))).limit(1);
  if (!session || session.status !== "started") throw new Error("This video session is no longer active.");
  const progress = Math.max(0, Math.floor(input.progressSeconds));
  const now = new Date();
  const anchor = session.lastHeartbeatAt ?? session.startedAt;
  const elapsedSinceHeartbeat = Math.max(0, (now.getTime() - anchor.getTime()) / 1000);
  if (progress + 2 < session.maxProgressSeconds || progress > session.maxProgressSeconds + elapsedSinceHeartbeat + 5) {
    await db.update(videoWatchSessions).set({ status: "rejected", interruptionReason: "Playback progress could not be validated." }).where(eq(videoWatchSessions.id, session.id));
    throw new Error("Video session interrupted because playback progress could not be validated.");
  }
  const maxProgressSeconds = Math.max(session.maxProgressSeconds, progress);
  const membership = await getActiveMembership(input.userId);
  const settings = await getSettingMap();
  const platformDay = getPlatformDayWindow(now.getTime(), settings.platform_timezone || "Asia/Karachi");
  const [dailyClaim] = await db.select({ count: sql<number>`count(*)` }).from(videoCompletions).where(and(eq(videoCompletions.userId, input.userId), eq(videoCompletions.videoId, session.videoId), eq(videoCompletions.completedDay, platformDay.completedDay)));
  const [video] = await db.select().from(rewardVideos).where(eq(rewardVideos.id, session.videoId)).limit(1);
  const check = evaluateVideoCompletion({ startedAtMs: session.startedAt.getTime(), nowMs: now.getTime(), requiredSeconds: session.requiredDurationSeconds, maxProgressSeconds, dailyClaims: Number(dailyClaim?.count ?? 0), dailyRewardLimit: video?.dailyRewardLimit ?? 0, belongsToActivePackage: Boolean(video && membership && membership.membership.id === session.membershipId && membership.package.id === video.packageId) });
  const claimAvailable = check.eligible;
  await db.update(videoWatchSessions).set({ lastProgressSeconds: progress, maxProgressSeconds, lastHeartbeatAt: now, ...(claimAvailable ? { status: "eligible" as const } : {}) }).where(eq(videoWatchSessions.id, session.id));
  return { maxProgressSeconds, requiredDurationSeconds: session.requiredDurationSeconds, claimAvailable, claimedToday: Number(dailyClaim?.count ?? 0) >= (video?.dailyRewardLimit ?? 1) };
}

export async function interruptVideoWatchSession(input: { userId: number; sessionToken: string; reason: string }) {
  const db = requireDatabase(await getDb());
  await db.update(videoWatchSessions).set({ status: "interrupted", interruptionReason: input.reason.slice(0, 255) }).where(and(eq(videoWatchSessions.sessionToken, input.sessionToken), eq(videoWatchSessions.userId, input.userId), eq(videoWatchSessions.status, "started")));
  return { success: true };
}

export async function claimVideoWatchSession(input: { userId: number; sessionToken: string }) {
  const db = requireDatabase(await getDb());
  const [session] = await db.select().from(videoWatchSessions).where(eq(videoWatchSessions.sessionToken, input.sessionToken)).limit(1);
  if (!session) throw new Error("This video session is no longer available.");
  const [video] = await db.select().from(rewardVideos).where(eq(rewardVideos.id, session.videoId)).limit(1);
  if (!video || video.status !== "enabled") throw new Error("This video is no longer eligible for rewards.");
  const membership = await getActiveMembership(input.userId);
  if (!membership || membership.membership.id !== session.membershipId || membership.package.id !== video.packageId) throw new Error("Your membership is no longer eligible for this video.");
  const settings = await getSettingMap();
  const platformDay = getPlatformDayWindow(Date.now(), settings.platform_timezone || "Asia/Karachi");
  const [dailyClaim] = await db.select({ count: sql<number>`count(*)` }).from(videoCompletions).where(and(eq(videoCompletions.userId, input.userId), eq(videoCompletions.videoId, video.id), eq(videoCompletions.completedDay, platformDay.completedDay)));
  assertExternalVideoClaimEligibility({ sessionUserId: session.userId, requesterUserId: input.userId, sessionStatus: session.status, verificationStatus: session.verificationStatus, rewardStatus: session.rewardStatus, dailyClaims: Number(dailyClaim?.count ?? 0), dailyRewardLimit: video.dailyRewardLimit });
  const durationCheck = evaluateExternalVideoReturn({ startedAtMs: session.startedAt.getTime(), returnedAtMs: Date.now(), requiredDurationSeconds: session.requiredDurationSeconds });
  if (!durationCheck.eligible) throw new Error(durationCheck.reason ?? "The required watch duration has not elapsed.");
  const wallet = await ensureWallet(input.userId);
  const now = new Date();
  await db.transaction(async tx => {
    const update = await tx.update(videoWatchSessions).set({ status: "claimed", rewardStatus: "claimed", completedAt: now }).where(and(eq(videoWatchSessions.id, session.id), eq(videoWatchSessions.status, "code_verified"), eq(videoWatchSessions.verificationStatus, "passed")));
    const affected = (update as unknown as [{ affectedRows?: number }])[0]?.affectedRows ?? 0;
    if (affected !== 1) throw new Error("This video session has already been resolved.");
    const [completion] = await tx.insert(videoCompletions).values({ userId: input.userId, videoId: video.id, watchSessionId: session.id, rewardPaisa: video.rewardPaisa, completedDay: platformDay.completedDay }).$returningId();
    await tx.update(wallets).set({ availableBalancePaisa: wallet.availableBalancePaisa + video.rewardPaisa, lifetimeEarnedPaisa: wallet.lifetimeEarnedPaisa + video.rewardPaisa }).where(eq(wallets.id, wallet.id));
    await tx.insert(ledgerEntries).values({ transactionGroupId: randomUUID(), userId: input.userId, transactionType: "video_reward", direction: "credit", amountPaisa: video.rewardPaisa, previousAvailableBalancePaisa: wallet.availableBalancePaisa, newAvailableBalancePaisa: wallet.availableBalancePaisa + video.rewardPaisa, previousHeldBalancePaisa: wallet.heldBalancePaisa, newHeldBalancePaisa: wallet.heldBalancePaisa, relatedEntityType: "video_completion", relatedEntityId: completion?.id, description: `Validated video reward for ${video.title}` });
    await tx.insert(notifications).values({ userId: input.userId, title: "Video reward credited", message: "Your video completion was validated and the reward was added to your balance.", type: "success" });
  });
  return { rewardPaisa: video.rewardPaisa };
}

export const completeVideoWatchSession = claimVideoWatchSession;
