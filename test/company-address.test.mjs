import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { addressOptions, addressTaken, pickCompanyAddress, reserveAddress, sameName } from '../service/lib/company-address.mjs';
import { masonEmailText } from '../service/lib/onboarding.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-16T20:00:00Z');

test('options in order, and near-namesakes are different people', () => {
  assert.deepEqual(addressOptions('Arlen Archer (Zepto)'), ['arlen@company.example', 'arlen.archer@company.example', 'arlena@company.example', 'arlenarcher@company.example', 'arlen.archer2@company.example']);
  assert.ok(sameName('Arlen Archer', 'Arlen Archer (Zepto)'));
  assert.ok(!sameName('Aarlen Archer', 'Arlen Archer'));
});

test('first@ taken anywhere -> first.last@; every source counts; one unreadable source means nothing is called free', async () => {
  const db = d1();
  const owners = { 'arlen@company.example': [{ name: 'Aarlen Archer' }] };
  const checks = { directoryOwners: async a => owners[a] ?? [], slackMembers: async () => [{ id: 'U1', name: 'arlen.archer', realName: 'Old Arlen', deleted: true }], mail: async a => (a === 'arlena@company.example' ? 2 : 0) };
  const pick = await pickCompanyAddress({ fullName: 'Arlen Archer', pageId: 'p-arlen', db, checks });
  assert.equal(pick.address, 'arlenarcher@company.example');
  assert.deepEqual(pick.skipped.map(s => s.by), ['Aarlen Archer', 'Slack member Old Arlen (deactivated)', "someone you've emailed (2 sent messages to it)"]);
  const blind = await pickCompanyAddress({ fullName: 'Arlen Archer', pageId: 'p-arlen', db, checks: { ...checks, directoryOwners: async () => null } });
  assert.equal(blind.address, null);
  assert.equal(blind.unknown, "Company's directory could not be read");
  assert.match(masonEmailText({ name: 'Arlen Archer', email: 'a@x.com', start: '2026-10-19', now: NOW, pick }), /Create their Company email: arlenarcher@company\.example \(arlen@company\.example is taken: Aarlen Archer; .*\)\. Invite a@x\.com/);
});

test('an address held or used for one hire is never given to another, namesakes included', async () => {
  const db = d1();
  assert.ok(await reserveAddress({ db, address: 'reagan@company.example', pageId: 'p-prox', name: 'Reagan Turner (Proximal)', clock: () => NOW }));
  assert.ok(!(await reserveAddress({ db, address: 'reagan@company.example', pageId: 'p-merc', name: 'Reagan Turner (Mercor)', clock: () => NOW })));
  const clean = { directoryOwners: async () => [], slackMembers: async () => [], mail: async () => 0 };
  assert.equal((await addressTaken({ address: 'reagan@company.example', pageId: 'p-merc', db, checks: clean })).taken, true);
  assert.equal((await pickCompanyAddress({ fullName: 'Reagan Turner', pageId: 'p-merc', db, checks: clean })).address, 'reagan.turner@company.example');
  // Checking the hire's own new account: their own directory entry is theirs; someone else's is not.
  const own = { directoryOwners: async () => [{ name: 'Reagan Turner' }], slackMembers: async () => [] };
  assert.equal((await addressTaken({ address: 'reagan.turner@company.example', pageId: 'p-merc', db, checks: own, forName: 'Reagan Turner (Mercor)' })).taken, false);
  assert.equal((await addressTaken({ address: 'reagan.turner@company.example', pageId: 'p-merc', db, checks: { ...own, directoryOwners: async () => [{ name: 'Reagan Jaiswal' }] }, forName: 'Reagan Turner' })).taken, true);
});

test('an address made for this hire: their own Slack account on that address is theirs, whatever its display name (Rowan Blake, Oct 18)', async () => {
  const { addressTaken } = await import('../service/lib/company-address.mjs');
  const checks = { slackMembers: async () => [{ id: 'U1', name: 'rowanb', realName: '', email: 'rowand@company.example' }], directoryOwners: async () => [] };
  assert.equal((await addressTaken({ address: 'rowand@company.example', pageId: 'p', db: null, checks, forName: 'Rowan Blake' })).taken, false);
  assert.equal((await addressTaken({ address: 'rowand@company.example', pageId: 'p', db: null, checks })).taken, true, 'a new address someone already uses');
});
