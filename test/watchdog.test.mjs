import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runWatchdog, TEXT } from '../service/lib/watchdog.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const T = Date.parse('2026-10-16T19:00:00Z');
const ENV = { SLACK_BOT_TOKEN: 'xoxb-fixture-only', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };

function world() {
  const w = { db: d1(), slack: [], email: [], slackAnswer: { ok: true }, googleError: null, slackDown: false };
  w.fetch = async () => Response.json(w.slackAnswer);
  w.run = (now, tickResult = { status: 'ok', summary: { control: { mode: 'Live' } } }) => runWatchdog({ env: ENV, db: w.db, tickResult, fetchImpl: w.fetch, googleConfigured: true,
    googleToken: async () => { if (w.googleError) throw Object.assign(new Error('x'), { code: w.googleError }); return 'tok'; },
    tellSlack: async t => { if (w.slackDown) throw Object.assign(new Error('x'), { code: 'slack_invalid_auth' }); w.slack.push(t); },
    tellEmail: async (subject, body) => { w.email.push({ subject, body }); }, clock: () => now });
  return w;
}
const min = n => n * 60_000;

test('Watchdog: Google revoked -> Slack at once, once; back -> one line', async () => {
  const w = world();
  await w.run(T);
  assert.equal(w.slack.length, 0, 'all well: silence');
  w.googleError = 'gmail_disconnected';
  await w.run(T + min(11));
  assert.equal(w.slack.length, 1);
  assert.match(w.slack[0], /^🚨 I've lost access to your Google account \(gmail_disconnected\)\. Until you reconnect/);
  w.googleError = 'gmail_not_connected';
  await w.run(T + min(22)); await w.run(T + min(33));
  assert.equal(w.slack.length, 1, 'told once');
  w.googleError = null;
  await w.run(T + min(44));
  assert.deepEqual(w.slack.slice(1), [TEXT.googleBack]);
});

test('Watchdog: a Google hiccup is told only after 30 minutes; never-connected is set-up, not an outage', async () => {
  const w = world();
  w.googleError = 'gmail_refresh_http_503';
  await w.run(T); await w.run(T + min(11)); await w.run(T + min(22));
  assert.equal(w.slack.length, 0);
  await w.run(T + min(33));
  assert.match(w.slack[0], /Google has been refusing me for 30 minutes \(gmail_refresh_http_503\)/);
  const n = world();
  n.googleError = 'gmail_not_connected';
  for (let i = 0; i < 5; i++) await n.run(T + min(11 * i));
  assert.equal(n.slack.length, 0);
});

test('Watchdog: Slack token revoked -> email from Gmail at once (Slack is what is down); back -> Slack line', async () => {
  const w = world();
  w.slackAnswer = { ok: false, error: 'token_revoked' };
  await w.run(T);
  assert.equal(w.email.length, 1);
  assert.equal(w.email[0].subject, 'Uncle Sam: Slack access lost');
  assert.match(w.email[0].body, /^Uncle Sam can't use Slack \(token_revoked\)\./);
  await w.run(T + min(5));
  assert.equal(w.email.length, 1, 'checked every 10 minutes, told once');
  w.slackAnswer = { ok: true };
  await w.run(T + min(11));
  assert.deepEqual(w.slack, [TEXT.slackBack]);
});

test('Watchdog: three failed runs in a row -> told with the reason; a gap of 20+ minutes is reported when runs resume', async () => {
  const w = world();
  const bad = { status: 'failed', reason: 'notion_http_502' };
  await w.run(T, bad); await w.run(T + min(5), bad);
  assert.equal(w.slack.length, 0);
  await w.run(T + min(10), bad);
  assert.equal(w.slack[0], TEXT.notionFailing(3, 'notion_http_502'));
  await w.run(T + min(15), bad);
  assert.equal(w.slack.length, 1);
  await w.run(T + min(20));
  assert.equal(w.slack[1], TEXT.notionBack);
  await w.run(T + min(65));
  assert.match(w.slack[2], /^📋 I wasn't running from Fri 12:20 PM to Fri 1:05 PM PT \(45 minutes\)\./);
  w.slackDown = true;
  await w.run(T + min(70), bad); await w.run(T + min(75), bad); await w.run(T + min(80), bad);
  assert.match(w.email.at(-1).body, /^🚨 My last 3 runs failed/, 'Slack down too: the same words by email');
});
