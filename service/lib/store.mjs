/**
 * D1 repository. Routes must authenticate first, then createStore(db,{authorized:true}).
 * No network calls, secrets, automatic retries, migrations or delivery happen here.
 * Call authorizeDispatch immediately before an external action. A pause racing AFTER
 * that check cannot undo a network request; always reconcile/persist its real result.
 */
const MODES = new Set(['Off', 'Test', 'Live']);
const EVENT_STATES = new Set(['Processed', 'Ignored', 'NeedsAttention']);
const REQUEST_FIELDS = 'request_key, candidate_id, occurrence_id, action, recipient_ids_json, payload_json, state, is_fixture, trigger_at, due_at, created_at, updated_at, claim_token, claim_mode, claim_control_version, claim_pause_generation, claimed_at, completed_at, receipt_json, last_error';
const NO_HOLD = `NOT EXISTS (SELECT 1 FROM uncle_sam_action_holds h WHERE h.active = 1
  AND h.action = uncle_sam_requests.action
  AND (h.candidate_id IS NULL OR h.candidate_id = uncle_sam_requests.candidate_id)
  AND (h.occurrence_id IS NULL OR h.occurrence_id = uncle_sam_requests.occurrence_id))`;

// An authenticated edit/delete permanently invalidates reliance on that source.
// The join also handles an amendment arriving before the original or its request.
// It never rewrites a receipt for an action already delivered.
const CURRENT_SOURCES = `NOT EXISTS (
  SELECT 1 FROM uncle_sam_request_events link
  JOIN uncle_sam_events original ON original.event_id = link.event_id
  JOIN uncle_sam_events amendment ON amendment.source = original.source
    AND amendment.is_fixture = original.is_fixture
    AND json_extract(amendment.payload_json, '$.type') = 'source_amendment'
    AND json_extract(amendment.payload_json, '$.teamId') = json_extract(original.payload_json, '$.teamId')
    AND json_extract(amendment.payload_json, '$.appId') = json_extract(original.payload_json, '$.appId')
    AND json_extract(amendment.payload_json, '$.channelId') = json_extract(original.payload_json, '$.channelId')
    AND json_extract(amendment.payload_json, '$.targetMessageTs') = json_extract(original.payload_json, '$.messageTs')
  WHERE link.request_key = uncle_sam_requests.request_key
)`;

