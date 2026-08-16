import {
  boolean,
  date,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

/**
 * Core account backing Manus OAuth. The application deliberately keeps
 * authentication credentials outside the product database; the OAuth service
 * manages login credentials and this table stores product profile information.
 */
export const users = mysqlTable(
  "users",
  {
    id: int("id").autoincrement().primaryKey(),
    openId: varchar("openId", { length: 64 }).notNull().unique(),
    name: text("name"),
    email: varchar("email", { length: 320 }),
    phone: varchar("phone", { length: 20 }),
    loginMethod: varchar("loginMethod", { length: 64 }),
    role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
    accountStatus: mysqlEnum("accountStatus", ["active", "suspended", "review"])
      .default("active")
      .notNull(),
    referralCode: varchar("referralCode", { length: 32 }),
    referredByUserId: int("referredByUserId"),
    lastKnownDeviceHash: varchar("lastKnownDeviceHash", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
    lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_phone_unique").on(table.phone),
    uniqueIndex("users_referral_code_unique").on(table.referralCode),
    index("users_referred_by_idx").on(table.referredByUserId),
  ],
);

export const packages = mysqlTable(
  "packages",
  {
    id: int("id").autoincrement().primaryKey(),
    name: varchar("name", { length: 48 }).notNull(),
    pricePaisa: int("pricePaisa").notNull(),
    rewardPerEligibleAdPaisa: int("rewardPerEligibleAdPaisa").notNull(),
    dailyAdLimit: int("dailyAdLimit").notNull(),
    durationDays: int("durationDays").notNull(),
    features: json("features").$type<string[] | null>(),
    termsText: text("termsText"),
    status: mysqlEnum("status", ["active", "inactive"]).default("active").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("packages_name_unique").on(table.name)],
);

export const userPackages = mysqlTable(
  "userPackages",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    packageId: int("packageId").notNull().references(() => packages.id, { onDelete: "restrict" }),
    paymentProofId: int("paymentProofId"),
    startedAt: timestamp("startedAt"),
    expiresAt: timestamp("expiresAt"),
    status: mysqlEnum("status", ["pending", "active", "expired", "cancelled"])
      .default("pending")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("user_packages_user_status_idx").on(table.userId, table.status),
    index("user_packages_package_idx").on(table.packageId),
  ],
);

export const wallets = mysqlTable(
  "wallets",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    availableBalancePaisa: int("availableBalancePaisa").default(0).notNull(),
    heldBalancePaisa: int("heldBalancePaisa").default(0).notNull(),
    lifetimeEarnedPaisa: int("lifetimeEarnedPaisa").default(0).notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("wallets_user_unique").on(table.userId)],
);

export const adCampaigns = mysqlTable(
  "adCampaigns",
  {
    id: int("id").autoincrement().primaryKey(),
    title: varchar("title", { length: 160 }).notNull(),
    advertiser: varchar("advertiser", { length: 160 }).notNull(),
    description: text("description"),
    mediaUrl: text("mediaUrl"),
    callToAction: varchar("callToAction", { length: 96 }),
    targetUrl: text("targetUrl"),
    eligiblePackageId: int("eligiblePackageId").references(() => packages.id, { onDelete: "set null" }),
    durationSeconds: int("durationSeconds").notNull(),
    rewardPaisa: int("rewardPaisa").notNull(),
    budgetPaisa: int("budgetPaisa").notNull(),
    rewardsDistributedPaisa: int("rewardsDistributedPaisa").default(0).notNull(),
    maxImpressions: int("maxImpressions").notNull(),
    completedViewsCount: int("completedViewsCount").default(0).notNull(),
    startAt: timestamp("startAt").notNull(),
    endAt: timestamp("endAt").notNull(),
    status: mysqlEnum("status", ["draft", "active", "paused", "complete", "ended"])
      .default("draft")
      .notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("campaign_status_dates_idx").on(table.status, table.startAt, table.endAt),
  ],
);

