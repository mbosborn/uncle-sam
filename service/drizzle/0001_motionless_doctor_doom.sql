PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_uncle_sam_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'Observed' NOT NULL,
	`processed_at` integer,
	`receipt_json` text,
	`notion_wake_page_id` text,
	`notion_wake_at` integer,
	`wake_state` text DEFAULT 'Pending' NOT NULL,
	`wake_attempt_id` text,
	`wake_error` text,
	`is_fixture` integer DEFAULT false NOT NULL,
	`wake_control_version` integer,
	`wake_pause_generation` integer,
	CONSTRAINT "event_status" CHECK("__new_uncle_sam_events"."status" IN ('Observed', 'Processed', 'Ignored', 'NeedsAttention')),
	CONSTRAINT "wake_state" CHECK("__new_uncle_sam_events"."wake_state" IN ('Pending', 'Sending', 'Complete', 'NeedsAttention')),
	CONSTRAINT "event_fixture" CHECK("__new_uncle_sam_events"."is_fixture" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_uncle_sam_events`("event_id", "source", "occurred_at", "observed_at", "payload_json", "status", "processed_at", "receipt_json", "notion_wake_page_id", "notion_wake_at", "wake_state", "wake_attempt_id", "wake_error", "is_fixture", "wake_control_version", "wake_pause_generation") SELECT "event_id", "source", "occurred_at", "observed_at", "payload_json", "status", "processed_at", "receipt_json", "notion_wake_page_id", "notion_wake_at", "wake_state", "wake_attempt_id", "wake_error", 0, NULL, NULL FROM `uncle_sam_events`;--> statement-breakpoint
DROP TABLE `uncle_sam_events`;--> statement-breakpoint
ALTER TABLE `__new_uncle_sam_events` RENAME TO `uncle_sam_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_status_observed` ON `uncle_sam_events` (`status`,`observed_at`);