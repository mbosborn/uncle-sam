/**
 * Work that stopped halfway (Project, 2026-10-16: "The two Notion updates from earlier got stuck mid-run ... add a sweeper ...
 * as long as it doesn't double-send the messages").
 *
 * A function that dies mid-run (time limit, crash, deploy) leaves a claim behind that nothing else will ever take:
 *   - an event claimed for processing (status Observed, wake_state Sending): the tick only runs events that are Pending;
 *   - a Slack message claimed for sending (request state Sending): the dispatcher only claims Pending requests.
 * This sweep runs once per tick. A claim is stale when the same claim is still held 15 minutes after the sweep first saw it
 * (functions stop at 300 seconds), so a run in progress is never touched.
 *
 * Never a double send:
 *   - An event is run again only once, and only when nothing it could have sent exists: no request was linked to it (every
 *     Slack message and email the runner sends is a request, keyed and claimed once), and it is not a typed Slack message
 *     or question, whose reply might have gone out directly. Otherwise it is closed as Needs attention and Project told once.
 *   - A message claimed for sending is never sent again: its result is unknown, so it becomes Uncertain (the state a failed
 *     readback leaves, which a recipient's button tap or reply settles) and Project is told once.
 * Also told once: an event whose processing was marked uncertain, and an event closed after its retries ran out.
 */
import { noticeStore } from './stuck-rejections.mjs';