export const adViews = mysqlTable(
  "adViews",
  {
    id: int("id").autoincrement().primaryKey(),
    sessionToken: varchar("sessionToken", { length: 96 }).notNull(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    campaignId: int("campaignId").notNull().references(() => adCampaigns.id, { onDelete: "restrict" }),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    completedAt: timestamp("completedAt"),
    requiredSeconds: int("requiredSeconds").notNull(),
    rewardPaisa: int("rewardPaisa").default(0).notNull(),
    ipHash: varchar("ipHash", { length: 128 }),
    deviceHash: varchar("deviceHash", { length: 128 }),
    status: mysqlEnum("status", ["started", "completed", "rejected", "expired"])
      .default("started")
      .notNull(),
    rejectionReason: varchar("rejectionReason", { length: 255 }),
  },
  table => [
    uniqueIndex("ad_views_session_unique").on(table.sessionToken),
    uniqueIndex("ad_views_user_campaign_unique").on(table.userId, table.campaignId),
    index("ad_views_user_campaign_idx").on(table.userId, table.campaignId),
    index("ad_views_campaign_status_idx").on(table.campaignId, table.status),
  ],
);

export const paymentProofs = mysqlTable(
  "paymentProofs",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    packageId: int("packageId").notNull().references(() => packages.id, { onDelete: "restrict" }),
    paymentMethod: mysqlEnum("paymentMethod", ["jazzcash", "easypaisa", "bank_transfer"])
      .notNull(),
    amountPaisa: int("amountPaisa").notNull(),
    senderAccount: varchar("senderAccount", { length: 64 }).notNull(),
    transactionId: varchar("transactionId", { length: 128 }).notNull(),
    screenshotKey: varchar("screenshotKey", { length: 512 }),
    screenshotUrl: varchar("screenshotUrl", { length: 512 }),
    screenshotFileName: varchar("screenshotFileName", { length: 160 }),
    screenshotMimeType: varchar("screenshotMimeType", { length: 80 }),
    screenshotBytes: int("screenshotBytes"),
    attemptNumber: int("attemptNumber").default(1).notNull(),
    additionalNote: text("additionalNote"),
    status: mysqlEnum("status", ["pending", "approved", "rejected"]).default("pending").notNull(),
    rejectionReason: text("rejectionReason"),
    reviewedByUserId: int("reviewedByUserId").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    uniqueIndex("payment_proofs_transaction_unique").on(table.transactionId),
    uniqueIndex("payment_proofs_user_attempt_unique").on(table.userId, table.attemptNumber),
    index("payment_proofs_user_status_idx").on(table.userId, table.status),
    index("payment_proofs_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const rewardVideos = mysqlTable(
  "rewardVideos",
  {
    id: int("id").autoincrement().primaryKey(),
    packageId: int("packageId").notNull().references(() => packages.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 180 }).notNull(),
    platform: mysqlEnum("platform", ["youtube", "tiktok"]).default("youtube").notNull(),
    youtubeUrl: varchar("youtubeUrl", { length: 512 }).notNull(),
    youtubeVideoId: varchar("youtubeVideoId", { length: 32 }).notNull(),
    thumbnailUrl: varchar("thumbnailUrl", { length: 512 }),
    description: text("description"),
    rewardPaisa: int("rewardPaisa").notNull(),
    requiredDurationSeconds: int("requiredDurationSeconds").default(10).notNull(),
    dailyRewardLimit: int("dailyRewardLimit").default(1).notNull(),
    verificationCodeHash: varchar("verificationCodeHash", { length: 255 }),
    verificationCodeUpdatedAt: timestamp("verificationCodeUpdatedAt"),
    sortOrder: int("sortOrder").default(0).notNull(),
    status: mysqlEnum("status", ["enabled", "disabled"]).default("enabled").notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id, { onDelete: "set null" }),
    updatedByUserId: int("updatedByUserId").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("reward_videos_package_status_order_idx").on(table.packageId, table.status, table.sortOrder),
    uniqueIndex("reward_videos_package_youtube_unique").on(table.packageId, table.youtubeVideoId),
  ],
);

