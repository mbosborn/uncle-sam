import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, primaryKey } from "drizzle-orm/sqlite-core";

// Internal operational state. No public route should serialize these records.
export const uncleSamControl = sqliteTable("uncle_sam_control", {
  id: text("id").primaryKey().default("global"),
  mode: text("mode").notNull().default("Off"),
  baselineComplete: integer("baseline_complete", { mode: "boolean" }).notNull().default(false),
  version: integer("version").notNull().default(0),
  pauseGeneration: integer("pause_generation").notNull().default(0),
  activatedAt: integer("activated_at"),
  updatedAt: integer("updated_at").notNull(),
}, t => [check("control_singleton", sql`${t.id} = 'global'`),
  check("control_mode", sql`${t.mode} IN ('Off', 'Test', 'Live')`),
  check("control_baseline", sql`${t.baselineComplete} IN (0, 1)`)]);

export const uncleSamEvents = sqliteTable("uncle_sam_events", {
  eventId: text("event_id").primaryKey(),
  source: text("source").notNull(),
  occurredAt: integer("occurred_at").notNull(),
  observedAt: integer("observed_at").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull().default("Observed"),
  processedAt: integer("processed_at"),
  receiptJson: text("receipt_json"),
  notionWakePageId: text("notion_wake_page_id"),
  notionWakeAt: integer("notion_wake_at"),
  wakeState: text("wake_state").notNull().default("Pending"),
  wakeAttemptId: text("wake_attempt_id"),
  wakeError: text("wake_error"),
  isFixture: integer("is_fixture", { mode: "boolean" }).notNull().default(false),
  wakeControlVersion: integer("wake_control_version"),
  wakePauseGeneration: integer("wake_pause_generation"),
}, t => [index("events_status_observed").on(t.status, t.observedAt),
  check("event_status", sql`${t.status} IN ('Observed', 'Processed', 'Ignored', 'NeedsAttention')`),
  check("wake_state", sql`${t.wakeState} IN ('Pending', 'Sending', 'Complete', 'NeedsAttention')`),
  check("event_fixture", sql`${t.isFixture} IN (0, 1)`)]);

export const uncleSamRequests = sqliteTable("uncle_sam_requests", {
  requestKey: text("request_key").primaryKey(),
  candidateId: text("candidate_id").notNull(),
  occurrenceId: text("occurrence_id").notNull(),
  action: text("action").notNull(),
  recipientIdsJson: text("recipient_ids_json").notNull(),
  payloadJson: text("payload_json").notNull(),
  state: text("state").notNull().default("Pending"),
  isFixture: integer("is_fixture", { mode: "boolean" }).notNull().default(false),
  triggerAt: integer("trigger_at").notNull(),
  dueAt: integer("due_at").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  claimToken: text("claim_token"),
  claimMode: text("claim_mode"),
  claimControlVersion: integer("claim_control_version"),
  claimPauseGeneration: integer("claim_pause_generation"),
  claimedAt: integer("claimed_at"),
  completedAt: integer("completed_at"),
  receiptJson: text("receipt_json"),
  lastError: text("last_error"),
}, t => [index("requests_state_due").on(t.state, t.dueAt),
  index("requests_candidate_occurrence").on(t.candidateId, t.occurrenceId),
  check("request_state", sql`${t.state} IN ('Pending', 'Sending', 'Sent', 'Complete', 'Uncertain', 'NeedsAttention', 'Cancelled', 'Baselined', 'Simulated')`),
  check("request_fixture", sql`${t.isFixture} IN (0, 1)`)]);

export const uncleSamRequestEvents = sqliteTable("uncle_sam_request_events", {
  requestKey: text("request_key").notNull().references(() => uncleSamRequests.requestKey),
  eventId: text("event_id").notNull().references(() => uncleSamEvents.eventId),
  linkedAt: integer("linked_at").notNull(),
}, t => [primaryKey({ columns: [t.requestKey, t.eventId] })]);

// One candidate thread per configured ongoing conversation. A first-post
// reservation cannot expire into a duplicate thread after an uncertain send.
export const uncleSamCandidateThreads = sqliteTable("uncle_sam_candidate_threads", {
  candidateId: text("candidate_id").notNull(),
  routeKey: text("route_key").notNull(),
  channelId: text("channel_id").notNull(),
  ownerRequestKey: text("owner_request_key").notNull().references(() => uncleSamRequests.requestKey),
  threadTs: text("thread_ts"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, t => [primaryKey({ columns: [t.candidateId, t.routeKey] })]);

export const uncleSamActionHolds = sqliteTable("uncle_sam_action_holds", {
  holdKey: text("hold_key").primaryKey(),
  candidateId: text("candidate_id"),
  occurrenceId: text("occurrence_id"),
  action: text("action").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  reason: text("reason").notNull(),
  sourceEventId: text("source_event_id").notNull().references(() => uncleSamEvents.eventId),
  releaseEventId: text("release_event_id").references(() => uncleSamEvents.eventId),
  version: integer("version").notNull().default(1),
  lastChangeToken: text("last_change_token").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, t => [index("holds_action_active").on(t.action, t.active),
  check("hold_active", sql`${t.active} IN (0, 1)`)]);
