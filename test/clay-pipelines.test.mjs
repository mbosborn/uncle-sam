import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runClayPipelines, placeOf, identityOf, samePerson, clayConfigured, clayPending, createClayClient } from '../service/lib/clay-pipelines.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const put = (db, name, value) => db.prepare('INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?)').bind(name, JSON.stringify(value), 0).run();
const get = async (db, name) => JSON.parse((await db.prepare('SELECT value FROM uncle_sam_notices WHERE name = ?').bind(name).first())?.value ?? 'null');
const T = Date.parse('2026-10-16T20:00:00Z');
const ENV = { CLAY_API_KEY: 'clay_fixture_key_0123456789', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
const DELHI = { 'Enrich person': { location_name: 'New Delhi, Delhi, India', structured_location: { country_iso: 'IN' } } };
const TORONTO = { location_name: 'Toronto, Ontario, Canada', structured_location: { country_iso: 'CA' } };

function fakeClay(answers) {
  const c = { started: [], runs: 0, ready: false };
  c.start = async items => { c.started.push(items); c.runs++; return `run_${c.runs}`; };
  c.results = async () => (c.ready ? new Map(Object.entries(answers(c.started.at(-1)))) : null);
  return c;
}
function fakeNotion(records) {
  const n = { set: [], notes: [], records };
  n.readControl = async () => ({ mode: 'Live' });
  n.listActiveCandidates = async () => [...records.values()].map(r => structuredClone(r));
  n.getCandidate = async id => structuredClone(records.get(id));
  n.setPipeline = async a => { n.set.push(a); const r = records.get(a.pageId); r.fields.Pipeline = a.pipeline; if (a.indiaStage !== undefined) r.fields['India Stage'] = a.indiaStage; };
  n.appendCandidateNote = async x => { n.notes.push(x); };
  return n;
}

test('Clay: where they are based -> pipeline; vague places are not guessed', () => {
  assert.deepEqual(placeOf(DELHI), { place: 'New Delhi, Delhi, India', pipeline: 'India' });
  assert.deepEqual(placeOf(JSON.stringify(TORONTO)), { place: 'Toronto, Ontario, Canada', pipeline: 'US/EU' });
  assert.deepEqual(placeOf({ location_name: 'Bengaluru, Karnataka' }), { place: 'Bengaluru, Karnataka', pipeline: 'India' });
  assert.equal(placeOf({ location_name: 'Greater Metro Area' }), null);
  assert.equal(placeOf({}), null);
  assert.equal(placeOf('{}'), null);
  assert.equal(clayConfigured({ CLAY_API_KEY: 'short' }), false);
  assert.equal(clayConfigured({ ...ENV, UNCLE_SAM_CLAY: 'off' }), false);
});

test('Clay: a new record with a LinkedIn and no pipeline is looked up once; the answer sets it with India Stage and a note', async () => {
  const db = d1();
  const records = new Map([
    ['p1', { pageId: 'p1', fullName: 'Asha Rao', email: 'a@x.com', createdTime: '2026-10-16T18:00:00Z', profile: { linkedin: 'https://www.linkedin.com/in/asharao' }, fields: { Stage: 'Intro Call', Outcome: 'Not Yet Decided' } }],
    ['p2', { pageId: 'p2', fullName: 'Old Person', email: 'o@x.com', createdTime: '2026-09-01T18:00:00Z', profile: { linkedin: 'https://www.linkedin.com/in/oldperson' }, fields: { Stage: 'Intro Call' } }],
    ['p3', { pageId: 'p3', fullName: 'No Link', email: 'n@x.com', createdTime: '2026-10-16T18:00:00Z', profile: {}, fields: { Stage: 'Intro Call' } }]]);
  const notion = fakeNotion(records);
  const clay = fakeClay(() => ({ s0: { status: 'complete', result: DELHI }, s1: { status: 'complete', result: {} } }));
  const r1 = await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T });
  assert.equal(r1.started, 2, 'LinkedIn when there is one, else the email');
  assert.deepEqual(clay.started[0].map(({ prevTries, ...i }) => i), [{ kind: 'record', pageId: 'p1', name: 'Asha Rao', by: 'linkedin', linkedin: 'https://www.linkedin.com/in/asharao', id: 's0' },
    { kind: 'record', pageId: 'p3', name: 'No Link', by: 'email', email: 'n@x.com', id: 's1' }]);
  assert.equal(await clayPending(db, 'p1'), true, 'the hourly check waits');
  await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T + 300_000 });
  assert.equal(clay.runs, 1, 'never started twice');
  clay.ready = true;
  const r3 = await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T + 600_000 });
  assert.equal(r3.set, 1);
  assert.deepEqual(notion.set[0], { pageId: 'p1', expectedEmail: 'a@x.com', pipeline: 'India', indiaStage: 'First Round' });
  assert.match(notion.notes[0].text, /^2026-10-16 · Pipeline set to India \(by Uncle Sam, from Clay: based in New Delhi, Delhi, India\)\.$/);
  assert.equal(await clayPending(db, 'p1'), false);
  await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T + 900_000 });
  assert.equal(clay.runs, 1, 'once per person, ever');
});

