import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { getSessionCookieOptions } from "./_core/cookies";
import { createSessionToken } from "./_core/session";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "./_core/trpc";
import {
  changeMemberPassword,
  completeAdSession,
  createCampaign,
  createFraudFlag,
  createRewardVideo,
  createWithdrawal,
  completeVideoWatchSession,
  deleteCampaign,
  deleteMemberAccount,
  deleteRewardVideo,
  getAuthorizedPaymentProofUrl,
  getAdminPackages,
  getAdminPaymentProofs,
  getAdminRewardVideos,
  getAdminFraudFlags,
  getAdminSummary,
  getAdminSettings,
  getAdminExternalVideoAnalytics,
  getAdminUsers,
  getAdminWithdrawals,
  getDashboardOverview,
  getEligibleCampaigns,
  getUserByEmail,
  getUserByOpenId,
  getLedgerHistory,
  getMemberProfile,
  getMemberRewardVideos,
  getPublicPackages,
  getSettingMap,
  getUserPaymentProofs,
  getUserNotifications,
  getUserWithdrawals,
  isAdminEmail,
  isGmailAddress,
  listCampaigns,
  markNotificationsRead,
  requestPasswordReset,
  resetPasswordWithToken,
  reviewPaymentProof,
  signupMemberWithPassword,
  startAdSession,
  startVideoWatchSession,
  submitPaymentProof,
  upsertUser,
  updateWithdrawalStatus,
  updateCampaign,
  updatePlatformSetting,
  updatePackageRules,
  updateRewardVideo,
  updateMemberProfile,
  updateUserAccountStatus,
  verifyExternalVideoCode,
  verifyExternalVideoReturn,
  verifyMemberPasswordLogin,
} from "./db";
import { storagePut } from "./storage";
import { isValidPakistanMobile, validatePaymentScreenshot } from "./platformRules";
import { z } from "zod";

const moneyPaisa = z.number().int().positive();
const paymentMethod = z.enum(["jazzcash", "easypaisa", "bank_transfer"]);
const payoutMethod = z.enum(["jazzcash", "easypaisa"]);
const videoPlatform = z.enum(["youtube", "tiktok"]);
const videoUrl = z.string().trim().url();
const videoVerificationCode = z.string().trim().regex(/^\d{6}$/, "Enter exactly six digits for the verification code.");

function getYoutubeVideoId(value: string) {
  const parsed = new URL(value.startsWith("http") ? value : `https://${value}`);
  const id = parsed.hostname.includes("youtu.be") ? parsed.pathname.slice(1) : parsed.searchParams.get("v") ?? parsed.pathname.split("/").filter(Boolean).pop();
  if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) throw new Error("The YouTube URL does not contain a valid video ID.");
  return id;
}

function getVideoIdentifier(platform: "youtube" | "tiktok", value: string) {
  if (platform === "youtube") return getYoutubeVideoId(value);
  const parsed = new URL(value.startsWith("http") ? value : `https://${value}`);
  if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname)) throw new Error("Enter a valid TikTok video URL.");
  const match = parsed.pathname.match(/\/video\/(\d{8,24})/) ?? parsed.pathname.match(/\/player\/v1\/(\d{8,24})/);
  if (!match?.[1]) throw new Error("Use a full TikTok post URL that includes its video ID.");
  return match[1];
}

function toDomainError(error: unknown): never {
  throw new Error(error instanceof Error ? error.message : "The request could not be completed.");
}

const localAdminAttempts = new Map<string, { count: number; resetAt: number }>();
const LOCAL_ADMIN_WINDOW_MS = 15 * 60 * 1_000;
const LOCAL_ADMIN_MAX_ATTEMPTS = 5;

function requestKey(headers: Record<string, string | string[] | undefined>) {
  const forwarded = headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return value?.split(",")[0]?.trim() || "local";
}

function checkLocalAdminRateLimit(key: string) {
  const now = Date.now();
  const current = localAdminAttempts.get(key);
  if (!current || current.resetAt <= now) return;
  if (current.count >= LOCAL_ADMIN_MAX_ATTEMPTS) throw new Error("Too many sign-in attempts. Please wait before trying again.");
}

