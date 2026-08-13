CREATE TABLE `adCampaigns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(160) NOT NULL,
	`advertiser` varchar(160) NOT NULL,
	`description` text,
	`mediaUrl` text,
	`durationSeconds` int NOT NULL,
	`rewardPaisa` int NOT NULL,
	`budgetPaisa` int NOT NULL,
	`rewardsDistributedPaisa` int NOT NULL DEFAULT 0,
	`maxImpressions` int NOT NULL,
	`completedViewsCount` int NOT NULL DEFAULT 0,
	`startAt` timestamp NOT NULL,
	`endAt` timestamp NOT NULL,
	`status` enum('draft','active','paused','complete','ended') NOT NULL DEFAULT 'draft',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `adCampaigns_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `adViews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionToken` varchar(96) NOT NULL,
	`userId` int NOT NULL,
	`campaignId` int NOT NULL,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`requiredSeconds` int NOT NULL,
	`rewardPaisa` int NOT NULL DEFAULT 0,
	`ipHash` varchar(128),
	`deviceHash` varchar(128),
	`status` enum('started','completed','rejected','expired') NOT NULL DEFAULT 'started',
	`rejectionReason` varchar(255),
	CONSTRAINT `adViews_id` PRIMARY KEY(`id`),
	CONSTRAINT `ad_views_session_unique` UNIQUE(`sessionToken`)
);
--> statement-breakpoint
CREATE TABLE `auditLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actorUserId` int,
	`action` varchar(120) NOT NULL,
	`entityType` varchar(64) NOT NULL,
	`entityId` int,
	`oldValue` json,
	`newValue` json,
	`ipHash` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `auditLogs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `fraudFlags` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`relatedEntityType` varchar(48),
	`relatedEntityId` int,
	`severity` enum('low','medium','high') NOT NULL DEFAULT 'low',
	`reason` text NOT NULL,
	`status` enum('open','reviewed','dismissed') NOT NULL DEFAULT 'open',
	`reviewedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`reviewedAt` timestamp,
	CONSTRAINT `fraudFlags_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ledgerEntries` (
	`id` int AUTO_INCREMENT NOT NULL,
	`transactionGroupId` varchar(64) NOT NULL,
	`userId` int NOT NULL,
	`transactionType` enum('package_payment','advertisement_reward','withdrawal_hold','withdrawal_payment','withdrawal_reversal','referral_reward','admin_adjustment') NOT NULL,
	`direction` enum('credit','debit','hold','release') NOT NULL,
	`amountPaisa` int NOT NULL,
	`previousAvailableBalancePaisa` int NOT NULL,
	`newAvailableBalancePaisa` int NOT NULL,
	`previousHeldBalancePaisa` int NOT NULL,
	`newHeldBalancePaisa` int NOT NULL,
	`relatedEntityType` varchar(48),
	`relatedEntityId` int,
	`description` text NOT NULL,
	`createdByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ledgerEntries_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`title` varchar(160) NOT NULL,
	`message` text NOT NULL,
	`type` enum('info','success','warning','security') NOT NULL DEFAULT 'info',
	`readAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `packages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(48) NOT NULL,
	`pricePaisa` int NOT NULL,
	`rewardPerEligibleAdPaisa` int NOT NULL,
	`dailyAdLimit` int NOT NULL,
	`durationDays` int NOT NULL,
	`features` json,
	`termsText` text,
	`status` enum('active','inactive') NOT NULL DEFAULT 'active',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `packages_id` PRIMARY KEY(`id`),
	CONSTRAINT `packages_name_unique` UNIQUE(`name`)
);
--> statement-breakpoint
CREATE TABLE `paymentProofs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`packageId` int NOT NULL,
	`paymentMethod` enum('jazzcash','easypaisa','bank_transfer') NOT NULL,
	`amountPaisa` int NOT NULL,
	`senderAccount` varchar(64) NOT NULL,
	`transactionId` varchar(128) NOT NULL,
	`screenshotKey` varchar(512),
	`screenshotUrl` varchar(512),
	`additionalNote` text,
	`status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
	`rejectionReason` text,
	`reviewedByUserId` int,
	`reviewedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `paymentProofs_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_proofs_transaction_unique` UNIQUE(`transactionId`)
);
--> statement-breakpoint
CREATE TABLE `platformSettings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`settingKey` varchar(96) NOT NULL,
	`settingValue` text NOT NULL,
	`isSensitive` boolean NOT NULL DEFAULT false,
	`updatedByUserId` int,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `platformSettings_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_settings_key_unique` UNIQUE(`settingKey`)
);
--> statement-breakpoint
CREATE TABLE `userPackages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`packageId` int NOT NULL,
	`paymentProofId` int,
	`startedAt` timestamp,
	`expiresAt` timestamp,
	`status` enum('pending','active','expired','cancelled') NOT NULL DEFAULT 'pending',
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `userPackages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`openId` varchar(64) NOT NULL,
	`name` text,
	`email` varchar(320),
	`phone` varchar(20),
	`loginMethod` varchar(64),
	`role` enum('user','admin') NOT NULL DEFAULT 'user',
	`accountStatus` enum('active','suspended','review') NOT NULL DEFAULT 'active',
	`referralCode` varchar(32),
	`referredByUserId` int,
	`lastKnownDeviceHash` varchar(128),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`lastSignedIn` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_openId_unique` UNIQUE(`openId`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`),
	CONSTRAINT `users_phone_unique` UNIQUE(`phone`),
	CONSTRAINT `users_referral_code_unique` UNIQUE(`referralCode`)
);
--> statement-breakpoint
CREATE TABLE `wallets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`availableBalancePaisa` int NOT NULL DEFAULT 0,
	`heldBalancePaisa` int NOT NULL DEFAULT 0,
	`lifetimeEarnedPaisa` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `wallets_id` PRIMARY KEY(`id`),
	CONSTRAINT `wallets_user_unique` UNIQUE(`userId`)
);
--> statement-breakpoint
CREATE TABLE `withdrawals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`amountPaisa` int NOT NULL,
	`feePaisa` int NOT NULL,
	`netAmountPaisa` int NOT NULL,
	`paymentMethod` enum('jazzcash','easypaisa') NOT NULL,
	`accountHolderName` varchar(160) NOT NULL,
	`accountNumber` varchar(32) NOT NULL,
	`status` enum('pending','processing','paid','rejected','cancelled') NOT NULL DEFAULT 'pending',
	`adminNote` text,
	`transactionReference` varchar(128),
	`processedByUserId` int,
	`processedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `withdrawals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `campaign_status_dates_idx` ON `adCampaigns` (`status`,`startAt`,`endAt`);--> statement-breakpoint
CREATE INDEX `ad_views_user_campaign_idx` ON `adViews` (`userId`,`campaignId`);--> statement-breakpoint
CREATE INDEX `ad_views_campaign_status_idx` ON `adViews` (`campaignId`,`status`);--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `auditLogs` (`entityType`,`entityId`);--> statement-breakpoint
CREATE INDEX `fraud_flags_status_created_idx` ON `fraudFlags` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ledger_entries_user_created_idx` ON `ledgerEntries` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `ledger_entries_group_idx` ON `ledgerEntries` (`transactionGroupId`);--> statement-breakpoint
CREATE INDEX `ledger_entries_type_idx` ON `ledgerEntries` (`transactionType`);--> statement-breakpoint
CREATE INDEX `notifications_user_read_idx` ON `notifications` (`userId`,`readAt`);--> statement-breakpoint
CREATE INDEX `payment_proofs_user_status_idx` ON `paymentProofs` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `payment_proofs_status_created_idx` ON `paymentProofs` (`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX `user_packages_user_status_idx` ON `userPackages` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `user_packages_package_idx` ON `userPackages` (`packageId`);--> statement-breakpoint
CREATE INDEX `users_referred_by_idx` ON `users` (`referredByUserId`);--> statement-breakpoint
CREATE INDEX `withdrawals_user_created_idx` ON `withdrawals` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `withdrawals_status_created_idx` ON `withdrawals` (`status`,`createdAt`);