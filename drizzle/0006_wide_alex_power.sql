ALTER TABLE `videoWatchSessions` MODIFY COLUMN `status` enum('started','awaiting_return','duration_verified','code_verified','verification_locked','interrupted','eligible','claimed','rejected','expired') NOT NULL DEFAULT 'started';--> statement-breakpoint
ALTER TABLE `rewardVideos` ADD `verificationCodeHash` varchar(255);--> statement-breakpoint
ALTER TABLE `rewardVideos` ADD `verificationCodeUpdatedAt` timestamp;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD `externalOpenedAt` timestamp;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD `returnedAt` timestamp;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD `verificationStatus` enum('pending','passed','failed','locked') DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD `rewardStatus` enum('pending','claimed','not_eligible') DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD `verificationAttempts` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD `lastVerificationAt` timestamp;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD `verificationLockedAt` timestamp;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` ADD `suspiciousEventCount` int DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `video_watch_sessions_user_status_idx` ON `videoWatchSessions` (`userId`,`status`);