test('Clay: a held booking gets its pipeline before it is added; Clay replaces the page default but never Project\'s word', async () => {
  const db = d1();
  await put(db, 'booking-new:uid1', { heldAt: T, name: 'Casey Reed', email: 'l@x.com', linkedin: 'https://www.linkedin.com/in/sample-84422f0bf3b2', pipeline: 'India', pipelineBy: 'page', kind: 'santosh_interview', threadTs: '111.1' });
  await put(db, 'booking-new:uid2', { heldAt: T, name: 'Mia Chen', email: 'm@x.com', linkedin: 'https://www.linkedin.com/in/miachen', pipeline: 'India', pipelineBy: 'project', threadTs: '222.2' });
  const said = [];
  const poster = ts => async text => { said.push([ts, text]); };
  const notion = fakeNotion(new Map());
  const clay = fakeClay(items => Object.fromEntries(items.map(i => [i.id, { result: TORONTO }])));
  await runClayPipelines({ env: ENV, db, notion, clay, poster, clock: () => T });
  assert.deepEqual(clay.started[0].map(i => i.key), ['booking-new:uid1'], "Project's answer is not looked up");
  clay.ready = true;
  await runClayPipelines({ env: ENV, db, notion, clay, poster, clock: () => T + 300_000 });
  const casey = await get(db, 'booking-new:uid1');
  assert.equal(casey.pipeline, 'US/EU');
  assert.equal(casey.pipelineBy, 'clay');
  assert.deepEqual(said, [['111.1', '🫡 Clay: Casey Reed is based in Toronto, Ontario, Canada, so US/EU (not India). I add them with it.']]);
  assert.equal((await get(db, 'booking-new:uid2')).pipeline, 'India');
});

