import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { takeTickLease, releaseTickLease, TICK_LEASE_TTL_MS } from '../service/lib/tick-lease.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}

test('Tick lease: one tick at a time; released at the end; a dead tick blocks for at most the TTL', async () => {
  const db = d1(), now = 1_792_000_000_000;
  const a = await takeTickLease(db, { now });
  assert.ok(a);
  assert.equal(await takeTickLease(db, { now: now + 60_000 }), null, 'a second, overlapping tick steps aside');
  await releaseTickLease(db, 'someone-else');
  assert.equal(await takeTickLease(db, { now: now + 61_000 }), null, 'only the holder can let go');
  await releaseTickLease(db, a);
  const b = await takeTickLease(db, { now: now + 120_000 });
  assert.ok(b && b !== a, 'free again after release');
  assert.equal(await takeTickLease(db, { now: now + 120_000 + TICK_LEASE_TTL_MS - 1 }), null);
  assert.ok(await takeTickLease(db, { now: now + 120_000 + TICK_LEASE_TTL_MS }), 'a lease nobody released expires');
});