function required(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new TypeError(`${name} is required`);
  return value.trim();
}
function timestamp(value, name = 'timestamp') {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const ms = Date.parse(value);
    if (Number.isSafeInteger(ms) && ms >= 0) return ms;
  }
  throw new TypeError(`${name} must be epoch milliseconds or an explicit ISO datetime`);
}
function number(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a nonnegative integer`);
  return value;
}
function json(value, maxBytes = 131072) {
  const text = JSON.stringify(value ?? {});
  if (text === undefined || new TextEncoder().encode(text).length > maxBytes) throw new TypeError(`Payload exceeds ${maxBytes} bytes`);
  return text;
}
function control(row) {
  return row && { mode: row.mode, baselineComplete: row.baseline_complete === 1, version: row.version,
    pauseGeneration: row.pause_generation, activatedAt: row.activated_at, updatedAt: row.updated_at };
}
function request(row) {
  return row && { requestKey: row.request_key, candidateId: row.candidate_id, occurrenceId: row.occurrence_id,
    action: row.action, recipientIds: JSON.parse(row.recipient_ids_json), payload: JSON.parse(row.payload_json),
    state: row.state, isFixture: row.is_fixture === 1, triggerAt: row.trigger_at, dueAt: row.due_at,
    createdAt: row.created_at, updatedAt: row.updated_at, claimToken: row.claim_token, claimMode: row.claim_mode,
    claimControlVersion: row.claim_control_version, claimPauseGeneration: row.claim_pause_generation,
    claimedAt: row.claimed_at, completedAt: row.completed_at,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null, lastError: row.last_error };
}

function event(row) {
  if (!row) return null;
  const payload = JSON.parse(row.payload_json);
  return { ...payload, eventId: row.event_id, source: row.source, occurredAt: row.occurred_at,
    observedAt: row.observed_at, payload, status: row.status, processedAt: row.processed_at,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    notionWakePageId: row.notion_wake_page_id, notionWakeAt: row.notion_wake_at,
    wakeState: row.wake_state, wakeAttemptId: row.wake_attempt_id, wakeError: row.wake_error,
    isFixture: row.is_fixture === 1, wakeControlVersion: row.wake_control_version,
    wakePauseGeneration: row.wake_pause_generation };
}

function slackTime(value) {
  if (typeof value !== 'string' || !/^\d{1,13}\.\d{1,6}$/.test(value)) throw new TypeError('Invalid Slack messageTs');
  const [seconds, fractional] = value.split('.');
  return timestamp(Number(seconds) * 1000 + Number(fractional.padEnd(3, '0').slice(0, 3)), 'messageTs');
}

export function createStore(db, { authorized = false, clock = Date.now } = {}) {
  if (!db?.prepare || !db?.batch) throw new TypeError('A D1-compatible database is required');
  const access = () => { if (authorized !== true) throw new Error('Unauthorized'); };
  const now = () => timestamp(clock(), 'clock');
  const stmt = (sql, values = []) => db.prepare(sql).bind(...values);
  const first = (sql, values) => stmt(sql, values).first();
  const all = async (sql, values) => (await stmt(sql, values).all()).results;
  const initialize = async () => {
    access();
    await stmt("INSERT INTO uncle_sam_control (id, mode, baseline_complete, version, pause_generation, updated_at) VALUES ('global', 'Off', 0, 0, 0, ?) ON CONFLICT(id) DO NOTHING", [now()]).run();
  };
  const readControl = async () => control(await first("SELECT * FROM uncle_sam_control WHERE id = 'global'"));
  const readRequest = async key => request(await first(`SELECT ${REQUEST_FIELDS} FROM uncle_sam_requests WHERE request_key = ?`, [required(key, 'requestKey')]));

  return Object.freeze({
    getPublicStatus() { return { service: 'Uncle Sam', authenticated: false }; },
    async ensureControl() { await initialize(); return readControl(); },
    async getControl() { await initialize(); return readControl(); },

    async updateControl({ expectedVersion, mode, baselineComplete, activatedAt } = {}) {
      access(); await initialize();
      number(expectedVersion, 'expectedVersion');
      const before = await readControl();
      if (before.version !== expectedVersion) return { updated: false, reason: 'version_conflict', control: before };
      const nextMode = mode ?? before.mode;
      if (!MODES.has(nextMode)) throw new TypeError('Invalid mode');
      if (baselineComplete !== undefined && typeof baselineComplete !== 'boolean') throw new TypeError('baselineComplete must be boolean');
      const baseline = baselineComplete ?? before.baselineComplete;
      const activation = activatedAt === undefined ? before.activatedAt : activatedAt === null ? null : timestamp(activatedAt, 'activatedAt');
      if (nextMode === 'Live' && (!baseline || activation === null)) throw new Error('Live requires a completed baseline and activation time');
      if (before.activatedAt !== null && activation !== before.activatedAt) throw new Error('Activation boundary is immutable after it is established');
      const row = await first(`UPDATE uncle_sam_control SET mode = ?, baseline_complete = ?, activated_at = ?,
        version = version + 1, pause_generation = pause_generation + CASE WHEN ? != 'Live' OR ? = 0 THEN 1 ELSE 0 END,
        updated_at = ? WHERE id = 'global' AND version = ? RETURNING *`,
      [nextMode, +baseline, activation, nextMode, +baseline, now(), expectedVersion]);
      return row ? { updated: true, control: control(row) } : { updated: false, reason: 'version_conflict', control: await readControl() };
    },

    async recordEvent(input = {}) {
      access();
      const { eventId, messageTs, occurredAt } = input;
      if (input.isFixture !== undefined && typeof input.isFixture !== 'boolean') throw new TypeError('isFixture must be boolean');
      const payload = input.payload ?? input;
      const encoded = json(payload, 262144); // Bound the full event before any database operation.
      const values = [required(eventId, 'eventId'), required(input.source ?? 'slack', 'source'),
        messageTs !== undefined ? slackTime(messageTs) : timestamp(occurredAt, 'occurredAt'), now(), encoded, +(input.isFixture === true)];
      const row = await first(`INSERT INTO uncle_sam_events (event_id, source, occurred_at, observed_at, payload_json, is_fixture)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`, values);
      return { created: !!row, eventId: values[0] };
    },

    async getEvent(eventId) {
      access();
      const row = await first('SELECT * FROM uncle_sam_events WHERE event_id = ?', [required(eventId, 'eventId')]);
      return event(row);
    },

    async listUnprocessedEvents({ limit = 50 } = {}) {
      access(); number(limit, 'limit');
      return (await all(`SELECT * FROM uncle_sam_events WHERE status = 'Observed'
        ORDER BY observed_at, event_id LIMIT ?`, [Math.min(limit, 50)])).map(event);
    },

    /**
     * How many @-mention questions were put to the bot since a time, by one asker or (without authorId) by anyone. The question is
     * the stored event itself, so this is the log and the rate-limit counter at once; the question that is being handled counts.
     */
    async countQuestions({ authorId, since } = {}) {
      access();
      const from = timestamp(since, 'since');
      const row = authorId === undefined
        ? await first(`SELECT COUNT(*) AS n FROM uncle_sam_events WHERE source = 'slack'
            AND json_extract(payload_json, '$.type') = 'qa_question' AND observed_at >= ?`, [from])
        : await first(`SELECT COUNT(*) AS n FROM uncle_sam_events WHERE source = 'slack'
            AND json_extract(payload_json, '$.type') = 'qa_question' AND json_extract(payload_json, '$.authorId') = ?
            AND observed_at >= ?`, [required(authorId, 'authorId'), from]);
      return row?.n ?? 0;
    },

    /**
     * The latest question the bot answered in a thread (or, with threadTs null, anywhere in a direct message) since a time,
     * when that answer was a "which one did you mean" question that was posted: { eventId, options }. Otherwise null, so a
     * question that has since been answered, or a later reply, closes it.
     */
    async findOpenQuestion({ channelId, threadTs = null, since } = {}) {
      access();
      const from = timestamp(since, 'since');
      const params = [required(channelId, 'channelId'), from];
      const thread = threadTs === null ? '' : `AND coalesce(json_extract(payload_json, '$.threadTs'), json_extract(payload_json, '$.messageTs')) = ?`;
      if (threadTs !== null) params.splice(1, 0, required(threadTs, 'threadTs'));
      const row = await first(`SELECT * FROM uncle_sam_events WHERE source = 'slack' AND status = 'Processed'
        AND json_extract(payload_json, '$.channelId') = ? ${thread} AND processed_at >= ?
        AND json_extract(receipt_json, '$.outcome.kind') = 'qa_reply'
        ORDER BY processed_at DESC, event_id DESC LIMIT 1`, params);
      const found = event(row);
      const outcome = found?.receipt?.outcome;
      if (!outcome || outcome.replyKind !== 'clarified' || outcome.posted !== 'sent' || !Array.isArray(outcome.options) || outcome.options.length < 2) return null;
      return { eventId: found.eventId, options: outcome.options };
    },

    async listWakePendingEvents({ limit = 50 } = {}) {
      access(); number(limit, 'limit');
      return (await all(`SELECT * FROM uncle_sam_events WHERE status = 'Observed' AND notion_wake_page_id IS NULL AND wake_state = 'Pending'
        ORDER BY observed_at, event_id LIMIT ?`, [Math.min(limit, 50)])).map(event);
    },

    async claimEventWake({ eventId, attemptId } = {}) {
      access(); await initialize();
      const row = await first(`UPDATE uncle_sam_events SET wake_state = 'Sending', wake_attempt_id = ?,
        wake_control_version = (SELECT version FROM uncle_sam_control WHERE id = 'global'),
        wake_pause_generation = (SELECT pause_generation FROM uncle_sam_control WHERE id = 'global')
        WHERE event_id = ? AND status = 'Observed' AND notion_wake_page_id IS NULL AND wake_state = 'Pending'
        AND EXISTS (SELECT 1 FROM uncle_sam_control c WHERE c.id = 'global'
          AND ((c.mode = 'Test' AND uncle_sam_events.is_fixture = 1) OR (c.mode = 'Live' AND c.baseline_complete = 1
            AND c.activated_at IS NOT NULL AND uncle_sam_events.is_fixture = 0 AND uncle_sam_events.occurred_at >= c.activated_at)))
        RETURNING event_id`, [required(attemptId, 'attemptId'), required(eventId, 'eventId')]);
      return { claimed: !!row };
    },

    async authorizeEventWake({ eventId, attemptId } = {}) {
      access();
      const row = await first(`SELECT event_id FROM uncle_sam_events WHERE event_id = ? AND wake_attempt_id = ?
        AND wake_state = 'Sending' AND status = 'Observed' AND notion_wake_page_id IS NULL
        AND EXISTS (SELECT 1 FROM uncle_sam_control c WHERE c.id = 'global'
          AND c.version = uncle_sam_events.wake_control_version AND c.pause_generation = uncle_sam_events.wake_pause_generation
          AND ((c.mode = 'Test' AND uncle_sam_events.is_fixture = 1) OR (c.mode = 'Live' AND c.baseline_complete = 1
            AND c.activated_at IS NOT NULL AND uncle_sam_events.is_fixture = 0 AND uncle_sam_events.occurred_at >= c.activated_at)))`,
      [required(eventId, 'eventId'), required(attemptId, 'attemptId')]);
      return { allowed: !!row, reason: row ? null : 'wake_paused_stale_or_ineligible' };
    },

    async releaseEventWake({ eventId, attemptId, reason, preCreateFailure = false } = {}) {
      access();
      if (preCreateFailure !== true) throw new Error('Wake release requires a confirmed pre-create failure');
      const row = await first(`UPDATE uncle_sam_events SET wake_state = 'Pending', wake_attempt_id = NULL,
        wake_control_version = NULL, wake_pause_generation = NULL, wake_error = ?
        WHERE event_id = ? AND wake_attempt_id = ? AND wake_state = 'Sending' AND notion_wake_page_id IS NULL RETURNING event_id`,
      [required(reason, 'reason'), required(eventId, 'eventId'), required(attemptId, 'attemptId')]);
      return { updated: !!row };
    },

    async markWakeUncertain({ eventId, attemptId, reason } = {}) {
      access();
      const row = await first(`UPDATE uncle_sam_events SET wake_state = 'NeedsAttention', wake_error = ?
        WHERE event_id = ? AND wake_attempt_id = ? AND wake_state = 'Sending' RETURNING event_id`,
      [required(reason, 'reason'), required(eventId, 'eventId'), required(attemptId, 'attemptId')]);
      return { updated: !!row };
    },

    async markEventNotionWake({ eventId, pageId, attemptId } = {}) {
      access();
      const id = required(eventId, 'eventId');
      const page = required(pageId, 'pageId');
      const row = await first(`UPDATE uncle_sam_events SET notion_wake_page_id = ?, notion_wake_at = ?, wake_state = 'Complete'
        WHERE event_id = ? AND wake_attempt_id = ? AND notion_wake_page_id IS NULL
          AND wake_state IN ('Sending', 'NeedsAttention') RETURNING event_id`,
      [page, now(), id, required(attemptId, 'attemptId')]);
      const saved = await first('SELECT notion_wake_page_id FROM uncle_sam_events WHERE event_id = ?', [id]);
      return { updated: !!row, recorded: saved?.notion_wake_page_id === page };
    },

    async markEventProcessed({ eventId, receipt } = {}) {
      access();
      if (receipt === undefined || receipt === null) throw new TypeError('A processing receipt is required');
      const row = await first(`UPDATE uncle_sam_events SET status = 'Processed', processed_at = ?, receipt_json = ?
        WHERE event_id = ? AND status = 'Observed' RETURNING event_id`,
      [now(), json(receipt), required(eventId, 'eventId')]);
      return { updated: !!row };
    },

    async completeEvent({ eventId, status = 'Processed', receipt } = {}) {
      access(); if (!EVENT_STATES.has(status)) throw new TypeError('Invalid event completion state');
      const row = receipt === undefined
        ? await first(`UPDATE uncle_sam_events SET status = ?, processed_at = ?
            WHERE event_id = ? AND status = 'Observed' RETURNING event_id`, [status, now(), required(eventId, 'eventId')])
        : await first(`UPDATE uncle_sam_events SET status = ?, processed_at = ?, receipt_json = ?
            WHERE event_id = ? AND status = 'Observed' RETURNING event_id`, [status, now(), json(receipt), required(eventId, 'eventId')]);
      return { updated: !!row };
    },

    /** Closes a processing claim taken with claimEventWake once the event left the Observed state. */
    async finishEventWake({ eventId, attemptId } = {}) {
      access();
      const row = await first(`UPDATE uncle_sam_events SET wake_state = 'Complete'
        WHERE event_id = ? AND wake_attempt_id = ? AND wake_state = 'Sending' AND status <> 'Observed' RETURNING event_id`,
      [required(eventId, 'eventId'), required(attemptId, 'attemptId')]);
      return { updated: !!row };
    },

    /** Resolves a Slack thread to the candidate it was verified for (null when unbound). */
    async findCandidateThread({ channelId, threadTs } = {}) {
      access();
      const row = await first('SELECT * FROM uncle_sam_candidate_threads WHERE channel_id = ? AND thread_ts = ?',
        [required(channelId, 'channelId'), required(threadTs, 'threadTs')]);
      return row ? { candidateId: row.candidate_id, routeKey: row.route_key, channelId: row.channel_id,
        threadTs: row.thread_ts, ownerRequestKey: row.owner_request_key } : null;
    },

    async listRequestEvents(requestKey) {
      access();
      return (await all('SELECT event_id FROM uncle_sam_request_events WHERE request_key = ? ORDER BY linked_at, event_id',
        [required(requestKey, 'requestKey')])).map(row => row.event_id);
    },

    async listRequestsForCandidate({ candidateId, limit = 50 } = {}) {
      access(); number(limit, 'limit');
      const rows = await all(`SELECT ${REQUEST_FIELDS} FROM uncle_sam_requests WHERE candidate_id = ?
        ORDER BY created_at DESC LIMIT ?`, [required(candidateId, 'candidateId'), Math.min(limit, 100)]);
      return rows.map(request);
    },

    /** A verified human reply to a Sent request closes it as Complete and keeps the delivery receipt. */
    async recordRequestReply({ requestKey, reply } = {}) {
      access();
      if (!reply || typeof reply !== 'object') throw new TypeError('A reply receipt is required');
      const row = await first(`UPDATE uncle_sam_requests SET state = 'Complete',
        receipt_json = json_set(COALESCE(receipt_json, '{}'), '$.reply', json(?)), completed_at = ?, updated_at = ?
        WHERE request_key = ? AND state = 'Sent' RETURNING request_key`,
      [json(reply), now(), now(), required(requestKey, 'requestKey')]);
      return { updated: !!row };
    },

    async ensureRequest({ requestKey, candidateId, occurrenceId, action, recipientIds, payload,
      triggerAt, dueAt, isFixture = false, baselined = false, sourceEventId } = {}) {
      access();
      if (typeof isFixture !== 'boolean' || typeof baselined !== 'boolean') throw new TypeError('Fixture/baseline markers must be boolean');
      if (!Array.isArray(recipientIds) || recipientIds.length === 0) throw new TypeError('recipientIds required');
      const recipients = [...new Set(recipientIds.map(id => required(id, 'recipientId')))].sort();
      const key = required(requestKey, 'requestKey');
      const immutable = [required(candidateId, 'candidateId'), required(occurrenceId, 'occurrenceId'), required(action, 'action'), json(recipients)];
      const createdAt = now();
      const insert = stmt(`INSERT INTO uncle_sam_requests
        (request_key, candidate_id, occurrence_id, action, recipient_ids_json, payload_json, state, is_fixture,
         trigger_at, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_key) DO NOTHING RETURNING request_key`,
      [key, ...immutable, json(payload), baselined ? 'Baselined' : 'Pending', +isFixture,
        timestamp(triggerAt, 'triggerAt'), timestamp(dueAt ?? triggerAt, 'dueAt'), createdAt, createdAt]);
      let row;
      if (sourceEventId) {
        const batch = await db.batch([insert,
          stmt(`INSERT INTO uncle_sam_request_events (request_key, event_id, linked_at)
            SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM uncle_sam_requests WHERE request_key = ?
              AND candidate_id = ? AND occurrence_id = ? AND action = ? AND recipient_ids_json = ? AND is_fixture = ?)
            ON CONFLICT(request_key, event_id) DO NOTHING`,
          [key, required(sourceEventId, 'sourceEventId'), createdAt, key, ...immutable, +isFixture]),
        ]);
        row = batch[0].results?.[0];
      } else row = await insert.first();
      const saved = await readRequest(key);
      if (!saved || saved.candidateId !== immutable[0] || saved.occurrenceId !== immutable[1] ||
        saved.action !== immutable[2] || json(saved.recipientIds) !== immutable[3] || saved.isFixture !== isFixture) {
        throw new Error('Request key collision with a different immutable scope');
      }
      return { created: !!row, request: saved };
    },

    async linkEventToRequest({ requestKey, eventId } = {}) {
      access();
      await stmt(`INSERT INTO uncle_sam_request_events (request_key, event_id, linked_at)
        VALUES (?, ?, ?) ON CONFLICT(request_key, event_id) DO NOTHING`,
      [required(requestKey, 'requestKey'), required(eventId, 'eventId'), now()]).run();
      return { linked: true };
    },

    async getRequest(requestKey) { access(); return readRequest(requestKey); },

    async reserveCandidateThread({ requestKey, candidateId, routeKey, channelId } = {}) {
      access();
      const key = required(requestKey, 'requestKey'), candidate = required(candidateId, 'candidateId');
      const route = required(routeKey, 'routeKey'), channel = required(channelId, 'channelId');
      if (!/^[CDG][A-Z0-9]+$/.test(channel)) throw new TypeError('Invalid channel');
      await stmt("INSERT INTO uncle_sam_candidate_threads (candidate_id, route_key, channel_id, owner_request_key, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM uncle_sam_requests WHERE request_key = ? AND candidate_id = ? AND state IN ('Pending', 'Sending')) ON CONFLICT(candidate_id, route_key) DO NOTHING",
        [candidate, route, channel, key, now(), now(), key, candidate]).run();
      const saved = await first('SELECT * FROM uncle_sam_candidate_threads WHERE candidate_id = ? AND route_key = ?', [candidate, route]);
      if (!saved || saved.channel_id !== channel) return { verified: false, reason: 'thread_missing_or_route_changed' };
      if (saved.thread_ts === null && saved.owner_request_key !== key)
        return { verified: false, reason: 'first_thread_owned_by_another_request' };
      return { verified: true, candidateId: candidate, routeKey: route, channelId: channel,
        ownerRequestKey: saved.owner_request_key, threadTs: saved.thread_ts };
    },

    async saveCandidateThread({ requestKey, candidateId, routeKey, channelId, ownerRequestKey,
      previousThreadTs, threadTs, verified } = {}) {
      access();
      if (verified !== true || !/^\d{1,13}\.\d{1,6}$/.test(threadTs ?? ''))
        throw new TypeError('Verified Slack thread receipt required');
      const candidate = required(candidateId, 'candidateId'), route = required(routeKey, 'routeKey');
      const channel = required(channelId, 'channelId'), owner = required(ownerRequestKey, 'ownerRequestKey');
      const key = required(requestKey, 'requestKey');
      if (previousThreadTs !== null && previousThreadTs !== threadTs)
        return { verified: false, reason: 'cannot_replace_candidate_thread' };
      if (previousThreadTs === null && owner !== key) return { verified: false, reason: 'first_thread_owner_mismatch' };
      await stmt("UPDATE uncle_sam_candidate_threads SET thread_ts = ?, updated_at = ? WHERE candidate_id = ? AND route_key = ? AND channel_id = ? AND owner_request_key = ? AND thread_ts IS ? AND EXISTS (SELECT 1 FROM uncle_sam_requests WHERE request_key = ? AND candidate_id = ? AND state IN ('Sending', 'Uncertain'))",
        [threadTs, now(), candidate, route, channel, owner, previousThreadTs, key, candidate]).run();
      const saved = await first('SELECT * FROM uncle_sam_candidate_threads WHERE candidate_id = ? AND route_key = ?', [candidate, route]);
      return { verified: saved?.channel_id === channel && saved?.owner_request_key === owner && saved?.thread_ts === threadTs,
        threadTs: saved?.thread_ts ?? null };
    },

    /** Every request made for one occurrence and action, oldest first (who was already asked about an interview). */
    async listOccurrenceRequests({ occurrenceId, action } = {}) {
      access();
      const rows = await all(`SELECT ${REQUEST_FIELDS} FROM uncle_sam_requests WHERE occurrence_id = ? AND action = ? ORDER BY created_at LIMIT 10`,
        [required(occurrenceId, 'occurrenceId'), required(action, 'action')]);
      return rows.map(request);
    },

    async listPending({ limit = 50 } = {}) {
      access(); number(limit, 'limit');
      const rows = await all(`SELECT ${REQUEST_FIELDS} FROM uncle_sam_requests
        WHERE state = 'Pending' AND due_at <= ? ORDER BY due_at, created_at LIMIT ?`, [now(), Math.min(limit, 100)]);
      return rows.map(request);
    },

    async claimRequest({ requestKey, claimToken, expectedControlVersion, expectedPauseGeneration } = {}) {
      access(); await initialize();
      number(expectedControlVersion, 'expectedControlVersion'); number(expectedPauseGeneration, 'expectedPauseGeneration');
      const at = now();
      // One UPDATE is the reservation: no read-then-write claim or expiring lease.
      const row = await first(`UPDATE uncle_sam_requests SET state = 'Sending', claim_token = ?,
        claim_mode = (SELECT mode FROM uncle_sam_control WHERE id = 'global'),
        claim_control_version = ?, claim_pause_generation = ?, claimed_at = ?, updated_at = ?
        WHERE request_key = ? AND state = 'Pending' AND due_at <= ? AND ${NO_HOLD} AND ${CURRENT_SOURCES}
        AND EXISTS (SELECT 1 FROM uncle_sam_control c WHERE c.id = 'global' AND c.version = ? AND c.pause_generation = ?
          AND ((c.mode = 'Test' AND uncle_sam_requests.is_fixture = 1)
            OR (c.mode = 'Live' AND c.baseline_complete = 1 AND c.activated_at IS NOT NULL
              AND uncle_sam_requests.is_fixture = 0 AND uncle_sam_requests.trigger_at >= c.activated_at)))
        RETURNING *`, [required(claimToken, 'claimToken'), expectedControlVersion, expectedPauseGeneration,
        at, at, required(requestKey, 'requestKey'), at, expectedControlVersion, expectedPauseGeneration]);
      return row ? { claimed: true, request: request(row), dryRun: row.claim_mode === 'Test' }
        : { claimed: false, reason: 'not_claimable' };
    },

    async authorizeDispatch({ requestKey, claimToken } = {}) {
      access();
      const row = await first(`SELECT request_key FROM uncle_sam_requests
        WHERE request_key = ? AND claim_token = ? AND state = 'Sending' AND claim_mode = 'Live'
        AND is_fixture = 0 AND ${NO_HOLD} AND ${CURRENT_SOURCES}
        AND EXISTS (SELECT 1 FROM uncle_sam_control c WHERE c.id = 'global' AND c.mode = 'Live'
          AND c.baseline_complete = 1 AND c.activated_at IS NOT NULL AND uncle_sam_requests.trigger_at >= c.activated_at
          AND c.version = uncle_sam_requests.claim_control_version
          AND c.pause_generation = uncle_sam_requests.claim_pause_generation)`,
      [required(requestKey, 'requestKey'), required(claimToken, 'claimToken')]);
      return { allowed: !!row, reason: row ? null : 'claim_paused_stale_or_not_live' };
    },

    async completeRequest({ requestKey, claimToken, state = 'Sent', receipt } = {}) {
      access();
      if (!['Sent', 'Complete'].includes(state) || receipt?.verified !== true || !receipt.resultId) {
        throw new TypeError('Completion requires verified resultId and a Sent/Complete state');
      }
      const row = await first(`UPDATE uncle_sam_requests SET state = ?, receipt_json = ?, completed_at = ?, updated_at = ?
        WHERE request_key = ? AND claim_token = ? AND state IN ('Sending', 'Uncertain') AND claim_mode = 'Live'
        RETURNING request_key`, [state, json(receipt), now(), now(), required(requestKey, 'requestKey'), required(claimToken, 'claimToken')]);
      return { updated: !!row };
    },

    /**
     * A person clicked a button on this question, so Slack has it in their conversation: an Uncertain request becomes Sent
     * (Oct 16: questions whose readback failed turned every click away). Only the recipient's click, only from Uncertain.
     */
    async confirmDeliveredByClick({ requestKey, channelId, messageTs, threadTs = null, userId, text = null } = {}) {
      access();
      if (!/^[DCG][A-Z0-9]+$/.test(channelId ?? '') || !/^\d{1,13}\.\d{1,6}$/.test(messageTs ?? '') || !/^[UW][A-Z0-9]+$/.test(userId ?? '')) return { updated: false };
      const request = await readRequest(required(requestKey, 'requestKey'));
      if (!request || request.state !== 'Uncertain' || !(request.recipientIds ?? []).includes(userId)) return { updated: false };
      // The same fields a verified send stores: later steps link the source (messageUrl), redraw the buttons (text), time reminders (verifiedAt).
      const root = /^\d{1,13}\.\d{1,6}$/.test(threadTs ?? '') ? threadTs : messageTs;
      const receipt = { verified: true, resultId: `${channelId}:${messageTs}`, channelId, messageTs, threadTs: root, routeKey: request.payload?.routeKey ?? null,
        recipientIds: request.recipientIds, text: typeof text === 'string' && text.trim() ? text.slice(0, 4000) : null, verifiedAt: now(),
        messageUrl: `https://example-workspace.slack.com/archives/${channelId}/p${messageTs.replace('.', '').padEnd(messageTs.indexOf('.') + 6, '0')}`,
        confirmedBy: 'recipient_click', confirmedAt: now() };
      const row = await first(`UPDATE uncle_sam_requests SET state = 'Sent', receipt_json = ?, last_error = NULL, completed_at = ?, updated_at = ?
        WHERE request_key = ? AND state = 'Uncertain' RETURNING request_key`, [json(receipt), now(), now(), requestKey]);
      if (row) await stmt(`UPDATE uncle_sam_candidate_threads SET thread_ts = ?, updated_at = ? WHERE owner_request_key = ? AND thread_ts IS NULL`, [root, now(), requestKey]).run();
      return { updated: !!row };
    },

    async markSimulated({ requestKey, claimToken, result } = {}) {
      access();
      const row = await first(`UPDATE uncle_sam_requests SET state = 'Simulated', receipt_json = ?, completed_at = ?, updated_at = ?
        WHERE request_key = ? AND claim_token = ? AND state = 'Sending' AND claim_mode = 'Test' RETURNING request_key`,
      [json({ simulated: true, result }), now(), now(), required(requestKey, 'requestKey'), required(claimToken, 'claimToken')]);
      return { updated: !!row };
    },

    async markUncertain({ requestKey, claimToken, reason } = {}) {
      access();
      const row = await first(`UPDATE uncle_sam_requests SET state = 'Uncertain', last_error = ?, updated_at = ?
        WHERE request_key = ? AND claim_token = ? AND state = 'Sending' RETURNING request_key`,
      [required(reason, 'reason'), now(), required(requestKey, 'requestKey'), required(claimToken, 'claimToken')]);
      return { updated: !!row };
    },

    async cancelRequest({ requestKey, reason } = {}) {
      access();
      const row = await first(`UPDATE uncle_sam_requests SET state = 'Cancelled', last_error = ?, updated_at = ?
        WHERE request_key = ? AND state = 'Pending' RETURNING request_key`,
      [required(reason, 'reason'), now(), required(requestKey, 'requestKey')]);
      return { updated: !!row };
    },

    async setActionHold({ holdKey, candidateId = null, occurrenceId = null, action, reason, sourceEventId } = {}) {
      access(); await initialize();
      const key = required(holdKey, 'holdKey');
      const candidate = candidateId === null ? null : required(candidateId, 'candidateId');
      const occurrence = occurrenceId === null ? null : required(occurrenceId, 'occurrenceId');
      const changeToken = crypto.randomUUID();
      const at = now();
      await db.batch([
        stmt(`INSERT INTO uncle_sam_action_holds
          (hold_key, candidate_id, occurrence_id, action, active, reason, source_event_id, version, last_change_token, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?) ON CONFLICT(hold_key) DO UPDATE SET
          active = 1, reason = excluded.reason, source_event_id = excluded.source_event_id, release_event_id = NULL,
          version = uncle_sam_action_holds.version + 1, last_change_token = excluded.last_change_token, updated_at = excluded.updated_at
          WHERE uncle_sam_action_holds.candidate_id IS excluded.candidate_id
            AND uncle_sam_action_holds.occurrence_id IS excluded.occurrence_id AND uncle_sam_action_holds.action = excluded.action
            AND (uncle_sam_action_holds.active != 1 OR uncle_sam_action_holds.reason != excluded.reason
              OR uncle_sam_action_holds.source_event_id != excluded.source_event_id)`,
        [key, candidate, occurrence, required(action, 'action'), required(reason, 'reason'), required(sourceEventId, 'sourceEventId'), changeToken, at, at]),
        stmt(`UPDATE uncle_sam_control SET version = version + 1, pause_generation = pause_generation + 1, updated_at = ?
          WHERE id = 'global' AND EXISTS (SELECT 1 FROM uncle_sam_action_holds WHERE hold_key = ? AND last_change_token = ?)`, [at, key, changeToken]),
      ]);
      const saved = await first('SELECT * FROM uncle_sam_action_holds WHERE hold_key = ?', [key]);
      if (saved.candidate_id !== candidate || saved.occurrence_id !== occurrence || saved.action !== action.trim()) throw new Error('Hold key scope collision');
      return { changed: saved.last_change_token === changeToken, hold: saved, control: await readControl() };
    },

    async releaseActionHold({ holdKey, expectedVersion, sourceEventId } = {}) {
      access(); await initialize(); number(expectedVersion, 'expectedVersion');
      const key = required(holdKey, 'holdKey');
      const changeToken = crypto.randomUUID();
      const at = now();
      await db.batch([
        stmt(`UPDATE uncle_sam_action_holds SET active = 0, release_event_id = ?, version = version + 1,
          last_change_token = ?, updated_at = ? WHERE hold_key = ? AND active = 1 AND version = ?`,
        [required(sourceEventId, 'sourceEventId'), changeToken, at, key, expectedVersion]),
        stmt(`UPDATE uncle_sam_control SET version = version + 1, updated_at = ? WHERE id = 'global'
          AND EXISTS (SELECT 1 FROM uncle_sam_action_holds WHERE hold_key = ? AND last_change_token = ?)`, [at, key, changeToken]),
      ]);
      const saved = await first('SELECT * FROM uncle_sam_action_holds WHERE hold_key = ?', [key]);
      return { changed: saved?.last_change_token === changeToken, hold: saved, control: await readControl() };
    },

    async getStatus() {
      access(); await initialize();
      const counts = await all('SELECT state, COUNT(*) AS count FROM uncle_sam_requests GROUP BY state');
      return { control: await readControl(), requests: Object.fromEntries(counts.map(row => [row.state, row.count])) };
    },
  });
}