test('Clay: a booking already added is corrected on the record only while the pipeline is still the one Uncle Sam set', async () => {
  const db = d1();
  const records = new Map([['k1', { pageId: 'k1', fullName: 'Ravi Kumar', email: 'r@x.com', fields: { Stage: 'Interview', Outcome: 'Not Yet Decided', Pipeline: 'India', 'India Stage': 'First Round' } }],
    ['k2', { pageId: 'k2', fullName: 'Ana Lima', email: 'an@x.com', fields: { Stage: 'Intro Call', Outcome: 'Not Yet Decided', Pipeline: 'US/EU' } }]]);
  await put(db, 'booking-new:a', { heldAt: T, done: T, pageId: 'k1', name: 'Ravi Kumar', email: 'r@x.com', linkedin: 'https://www.linkedin.com/in/ravik', pipeline: 'India', pipelineBy: 'page', kind: 'santosh_interview', threadTs: '1.1' });
  await put(db, 'booking-new:b', { heldAt: T, done: T, pageId: 'k2', name: 'Ana Lima', email: 'an@x.com', linkedin: 'https://www.linkedin.com/in/analima', pipeline: null, kind: 'intro', threadTs: '2.2' });
  const notion = fakeNotion(records);
  const clay = fakeClay(items => Object.fromEntries(items.map(i => [i.id, { result: i.key === 'booking-new:a' ? TORONTO : DELHI }])));
  const said = [];
  await runClayPipelines({ env: ENV, db, notion, clay, poster: ts => async t => { said.push(t); }, clock: () => T });
  clay.ready = true;
  const r = await runClayPipelines({ env: ENV, db, notion, clay, poster: ts => async t => { said.push(t); }, clock: () => T + 300_000 });
  assert.deepEqual(notion.set, [{ pageId: 'k1', expectedEmail: 'r@x.com', pipeline: 'US/EU', replace: true, indiaStage: null }]);
  assert.equal(r.corrected, 1);
  assert.equal(records.get('k2').fields.Pipeline, 'US/EU', 'set by someone else after it was made: theirs stands');
  assert.deepEqual(said, ['🫡 Clay: Ravi Kumar is based in Toronto, Ontario, Canada, so US/EU (was India). Record updated.']);
});

test('Clay: a refused key is told once a day; the daily cap holds; off when not Live', async () => {
  const db = d1();
  const records = new Map([['p1', { pageId: 'p1', fullName: 'A B', email: 'a@x.com', createdTime: '2026-10-16T18:00:00Z', profile: { linkedin: 'linkedin.com/in/abcd' }, fields: {} }],
    ['p2', { pageId: 'p2', fullName: 'C D', email: 'c@x.com', createdTime: '2026-10-16T18:00:00Z', profile: { linkedin: 'linkedin.com/in/cdef' }, fields: {} }]]);
  const notion = fakeNotion(records);
  const said = [];
  const clay = { start: async () => { throw Object.assign(new Error('x'), { code: 'clay_http_401', reason: 'Invalid API key' }); }, results: async () => null };
  const r = await runClayPipelines({ env: { ...ENV, CLAY_DAILY_MAX: '1' }, db, notion, clay, poster: () => async t => { said.push(t); }, clock: () => T });
  assert.equal(r.error, 'clay_http_401');
  assert.match(said[0], /^🚨 Clay refused my lookup \(clay_http_401: Invalid API key\)\./);
  await runClayPipelines({ env: { ...ENV, CLAY_DAILY_MAX: '1' }, db, notion, clay, poster: () => async t => { said.push(t); }, clock: () => T + 300_000 });
  assert.equal(said.length, 1, 'told once, and paused for the day');
  assert.equal((await get(db, 'clay:p1')).tries, 0, 'a refused key is not a try');
  assert.equal((await get(db, 'clay:day:2026-10-16')).count, 0, 'nothing was looked up');
  notion.readControl = async () => ({ mode: 'Test' });
  assert.equal((await runClayPipelines({ env: ENV, db: d1(), notion, clay, clock: () => T })).state, 'not_live');
});

test('Clay client: the Public API calls, with the key in its header', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return url.endsWith('/run') ? new Response(JSON.stringify({ routine_run_id: 'rr1', status: 'in_progress' }), { status: 202 })
    : new Response(JSON.stringify({ status: 'complete', data: [{ id: 's0', status: 'complete', result: TORONTO }] }), { status: 200 }); };
  const client = createClayClient({ env: ENV, fetchImpl });
  assert.equal(await client.start([{ id: 's0', linkedin: 'https://www.linkedin.com/in/x1y' }]), 'rr1');
  assert.equal(calls[0].url, 'https://api.clay.com/public/v0/routines/function%3At_0tl2hpydaph4xhA64aF/run');
  assert.equal(calls[0].init.headers['clay-api-key'], ENV.CLAY_API_KEY);
  assert.deepEqual(JSON.parse(calls[0].init.body), { items: [{ id: 's0', inputs: { 'Professional Profile URL': 'https://www.linkedin.com/in/x1y' } }] });
  const results = await client.results('rr1');
  assert.deepEqual(placeOf(results.get('s0').result), { place: 'Toronto, Ontario, Canada', pipeline: 'US/EU' });
});

