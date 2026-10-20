import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { confirmUnclearSends, attemptTime } from '../service/lib/rejection-sender.mjs';
import { runStuckRejections } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const AT = '2026-10-16T18:00:00.000Z', T = Date.parse(AT);
const ENV = { UNCLE_SAM_REJECTION_SENDER: 'uncle-sam', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };

function world({ status = 'Sending', sent = [], outcome = 'Not Selected' } = {}) {
  const w = { db: d1(), writes: [], notes: [], searches: 0 };
  w.row = { candidate: { pageId: 'p1', fullName: 'Pat Fixture', email: 'pat@example.invalid', url: 'https://www.notion.so/p1', fields: { Outcome: outcome } },
    sender: { status, attempt: `p1|2026-10-15T18:00:00.000Z | uncle-sam tick-1 | ${AT}`, queuedTo: 'pat@example.invalid' } };
  w.notion = { readControl: async () => ({ mode: 'Live' }), listUnclearRejections: async () => (['Sending', 'Needs attention'].includes(w.row.sender.status) ? [structuredClone(w.row)] : []),
    writeRejection: async ({ fields }) => { w.writes.push(fields); if (fields.status) w.row.sender.status = fields.status; return {}; }, appendCandidateNote: async n => { w.notes.push(n.text); } };
  w.gmail = { canSearch: async () => true, searchSent: async () => { w.searches++; return sent; } };
  w.run = now => confirmUnclearSends({ env: ENV, db: w.db, notion: w.notion, gmail: w.gmail, clock: () => now });
  return w;
}

test('Unclear rejection sends: found in Sent mail -> recorded Sent, no message to Project', async () => {
  assert.equal(attemptTime(`k | uncle-sam tick-1 | ${AT}`), T);
  const w = world({ sent: [{ sentAt: '2026-10-16T18:00:05Z', url: 'https://mail.google.com/x' }] });
  assert.equal((await w.run(T + 10 * 60_000)).waiting, 1, 'too soon: the send may still be in flight');
  assert.equal(w.searches, 0);
  const out = await w.run(T + 16 * 60_000);
  assert.equal(out.confirmedSent, 1);
  assert.deepEqual({ ...w.writes[0], attempt: undefined }, { attempt: undefined, sentAt: '2026-10-16T18:00:05Z', messageUrl: 'https://mail.google.com/x', close: true, status: 'Sent' });
  assert.match(w.notes[0], /confirmed sent from Project's Sent mail/);
});

test('Unclear rejection sends: confirmed not sent -> Scheduled again; a second unclear send -> Project asked through the stuck notice', async () => {
  const w = world({ status: 'Needs attention' });
  await w.run(T + 16 * 60_000);
  assert.equal(w.writes.length, 0, 'one look is not enough');
  await w.run(T + 22 * 60_000);
  assert.equal(w.writes.length, 0, 'second look under 10 minutes after the first');
  const out = await w.run(T + 31 * 60_000);
  assert.equal(out.requeued, 1);
  assert.deepEqual(w.writes[0], { attempt: '', status: 'Scheduled' });
  assert.match(w.notes.at(-1), /queued again by Uncle Sam: .*checked twice, 10\+ minutes apart/);
  // The sender tries again and that is unclear too.
  const T2 = T + 3600_000;
  w.row.sender = { ...w.row.sender, status: 'Needs attention', attempt: `p1 | uncle-sam tick-2 | ${new Date(T2).toISOString()}` };
  await w.run(T2 + 16 * 60_000); await w.run(T2 + 27 * 60_000);
  assert.equal((await w.run(T2 + 31 * 60_000)).gaveUp, 1);
  assert.match(w.notes.at(-1), /could not confirm .* \(a second send was also unclear\)\. Project is asked\./);
  // Only now does the stuck-rejection notice reach Project.
  const posts = [];
  const stuck = await runStuckRejections({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only' }, db: w.db,
    notion: { readControl: async () => ({ mode: 'Live' }), listStuckRejections: async () => [structuredClone(w.row)] }, routeMap: { project: { channelId: 'D0MASON001' } },
    fetchImpl: async (url, init) => { posts.push(JSON.parse(init.body)); return Response.json({ ok: true, ts: '1.1' }); }, clock: () => T2 + 32 * 60_000 });
  assert.equal(stuck.notified, 1);
});

test('Unclear rejection sends: the stuck notice stays quiet while Sent mail can still settle it; an Outcome changed away cancels', async () => {
  const w = world({ status: 'Needs attention' });
  const posts = [];
  const stuck = await runStuckRejections({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only' }, db: w.db,
    notion: { readControl: async () => ({ mode: 'Live' }), listStuckRejections: async () => [structuredClone(w.row)] }, routeMap: { project: { channelId: 'D0MASON001' } },
    fetchImpl: async (url, init) => { posts.push(init); return Response.json({ ok: true, ts: '1.1' }); }, clock: () => T + 60_000 });
  assert.equal(stuck.notified, 0);
  assert.equal(posts.length, 0);
  const c = world({ outcome: 'On Hold' });
  await c.run(T + 16 * 60_000); await c.run(T + 31 * 60_000);
  assert.deepEqual(c.writes[0], { attempt: '', status: 'Cancelled' });
});
