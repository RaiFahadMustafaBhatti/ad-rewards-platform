// Pure TypeScript row types for the Firestore-backed data layer.
//
// These were previously Drizzle MySQL table definitions. During the Firebase
// migration the relational schema was replaced by Firestore collections, so
// this module now carries only the shared record shapes. Document IDs in
// Firestore are the decimal string form of the numeric `id` field, and
// Firestore Timestamps are converted to `Date` at the data-layer boundary,
// so every consumer keeps working with the same types as before.

export type UserRole = "user" | "admin";
export type AccountStatus = "active" | "suspended" | "review";

export interface User {
  id: number;
  openId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  loginMethod: string | null;
  /** Scrypt password hash for email+password members. Null for Google-only or admin accounts. Never sent to clients. */
  passwordHash: string | null;
  role: UserRole;
  accountStatus: AccountStatus;
  referralCode: string | null;
  referredByUserId: number | null;
  lastKnownDeviceHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSignedIn: Date;
}

export type InsertUser = { openId: string } & Partial<
  Omit<User, "id" | "openId" | "createdAt" | "updatedAt">
>;

export type PackageStatus = "active" | "inactive";

export interface Package {
  id: number;
  name: string;
  pricePaisa: number;
  rewardPerEligibleAdPaisa: number;
  dailyAdLimit: number;
  durationDays: number;
  features: string[] | null;
  termsText: string | null;
  status: PackageStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertPackage = Omit<Package, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<Package, "id" | "createdAt" | "updatedAt">>;

export type UserPackageStatus = "pending" | "active" | "expired" | "cancelled";

export interface UserPackage {
  id: number;
  userId: number;
  packageId: number;
  paymentProofId: number | null;
  startedAt: Date | null;
  expiresAt: Date | null;
  status: UserPackageStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertUserPackage = Omit<UserPackage, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<UserPackage, "id" | "createdAt" | "updatedAt">>;

export interface Wallet {
  id: number;
  userId: number;
  availableBalancePaisa: number;
  heldBalancePaisa: number;
  lifetimeEarnedPaisa: number;
  updatedAt: Date;
}

export type InsertWallet = Omit<Wallet, "id" | "updatedAt"> &
  Partial<Pick<Wallet, "id" | "updatedAt">>;

export type AdCampaignStatus = "draft" | "active" | "paused" | "complete" | "ended";

export interface AdCampaign {
  id: number;
  title: string;
  advertiser: string;
  description: string | null;
  mediaUrl: string | null;
  callToAction: string | null;
  targetUrl: string | null;
  eligiblePackageId: number | null;
  durationSeconds: number;
  rewardPaisa: number;
  budgetPaisa: number;
  rewardsDistributedPaisa: number;
  maxImpressions: number;
  completedViewsCount: number;
  startAt: Date;
  endAt: Date;
  status: AdCampaignStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertAdCampaign = Omit<
  AdCampaign,
  "id" | "createdAt" | "updatedAt" | "completedViewsCount" | "rewardsDistributedPaisa"
> &
  Partial<
    Pick<AdCampaign, "id" | "createdAt" | "updatedAt" | "completedViewsCount" | "rewardsDistributedPaisa">
  >;

export type AdViewStatus = "started" | "completed" | "rejected" | "expired";

export interface AdView {
  id: number;
  sessionToken: string;
  userId: number;
  campaignId: number;
  startedAt: Date;
  completedAt: Date | null;
  requiredSeconds: number;
  rewardPaisa: number;
  ipHash: string | null;
  deviceHash: string | null;
  status: AdViewStatus;
  rejectionReason: string | null;
}

export type InsertAdView = Omit<AdView, "id" | "startedAt"> &
  Partial<Pick<AdView, "id" | "startedAt">>;

export type PaymentMethod = "jazzcash" | "easypaisa" | "bank_transfer";
export type PaymentProofStatus = "pending" | "approved" | "rejected";

export interface PaymentProof {
  id: number;
  userId: number;
  packageId: number;
  paymentMethod: PaymentMethod;
  amountPaisa: number;
  senderAccount: string;
  transactionId: string;
  screenshotKey: string | null;
  screenshotUrl: string | null;
  screenshotFileName: string | null;
  screenshotMimeType: string | null;
  screenshotBytes: number | null;
  attemptNumber: number;
  additionalNote: string | null;
  status: PaymentProofStatus;
  rejectionReason: string | null;
  reviewedByUserId: number | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export type InsertPaymentProof = Omit<PaymentProof, "id" | "createdAt"> &
  Partial<Pick<PaymentProof, "id" | "createdAt">>;

export type VideoPlatform = "youtube" | "tiktok";
export type RewardVideoStatus = "enabled" | "disabled";

export interface RewardVideo {
  id: number;
  packageId: number;
  title: string;
  platform: VideoPlatform;
  youtubeUrl: string;
  youtubeVideoId: string;
  thumbnailUrl: string | null;
  description: string | null;
  rewardPaisa: number;
  requiredDurationSeconds: number;
  dailyRewardLimit: number;
  verificationCodeHash: string | null;
  verificationCodeUpdatedAt: Date | null;
  sortOrder: number;
  episodeNumber: number;
  status: RewardVideoStatus;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertRewardVideo = Omit<RewardVideo, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<RewardVideo, "id" | "createdAt" | "updatedAt">>;

export type VideoWatchSessionStatus =
  | "started"
  | "awaiting_return"
  | "duration_verified"
  | "code_verified"
  | "verification_locked"
  | "interrupted"
  | "eligible"
  | "claimed"
  | "rejected"
  | "expired";
export type VideoVerificationStatus = "pending" | "passed" | "failed" | "locked";
export type VideoRewardStatus = "pending" | "claimed" | "not_eligible";

export interface VideoWatchSession {
  id: number;
  sessionToken: string;
  userId: number;
  videoId: number;
  membershipId: number;
  requiredDurationSeconds: number;
  lastProgressSeconds: number;
  maxProgressSeconds: number;
  lastHeartbeatAt: Date | null;
  startedAt: Date;
  externalOpenedAt: Date | null;
  returnedAt: Date | null;
  completedAt: Date | null;
  status: VideoWatchSessionStatus;
  verificationStatus: VideoVerificationStatus;
  rewardStatus: VideoRewardStatus;
  verificationAttempts: number;
  lastVerificationAt: Date | null;
  verificationLockedAt: Date | null;
  suspiciousEventCount: number;
  interruptionReason: string | null;
  ipHash: string | null;
  deviceHash: string | null;
}

export type InsertVideoWatchSession = Omit<VideoWatchSession, "id" | "startedAt"> &
  Partial<Pick<VideoWatchSession, "id" | "startedAt">>;

export interface VideoCompletion {
  id: number;
  userId: number;
  videoId: number;
  episodeNumber: number;
  watchSessionId: number;
  rewardPaisa: number;
  completedDay: Date;
  completedAt: Date;
}

export type InsertVideoCompletion = Omit<VideoCompletion, "id" | "completedAt"> &
  Partial<Pick<VideoCompletion, "id" | "completedAt">>;

export type PayoutMethod = "jazzcash" | "easypaisa";
export type WithdrawalStatus = "pending" | "processing" | "paid" | "rejected" | "cancelled";

export interface Withdrawal {
  id: number;
  userId: number;
  amountPaisa: number;
  feePaisa: number;
  netAmountPaisa: number;
  paymentMethod: PayoutMethod;
  accountHolderName: string;
  accountNumber: string;
  status: WithdrawalStatus;
  adminNote: string | null;
  transactionReference: string | null;
  processedByUserId: number | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertWithdrawal = Omit<Withdrawal, "id" | "createdAt" | "updatedAt"> &
  Partial<Pick<Withdrawal, "id" | "createdAt" | "updatedAt">>;

export type LedgerTransactionType =
  | "package_payment"
  | "advertisement_reward"
  | "video_reward"
  | "withdrawal_hold"
  | "withdrawal_payment"
  | "withdrawal_reversal"
  | "referral_reward"
  | "admin_adjustment";
export type LedgerDirection = "credit" | "debit" | "hold" | "release";

export interface LedgerEntry {
  id: number;
  transactionGroupId: string;
  userId: number;
  transactionType: LedgerTransactionType;
  direction: LedgerDirection;
  amountPaisa: number;
  previousAvailableBalancePaisa: number;
  newAvailableBalancePaisa: number;
  previousHeldBalancePaisa: number;
  newHeldBalancePaisa: number;
  relatedEntityType: string | null;
  relatedEntityId: number | null;
  description: string;
  createdByUserId: number | null;
  createdAt: Date;
}

export type InsertLedgerEntry = Omit<LedgerEntry, "id" | "createdAt"> &
  Partial<Pick<LedgerEntry, "id" | "createdAt">>;

export type NotificationType = "info" | "success" | "warning" | "security";

export interface Notification {
  id: number;
  userId: number;
  title: string;
  message: string;
  type: NotificationType;
  readAt: Date | null;
  createdAt: Date;
}

export type InsertNotification = Omit<Notification, "id" | "createdAt"> &
  Partial<Pick<Notification, "id" | "createdAt">>;

export type FraudSeverity = "low" | "medium" | "high";
export type FraudFlagStatus = "open" | "reviewed" | "dismissed";

export interface FraudFlag {
  id: number;
  userId: number;
  relatedEntityType: string | null;
  relatedEntityId: number | null;
  severity: FraudSeverity;
  reason: string;
  status: FraudFlagStatus;
  reviewedByUserId: number | null;
  createdAt: Date;
  reviewedAt: Date | null;
}

export type InsertFraudFlag = Omit<FraudFlag, "id" | "createdAt"> &
  Partial<Pick<FraudFlag, "id" | "createdAt">>;

export interface AuditLog {
  id: number;
  actorUserId: number | null;
  action: string;
  entityType: string;
  entityId: number | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  ipHash: string | null;
  createdAt: Date;
}

export type InsertAuditLog = Omit<AuditLog, "id" | "createdAt"> &
  Partial<Pick<AuditLog, "id" | "createdAt">>;

export interface PlatformSetting {
  id: number;
  settingKey: string;
  settingValue: string;
  isSensitive: boolean;
  updatedByUserId: number | null;
  updatedAt: Date;
}

export type InsertPlatformSetting = Omit<PlatformSetting, "id" | "updatedAt"> &
  Partial<Pick<PlatformSetting, "id" | "updatedAt">>;

export interface PasswordReset {
  id: number;
  userId: number;
  /** SHA-256 hex of the reset token. The raw token only ever travels by email. */
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export type InsertPasswordReset = Omit<PasswordReset, "id" | "createdAt"> &
  Partial<Pick<PasswordReset, "id" | "createdAt">>;