function recordLocalAdminFailure(key: string) {
  const now = Date.now();
  const current = localAdminAttempts.get(key);
  if (!current || current.resetAt <= now) localAdminAttempts.set(key, { count: 1, resetAt: now + LOCAL_ADMIN_WINDOW_MS });
  else localAdminAttempts.set(key, { ...current, count: current.count + 1 });
}

// Separate brute-force bucket for the unified email+password endpoints.
const passwordAuthAttempts = new Map<string, { count: number; resetAt: number }>();
const PASSWORD_AUTH_WINDOW_MS = 15 * 60 * 1_000;
const PASSWORD_AUTH_MAX_ATTEMPTS = 5;

function checkPasswordAuthRateLimit(key: string) {
  const now = Date.now();
  const current = passwordAuthAttempts.get(key);
  if (!current || current.resetAt <= now) return;
  if (current.count >= PASSWORD_AUTH_MAX_ATTEMPTS) throw new Error("Too many sign-in attempts. Please wait before trying again.");
}

function recordPasswordAuthFailure(key: string) {
  const now = Date.now();
  const current = passwordAuthAttempts.get(key);
  if (!current || current.resetAt <= now) passwordAuthAttempts.set(key, { count: 1, resetAt: now + PASSWORD_AUTH_WINDOW_MS });
  else passwordAuthAttempts.set(key, { ...current, count: current.count + 1 });
}

function clearPasswordAuthAttempts(key: string) {
  passwordAuthAttempts.delete(key);
}

/** Ensure the local administrator user record exists and is active. */
async function ensureAdminSessionUser() {
  const configuredEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
  let admin = await getUserByEmail(configuredEmail);
  if (!admin) {
    const openId = `local-admin:${configuredEmail}`;
    await upsertUser({ openId, email: configuredEmail, name: "FMB Earning Hub Administrator", loginMethod: "local_admin", role: "admin", accountStatus: "active", lastSignedIn: new Date() });
    admin = await getUserByOpenId(openId);
  }
  if (!admin) throw new Error("The administrator account could not be prepared.");
  if (admin.role !== "admin" || admin.accountStatus !== "active") {
    await upsertUser({ openId: admin.openId, role: "admin", accountStatus: "active", lastSignedIn: new Date() });
    admin = await getUserByOpenId(admin.openId);
  }
  if (!admin) throw new Error("The administrator account could not be activated.");
  return admin;
}