export const videoWatchSessions = mysqlTable(
  "videoWatchSessions",
  {
    id: int("id").autoincrement().primaryKey(),
    sessionToken: varchar("sessionToken", { length: 96 }).notNull(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    videoId: int("videoId").notNull().references(() => rewardVideos.id, { onDelete: "restrict" }),
    membershipId: int("membershipId").notNull().references(() => userPackages.id, { onDelete: "restrict" }),
    requiredDurationSeconds: int("requiredDurationSeconds").notNull(),
    lastProgressSeconds: int("lastProgressSeconds").default(0).notNull(),
    maxProgressSeconds: int("maxProgressSeconds").default(0).notNull(),
    lastHeartbeatAt: timestamp("lastHeartbeatAt"),
    startedAt: timestamp("startedAt").defaultNow().notNull(),
    externalOpenedAt: timestamp("externalOpenedAt"),
    returnedAt: timestamp("returnedAt"),
    completedAt: timestamp("completedAt"),
    status: mysqlEnum("status", ["started", "awaiting_return", "duration_verified", "code_verified", "verification_locked", "interrupted", "eligible", "claimed", "rejected", "expired"]).default("started").notNull(),
    verificationStatus: mysqlEnum("verificationStatus", ["pending", "passed", "failed", "locked"]).default("pending").notNull(),
    rewardStatus: mysqlEnum("rewardStatus", ["pending", "claimed", "not_eligible"]).default("pending").notNull(),
    verificationAttempts: int("verificationAttempts").default(0).notNull(),
    lastVerificationAt: timestamp("lastVerificationAt"),
    verificationLockedAt: timestamp("verificationLockedAt"),
    suspiciousEventCount: int("suspiciousEventCount").default(0).notNull(),
    interruptionReason: varchar("interruptionReason", { length: 255 }),
    ipHash: varchar("ipHash", { length: 128 }),
    deviceHash: varchar("deviceHash", { length: 128 }),
  },
  table => [
    uniqueIndex("video_watch_sessions_token_unique").on(table.sessionToken),
    index("video_watch_sessions_user_video_idx").on(table.userId, table.videoId),
    index("video_watch_sessions_video_status_idx").on(table.videoId, table.status),
    index("video_watch_sessions_user_status_idx").on(table.userId, table.status),
  ],
);

export const videoCompletions = mysqlTable(
  "videoCompletions",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    videoId: int("videoId").notNull().references(() => rewardVideos.id, { onDelete: "restrict" }),
    watchSessionId: int("watchSessionId").notNull().references(() => videoWatchSessions.id, { onDelete: "restrict" }),
    rewardPaisa: int("rewardPaisa").notNull(),
    completedDay: date("completedDay").notNull(),
    completedAt: timestamp("completedAt").defaultNow().notNull(),
  },
  table => [
    index("video_completions_user_idx").on(table.userId),
    uniqueIndex("video_completions_user_video_day_unique").on(table.userId, table.videoId, table.completedDay),
    uniqueIndex("video_completions_session_unique").on(table.watchSessionId),
  ],
);

