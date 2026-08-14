CREATE INDEX `video_completions_user_idx` ON `videoCompletions` (`userId`);--> statement-breakpoint
ALTER TABLE `videoCompletions` DROP INDEX `video_completions_user_video_unique`;--> statement-breakpoint
ALTER TABLE `videoWatchSessions` MODIFY COLUMN `status` enum('started','interrupted','completed','eligible','claimed','rejected','expired') NOT NULL DEFAULT 'started';--> statement-breakpoint
UPDATE `videoWatchSessions` SET `status` = 'claimed' WHERE `status` = 'completed';--> statement-breakpoint
ALTER TABLE `videoWatchSessions` MODIFY COLUMN `status` enum('started','interrupted','eligible','claimed','rejected','expired') NOT NULL DEFAULT 'started';--> statement-breakpoint
ALTER TABLE `adCampaigns` ADD `callToAction` varchar(96);--> statement-breakpoint
ALTER TABLE `adCampaigns` ADD `targetUrl` text;--> statement-breakpoint
ALTER TABLE `adCampaigns` ADD `eligiblePackageId` int;--> statement-breakpoint
ALTER TABLE `rewardVideos` ADD `platform` enum('youtube','tiktok') DEFAULT 'youtube' NOT NULL;--> statement-breakpoint
ALTER TABLE `rewardVideos` ADD `dailyRewardLimit` int DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `videoCompletions` ADD `completedDay` date;--> statement-breakpoint
UPDATE `videoCompletions` SET `completedDay` = DATE(`completedAt`) WHERE `completedDay` IS NULL;--> statement-breakpoint
ALTER TABLE `videoCompletions` MODIFY COLUMN `completedDay` date NOT NULL;--> statement-breakpoint
ALTER TABLE `videoCompletions` ADD CONSTRAINT `video_completions_user_video_day_unique` UNIQUE(`userId`,`videoId`,`completedDay`);--> statement-breakpoint
ALTER TABLE `adCampaigns` ADD CONSTRAINT `adCampaigns_eligiblePackageId_packages_id_fk` FOREIGN KEY (`eligiblePackageId`) REFERENCES `packages`(`id`) ON DELETE set null ON UPDATE no action;