function secureValueMatch(value: string, expected: string) {
  const received = Buffer.from(value);
  const target = Buffer.from(expected);
  return received.length === target.length && timingSafeEqual(received, target);
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    localAdminLogin: publicProcedure.input(z.object({ email: z.string().trim().email(), password: z.string().min(1).max(256) })).mutation(async ({ ctx, input }) => {
      const key = requestKey(ctx.req.headers);
      checkLocalAdminRateLimit(key);
      const configuredEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase() ?? "";
      const configuredPassword = process.env.ADMIN_PASSWORD ?? "";
      const email = input.email.trim().toLowerCase();
      if (!configuredEmail || !configuredPassword || !secureValueMatch(email, configuredEmail) || !secureValueMatch(input.password, configuredPassword)) {
        recordLocalAdminFailure(key);
        throw new Error("Invalid administrator credentials.");
      }
      localAdminAttempts.delete(key);
      const admin = await ensureAdminSessionUser();
      const session = await createSessionToken(admin.openId, { name: admin.name ?? "FMB Earning Hub Administrator", expiresInMs: 8 * 60 * 60 * 1_000 });
      ctx.res.cookie(COOKIE_NAME, session, { ...getSessionCookieOptions(ctx.req), maxAge: 8 * 60 * 60 * 1_000 });
      return { success: true } as const;
    }),
    /**
     * Unified email + password sign-in. The administrator email routes to the
     * admin panel; every other active member routes to the member dashboard.
     */
    passwordLogin: publicProcedure.input(z.object({ email: z.string().trim().email().max(160), password: z.string().min(1).max(256) })).mutation(async ({ ctx, input }) => {
      const key = requestKey(ctx.req.headers);
      checkPasswordAuthRateLimit(key);
      try {
        const email = input.email.trim().toLowerCase();
        if (isAdminEmail(email)) {
          const configuredPassword = process.env.ADMIN_PASSWORD ?? "";
          if (!configuredPassword || !secureValueMatch(input.password, configuredPassword)) {
            throw new Error("Invalid email or password.");
          }
          const admin = await ensureAdminSessionUser();
          const session = await createSessionToken(admin.openId, { name: admin.name ?? "FMB Earning Hub Administrator", expiresInMs: 8 * 60 * 60 * 1_000 });
          ctx.res.cookie(COOKIE_NAME, session, { ...getSessionCookieOptions(ctx.req), maxAge: 8 * 60 * 60 * 1_000 });
          clearPasswordAuthAttempts(key);
          return { role: "admin" } as const;
        }
        const user = await verifyMemberPasswordLogin({ email, password: input.password });
        const session = await createSessionToken(user.openId, { name: user.name ?? "", expiresInMs: ONE_YEAR_MS });
        ctx.res.cookie(COOKIE_NAME, session, { ...getSessionCookieOptions(ctx.req), maxAge: ONE_YEAR_MS });
        clearPasswordAuthAttempts(key);
        return { role: "member" } as const;
      } catch (error) {
        recordPasswordAuthFailure(key);
        throw error;
      }
    }),
    /** Member self-registration with email + password. Starts in manual review. */
    passwordSignup: publicProcedure.input(z.object({ name: z.string().trim().min(2).max(160), email: z.string().trim().email().max(160).refine(isGmailAddress, "Please sign up with a valid Gmail address (example@gmail.com)."), password: z.string().min(8).max(256), phone: z.string().trim().min(1).max(20).refine(isValidPakistanMobile, "Enter a valid Pakistani mobile number (e.g. 03XXXXXXXXX).") })).mutation(async ({ ctx, input }) => {
      const key = requestKey(ctx.req.headers);
      checkPasswordAuthRateLimit(key);
      try {
        return await signupMemberWithPassword(input);
      } catch (error) {
        recordPasswordAuthFailure(key);
        throw error;
      }
    }),
    requestPasswordReset: publicProcedure.input(z.object({ email: z.string().trim().email().max(160) })).mutation(async ({ ctx, input }) => {
      const key = requestKey(ctx.req.headers);
      checkPasswordAuthRateLimit(key);
      try {
        return await requestPasswordReset(input.email);
      } catch (error) {
        recordPasswordAuthFailure(key);
        throw error;
      }
    }),
    resetPassword: publicProcedure.input(z.object({ token: z.string().trim().min(16).max(128), newPassword: z.string().min(8).max(256) })).mutation(async ({ input }) => {
      return resetPasswordWithToken({ token: input.token, newPassword: input.newPassword });
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  platform: router({
    packages: publicProcedure.query(async () => {
      try { return await getPublicPackages(); } catch { return []; }
    }),
    settings: publicProcedure.query(async () => {
      const settings = await getSettingMap();
      const { jazzcash_number, easypaisa_number, bank_information, payment_account_title, ...safeSettings } = settings;
      return safeSettings;
    }),
  }),
  dashboard: router({
    overview: protectedProcedure.query(async ({ ctx }) => {
      try { return await getDashboardOverview(ctx.user.id); } catch (error) { return toDomainError(error); }
    }),
  }),
  ads: router({
    available: protectedProcedure.query(async ({ ctx }) => {
      try { return await getEligibleCampaigns(ctx.user.id); } catch (error) { return toDomainError(error); }
    }),
    start: protectedProcedure.input(z.object({ campaignId: z.number().int().positive(), deviceHash: z.string().max(128).optional() })).mutation(async ({ ctx, input }) => {
      try {
        const forwarded = ctx.req.headers["x-forwarded-for"];
        const ipHash = typeof forwarded === "string" ? forwarded.slice(0, 128) : undefined;
        return await startAdSession(ctx.user.id, input.campaignId, { ipHash, deviceHash: input.deviceHash });
      } catch (error) { return toDomainError(error); }
    }),
    complete: protectedProcedure.input(z.object({ sessionToken: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      try { return await completeAdSession(ctx.user.id, input.sessionToken); } catch (error) { return toDomainError(error); }
    }),
  }),
  videos: router({
    available: protectedProcedure.query(async ({ ctx }) => {
      try { return await getMemberRewardVideos(ctx.user.id); } catch (error) { return toDomainError(error); }
    }),
    start: protectedProcedure.input(z.object({ videoId: z.number().int().positive(), deviceHash: z.string().max(128).optional() })).mutation(async ({ ctx, input }) => {
      try {
        const forwarded = ctx.req.headers["x-forwarded-for"];
        const ipHash = typeof forwarded === "string" ? forwarded.slice(0, 128) : undefined;
        return await startVideoWatchSession({ userId: ctx.user.id, videoId: input.videoId, deviceHash: input.deviceHash, ipHash });
      } catch (error) { return toDomainError(error); }
    }),
    verifyReturn: protectedProcedure.input(z.object({ sessionToken: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      try { return await verifyExternalVideoReturn({ ...input, userId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    verifyCode: protectedProcedure.input(z.object({ sessionToken: z.string().uuid(), code: videoVerificationCode })).mutation(async ({ ctx, input }) => {
      try { return await verifyExternalVideoCode({ ...input, userId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    complete: protectedProcedure.input(z.object({ sessionToken: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      try { return await completeVideoWatchSession({ ...input, userId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
  }),
  payments: router({
    instructions: protectedProcedure.query(async () => {
      const settings = await getSettingMap();
      return {
        companyName: settings.company_name,
        accountTitle: settings.payment_account_title,
        jazzcashNumber: settings.jazzcash_number,
        easypaisaNumber: settings.easypaisa_number,
        bankInformation: settings.bank_information,
      };
    }),
    list: protectedProcedure.query(async ({ ctx }) => {
      try { return await getUserPaymentProofs(ctx.user.id); } catch (error) { return toDomainError(error); }
    }),
    proofUrl: protectedProcedure.input(z.object({ paymentProofId: z.number().int().positive() })).query(async ({ ctx, input }) => {
      try { return await getAuthorizedPaymentProofUrl({ requester: ctx.user, paymentProofId: input.paymentProofId }); } catch (error) { return toDomainError(error); }
    }),
    submit: protectedProcedure.input(z.object({
      packageId: z.number().int().positive(),
      paymentMethod,
      amountPaisa: moneyPaisa,
      senderAccount: z.string().trim().min(5).max(64),
      transactionId: z.string().trim().min(4).max(128),
      additionalNote: z.string().trim().max(1_000).optional(),
      screenshot: z.object({ fileName: z.string().trim().min(5).max(120), mimeType: z.string().max(64), base64: z.string().min(4).max(7_000_000) }).optional(),
    })).mutation(async ({ ctx, input }) => {
      try {
        let screenshotKey: string | undefined;
        if (input.screenshot) {
          const bytes = Buffer.from(input.screenshot.base64, "base64");
          validatePaymentScreenshot({ name: input.screenshot.fileName, type: input.screenshot.mimeType, bytes: bytes.byteLength });
          const safeName = input.screenshot.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
          const stored = await storagePut(`payment-proofs/${ctx.user.id}/${randomUUID()}-${safeName}`, bytes, input.screenshot.mimeType);
          screenshotKey = stored.key;
        }
        return await submitPaymentProof({ ...input, userId: ctx.user.id, screenshotKey, screenshotFileName: input.screenshot?.fileName, screenshotMimeType: input.screenshot?.mimeType, screenshotBytes: input.screenshot ? Buffer.from(input.screenshot.base64, "base64").byteLength : undefined });
      } catch (error) { return toDomainError(error); }
    }),
  }),
  withdrawals: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      try { return await getUserWithdrawals(ctx.user.id); } catch (error) { return toDomainError(error); }
    }),
    create: protectedProcedure.input(z.object({ amountPaisa: moneyPaisa, paymentMethod: payoutMethod, accountHolderName: z.string().trim().min(2).max(160), accountNumber: z.string().trim().regex(/^(?:\+92|92|0)3\d{9}$/) })).mutation(async ({ ctx, input }) => {
      try { return await createWithdrawal({ ...input, userId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
  }),
  profile: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      try { return await getMemberProfile(ctx.user.id); } catch (error) { return toDomainError(error); }
    }),
    update: protectedProcedure.input(z.object({ name: z.string().trim().min(2).max(160), phone: z.string().trim().max(20).optional() })).mutation(async ({ ctx, input }) => {
      try { return await updateMemberProfile({ ...input, userId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    changePassword: protectedProcedure.input(z.object({ currentPassword: z.string().max(256).optional(), newPassword: z.string().min(8).max(256) })).mutation(async ({ ctx, input }) => {
      try { return await changeMemberPassword({ userId: ctx.user.id, currentPassword: input.currentPassword, newPassword: input.newPassword }); } catch (error) { return toDomainError(error); }
    }),
    deleteAccount: protectedProcedure.mutation(async ({ ctx }) => {
      try {
        const result = await deleteMemberAccount(ctx.user.id);
        ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
        return result;
      } catch (error) { return toDomainError(error); }
    }),
  }),
  ledger: router({
    list: protectedProcedure.input(z.object({ period: z.enum(["today", "week", "month", "all"]).default("all") })).query(async ({ ctx, input }) => {
      try { return await getLedgerHistory(ctx.user.id, input.period); } catch (error) { return toDomainError(error); }
    }),
  }),
  notifications: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      try { return await getUserNotifications(ctx.user.id); } catch (error) { return toDomainError(error); }
    }),
    markRead: protectedProcedure.input(z.object({ notificationIds: z.array(z.number().int().positive()).optional() }).optional()).mutation(async ({ ctx, input }) => {
      try { return await markNotificationsRead(ctx.user.id, input?.notificationIds); } catch (error) { return toDomainError(error); }
    }),
  }),
  admin: router({
    summary: adminProcedure.query(async () => {
      try { return await getAdminSummary(); } catch (error) { return toDomainError(error); }
    }),
    externalVideoAnalytics: adminProcedure.query(async () => {
      try { return await getAdminExternalVideoAnalytics(); } catch (error) { return toDomainError(error); }
    }),
    payments: adminProcedure.query(async () => {
      try { return await getAdminPaymentProofs(); } catch (error) { return toDomainError(error); }
    }),
    reviewPayment: adminProcedure.input(z.object({ paymentProofId: z.number().int().positive(), action: z.enum(["approve", "reject"]), rejectionReason: z.string().trim().min(3).max(1_000).optional() })).mutation(async ({ ctx, input }) => {
      try { return await reviewPaymentProof({ ...input, adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    videos: adminProcedure.query(async () => {
      try { return await getAdminRewardVideos(); } catch (error) { return toDomainError(error); }
    }),
    createVideo: adminProcedure.input(z.object({ packageId: z.number().int().positive(), title: z.string().trim().min(3).max(180), platform: videoPlatform.default("youtube"), youtubeUrl: videoUrl, thumbnailUrl: z.string().trim().url().max(512).optional(), description: z.string().trim().max(2_000).optional(), rewardPaisa: moneyPaisa, requiredDurationSeconds: z.number().int().min(10).max(14_400).optional(), dailyRewardLimit: z.number().int().min(0).max(1).default(1), verificationCode: videoVerificationCode, sortOrder: z.number().int().min(0).max(100_000).optional(), episodeNumber: z.number().int().min(0).max(100_000).optional() })).mutation(async ({ ctx, input }) => {
      try { return await createRewardVideo({ ...input, youtubeVideoId: getVideoIdentifier(input.platform, input.youtubeUrl), adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    updateVideo: adminProcedure.input(z.object({ videoId: z.number().int().positive(), packageId: z.number().int().positive(), title: z.string().trim().min(3).max(180), platform: videoPlatform, youtubeUrl: videoUrl, thumbnailUrl: z.string().trim().url().max(512).optional(), description: z.string().trim().max(2_000).optional(), rewardPaisa: moneyPaisa, requiredDurationSeconds: z.number().int().min(10).max(14_400).optional(), dailyRewardLimit: z.number().int().min(0).max(1), verificationCode: videoVerificationCode.optional(), sortOrder: z.number().int().min(0).max(100_000), episodeNumber: z.number().int().min(0).max(100_000), status: z.enum(["enabled", "disabled"]) })).mutation(async ({ ctx, input }) => {
      try { return await updateRewardVideo({ ...input, youtubeVideoId: getVideoIdentifier(input.platform, input.youtubeUrl), adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    deleteVideo: adminProcedure.input(z.object({ videoId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      try { return await deleteRewardVideo({ ...input, adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    withdrawals: adminProcedure.query(async () => {
      try { return await getAdminWithdrawals(); } catch (error) { return toDomainError(error); }
    }),
    updateWithdrawal: adminProcedure.input(z.object({ withdrawalId: z.number().int().positive(), status: z.enum(["processing", "paid", "rejected", "cancelled"]), transactionReference: z.string().trim().min(3).max(128).optional(), adminNote: z.string().trim().max(1_000).optional() })).mutation(async ({ ctx, input }) => {
      try { return await updateWithdrawalStatus({ ...input, adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    campaigns: adminProcedure.query(async () => {
      try { return await listCampaigns(); } catch (error) { return toDomainError(error); }
    }),
    createCampaign: adminProcedure.input(z.object({ title: z.string().trim().min(4).max(160), advertiser: z.string().trim().min(2).max(160), description: z.string().trim().max(2_000).optional(), mediaUrl: z.string().url().optional(), callToAction: z.string().trim().max(96).optional(), targetUrl: z.string().url().optional(), eligiblePackageId: z.number().int().positive().nullable().optional(), durationSeconds: z.number().int().min(5).max(900), rewardPaisa: moneyPaisa, budgetPaisa: moneyPaisa, maxImpressions: z.number().int().min(1), startAt: z.coerce.date(), endAt: z.coerce.date(), status: z.enum(["draft", "active", "paused"]).default("draft") })).mutation(async ({ ctx, input }) => {
      try { return await createCampaign(input, ctx.user.id); } catch (error) { return toDomainError(error); }
    }),
    updateCampaign: adminProcedure.input(z.object({ campaignId: z.number().int().positive(), title: z.string().trim().min(4).max(160), advertiser: z.string().trim().min(2).max(160), description: z.string().trim().max(2_000).optional(), mediaUrl: z.string().url().optional(), callToAction: z.string().trim().max(96).optional(), targetUrl: z.string().url().optional(), eligiblePackageId: z.number().int().positive().nullable().optional(), durationSeconds: z.number().int().min(5).max(900), rewardPaisa: moneyPaisa, budgetPaisa: moneyPaisa, maxImpressions: z.number().int().min(1), startAt: z.coerce.date(), endAt: z.coerce.date(), status: z.enum(["draft", "active", "paused"]) })).mutation(async ({ ctx, input }) => {
      try { return await updateCampaign({ ...input, adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    deleteCampaign: adminProcedure.input(z.object({ campaignId: z.number().int().positive() })).mutation(async ({ ctx, input }) => {
      try { return await deleteCampaign({ ...input, adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    users: adminProcedure.query(async () => {
      try { return await getAdminUsers(); } catch (error) { return toDomainError(error); }
    }),
    updateUserStatus: adminProcedure.input(z.object({ userId: z.number().int().positive(), accountStatus: z.enum(["active", "suspended", "review"]), reason: z.string().trim().max(1_000).optional() })).mutation(async ({ ctx, input }) => {
      try { return await updateUserAccountStatus({ ...input, adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    fraudFlags: adminProcedure.query(async () => {
      try { return await getAdminFraudFlags(); } catch (error) { return toDomainError(error); }
    }),
    flagUser: adminProcedure.input(z.object({ userId: z.number().int().positive(), severity: z.enum(["low", "medium", "high"]), reason: z.string().trim().min(5).max(1_000) })).mutation(async ({ ctx, input }) => {
      try { return await createFraudFlag({ ...input, adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    settings: adminProcedure.query(async () => {
      try { return await getAdminSettings(); } catch (error) { return toDomainError(error); }
    }),
    updateSetting: adminProcedure.input(z.object({ settingKey: z.string().trim().min(2).max(96), settingValue: z.string().trim().max(10_000) })).mutation(async ({ ctx, input }) => {
      try { return await updatePlatformSetting({ ...input, adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
    packages: adminProcedure.query(async () => {
      try { return await getAdminPackages(); } catch (error) { return toDomainError(error); }
    }),
    updatePackage: adminProcedure.input(z.object({ packageId: z.number().int().positive(), pricePaisa: moneyPaisa, rewardPerEligibleAdPaisa: moneyPaisa, dailyAdLimit: z.number().int().min(0).max(10_000), durationDays: z.number().int().positive().max(3_650), status: z.enum(["active", "inactive"]) })).mutation(async ({ ctx, input }) => {
      try { return await updatePackageRules({ ...input, adminUserId: ctx.user.id }); } catch (error) { return toDomainError(error); }
    }),
  }),
});

export type AppRouter = typeof appRouter;
