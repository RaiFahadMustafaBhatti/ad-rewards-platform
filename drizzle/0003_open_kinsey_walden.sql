CREATE TABLE `rewardVideos` (
	`id` int AUTO_INCREMENT NOT NULL,
	`packageId` int NOT NULL,
	`title` varchar(180) NOT NULL,
	`youtubeUrl` varchar(512) NOT NULL,
	`youtubeVideoId` varchar(32) NOT NULL,
	`thumbnailUrl` varchar(512),
	`description` text,
	`rewardPaisa` int NOT NULL,
	`sortOrder` int NOT NULL DEFAULT 0,
	`status` enum('enabled','disabled') NOT NULL DEFAULT 'enabled',
	`createdByUserId` int,
	`updatedByUserId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `rewardVideos_id` PRIMARY KEY(`id`),
	CONSTRAINT `reward_videos_package_youtube_unique` UNIQUE(`packageId`,`youtubeVideoId`)
);
--> statement-breakpoint
CREATE TABLE `videoCompletions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`videoId` int NOT NULL,
	`watchSessionId` int NOT NULL,
	`rewardPaisa` int NOT NULL,
	`completedAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `videoCompletions_id` PRIMARY KEY(`id`),
	CONSTRAINT `video_completions_user_video_unique` UNIQUE(`userId`,`videoId`),
	CONSTRAINT `video_completions_session_unique` UNIQUE(`watchSessionId`)
);
--> statement-breakpoint
CREATE TABLE `videoWatchSessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sessionToken` varchar(96) NOT NULL,
	`userId` int NOT NULL,
	`videoId` int NOT NULL,
	`membershipId` int NOT NULL,
	`requiredDurationSeconds` int NOT NULL,
	`lastProgressSeconds` int NOT NULL DEFAULT 0,
	`maxProgressSeconds` int NOT NULL DEFAULT 0,
	`lastHeartbeatAt` timestamp,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`completedAt` timestamp,
	`status` enum('started','interrupted','completed','rejected','expired') NOT NULL DEFAULT 'started',
	`interruptionReason` varchar(255),
	`ipHash` varchar(128),
	`deviceHash` varchar(128),
	CONSTRAINT `videoWatchSessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `video_watch_sessions_token_unique` UNIQUE(`sessionToken`)
);
--> statement-breakpoint
ALTER TABLE `ledgerEntries` MODIFY COLUMN `transactionType` enum('package_payment','advertisement_reward','video_reward','withdrawal_hold','withdrawal_payment','withdrawal_reversal','referral_reward','admin_adjustment') NOT NULL;--> statement-breakpoint
ALTER TABLE `paymentProofs` ADD `screenshotFileName` varchar(160);--> statement-breakpoint
ALTER TABLE `paymentProofs` ADD `screenshotMimeType` varchar(80);--> statement-breakpoint
ALTER TABLE `paymentProofs` ADD `screenshotBytes` int;--> statement-breakpoint
ALTER TABLE `paymentProofs` ADD `attemptNumber` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `paymentProofs` ADD CONSTRAINT `payment_proofs_user_attempt_unique` UNIQUE(`userId`,`attemptNumber`);--> statement-breakpoint
ALTER TABLE `rewardVideos` ADD CONSTRAINT `rewardVideos_packageId_packages_id_fk` FOREIGN KEY (`packageId`) REFERENCES `packages`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rewardVideos` ADD CONSTRAINT `rewardVideos_createdByUserId_users_id_fk` FOREIGN KEY (`createdByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `rewardVideos` ADD CONSTRAINT `rewardVideos_updatedByUserId_users_id_fk` FOREIGN KEY (`updatedByUserId`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `videoCompletions` ADD CONSTRAINT `videoCompletions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `videoCompletions` ADD CONSTRAINT `videoCompletions_videoId_rewardVideos_id_fk` FOREIGN KEY (`videoId`) REFERENCES `rewardVideos`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `videoCompletions` ADD CONSTRAINT `videoCompletions_watchSessionId_videoWatchSessions_id_fk` FOREIGN KEY (`watchSessionId`) REFERENCES `videoWatchSessions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD CONSTRAINT `videoWatchSessions_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD CONSTRAINT `videoWatchSessions_videoId_rewardVideos_id_fk` FOREIGN KEY (`videoId`) REFERENCES `rewardVideos`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD CONSTRAINT `videoWatchSessions_membershipId_userPackages_id_fk` FOREIGN KEY (`membershipId`) REFERENCES `userPackages`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `reward_videos_package_status_order_idx` ON `rewardVideos` (`packageId`,`status`,`sortOrder`);--> statement-breakpoint
CREATE INDEX `video_watch_sessions_user_video_idx` ON `videoWatchSessions` (`userId`,`videoId`);--> statement-breakpoint
CREATE INDEX `video_watch_sessions_video_status_idx` ON `videoWatchSessions` (`videoId`,`status`);