export const STALE_MS = 15 * 60_000;
const PREFIX = 'stale:';
// Button and form events: what they do is keyed (requests, holds, Notion fields), never a direct reply.
const RETRYABLE_SLACK = new Set(['feedback_form', 'takehome_form', 'email_cancel', 'rejection_button', 'takehome_reject', 'source_amendment', 'noshow_choice']);
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** What an event was, in a few plain words for Project (no content beyond a short quote of his own team's message). */
export function describeEvent(row) {
  let payload = {};
  try { payload = JSON.parse(row.payload_json ?? '{}'); } catch { /* shape unknown */ }
  const type = payload.type ?? 'event';
  if (row.source === 'notion') return `a Notion change${payload.entityId || payload.pageId ? ` to page ${clean(payload.entityId ?? payload.pageId, 40)}` : ''}`;
  if (row.source === 'slack' && type === 'feedback_form') return 'an interviewer\'s feedback form';
  if (row.source === 'slack' && type === 'takehome_form') return 'Interviewer\'s take-home review form';
  if (row.source === 'slack' && type === 'packet_send') return 'your Send on a work-trial packet (check DocuSign before tapping again)';
  if (row.source === 'slack') return `a Slack ${type === 'qa_question' ? 'question' : 'message'}${payload.text ? `: “${clean(payload.text, 120)}”` : ''}`;
  return `a ${clean(row.source, 20)} ${clean(type, 40).replace(/_/g, ' ')}`;
}

export function retryable(row) {
  if (row.source !== 'slack') return true;
  let type = null;
  try { type = JSON.parse(row.payload_json ?? '{}').type ?? null; } catch { /* not retryable */ }
  return RETRYABLE_SLACK.has(type);
}

export async function runStaleSweep({ db, poster = null, clock = Date.now, log = () => {} } = {}) {
  const summary = { watched: 0, retried: 0, closed: 0, uncertain: 0, told: 0 };
  if (!db?.prepare) return { ...summary, error: 'database_missing' };
  const kv = noticeStore(db), now = clock();
  const tell = async (key, text) => {
    if (!poster || !(await kv.claim(`${PREFIX}told:${key}`, { at: now }, now))) return;
    try { await poster(text); summary.told++; } catch { /* told next time is worse than not at all: the mark stays */ }
  };
  // Is this claim the same one we saw before, and for how long?
  const stale = async (key, claim) => {
    const mark = await kv.get(`${PREFIX}${key}`);
    if (!mark || mark.claim !== claim) { await kv.put(`${PREFIX}${key}`, { claim, firstSeen: now, retries: mark?.retries ?? 0 }, now); summary.watched++; return null; }
    return now - mark.firstSeen >= STALE_MS ? mark : null;
  };

  // 1. Events claimed for processing and never finished.
  const { results: events = [] } = await db.prepare(`SELECT event_id, source, payload_json, wake_attempt_id FROM uncle_sam_events
    WHERE status = 'Observed' AND wake_state = 'Sending' ORDER BY observed_at LIMIT 20`).bind().all();
  for (const row of events) {
    const mark = await stale(`event:${row.event_id}`, row.wake_attempt_id ?? 'none');
    if (!mark) continue;
    const linked = (await db.prepare('SELECT COUNT(*) AS n FROM uncle_sam_request_events WHERE event_id = ?').bind(row.event_id).first())?.n ?? 0;
    if (!linked && !mark.retries && retryable(row)) {
      const released = await db.prepare(`UPDATE uncle_sam_events SET wake_state = 'Pending', wake_attempt_id = NULL, wake_control_version = NULL,
        wake_pause_generation = NULL, wake_error = 'stale_claim_swept' WHERE event_id = ? AND wake_attempt_id IS ? AND wake_state = 'Sending'
        AND status = 'Observed' RETURNING event_id`).bind(row.event_id, row.wake_attempt_id).first();
      if (released) { await kv.put(`${PREFIX}event:${row.event_id}`, { ...mark, retries: 1, retriedAt: now }, now); summary.retried++; log(`uncle_sam_stale retried=${row.event_id.slice(0, 60)}`); }
      continue;
    }
    const closed = await db.prepare(`UPDATE uncle_sam_events SET status = 'NeedsAttention', processed_at = ?, receipt_json = ?
      WHERE event_id = ? AND wake_attempt_id IS ? AND wake_state = 'Sending' AND status = 'Observed' RETURNING event_id`)
      .bind(now, JSON.stringify({ reason: 'stale_claim', linkedRequests: linked, retried: !!mark.retries, sweptAt: new Date(now).toISOString() }), row.event_id, row.wake_attempt_id).first();
    if (!closed) continue;
    summary.closed++;
    log(`uncle_sam_stale closed=${row.event_id.slice(0, 60)} linked=${linked}`);
    await tell(`event:${row.event_id}`, `🚨 Project, I need YOU on this one: I stopped partway through ${describeEvent(row)} and I will not run it again, so nothing goes out twice.${linked ? ' A message was already queued from it; check that thread.' : ''} If it still needs doing, tell me again in your own words. Ref ${clean(row.event_id, 80)}.`);
  }

  // 2. Events whose processing was marked uncertain, or closed after their retries ran out: told once, never silent.
  const { results: quiet = [] } = await db.prepare(`SELECT event_id, source, payload_json, wake_error FROM uncle_sam_events
    WHERE ((status = 'Observed' AND wake_state = 'NeedsAttention') OR (status = 'NeedsAttention' AND processed_at >= ?
      AND json_extract(receipt_json, '$.reason') <> 'stale_claim')) ORDER BY observed_at LIMIT 10`).bind(now - 2 * 86_400_000).all();
  for (const row of quiet) {
    await tell(`event:${row.event_id}`, `🚨 Project, I need YOU on this one: I could not finish ${describeEvent(row)}${row.wake_error ? ` (${clean(row.wake_error, 80)})` : ''}. I will not retry it on my own. If it still needs doing, tell me again in your own words. Ref ${clean(row.event_id, 80)}.`);
  }

  // 3. Slack messages claimed for sending and never settled: the result is unknown, so never sent again.
  const { results: sending = [] } = await db.prepare(`SELECT request_key, action, payload_json, claim_token FROM uncle_sam_requests
    WHERE state = 'Sending' AND claimed_at IS NOT NULL AND claimed_at <= ? LIMIT 20`).bind(now - 5 * 60_000).all();
  for (const row of sending) {
    if (!(await stale(`request:${row.request_key}`, row.claim_token ?? 'none'))) continue;
    const moved = await db.prepare(`UPDATE uncle_sam_requests SET state = 'Uncertain', last_error = 'stale_sending_swept', updated_at = ?
      WHERE request_key = ? AND state = 'Sending' AND claim_token IS ? RETURNING request_key`).bind(now, row.request_key, row.claim_token).first();
    if (!moved) continue;
    summary.uncertain++;
    let name = 'a candidate';
    try { name = clean(JSON.parse(row.payload_json).candidate?.fullName, 80) || name; } catch { /* keep the plain words */ }
    log(`uncle_sam_stale uncertain=${row.request_key.slice(-12)} action=${row.action}`);
    await tell(`request:${row.request_key}`, `🚨 Project, I need YOU on this one: my ${clean(row.action, 60).replace(/[._]/g, ' ')} about ${name} stopped mid-send. It may or may not have gone out, so I will not send it again. If the recipient taps its button or replies, I'll pick it up from there.`);
  }
  return summary;
}
