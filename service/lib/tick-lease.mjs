/**
 * One tick at a time. Two overlapping ticks (a slow tick still running when the next cron fires, a retried cron, a manual
 * run) could each send the same DM before either recorded it. The lease is one row in uncle_sam_notices, taken with a single
 * atomic upsert that only succeeds when no unexpired lease exists; it is released when the tick ends. TTL > the 300 s limit.
 */
export const TICK_LEASE = 'tick:lease';
export const TICK_LEASE_TTL_MS = 6 * 60_000;

/** The lease token, or null when another tick holds an unexpired lease. */
export async function takeTickLease(db, { now = Date.now(), ttlMs = TICK_LEASE_TTL_MS, token = crypto.randomUUID(), name = TICK_LEASE } = {}) {
  if (!db?.prepare) return null;
  const row = await db.prepare(`INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE uncle_sam_notices.updated_at <= ?
    RETURNING value`).bind(name, JSON.stringify({ token, at: now }), now, now - ttlMs).first();
  if (!row) return null;
  try { return JSON.parse(row.value).token === token ? token : null; } catch { return null; }
}

/** Lets go of the lease, only if it is still ours. */
export async function releaseTickLease(db, token, name = TICK_LEASE) {
  if (!db?.prepare || !token) return;
  await db.prepare('DELETE FROM uncle_sam_notices WHERE name = ? AND value LIKE ?').bind(name, `%"token":"${token}"%`).run();
}

/**
 * The interview follow-ups (who is asked about which interview) run from both the 5-minute tick and the minute-by-minute
 * follow-up run. Two at once could each pick different people for the same interview (the Meet changed between their reads)
 * and both ask. So that one step runs under its own lease, shared by both; whichever finds it held skips this round.
 */
export const INTERVIEW_FOLLOWUPS_LEASE = 'interview-followups:lease';
/** `fn()` under the named lease: { value } when it ran, { skipped: 'in_progress' } when another run holds it. */
export async function withLease(db, name, fn, { ttlMs = TICK_LEASE_TTL_MS, now = Date.now() } = {}) {
  const token = await takeTickLease(db, { now, ttlMs, name });
  if (!token) return { skipped: 'in_progress' };
  try { return { value: await fn() }; } finally { await releaseTickLease(db, token, name).catch(() => {}); }
}

/** The minute-by-minute follow-up run's own lease (one at a time; it never waits on the 5-minute tick). */
export const FOLLOWUPS_LEASE = 'followups:lease';
export const FOLLOWUPS_LEASE_TTL_MS = 2 * 60_000;
