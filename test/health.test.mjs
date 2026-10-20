import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { failureOf, recordFailures, healthReport, runMorningHealth, reportText, looksLikeHealthAsk } from '../service/lib/health.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_wispr (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_events (event_id TEXT PRIMARY KEY, status TEXT NOT NULL, observed_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare, sqlite };
}
const MORNING = Date.parse('2026-10-17T14:05:00Z'); // 7:05 am Pacific
const put = (db, name, value, at) => db.sqlite.prepare('INSERT OR REPLACE INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?)').run(name, JSON.stringify(value), at);
function healthy(db, now) {
  for (const k of ['followups:last', 'watchdog:last-tick', 'pipeline:last', 'decision:last', 'stripe:last']) put(db, k, { at: now - 60_000 }, now);
}

test('which log lines are failures', () => {
  assert.deepEqual(failureOf('uncle_sam_slack_dms {"state":"connected","error":"llm_no_report"}'), { job: 'slack_dms', code: 'llm_no_report' });
  assert.deepEqual(failureOf('uncle_sam_followups status=failed reason=notion_timeout'), { job: 'followups', code: 'notion_timeout' });
  assert.deepEqual(failureOf('uncle_sam_wispr assignments_failed error=llm_timeout'), { job: 'wispr', code: 'llm_timeout' });
  assert.equal(failureOf('uncle_sam_slack_dms {"notes":2}'), null);
  assert.equal(failureOf('uncle_sam_tick status=skipped reason=tick_in_progress'), null);
  assert.equal(failureOf('something else error=x'), null);
});

test('all fine in the morning: no message; once a day; not before 7 Pacific', async () => {
  const db = d1(); healthy(db, MORNING);
  const said = [];
  const poster = async t => said.push(t);
  assert.equal((await runMorningHealth({ db, poster, mode: 'Live', clock: () => MORNING - 2 * 3600_000 })).state, 'not_due');
  assert.equal((await runMorningHealth({ db, poster, mode: 'Live', connections: { slackDms: true, docusign: true }, clock: () => MORNING })).state, 'ok');
  assert.equal((await runMorningHealth({ db, poster, mode: 'Live', clock: () => MORNING + 600_000 })).state, 'done_today');
  assert.equal(said.length, 0);
});

test('something wrong in the morning: one DM listing each problem in plain words', async () => {
  const db = d1(); healthy(db, MORNING);
  put(db, 'pipeline:last', { at: MORNING - 5 * 3600_000 }, MORNING);
  await recordFailures(db, ['uncle_sam_slack_dms {"error":"llm_no_report"}', 'uncle_sam_slack_dms {"error":"llm_no_report"}', 'uncle_sam_stripe {"paid":0}'], MORNING - 3600_000);
  put(db, 'health:job:recaps', { code: 'old', first: 0, last: MORNING - 3 * 86400_000, count: 1 }, MORNING);
  db.sqlite.prepare('INSERT INTO uncle_sam_events VALUES (?, ?, ?)').run('Ev1', 'Observed', MORNING - 2 * 3600_000);
  db.sqlite.prepare('INSERT INTO uncle_sam_events VALUES (?, ?, ?)').run('Ev2', 'Processed', MORNING - 2 * 3600_000);
  const said = [];
  const out = await runMorningHealth({ db, poster: async t => said.push(t), mode: 'Live', connections: async () => ({ slackDms: true, slackFiles: false, docusign: false }), clock: () => MORNING });
  assert.equal(out.state, 'told');
  const text = said[0];
  assert.match(text, /^🩺 Morning check: 5 things I can't fix myself\./);
  assert.match(text, /🎖️ Reading screenshots in your DMs \(files:read\) isn't connected/);
  assert.match(text, /🎖️ DocuSign access isn't connected/);
  assert.match(text, /🎖️ The pipeline check hasn't run for 5 hours/);
  assert.match(text, /🎖️ Reading your Slack DMs failed 2 times in the last day, last at Sat 6:05 AM PT \(llm_no_report\)\./);
  assert.match(text, /🎖️ 1 Slack message or tap from the last day never finished/);
  assert.doesNotMatch(text, /Recaps/, 'older than a day is not reported');
});

test('"health check" in his DM always answers; Mode not Live is a problem', async () => {
  for (const t of ['health check', '<@U0C4899BFC9> health check?', 'are you ok', 'run a health check', 'health check\n*Sent using* <@U0A88TFE3RT|Claude>']) assert.ok(looksLikeHealthAsk(t), t);
  for (const t of ['check the health of Morgan', 'send Morgan the docs']) assert.ok(!looksLikeHealthAsk(t), t);
  const db = d1(); healthy(db, MORNING);
  assert.match(reportText(await healthReport({ db, now: MORNING, mode: 'Live' }), { asked: true, now: MORNING }), /^🩺 All checks pass/);
  assert.match(reportText(await healthReport({ db, now: MORNING, mode: 'Off' }), { asked: true }), /My Mode on the Notion control row is Off/);
});

test('Only what Uncle Sam can\'t fix: a job that ran fine after failing, one old failure and swept messages are left out; the Google admin 403 is said plainly', async () => {
  const db = d1(); healthy(db, MORNING);
  // Wispr failed twice overnight, then ran fine: recovered.
  await recordFailures(db, ['uncle_sam_wispr {"error":"wispr_timeout"}', 'uncle_sam_wispr {"error":"wispr_timeout"}'], MORNING - 5 * 3600_000);
  await recordFailures(db, ['uncle_sam_wispr {"state":"connected","error":null}'], MORNING - 4 * 3600_000);
  // One Clay failure 10 hours ago: transient.
  await recordFailures(db, ['uncle_sam_clay {"error":"clay_502"}'], MORNING - 10 * 3600_000);
  // Gmail notes failing again and again, still now: reported.
  await recordFailures(db, ['uncle_sam_gmail_notes {"error":"gmail_401"}', 'uncle_sam_gmail_notes {"error":"gmail_401"}'], MORNING - 600_000);
  // A message the sweep already closed (and told him about) is not repeated.
  db.sqlite.prepare('INSERT INTO uncle_sam_events VALUES (?, ?, ?)').run('Ev3', 'Needs attention', MORNING - 2 * 3600_000);
  const report = await healthReport({ db, now: MORNING, mode: 'Live', connections: { googleAdmin: false } });
  const text = reportText(report, { now: MORNING });
  assert.equal(report.problems.length, 2, text);
  assert.match(text, /Gmail notes failed 2 times/);
  assert.match(text, /Google refuses my admin lookups \(403\)/);
  assert.doesNotMatch(text, /Wispr|Clay|never finished/);
});

test('The Google admin probe: a 403 is false; no grant or an unclear answer is not a problem', async () => {
  const { googleAdminWorks } = await import('../service/lib/health.mjs');
  const fail = code => ({ get: async () => { throw Object.assign(new Error('x'), { code }); } });
  assert.equal(await googleAdminWorks({ granted: async () => true, admin: () => fail('admin_lookup_http_403') }), false);
  assert.equal(await googleAdminWorks({ granted: async () => true, admin: () => fail('admin_lookup_http_500') }), undefined);
  assert.equal(await googleAdminWorks({ granted: async () => false, admin: () => fail('admin_lookup_http_403') }), undefined);
  assert.equal(await googleAdminWorks({ granted: async () => true, admin: () => ({ get: async () => ({}) }) }), true);
});
