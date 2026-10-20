import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTursoClient } from '../service/lib/turso.mjs';
import { applyMigrations } from '../service/lib/migrate.mjs';
import { migrationFiles } from './support/libsql.mjs';

/**
 * `setup:check` end to end as a child process against fixture hosts (test/support/fake-network.mjs replaces fetch): which model
 * route it tests, what it prints, and that it never prints a key. No real service is contacted and no credential is real.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const setup = path.join(root, 'scripts', 'setup.mjs');
const preload = path.join(root, 'test', 'support', 'fake-network.mjs');
const exec = promisify(execFile);
const dirs = [];
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'uncle-sam-check-')); dirs.push(dir); return dir; };
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const ANTHROPIC_KEY = 'sk-ant-cli-fixture-key-0123456789abcdef';
const OPENROUTER_KEY = 'sk-or-v1-cli-fixture-key-0123456789abcdef';
const KEYS = [ANTHROPIC_KEY, OPENROUTER_KEY];

async function migratedDatabaseUrl() {
  const url = `file:${path.join(tmp(), 'uncle-sam.db')}`;
  const client = await createTursoClient({ TURSO_DATABASE_URL: url });
  await applyMigrations(client, migrationFiles());
  client.close();
  return url;
}

async function check(args, { secrets = {}, scenario = 'ok', without = [] } = {}) {
  const dir = tmp();
  const values = { TURSO_DATABASE_URL: await migratedDatabaseUrl(), TURSO_AUTH_TOKEN: 'fixture-turso-token-value', CRON_SECRET: 'c'.repeat(40),
    UNCLE_SAM_AUTOMATIC_ACTIVITY: 'off', SLACK_SIGNING_SECRET: 'fixture-signing-secret', SLACK_BOT_TOKEN: 'xoxb-111-222-fixture',
    SLACK_BOT_USER_ID: 'UBOTFIXTURE', SLACK_BOT_ID: 'BBOTFIXTURE', NOTION_TOKEN: 'ntn_fixture_token', ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    SLACK_ROUTE_MAP_JSON: JSON.stringify({ project: { channelId: 'DMASON0001', type: 'im' } }), ...secrets };
  for (const key of without) delete values[key];
  const secretsFile = path.join(dir, 'secrets.json');
  const logFile = path.join(dir, 'network.log');
  writeFileSync(secretsFile, JSON.stringify({ vercel: { scope: '<optional>' }, secrets: values }), { mode: 0o600 });
  let result;
  try {
    const { stdout, stderr } = await exec(process.execPath, ['--import', preload, setup, 'check', ...args], { cwd: os.tmpdir(), timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, UNCLE_SAM_SECRETS_FILE: secretsFile, FAKE_NET_SCENARIO: scenario, FAKE_NET_LOG: logFile } });
    result = { code: 0, stdout, stderr };
  } catch (error) { result = { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const output = result.stdout + result.stderr;
  assert.equal(KEYS.some(key => output.includes(key)) || output.includes('secret-sentinel'), false, 'no key and no response body is ever printed');
  return { ...result, output, calls, to: host => calls.filter(call => call.url.includes(host)) };
}

test('check on the Anthropic route verifies the model id and, with --probe-model, makes one real-shaped call with an automatic tool choice', async () => {
  const r = await check(['--probe-model'], { secrets: { ANTHROPIC_MODEL: 'claude-sonnet-5-5' } });
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /✓ Anthropic key and model — claude-sonnet-5-5/);
  assert.match(r.stdout, /✓ Model probe over the anthropic route \(one tiny real call, synthetic event\) — claude-sonnet-5-5: \d+\.\d s, stop_reason tool_use, called propose, proposed no_action, 21 in \/ 8 out tokens/);
  assert.match(r.stdout, /Preflight passed\. Nothing was changed \(the model probe cost a fraction of a cent\)\./);
  assert.equal(r.to('openrouter.ai').length, 0);
  const [call] = r.to('api.anthropic.com/v1/messages');
  assert.equal(r.to('api.anthropic.com/v1/messages').length, 1);
  assert.equal(call.headers['x-api-key'], ANTHROPIC_KEY);
  const body = JSON.parse(call.body);
  assert.deepEqual(body.tool_choice, { type: 'auto' }); assert.equal(body.model, 'claude-sonnet-5-5'); assert.ok(body.tools.some(tool => tool.name === 'propose'));
  assert.match(body.messages[0].content, /SYNTHETIC CONNECTION CHECK/);
});

test('check without --probe-model never calls the model messages endpoint on the Anthropic route', async () => {
  const r = await check([]);
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /Preflight passed\. Nothing was changed\.\n/);
  assert.equal(r.to('api.anthropic.com/v1/messages').length, 0);
  assert.equal(r.to('api.anthropic.com/v1/models/claude-sonnet-4-5').length, 1, 'the free model lookup is all it does');
});

test('check on the OpenRouter route sends one tiny real request through the service\'s own client, pinned to Anthropic, and never touches api.anthropic.com', async () => {
  const r = await check([], { without: ['ANTHROPIC_API_KEY'], secrets: { OPENROUTER_API_KEY: OPENROUTER_KEY } });
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /✓ OpenRouter key and model — anthropic\/claude-sonnet-5\.5, pinned to Anthropic's own endpoint/);
  assert.equal(r.to('api.anthropic.com').length, 0);
  assert.equal(r.to('openrouter.ai').length, 1);
  const [call] = r.to('openrouter.ai');
  assert.equal(call.url, 'https://openrouter.ai/api/v1/messages');
  assert.equal(call.headers.authorization, `Bearer ${OPENROUTER_KEY}`); assert.equal('x-api-key' in call.headers, false);
  const body = JSON.parse(call.body);
  assert.deepEqual(body.provider, { only: ['anthropic'], allow_fallbacks: false }); assert.equal(body.max_tokens, 256);
  assert.equal(body.model, 'anthropic/claude-sonnet-5.5');
});

test('check --probe-model on the OpenRouter route reports which provider served it; an OPENROUTER_MODEL setting is used as given', async () => {
  const r = await check(['--probe-model'], { without: ['ANTHROPIC_API_KEY'], secrets: { OPENROUTER_API_KEY: OPENROUTER_KEY, OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5' } });
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /✓ Model probe over the openrouter route .* — anthropic\/claude-sonnet-5\.5 served by Anthropic: \d+\.\d s, stop_reason tool_use, called propose, proposed no_action/);
  assert.equal(r.to('openrouter.ai').length, 2, 'the key check and the probe');
  assert.deepEqual(JSON.parse(r.to('openrouter.ai')[1].body).tool_choice, { type: 'auto' });
});

test('when both keys are set the check says so and tests Anthropic\'s, which is the one the service uses', async () => {
  const r = await check([], { secrets: { OPENROUTER_API_KEY: OPENROUTER_KEY } });
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, /! Both model keys are set\. The service uses Anthropic's own and ignores OPENROUTER_API_KEY\./);
  assert.equal(r.to('openrouter.ai').length, 0);
  assert.equal(r.to('api.anthropic.com/v1/models/claude-sonnet-4-5').length, 1);
});

test('a model API failure is explained in plain words by its status and nothing from the response is printed', async () => {
  const noCredit = await check([], { without: ['ANTHROPIC_API_KEY'], secrets: { OPENROUTER_API_KEY: OPENROUTER_KEY }, scenario: 'credit' });
  assert.equal(noCredit.code, 1);
  assert.match(noCredit.stderr, /✗ OpenRouter key and model — openrouter_http_402 — out of credit, or the key's spending limit is used up/);
  assert.match(noCredit.stderr, /Preflight failed; nothing was changed\./);
  const unknown = await check([], { secrets: { ANTHROPIC_MODEL: 'claude-nonexistent-9' }, scenario: 'unknown-model' });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /model "claude-nonexistent-9" not found/);
});

test('the probe fails when the reply ran out of tokens, and says so when the model made no tool call', async () => {
  const cut = await check(['--probe-model'], { scenario: 'truncated' });
  assert.equal(cut.code, 1);
  assert.match(cut.stderr, /✗ Model probe over the anthropic route .* — the reply ran out of output tokens before it finished \(thinking counts toward the limit\)/);
  const talks = await check(['--probe-model'], { scenario: 'talks' });
  assert.equal(talks.code, 0, talks.output);
  assert.match(talks.stdout, /stop_reason end_turn, no tool call \(the runner would nudge it\)/);
});

test('with neither model key the secrets file is refused before any network call', async () => {
  const r = await check([], { without: ['ANTHROPIC_API_KEY'] });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ANTHROPIC_API_KEY: missing/);
  assert.equal(r.calls.length, 0);
});
