CREATE TABLE `uncle_sam_candidate_threads` (
	`candidate_id` text NOT NULL,
	`route_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`owner_request_key` text NOT NULL,
	`thread_ts` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`candidate_id`, `route_key`),
	FOREIGN KEY (`owner_request_key`) REFERENCES `uncle_sam_requests`(`request_key`) ON UPDATE no action ON DELETE no action
);
