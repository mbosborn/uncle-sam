import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../service/lib/vercel-handlers.mjs';
import { createTursoClient } from '../service/lib/turso.mjs';
import { applyMigrations } from '../service/lib/migrate.mjs';
import { createStore } from '../service/lib/store.mjs';
import { startDevServer, routesFor } from '../scripts/dev-server.mjs';
import { SECRETS, ROUTES, baseEnv, harness, slackHeaders, slackMessage, json } from './support/vercel-world.mjs';
import { migrationFiles } from './support/libsql.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = name => path.join(root, 'scripts', name);
const exec = promisify(execFile);
const dirs = [];
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'uncle-sam-deploy-')); dirs.push(dir); return dir; };
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** Runs a script in a clean environment (no inherited secrets or proxies) and never throws on a non-zero exit. */
async function run(file, args = [], { env = {} } = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [file, ...args], { cwd: os.tmpdir(), timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) { return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
}

const fileSecrets = (overrides = {}) => ({ TURSO_DATABASE_URL: 'libsql://fixture-db.turso.io', TURSO_AUTH_TOKEN: 'fixture-turso-token-value',
  CRON_SECRET: SECRETS.CRON_SECRET, UNCLE_SAM_AUTOMATIC_ACTIVITY: 'off', SLACK_SIGNING_SECRET: SECRETS.SLACK_SIGNING_SECRET,
  SLACK_BOT_TOKEN: SECRETS.SLACK_BOT_TOKEN, SLACK_BOT_USER_ID: 'UBOTFIXTURE', SLACK_BOT_ID: 'BBOTFIXTURE', NOTION_TOKEN: SECRETS.NOTION_TOKEN,
  ANTHROPIC_API_KEY: SECRETS.ANTHROPIC_API_KEY, SLACK_ROUTE_MAP_JSON: ROUTES, ...overrides });
function writeSecrets(secrets = fileSecrets(), vercel = { scope: '<optional>' }) {
  const file = path.join(tmp(), 'secrets.json');
  writeFileSync(file, JSON.stringify({ vercel, secrets }), { mode: 0o600 });
  return file;
}
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
async function migratedFileDatabase() {
  const url = `file:${path.join(tmp(), 'uncle-sam.db')}`;
  const client = await createTursoClient({ TURSO_DATABASE_URL: url });
  await applyMigrations(client, migrationFiles());
  client.close();
  return url;
}

// ---------------------------------------------------------------------------------------------------------------
// Database wiring
// ---------------------------------------------------------------------------------------------------------------
test('database: no URL means no database; a file URL gives the surface the store runs on; a libsql URL builds a client without connecting', async () => {
  assert.equal(await openDatabase({}), null);
  assert.equal(await createTursoClient({}), null);
  const url = await migratedFileDatabase();
  const db = await openDatabase({ TURSO_DATABASE_URL: url });
  assert.equal(await db.prepare('SELECT 1 AS ok').first('ok'), 1);
  assert.equal((await createStore(db, { authorized: true }).getControl()).mode, 'Off');
  const remote = await createTursoClient({ TURSO_DATABASE_URL: 'libsql://example-db.turso.io', TURSO_AUTH_TOKEN: 'fixture-token' });
  assert.equal(typeof remote.execute, 'function');
  assert.equal(typeof remote.batch, 'function');
  remote.close?.();
});

// ---------------------------------------------------------------------------------------------------------------
// The files Vercel actually runs
// ---------------------------------------------------------------------------------------------------------------
test('the five api/*.js entry points follow the Web handler convention and serve real requests from a real database', async () => {
  const url = await migratedFileDatabase();
  const previous = { ...process.env };
  Object.assign(process.env, baseEnv({ TURSO_DATABASE_URL: url }));
  try {
    const load = async file => (await import(`../api/${file}`)).default;
    const handlers = { health: await load('health.js'), tick: await load('cron/tick.js'), slack: await load('slack/events.js'),
      notion: await load('notion/webhook.js'), portal: await load('portal/webhook.js') };
    for (const [name, handler] of Object.entries(handlers)) {
      assert.deepEqual(Object.keys(handler), ['fetch'], name);
      assert.equal(typeof handler.fetch, 'function', name);
    }
    const health = await json(await handlers.health.fetch(new Request('https://uncle-sam.example/api/health')));
    assert.equal(health.service, 'Uncle Sam');
    assert.equal(health.configuration.databaseReachable, true);
    assert.equal(health.configuration.cron, true);
    assert.equal((await handlers.tick.fetch(new Request('https://uncle-sam.example/api/cron/tick'))).status, 401);
    const tick = await json(await handlers.tick.fetch(new Request('https://uncle-sam.example/api/cron/tick', { headers: { authorization: `Bearer ${SECRETS.CRON_SECRET}` } })));
    assert.equal(tick.reason, 'automatic_activity_off');
    assert.equal((await handlers.slack.fetch(new Request('https://uncle-sam.example/api/slack/events'))).status, 405);
    const raw = JSON.stringify({ type: 'url_verification', challenge: 'wrapper-check' });
    const handshake = await handlers.slack.fetch(new Request('https://uncle-sam.example/api/slack/events', { method: 'POST', body: raw, headers: slackHeaders(raw, { at: Date.now() }) }));
    assert.deepEqual(await json(handshake), { challenge: 'wrapper-check' });
    const portal = await handlers.portal.fetch(new Request('https://uncle-sam.example/api/portal/webhook', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    assert.equal(portal.status, 401);
    const notion = await handlers.notion.fetch(new Request('https://uncle-sam.example/api/notion/webhook', { method: 'POST', body: '{"id":"x"}', headers: { 'content-type': 'application/json' } }));
    assert.equal(notion.status, 401);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Local development server (a faithful stand-in for Vercel's request handling)
// ---------------------------------------------------------------------------------------------------------------
test('dev server: a real HTTP round trip reaches the same handlers, raw-body Slack signatures included', async () => {
  const h = await harness({ clock: Date.now });
  const server = await startDevServer({ app: h.app, port: 0 });
  try {
    assert.deepEqual(Object.keys(routesFor(h.app)).sort(), ['/api/cron/tick', '/api/health', '/api/notion/webhook', '/api/portal/webhook', '/api/slack/events']);
    const health = await fetch(`${server.url}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).configuration.databaseReachable, true);
    const head = await fetch(`${server.url}/api/health`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.deepEqual(await (await fetch(`${server.url}/nowhere`)).json(), { error: 'not_found' });
    const raw = JSON.stringify(slackMessage({ text: 'Über naïve “unicode” text — signed over raw bytes' }));
    const accepted = await fetch(`${server.url}/api/slack/events`, { method: 'POST', body: raw, headers: slackHeaders(raw, { at: Date.now() }) });
    assert.equal(accepted.status, 200);
    assert.equal((await h.store.getEvent('EvVercelOne')).text, 'Über naïve “unicode” text — signed over raw bytes');
    const forged = await fetch(`${server.url}/api/slack/events`, { method: 'POST', body: raw.replace('naïve', 'naive'), headers: slackHeaders(raw, { at: Date.now() }) });
    assert.equal(forged.status, 401);
    const tick = await fetch(`${server.url}/api/cron/tick`);
    assert.equal(tick.status, 401);
    assert.equal(tick.headers.get('www-authenticate'), 'Bearer');
    const huge = await fetch(`${server.url}/api/portal/webhook`, { method: 'POST', body: 'x'.repeat(1_200_000), headers: { 'content-type': 'application/json' } });
    assert.equal(huge.status, 413);
  } finally { await server.close(); h.close(); }
});

test('dev server script: starts on a local file database, applies the migrations itself and answers health', async () => {
  const port = await freePort();
  const url = `file:${path.join(tmp(), 'dev.db')}`;
  const child = spawn(process.execPath, [script('dev-server.mjs')], { cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), TURSO_DATABASE_URL: url, CRON_SECRET: SECRETS.CRON_SECRET } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  try {
    let body;
    for (let attempt = 0; attempt < 100 && !body; attempt++) {
      try { body = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(body, `the server answered (output: ${output})`);
    assert.equal(body.phase, 'setup');
    assert.equal(body.automaticActionsEnabled, false, 'the dev server defaults the kill switch to off');
    assert.equal(body.configuration.databaseReachable, true);
    assert.match(output, /applied 5 local migrations/);
    assert.match(output, new RegExp(`Uncle Sam dev server on http://127\\.0\\.0\\.1:${port}`));
  } finally { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
});

// ---------------------------------------------------------------------------------------------------------------
// setup.mjs
// ---------------------------------------------------------------------------------------------------------------
test('setup verify: every check passes against a correctly configured server, using only the secrets file', async () => {
  const h = await harness({ clock: Date.now });
  const server = await startDevServer({ app: h.app, port: 0 });
  try {
    const plain = await run(script('setup.mjs'), ['verify', server.url]);
    assert.equal(plain.code, 0, plain.stdout + plain.stderr);
    // The summary line names the model route and counts the routes (a number, not an object).
    assert.match(plain.stdout, /llm=anthropic\/fixture-model-1 cron=true routes=2(?: |\n)/, plain.stdout);
    assert.match(plain.stdout, /inbound: notionWebhook=true portalWebhook=true calendar=false/, plain.stdout);
    for (const line of ['✓ GET /api/health', '✓ database reachable from the deployment', '✓ POST /api/slack/events without a Slack signature is refused',
      '✓ GET /api/cron/tick without the cron secret is refused', '✓ POST /api/portal/webhook without the portal secret is refused', 'All checks passed.']) {
      assert.ok(plain.stdout.includes(line), `${line}\n${plain.stdout}`);
    }
    const full = await run(script('setup.mjs'), ['verify', server.url, '--signed', '--tick'], { env: { UNCLE_SAM_SECRETS_FILE: writeSecrets() } });
    assert.equal(full.code, 0, full.stdout + full.stderr);
    assert.ok(full.stdout.includes('✓ signed Slack url_verification is answered'));
    assert.match(full.stdout, /✓ authorized tick runs — HTTP 200 status=blocked reason=automatic_activity_off mode=null/);
    for (const value of Object.values(SECRETS)) assert.equal((full.stdout + full.stderr).includes(value), false, 'no secret is printed');
    // The same checks fail when the server holds a different signing secret or cron secret than the file.
    const wrong = await run(script('setup.mjs'), ['verify', server.url, '--signed', '--tick'],
      { env: { UNCLE_SAM_SECRETS_FILE: writeSecrets(fileSecrets({ SLACK_SIGNING_SECRET: 'a-different-signing-secret', CRON_SECRET: 'y'.repeat(40) })) } });
    assert.equal(wrong.code, 1);
    assert.match(wrong.stdout, /✗ signed Slack url_verification is answered/);
    assert.match(wrong.stdout, /✗ authorized tick runs/);
  } finally { await server.close(); h.close(); }
});

test('setup verify: reports an unreachable database, refuses non-https targets, and recognises the Vercel protection wall', async () => {
  const h = await harness({ clock: Date.now, open: () => async () => null });
  const server = await startDevServer({ app: h.app, port: 0 });
  try {
    const broken = await run(script('setup.mjs'), ['verify', server.url]);
    assert.equal(broken.code, 1);
    assert.match(broken.stdout, /✗ database reachable from the deployment/);
    assert.match(broken.stderr, /Some checks failed/);
  } finally { await server.close(); h.close(); }
  for (const target of ['ftp://uncle-sam.example', 'http://uncle-sam.example', 'uncle-sam.example', 'https://uncle-sam.example/api/health']) {
    const refused = await run(script('setup.mjs'), ['verify', target]);
    assert.equal(refused.code, 1, target);
    assert.match(refused.stderr, /Usage: node scripts\/setup\.mjs verify/, target);
  }
  const wall = http.createServer((request, response) => {
    response.writeHead(401, { 'content-type': 'text/html; charset=utf-8', server: 'Vercel', 'x-vercel-id': 'iad1::fixture' });
    response.end('<!doctype html><title>Authentication Required</title>');
  });
  await new Promise(resolve => wall.listen(0, '127.0.0.1', resolve));
  try {
    const walled = await run(script('setup.mjs'), ['verify', `http://127.0.0.1:${wall.address().port}`]);
    assert.equal(walled.code, 1);
    assert.match(walled.stderr, /Deployment Protection is answering instead of Uncle Sam/);
  } finally { await new Promise(resolve => wall.close(resolve)); }
});

test('setup check and env: a bad or missing secrets file fails before any network call, naming keys but never values', async () => {
  const missing = await run(script('setup.mjs'), ['check'], { env: { UNCLE_SAM_SECRETS_FILE: path.join(tmp(), 'nope.json') } });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Missing \.env\.secrets\.json/);
  const bad = writeSecrets(fileSecrets({ CRON_SECRET: 'secretmarker-short', SLACK_BOT_TOKEN: 'secretmarker-not-a-token', TURSO_AUTH_TOKEN: '<fill in>' }));
  for (const command of [['check'], ['env', '--dry-run']]) {
    const result = await run(script('setup.mjs'), command, { env: { UNCLE_SAM_SECRETS_FILE: bad } });
    assert.equal(result.code, 1, command.join(' '));
    assert.match(result.stderr, /Secrets file problems/);
    assert.match(result.stderr, /CRON_SECRET: use at least 32/);
    assert.match(result.stderr, /SLACK_BOT_TOKEN: must start with xoxb-/);
    assert.match(result.stderr, /TURSO_AUTH_TOKEN: missing/);
    assert.equal(/secretmarker/.test(result.stdout + result.stderr), false);
  }
  const notJson = path.join(tmp(), 'broken.json');
  writeFileSync(notJson, '{ not json');
  assert.match((await run(script('setup.mjs'), ['check'], { env: { UNCLE_SAM_SECRETS_FILE: notJson } })).stderr, /not valid JSON/);
});

test('setup env --dry-run lists every variable it would set, sends nothing and prints no value', async () => {
  const secrets = fileSecrets({ NOTION_WEBHOOK_SECRET: 'notion-webhook-fixture-secret', ANTHROPIC_MODEL: 'claude-sonnet-5-5' });
  const result = await run(script('setup.mjs'), ['env', '--dry-run'], { env: { UNCLE_SAM_SECRETS_FILE: writeSecrets(secrets) } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const would = [...result.stdout.matchAll(/^would set (\w+) \(production\)$/gm)].map(match => match[1]);
  assert.deepEqual(would.sort(), Object.keys(secrets).sort());
  assert.match(result.stdout, /Dry run: nothing was sent to Vercel\./);
  assert.match(result.stdout, /automatic activity = off/);
  for (const value of Object.values(secrets)) assert.equal(result.stdout.includes(value) && value.length > 8, false, 'no value is printed');
});

test('setup env with databaseFromIntegration: the Turso keys are never pushed and need not be in the file; without the flag they are still required', async () => {
  const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, ...withoutDatabase } = fileSecrets();
  const flagged = writeSecrets(withoutDatabase, { scope: '<optional>', databaseFromIntegration: true });
  const result = await run(script('setup.mjs'), ['env', '--dry-run'], { env: { UNCLE_SAM_SECRETS_FILE: flagged } });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /database keys are owned by the Turso integration in Vercel \(0 of 2 found in this environment\)/);
  const would = [...result.stdout.matchAll(/^would set (\w+) \(production\)$/gm)].map(match => match[1]);
  assert.deepEqual(would.sort(), Object.keys(withoutDatabase).sort());
  assert.equal(would.some(key => key.startsWith('TURSO_')), false);
  // With the integration's values in the environment they are found, still skipped, and never printed.
  const found = await run(script('setup.mjs'), ['env', '--dry-run'], { env: { UNCLE_SAM_SECRETS_FILE: flagged, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN } });
  assert.equal(found.code, 0, found.stdout + found.stderr);
  assert.match(found.stdout, /\(2 of 2 found in this environment\)/);
  assert.match(found.stdout, /^skipped TURSO_DATABASE_URL \(owned by the Turso integration\)$/m);
  assert.match(found.stdout, /^skipped TURSO_AUTH_TOKEN \(owned by the Turso integration\)$/m);
  for (const value of [TURSO_DATABASE_URL, TURSO_AUTH_TOKEN]) assert.equal(found.stdout.includes(value), false, 'no database value is printed');
  // Without the flag the file must hold them.
  const unflagged = await run(script('setup.mjs'), ['env', '--dry-run'], { env: { UNCLE_SAM_SECRETS_FILE: writeSecrets(withoutDatabase) } });
  assert.equal(unflagged.code, 1);
  assert.match(unflagged.stderr, /TURSO_DATABASE_URL: missing/);
  assert.match(unflagged.stderr, /TURSO_AUTH_TOKEN: missing/);
});

test('db-migrate takes the integration-owned Turso keys from an env file (node --env-file) without touching the secrets file', async () => {
  const url = `file:${path.join(tmp(), 'from-env-file.db')}`;
  const envFile = path.join(tmp(), 'pulled.env');
  writeFileSync(envFile, `TURSO_DATABASE_URL="${url}"\nTURSO_AUTH_TOKEN="unused-for-file-databases"\n`, { mode: 0o600 });
  const { stdout } = await exec(process.execPath, [`--env-file=${envFile}`, script('db-migrate.mjs')], { cwd: os.tmpdir(), env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.match(stdout, /✓ database .*: 5 applied, 0 already up to date/);
});

// ---------------------------------------------------------------------------------------------------------------
// db-migrate.mjs
// ---------------------------------------------------------------------------------------------------------------
test('db-migrate: reports status, applies each migration once, and a second run changes nothing', async () => {
  const url = `file:${path.join(tmp(), 'migrate.db')}`;
  const env = { TURSO_DATABASE_URL: url };
  const status = await run(script('db-migrate.mjs'), ['--status'], { env });
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /0 applied, 5 pending \(0000_unknown_silver_fox\.sql, 0001_motionless_doctor_doom\.sql, 0002_candidate_threads\.sql, 0003_wispr_connection\.sql, 0004_notices\.sql\)/);
  const first = await run(script('db-migrate.mjs'), [], { env });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /✓ database .*: 5 applied, 0 already up to date/);
  const second = await run(script('db-migrate.mjs'), [], { env });
  assert.match(second.stdout, /✓ database .*: 0 applied, 5 already up to date/);
  assert.match((await run(script('db-migrate.mjs'), ['--status'], { env })).stdout, /5 applied, 0 pending/);
  const none = await run(script('db-migrate.mjs'), [], { env: {} });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /TURSO_DATABASE_URL is not set/);
});
