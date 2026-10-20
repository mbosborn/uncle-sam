CREATE TABLE `uncle_sam_action_holds` (
	`hold_key` text PRIMARY KEY NOT NULL,
	`candidate_id` text,
	`occurrence_id` text,
	`action` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`reason` text NOT NULL,
	`source_event_id` text NOT NULL,
	`release_event_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`last_change_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_event_id`) REFERENCES `uncle_sam_events`(`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`release_event_id`) REFERENCES `uncle_sam_events`(`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "hold_active" CHECK("uncle_sam_action_holds"."active" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `holds_action_active` ON `uncle_sam_action_holds` (`action`,`active`);--> statement-breakpoint
CREATE TABLE `uncle_sam_control` (
	`id` text PRIMARY KEY DEFAULT 'global' NOT NULL,
	`mode` text DEFAULT 'Off' NOT NULL,
	`baseline_complete` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`pause_generation` integer DEFAULT 0 NOT NULL,
	`activated_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "control_singleton" CHECK("uncle_sam_control"."id" = 'global'),
	CONSTRAINT "control_mode" CHECK("uncle_sam_control"."mode" IN ('Off', 'Test', 'Live')),
	CONSTRAINT "control_baseline" CHECK("uncle_sam_control"."baseline_complete" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `uncle_sam_events` (
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
	CONSTRAINT "event_status" CHECK("uncle_sam_events"."status" IN ('Observed', 'Processed', 'Ignored', 'NeedsAttention')),
	CONSTRAINT "wake_state" CHECK("uncle_sam_events"."wake_state" IN ('Pending', 'Sending', 'Complete', 'NeedsAttention'))
);
--> statement-breakpoint
CREATE INDEX `events_status_observed` ON `uncle_sam_events` (`status`,`observed_at`);--> statement-breakpoint
CREATE TABLE `uncle_sam_request_events` (
	`request_key` text NOT NULL,
	`event_id` text NOT NULL,
	`linked_at` integer NOT NULL,
	PRIMARY KEY(`request_key`, `event_id`),
	FOREIGN KEY (`request_key`) REFERENCES `uncle_sam_requests`(`request_key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `uncle_sam_events`(`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `uncle_sam_requests` (
	`request_key` text PRIMARY KEY NOT NULL,
	`candidate_id` text NOT NULL,
	`occurrence_id` text NOT NULL,
	`action` text NOT NULL,
	`recipient_ids_json` text NOT NULL,
	`payload_json` text NOT NULL,
	`state` text DEFAULT 'Pending' NOT NULL,
	`is_fixture` integer DEFAULT false NOT NULL,
	`trigger_at` integer NOT NULL,
	`due_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`claim_token` text,
	`claim_mode` text,
	`claim_control_version` integer,
	`claim_pause_generation` integer,
	`claimed_at` integer,
	`completed_at` integer,
	`receipt_json` text,
	`last_error` text,
	CONSTRAINT "request_state" CHECK("uncle_sam_requests"."state" IN ('Pending', 'Sending', 'Sent', 'Complete', 'Uncertain', 'NeedsAttention', 'Cancelled', 'Baselined', 'Simulated')),
	CONSTRAINT "request_fixture" CHECK("uncle_sam_requests"."is_fixture" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `requests_state_due` ON `uncle_sam_requests` (`state`,`due_at`);--> statement-breakpoint
CREATE INDEX `requests_candidate_occurrence` ON `uncle_sam_requests` (`candidate_id`,`occurrence_id`);