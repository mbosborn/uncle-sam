import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { libsqlFixture } from './support/libsql.mjs';

/**
 * DEPLOY-VERCEL.md is the runbook an engineer will follow. These tests keep it honest: every command,
 * file, variable and SQL query it names must exist or run against the real code and schema.
 */
const root = new URL('../', import.meta.url);
const read = relative => readFileSync(new URL(relative, root), 'utf8');
const exists = relative => existsSync(new URL(relative, root));
const doc = read('DEPLOY-VERCEL.md');
const pkg = JSON.parse(read('package.json'));
const vercel = JSON.parse(read('vercel.json'));
const example = JSON.parse(read('.env.secrets.example.json'));

const inlineCode = [...doc.matchAll(/`([^`\n]+)`/g)].map(match => match[1]);

test('every npm script the runbook tells you to run exists in package.json', () => {
  const named = new Set([...doc.matchAll(/npm run ([a-z]+(?::[a-z]+)?)/g)].map(match => match[1]));
  assert.ok(named.size >= 5, `expected the runbook to name several scripts, found ${[...named]}`);
  for (const script of named) assert.ok(pkg.scripts[script], `npm run ${script} is not defined in package.json`);
  assert.ok(pkg.scripts.test, 'npm test is not defined');
});

test('every repository path the runbook names exists', () => {
  const libFiles = readdirSync(new URL('service/lib/', root));
  const skip = new Set(['.env.secrets.json', '.local/uncle-sam.db', 'api/**/*.js']);
  let checked = 0;
  for (const token of inlineCode) {
    if (skip.has(token) || /[<>{}\s…]/.test(token) || token.startsWith('/') || token.startsWith('http')) continue;
    if (/^(?:api|service|scripts|test|src)\/.*\.(?:js|mjs|ts|sql|md|json)$/.test(token) || /^[A-Z-]+[A-Z0-9-]*\.md$/.test(token) || /^(?:package|vercel)\.json$/.test(token)) {
      if (token.includes('*')) {
        const dir = token.slice(0, token.lastIndexOf('/') + 1);
        assert.ok(readdirSync(new URL(dir, root)).length > 0, `${token}: directory is empty or missing`);
      } else {
        assert.ok(exists(token), `${token} is named in the runbook but does not exist`);
      }
      checked += 1;
    } else if (/^[a-z-]+\.mjs$/.test(token)) {
      const found = libFiles.includes(token) || exists(`scripts/${token}`);
      assert.ok(found, `${token} is named in the runbook but is not in service/lib or scripts`);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `expected to check many paths, checked ${checked}`);
});

test('every environment variable the runbook names is defined in the example secrets file', () => {
  const secrets = new Set(Object.keys(example.secrets));
  const names = inlineCode.filter(token => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(token));
  assert.ok(names.length >= 8, `expected several variable names, found ${names}`);
  for (const name of new Set(names)) assert.ok(secrets.has(name), `${name} is named in the runbook but missing from .env.secrets.example.json`);
});

test('the routes, schedule and limits in the runbook match the code and vercel.json', () => {
  for (const route of ['api/slack/events.js', 'api/notion/webhook.js', 'api/portal/webhook.js', 'api/health.js', 'api/cron/tick.js']) {
    assert.ok(exists(route), `${route} is missing`);
  }
  for (const url of ['/api/slack/events', '/api/notion/webhook', '/api/portal/webhook', '/api/cron/tick', '/api/health']) {
    assert.ok(doc.includes(url), `the runbook does not mention ${url}`);
  }
  assert.deepEqual(vercel.crons.map(c => c.path), ['/api/cron/tick', '/api/cron/followups', '/api/cron/sourcing']);
  for (const cron of vercel.crons) assert.ok(doc.includes(cron.schedule), `the runbook must state the cron schedule ${cron.schedule}`);
  assert.ok(doc.includes('/api/cron/followups'), 'the runbook does not mention /api/cron/followups');
  const seconds = vercel.functions['api/**/*.js'].maxDuration;
  assert.ok(doc.includes(`${seconds}-second`) || doc.includes(`${seconds} seconds`), `the runbook must state the ${seconds}-second function limit`);
  assert.equal(pkg.engines.node, '22.x');
});

test('log lines and migration tables named in the runbook are really produced by the code', async () => {
  assert.ok(read('service/lib/webhooks.mjs').includes('notion_webhook_verification_token='), 'Notion handshake log line changed');
  assert.ok(doc.includes('notion_webhook_verification_token'));
  assert.ok(read('service/lib/runtime.mjs').includes('uncle_sam_tick status='), 'tick log line changed');
  assert.ok(doc.includes('uncle_sam_tick status='));
  const { client, close } = await libsqlFixture();
  try {
    const tables = (await client.execute(`SELECT name FROM sqlite_master WHERE type = 'table'`)).rows.map(row => row.name);
    for (const token of inlineCode.filter(token => /^uncle_sam_[a-z_]+$/.test(token))) {
      assert.ok(tables.includes(token), `${token} is named in the runbook but is not a table`);
    }
    assert.ok(tables.includes('uncle_sam_schema_migrations'), 'the migration journal table is not created');
  } finally { close(); }
});

test('the SQL queries in the runbook run against the migrated schema and return the right rows', async () => {
  const blocks = [...doc.matchAll(/```sql\n([\s\S]*?)```/g)].map(match => match[1].trim());
  assert.equal(blocks.length, 6, 'the runbook documents six queries');
  const { client, close } = await libsqlFixture();
  try {
    const now = Date.now();
    const minutesAgo = minutes => now - minutes * 60_000;
    const event = (id, source, status, observed, { wake = 'Pending', error = null, processed = null } = {}) => client.execute({
      sql: `INSERT INTO uncle_sam_events (event_id, source, occurred_at, observed_at, payload_json, status, processed_at, wake_state, wake_error, is_fixture)
            VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, 0)`,
      args: [id, source, observed, observed, status, processed, wake, error] });
    await event('E-stale', 'slack', 'Observed', minutesAgo(120));
    await event('E-fresh', 'slack', 'Observed', minutesAgo(1));
    await event('E-done', 'notion', 'Processed', minutesAgo(30), { wake: 'Complete', processed: minutesAgo(29) });
    await event('E-attention', 'portal', 'NeedsAttention', minutesAgo(45), { wake: 'NeedsAttention', error: 'boom' });
    await event('E-wake', 'slack', 'Processed', minutesAgo(50), { wake: 'NeedsAttention', error: 'wake failed', processed: minutesAgo(49) });
    const request = (key, state, fixture = 0, error = null) => client.execute({
      sql: `INSERT INTO uncle_sam_requests (request_key, candidate_id, occurrence_id, action, recipient_ids_json, payload_json, state,
              is_fixture, trigger_at, due_at, created_at, updated_at, last_error) VALUES (?, 'cand-1', ?, 'feedback_prompt', '[]', '{}', ?, ?, ?, ?, ?, ?, ?)`,
      args: [key, `occ-${key}`, state, fixture, minutesAgo(10), minutesAgo(5), minutesAgo(20), minutesAgo(2), error] });
    await request('R-pending', 'Pending'); await request('R-complete', 'Complete');
    await request('R-uncertain', 'Uncertain', 0, 'timeout after send'); await request('R-attention', 'NeedsAttention', 0, 'recipient missing');
    await request('R-simulated', 'Simulated', 1);
    const hold = (key, active) => client.execute({
      sql: `INSERT INTO uncle_sam_action_holds (hold_key, candidate_id, action, active, reason, source_event_id, last_change_token, created_at, updated_at)
            VALUES (?, 'cand-1', 'feedback_prompt', ?, 'Robin said wait', 'E-done', 'token', ?, ?)`,
      args: [key, active, minutesAgo(60), minutesAgo(60)] });
    await hold('H-active', 1); await hold('H-released', 0);
    await client.execute({ sql: `INSERT INTO uncle_sam_control (id, mode, baseline_complete, version, pause_generation, activated_at, updated_at)
      VALUES ('global', 'Live', 1, 3, 0, ?, ?)`, args: [minutesAgo(600), minutesAgo(1)] });

    const run = async index => (await client.execute(blocks[index])).rows;
    const control = await run(0);
    assert.equal(control.length, 1);
    assert.equal(control[0].mode, 'Live');
    assert.match(String(control[0].updated_utc), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal((await run(1)).length, 5);
    assert.deepEqual((await run(2)).map(row => row.event_id).sort(), ['E-attention', 'E-stale', 'E-wake']);
    assert.deepEqual(Object.fromEntries((await run(3)).map(row => [row.state, Number(row.requests)])),
      { Pending: 1, Complete: 1, Uncertain: 1, NeedsAttention: 1 });
    assert.deepEqual((await run(4)).map(row => row.request_key).sort(), ['R-attention', 'R-uncertain']);
    assert.deepEqual((await run(5)).map(row => row.hold_key), ['H-active']);
  } finally { close(); }
});