test('Clay: an email lookup counts only for the same person; it fills LinkedIn and From and is not followed by a LinkedIn lookup', async () => {
  const db = d1();
  const records = new Map([
    ['e1', { pageId: 'e1', fullName: 'Priya Nair', email: 'priya@example.test', createdTime: '2026-10-16T18:00:00Z', profile: {}, fields: { Stage: 'Intro Call' } }],
    ['e2', { pageId: 'e2', fullName: 'Tom Hale', email: 'shared@team.io', createdTime: '2026-10-16T18:00:00Z', profile: {}, fields: { Stage: 'Intro Call' } }]]);
  const notion = fakeNotion(records);
  notion.filled = [];
  notion.fillProfile = async a => { notion.filled.push(a); const r = records.get(a.pageId); if (a.linkedin) r.profile.linkedin = a.linkedin; return { changed: ['LinkedIn'] }; };
  const clay = fakeClay(() => ({ s0: { result: { name: 'Priya Nair', url: 'https://www.linkedin.com/in/priyanair', latest_experience_company: 'Mercor', location_name: 'Pune, Maharashtra, India', structured_location: { country_iso: 'IN' } } },
    s1: { result: { name: 'Someone Else', url: 'https://www.linkedin.com/in/someoneelse', location_name: 'Austin, Texas', structured_location: { country_iso: 'US' } } } }));
  await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T });
  clay.ready = true;
  const r = await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T + 300_000 });
  assert.equal(r.set, 1);
  assert.deepEqual(notion.filled, [{ pageId: 'e1', expectedEmail: 'priya@example.test', linkedin: 'https://www.linkedin.com/in/priyanair', from: 'Mercor' }]);
  assert.equal(records.get('e2').fields.Pipeline, undefined, 'a different name on that email: nothing used');
  await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T + 600_000 });
  assert.equal(clay.runs, 1, 'Priya found by email is not looked up again; Tom has no LinkedIn');
  records.get('e2').profile.linkedin = 'https://www.linkedin.com/in/tomhale';
  await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T + 900_000 });
  assert.deepEqual(clay.started[1].map(i => [i.pageId, i.by]), [['e2', 'linkedin']], 'a LinkedIn added later gets one lookup');
});

test('Clay: a moment\'s refusal is tried again next tick, at most 3 times; Company and test records are never looked up', async () => {
  const db = d1();
  const records = new Map([['r1', { pageId: 'r1', fullName: 'Lee Park', email: 'lee@x.com', createdTime: '2026-10-16T18:00:00Z', profile: { linkedin: 'https://www.linkedin.com/in/leepark' }, fields: {} }],
    ['r2', { pageId: 'r2', fullName: 'Staff Person', email: 'a@company.example', createdTime: '2026-10-16T18:00:00Z', profile: {}, fields: {} }],
    ['r3', { pageId: 'r3', fullName: '[FIXTURE] Test', email: 't@x.com', createdTime: '2026-10-16T18:00:00Z', profile: { linkedin: 'https://www.linkedin.com/in/fixture' }, fields: {} }]]);
  const notion = fakeNotion(records);
  let calls = 0;
  const clay = { start: async items => { calls++; assert.deepEqual(items.map(i => i.pageId), ['r1']); throw Object.assign(new Error('x'), { code: 'clay_http_429' }); }, results: async () => null };
  for (let i = 0; i < 5; i++) await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T + i * 300_000 });
  assert.equal(calls, 3);
  assert.equal(await clayPending(db, 'r1'), false, 'the hourly check may ask Project');
});