export const withdrawals = mysqlTable(
  "withdrawals",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    amountPaisa: int("amountPaisa").notNull(),
    feePaisa: int("feePaisa").notNull(),
    netAmountPaisa: int("netAmountPaisa").notNull(),
    paymentMethod: mysqlEnum("paymentMethod", ["jazzcash", "easypaisa"]).notNull(),
    accountHolderName: varchar("accountHolderName", { length: 160 }).notNull(),
    accountNumber: varchar("accountNumber", { length: 32 }).notNull(),
    status: mysqlEnum("status", ["pending", "processing", "paid", "rejected", "cancelled"])
      .default("pending")
      .notNull(),
    adminNote: text("adminNote"),
    transactionReference: varchar("transactionReference", { length: 128 }),
    processedByUserId: int("processedByUserId").references(() => users.id, { onDelete: "set null" }),
    processedAt: timestamp("processedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [
    index("withdrawals_user_created_idx").on(table.userId, table.createdAt),
    index("withdrawals_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const ledgerEntries = mysqlTable(
  "ledgerEntries",
  {
    id: int("id").autoincrement().primaryKey(),
    transactionGroupId: varchar("transactionGroupId", { length: 64 }).notNull(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    transactionType: mysqlEnum("transactionType", [
      "package_payment",
      "advertisement_reward",
      "video_reward",
      "withdrawal_hold",
      "withdrawal_payment",
      "withdrawal_reversal",
      "referral_reward",
      "admin_adjustment",
    ]).notNull(),
    direction: mysqlEnum("direction", ["credit", "debit", "hold", "release"]).notNull(),
    amountPaisa: int("amountPaisa").notNull(),
    previousAvailableBalancePaisa: int("previousAvailableBalancePaisa").notNull(),
    newAvailableBalancePaisa: int("newAvailableBalancePaisa").notNull(),
    previousHeldBalancePaisa: int("previousHeldBalancePaisa").notNull(),
    newHeldBalancePaisa: int("newHeldBalancePaisa").notNull(),
    relatedEntityType: varchar("relatedEntityType", { length: 48 }),
    relatedEntityId: int("relatedEntityId"),
    description: text("description").notNull(),
    createdByUserId: int("createdByUserId").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [
    index("ledger_entries_user_created_idx").on(table.userId, table.createdAt),
    index("ledger_entries_group_idx").on(table.transactionGroupId),
    index("ledger_entries_type_idx").on(table.transactionType),
  ],
);

export const notifications = mysqlTable(
  "notifications",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 160 }).notNull(),
    message: text("message").notNull(),
    type: mysqlEnum("type", ["info", "success", "warning", "security"]).default("info").notNull(),
    readAt: timestamp("readAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("notifications_user_read_idx").on(table.userId, table.readAt)],
);

export const fraudFlags = mysqlTable(
  "fraudFlags",
  {
    id: int("id").autoincrement().primaryKey(),
    userId: int("userId").notNull().references(() => users.id, { onDelete: "restrict" }),
    relatedEntityType: varchar("relatedEntityType", { length: 48 }),
    relatedEntityId: int("relatedEntityId"),
    severity: mysqlEnum("severity", ["low", "medium", "high"]).default("low").notNull(),
    reason: text("reason").notNull(),
    status: mysqlEnum("status", ["open", "reviewed", "dismissed"]).default("open").notNull(),
    reviewedByUserId: int("reviewedByUserId").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    reviewedAt: timestamp("reviewedAt"),
  },
  table => [index("fraud_flags_status_created_idx").on(table.status, table.createdAt)],
);

export const auditLogs = mysqlTable(
  "auditLogs",
  {
    id: int("id").autoincrement().primaryKey(),
    actorUserId: int("actorUserId").references(() => users.id, { onDelete: "set null" }),
    action: varchar("action", { length: 120 }).notNull(),
    entityType: varchar("entityType", { length: 64 }).notNull(),
    entityId: int("entityId"),
    oldValue: json("oldValue").$type<Record<string, unknown> | null>(),
    newValue: json("newValue").$type<Record<string, unknown> | null>(),
    ipHash: varchar("ipHash", { length: 128 }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  table => [index("audit_logs_entity_idx").on(table.entityType, table.entityId)],
);

export const platformSettings = mysqlTable(
  "platformSettings",
  {
    id: int("id").autoincrement().primaryKey(),
    settingKey: varchar("settingKey", { length: 96 }).notNull(),
    settingValue: text("settingValue").notNull(),
    isSensitive: boolean("isSensitive").default(false).notNull(),
    updatedByUserId: int("updatedByUserId").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  },
  table => [uniqueIndex("platform_settings_key_unique").on(table.settingKey)],
);

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
