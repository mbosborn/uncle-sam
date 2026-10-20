import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { markFirstCheckins } from '../service/lib/work-trial.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}

test('First check-in (#7): a title with a shared first name counts for no one; their own registered series or address does', async () => {
  const now = Date.parse('2026-10-20T18:00:00Z');
  const mk = (id, name) => ({ pageId: `3f26ba36-8537-8000-8000-00000000000${id}`, fullName: name, email: `${id}@x.invalid`, fields: { 'Trial Start': '2026-10-20', 'Trial End': '2026-10-22', 'First check-in done': false } });
  const list = [mk(1, 'Rowan Blake'), mk(2, 'Rowan Rao ⭐')];
  const events = [{ id: 'ser1_20261020', recurringEventId: 'ser1', status: 'confirmed', summary: 'Rowan / Company: Morning Check-in', start: '2026-10-20T03:30:00Z', end: '2026-10-20T04:00:00Z', attendees: [] }];
  const run = async db => {
    const marked = [];
    const notion = { listTierCandidates: async () => list, setFirstCheckinDone: async a => { marked.push(a.pageId.slice(-1)); return { verified: true }; }, appendCandidateNote: async () => ({}) };
    await markFirstCheckins({ db, notion, calendar: { listEvents: async () => events }, clock: () => now, force: true });
    return marked;
  };
  assert.deepEqual(await run(d1()), [], 'two Rowans: the title alone is not enough');
  const db = d1();
  await noticeStore(db).put(`checkins:${list[0].pageId}`, { pageId: list[0].pageId, series: [{ kind: 'morning', eventId: 'ser1' }, { kind: 'night', eventId: 'ser2' }] }, now);
  assert.deepEqual(await run(db), ['1'], 'the series made for Rowan Blake');
});