test('Clay: a booking whose record exists is looked up once, as the booking; a booking found by email keeps the LinkedIn for its record', async () => {
  const db = d1();
  await put(db, 'booking-new:z', { heldAt: T, name: 'Nina Roy', email: 'nina@corp.com', linkedin: null, pipeline: null, kind: 'intro', threadTs: '9.9' });
  await put(db, 'booking-new:y', { heldAt: T, done: T, pageId: 'q1', name: 'Omar Ali', email: 'omar@x.com', linkedin: 'https://www.linkedin.com/in/omarali', pipeline: null, kind: 'intro', threadTs: '8.8' });
  const records = new Map([['q1', { pageId: 'q1', fullName: 'Omar Ali', email: 'omar@x.com', createdTime: '2026-10-16T18:00:00Z', profile: { linkedin: 'https://www.linkedin.com/in/omarali' }, fields: { Stage: 'Intro Call', Outcome: 'Not Yet Decided' } }]]);
  const notion = fakeNotion(records);
  const clay = fakeClay(items => Object.fromEntries(items.map(i => [i.id, { result: i.key === 'booking-new:z' ? { name: 'Nina Roy', url: 'https://www.linkedin.com/in/ninaroy', location_name: 'Berlin, Germany', structured_location: { country_iso: 'DE' } } : TORONTO }])));
  await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T });
  assert.deepEqual(clay.started[0].map(i => [i.key ?? i.pageId, i.by]).sort(), [['booking-new:y', 'linkedin'], ['booking-new:z', 'email']]);
  clay.ready = true;
  await runClayPipelines({ env: ENV, db, notion, clay, poster: () => async () => {}, clock: () => T + 300_000 });
  const nina = await get(db, 'booking-new:z');
  assert.equal(nina.linkedin, 'https://www.linkedin.com/in/ninaroy');
  assert.equal(nina.pipeline, 'US/EU');
  assert.equal(records.get('q1').fields.Pipeline, 'US/EU');
  await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T + 600_000 });
  assert.equal(clay.runs, 1);
});

test('Clay: results in other wrappers still read', () => {
  assert.deepEqual(placeOf({ data: JSON.stringify({ person: { location_name: 'London, England, United Kingdom', structured_location: { country_iso: 'GB' } } }) }), { place: 'London, England, United Kingdom', pipeline: 'US/EU' });
  assert.equal(identityOf({ 'Enrich person': { name: 'A B', url: 'linkedin.com/in/abcd' } }).linkedin, 'https://www.linkedin.com/in/abcd');
  assert.equal(samePerson('Dylan Hayes (Mercor)', { name: 'Dylan S.' }), true);
  assert.equal(samePerson('Dylan Hayes', { name: 'Rahul Verma' }), false);
});

test('Clay: someone added in the last 3 weeks with a pipeline but no LinkedIn or company is looked up too; the pipeline stays', async () => {
  const db = d1();
  const records = new Map([['v1', { pageId: 'v1', fullName: 'Sage Russell', email: 'sage@example.test', createdTime: '2026-10-11T18:00:00Z', profile: {}, fields: { Stage: 'Interview', Pipeline: 'India', Outcome: 'Not Yet Decided' } }]]);
  const notion = fakeNotion(records);
  notion.filled = [];
  notion.fillProfile = async a => { notion.filled.push(a); return { changed: ['LinkedIn', 'From'] }; };
  const clay = fakeClay(() => ({ s0: { result: { name: 'Sage Russell', url: 'https://www.linkedin.com/in/sample-2cf35665b2f4', latest_experience_company: 'Mercor', location_name: 'Toronto, Ontario, Canada', structured_location: { country_iso: 'CA' } } } }));
  const r1 = await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T });
  assert.equal(r1.started, 1);
  clay.ready = true;
  await runClayPipelines({ env: ENV, db, notion, clay, clock: () => T + 300_000 });
  assert.deepEqual(notion.filled, [{ pageId: 'v1', expectedEmail: 'sage@example.test', linkedin: 'https://www.linkedin.com/in/sample-2cf35665b2f4', from: 'Mercor' }]);
  assert.equal(notion.set.length, 0, 'the pipeline someone set stands');
});
