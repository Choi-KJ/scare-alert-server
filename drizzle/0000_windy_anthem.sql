CREATE TABLE `confirmed_timestamps` (
	`id` int AUTO_INCREMENT NOT NULL,
	`platform_content_id` int NOT NULL,
	`at_seconds` double NOT NULL,
	`confidence` double NOT NULL DEFAULT 0,
	`report_count` int NOT NULL DEFAULT 0,
	`status` varchar(16) NOT NULL DEFAULT 'confirmed',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `confirmed_timestamps_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `movies` (
	`id` int AUTO_INCREMENT NOT NULL,
	`title` varchar(255) NOT NULL,
	`poster` varchar(512),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `movies_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `platform_contents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`movie_id` int,
	`platform` varchar(32) NOT NULL,
	`content_id` varchar(128) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `platform_contents_id` PRIMARY KEY(`id`),
	CONSTRAINT `platform_content_uq` UNIQUE(`platform`,`content_id`)
);
--> statement-breakpoint
CREATE TABLE `submissions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`platform_content_id` int NOT NULL,
	`at_seconds` double NOT NULL,
	`intensity` enum('mild','moderate','intense') NOT NULL DEFAULT 'moderate',
	`session_id` varchar(64) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `submissions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `confirmed_pc_idx` ON `confirmed_timestamps` (`platform_content_id`);--> statement-breakpoint
CREATE INDEX `submissions_pc_idx` ON `submissions` (`platform_content_id`);