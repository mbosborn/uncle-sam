import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleMessage } from '../service/lib/interview-plan.mjs';

test('the morning post: Alexis\'s own chats are left out; an in-person panel with Robin and Interviewer lists her, "In person" instead of Meet (Project, Oct 19)', () => {
  const items = [
    { start: '2026-10-19T21:00:00Z', end: '2026-10-19T21:20:00Z', title: '20 Minute Chat between Alex Duffy and Alexis Bailey', meetUrl: 'https://meet.google.com/a', onCalendar: ['alexis'], takers: ['alexis'] },
    { start: '2026-10-20T00:00:00Z', end: '2026-10-20T01:00:00Z', candidate: { fullName: 'Hayden Ross', linkedin: 'https://www.linkedin.com/in/v' }, meetUrl: null, inPerson: true, onCalendar: ['interviewer'], takers: ['robin', 'interviewer', 'alexis'] },
    { start: '2026-10-19T17:00:00Z', end: '2026-10-19T17:30:00Z', candidate: { fullName: 'Skyler Dawson' }, meetUrl: 'https://meet.google.com/b', onCalendar: ['interviewer'], takers: ['interviewer'] }];
  const text = scheduleMessage(items, 'Mon 10/19');
  assert.doesNotMatch(text, /Alex Duffy/);
  assert.equal(text.match(/Hayden Ross> — In person/g).length, 1, 'once, under all three');
  assert.match(text, /<@U0A4F08721B> <@U0476A5BC82> <@U030A09DBFF>\n• \*5:00–6:00 PM\* — <https:\/\/www\.linkedin\.com\/in\/v\|Hayden Ross> — In person/);
  assert.match(text, /\*5:00–6:00 PM\* — <https:\/\/www\.linkedin\.com\/in\/v\|Hayden Ross> — In person/);
});

import { DatabaseSync } from 'node:sqlite';
import { runEmailReschedules, assignmentsReader } from '../service/lib/interview-plan.mjs';
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}

test('a move settled by email (Project, Oct 19: "we rescheduled to 5 to 6 in person") is kept on the interview; read again only on new mail', async () => {
  const db = d1(), NOW = Date.parse('2026-10-19T16:00:00Z');
  const event = { dedupe: 'v1@example.test', start: '2026-10-19T22:30:00Z', end: '2026-10-19T23:00:00Z', kind: 'Technical deep dive', onCalendar: ['interviewer'], takers: ['interviewer'],
    candidate: { fullName: 'Hayden Ross', email: 'tm.hayden.ms@example.test' } };
  const runner = { previewInterviews: async () => [event] };
  const mail = [{ id: 'm1', from: 'project@company.example', fromName: 'Project Owner', receivedAt: '2026-10-19T15:00:00Z', text: 'Hi Hayden, works for us. See you 5-6pm today in person at the office.' }];
  const gmail = { listInbox: async () => mail };
  let calls = 0;
  const claude = { complete: async () => { calls++; return { content: [{ type: 'tool_use', name: 'assign', input: { assignments: [{ event_index: 0, start: '17:00', end: '18:00', in_person: true, quote: 'See you 5-6pm today in person' }] } }] }; } };
  const out = await runEmailReschedules({ db, runner, gmail, claude, clock: () => NOW });
  assert.deepEqual([out.read, out.kept], [1, 1]);
  const kept = await assignmentsReader(db)('v1@example.test');
  assert.deepEqual([kept.start, kept.end, kept.inPerson, kept.ids], ['2026-10-20T00:00:00.000Z', '2026-10-20T01:00:00.000Z', true, []]);
  await runEmailReschedules({ db, runner, gmail, claude, clock: () => NOW + 31 * 60_000 });
  assert.equal(calls, 1, 'same thread, not read again');
});

import { categoryFromProfile } from '../service/lib/clay-pipelines.mjs';
test('US/EU role from the Clay profile; "unsure" leaves no Category (Project, Oct 19, on Casey Reed)', async () => {
  const result = { person: { name: 'Casey Reed', location_name: 'Providence, Rhode Island, United States', structured_location: { country_iso: 'US' }, headline: 'Software Engineering Intern',
    education: [{ school: 'Brown University', field: 'Computer Science' }], experiences: [{ title: 'Researcher', company: 'Brown University', description: 'multi-agent RL optimization' }] } };
  const says = input => ({ complete: async () => ({ content: [{ type: 'tool_use', name: 'place', input }] }) });
  assert.deepEqual(await categoryFromProfile({ claude: says({ category: 'ML/RL engineers', track: 'ML & RL Engineering', basis: 'US SWE intern; multi-agent RL at Brown' }), result }),
    { category: 'ML/RL engineers', track: 'ML & RL Engineering', basis: 'US SWE intern; multi-agent RL at Brown (from Clay; by Uncle Sam).' });
  assert.equal(await categoryFromProfile({ claude: says({ category: 'unsure', track: 'Scope to Confirm', basis: 'thin' }), result }), null);
  assert.equal(await categoryFromProfile({ claude: null, result }), null);
});
