import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { REQUIRED, OPTIONAL, TURSO_KEYS, isPlaceholder, validateSecrets, signSlackBody, looksLikeProtectionWall, probeModel } from '../service/lib/setup-checks.mjs';
import { POLICY_DIGEST, TOOLS } from '../service/lib/agent-runner.mjs';
import { handleSlackRequest } from '../service/lib/protocol.mjs';
import { APP_ID, TEAM_ID } from '../service/lib/identity.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const readJson = path => JSON.parse(read(path));

const valid = () => ({
  TURSO_DATABASE_URL: 'libsql://uncle-sam-company.turso.io', TURSO_AUTH_TOKEN: 'eyJ-fixture-token-value', CRON_SECRET: 'c'.repeat(40),
  UNCLE_SAM_AUTOMATIC_ACTIVITY: 'off', SLACK_SIGNING_SECRET: 'fixture-signing-secret', SLACK_BOT_TOKEN: 'xoxb-111-222-fixture',
  SLACK_BOT_USER_ID: 'U0FIXTURE1', SLACK_BOT_ID: 'B0FIXTURE1', NOTION_TOKEN: 'ntn_fixture_token', ANTHROPIC_API_KEY: 'sk-ant-fixture-key',
  SLACK_ROUTE_MAP_JSON: JSON.stringify({ project: { channelId: 'DMASON0001', type: 'im' } }),
});

// ---------------------------------------------------------------------------------------------------------------
// Secrets-file validation
// ---------------------------------------------------------------------------------------------------------------
test('a complete secrets file passes and yields exactly the values to deploy (optional ones only when filled in)', () => {
  const { problems, values } = validateSecrets(valid());
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(values).sort(), Object.keys(valid()).sort());
  const withOptional = validateSecrets({ ...valid(), ANTHROPIC_MODEL: 'claude-sonnet-5-5', NOTION_WEBHOOK_SECRET: '<leave empty until Notion sends one>',
    PORTAL_WEBHOOK_SECRET: '', GOOGLE_CALENDAR_IDS: 'robin@company.example', INTERVIEWER_EMAILS_JSON: '{"robin@company.example":"U0A4F08721B"}' });
  assert.deepEqual(withOptional.problems, []);
  assert.equal(withOptional.values.ANTHROPIC_MODEL, 'claude-sonnet-5-5');
  assert.equal('NOTION_WEBHOOK_SECRET' in withOptional.values, false, 'a placeholder is never deployed');
  assert.equal('PORTAL_WEBHOOK_SECRET' in withOptional.values, false, 'an empty value is never deployed');
  assert.equal(validateSecrets({ ...valid(), TURSO_DATABASE_URL: 'file:./.local/uncle-sam.db' }).problems.length, 0, 'a local file database is allowed for development');
});

test('every required key is reported when missing, empty or still a <placeholder>, by name only', () => {
  assert.deepEqual(validateSecrets({}).problems, REQUIRED.map(key => `${key}: missing`));
  const placeholders = Object.fromEntries(REQUIRED.map(key => [key, `<fill in ${key}>`]));
  assert.deepEqual(validateSecrets(placeholders).problems, REQUIRED.map(key => `${key}: missing`));
  assert.equal(isPlaceholder(undefined), true); assert.equal(isPlaceholder('  '), true); assert.equal(isPlaceholder('<x>'), true);
  assert.equal(isPlaceholder('off'), false); assert.equal(isPlaceholder(42), true);
});

test('malformed values are caught with a reason that names the key and never repeats the value', () => {
  const bad = {
    TURSO_DATABASE_URL: 'postgres://secretmarker1@example.test/db', CRON_SECRET: 'secretmarker2 has spaces and is short', SLACK_BOT_TOKEN: 'xoxp-secretmarker3',
    SLACK_BOT_USER_ID: 'secretmarker4', SLACK_BOT_ID: 'Usecretmarker5', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'secretmarker6',
    SLACK_ROUTE_MAP_JSON: '{"nobody":{"channelId":"Dsecretmarker7","type":"im"}}', INTERVIEWER_EMAILS_JSON: '{"not-an-email":"secretmarker8"}',
    GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"authorized_user","secretmarker9":1}',
  };
  const { problems } = validateSecrets({ ...valid(), ...bad });
  const keys = ['TURSO_DATABASE_URL', 'CRON_SECRET', 'SLACK_BOT_TOKEN', 'SLACK_BOT_USER_ID', 'SLACK_BOT_ID', 'UNCLE_SAM_AUTOMATIC_ACTIVITY', 'SLACK_ROUTE_MAP_JSON', 'INTERVIEWER_EMAILS_JSON', 'GOOGLE_SERVICE_ACCOUNT_JSON'];
  for (const key of keys) assert.ok(problems.some(problem => problem.startsWith(`${key}:`)), `${key} flagged`);
  assert.equal(problems.length, keys.length, 'one problem per bad key and nothing else');
  assert.equal(/secretmarker/.test(problems.join('\n')), false, 'no value leaks into a message');
  for (const [key, value] of [['SLACK_ROUTE_MAP_JSON', '{'], ['SLACK_ROUTE_MAP_JSON', '{}'], ['SLACK_ROUTE_MAP_JSON', '[]'],
    ['SLACK_ROUTE_MAP_JSON', '{"project":{"channelId":"DMASON0001","type":"mpim"}}'], ['CRON_SECRET', 'x'.repeat(31)], ['CRON_SECRET', `${'x'.repeat(40)} `]]) {
    assert.ok(validateSecrets({ ...valid(), [key]: value }).problems.some(problem => problem.startsWith(`${key}:`)), `${key}=${value.slice(0, 20)}`);
  }
});

test('UNCLE_SAM_CALENDAR_FLOOR: needs a date, time and zone; a future time is refused; only a real value is deployed', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const run = value => validateSecrets({ ...valid(), UNCLE_SAM_CALENDAR_FLOOR: value }, { now });
  assert.deepEqual(run('2026-10-15T11:20:00Z').problems, []);
  assert.equal(run('2026-10-15T11:20:00Z').values.UNCLE_SAM_CALENDAR_FLOOR, '2026-10-15T11:20:00Z');
  assert.deepEqual(run('2026-10-15T04:20:00-07:00').problems, []);
  assert.deepEqual(run('2026-10-15T12:04:00Z').problems, [], 'a few minutes ahead is clock slack, not a mistake');
  for (const bad of ['2026-10-15', '2026-10-15 11:20', '2026-10-15T11:20:00', 'yesterday', '2026-13-45T11:20:00Z', '1760527200000'])
    assert.deepEqual(run(bad).problems.map(problem => problem.split(':')[0]), ['UNCLE_SAM_CALENDAR_FLOOR'], bad);
  const future = run('2099-01-01T00:00:00Z').problems;
  assert.equal(future.length, 1); assert.match(future[0], /^UNCLE_SAM_CALENDAR_FLOOR: is in the future/); assert.equal(/2099/.test(future[0]), false, 'the value is not repeated');
  assert.equal('UNCLE_SAM_CALENDAR_FLOOR' in validateSecrets(valid(), { now }).values, false, 'unset deploys nothing');
  assert.equal('UNCLE_SAM_CALENDAR_FLOOR' in run('<empty until cutover>').values, false, 'a placeholder deploys nothing');
  assert.ok(OPTIONAL.includes('UNCLE_SAM_CALENDAR_FLOOR'));
});

test('UNCLE_SAM_QA is "off" or "enabled", UNCLE_SAM_QA_ASKERS lists Slack user IDs, and both are deployed only when filled in', () => {
  const qaProblems = secrets => validateSecrets(secrets).problems.filter(problem => problem.startsWith('UNCLE_SAM_QA'));
  assert.ok(OPTIONAL.includes('UNCLE_SAM_QA') && OPTIONAL.includes('UNCLE_SAM_QA_ASKERS'));
  assert.deepEqual(qaProblems({ UNCLE_SAM_QA: 'enabled', UNCLE_SAM_QA_ASKERS: 'U0F9EF97D89, U0CB213D6D6' }), []);
  assert.deepEqual(qaProblems({ UNCLE_SAM_QA: 'off' }), []);
  assert.deepEqual(qaProblems({ UNCLE_SAM_QA: '<off or enabled>', UNCLE_SAM_QA_ASKERS: '<optional: Slack user IDs>' }), []);
  assert.deepEqual(qaProblems({ UNCLE_SAM_QA: 'on' }), ['UNCLE_SAM_QA: must be "off" or "enabled"']);
  assert.deepEqual(qaProblems({ UNCLE_SAM_QA: 'Enabled' }), ['UNCLE_SAM_QA: must be "off" or "enabled"']);
  for (const askers of ['project', 'U0F9EF97D89;U0CB213D6D6', 'U0F9EF97D89 U0CB213D6D6', ',,']) {
    assert.deepEqual(qaProblems({ UNCLE_SAM_QA_ASKERS: askers }), ['UNCLE_SAM_QA_ASKERS: list Slack user IDs separated by commas, like U0F9EF97D89,U0CB213D6D6'], askers);
  }
  const { values } = validateSecrets({ UNCLE_SAM_QA: 'enabled', UNCLE_SAM_QA_ASKERS: 'U0F9EF97D89', UNCLE_SAM_CALENDAR_FLOOR: '<later>' });
  assert.deepEqual(values, { UNCLE_SAM_QA: 'enabled', UNCLE_SAM_QA_ASKERS: 'U0F9EF97D89' });
});

test('databaseFromIntegration: the Turso integration owns the two TURSO_* keys, so the file need not hold them (but a bad one is still caught)', () => {
  assert.deepEqual(TURSO_KEYS, ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']);
  assert.ok(TURSO_KEYS.every(key => REQUIRED.includes(key)));
  const { TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, ...rest } = valid();
  assert.deepEqual(validateSecrets(rest).problems, ['TURSO_DATABASE_URL: missing', 'TURSO_AUTH_TOKEN: missing']);
  assert.deepEqual(validateSecrets(rest, { databaseFromIntegration: true }).problems, []);
  assert.deepEqual(Object.keys(validateSecrets(rest, { databaseFromIntegration: true }).values).sort(), Object.keys(rest).sort());
  assert.deepEqual(validateSecrets({ ...rest, TURSO_DATABASE_URL: 'postgres://nope' }, { databaseFromIntegration: true }).problems, ['TURSO_DATABASE_URL: must start with libsql://']);
  const stillMissing = validateSecrets({}, { databaseFromIntegration: true }).problems.map(problem => problem.split(':')[0]);
  assert.equal(stillMissing.some(key => TURSO_KEYS.includes(key)), false);
  assert.equal(stillMissing.length, REQUIRED.length - TURSO_KEYS.length, 'every other required key is still required');
});

// ---------------------------------------------------------------------------------------------------------------
// Smoke-test helpers
// ---------------------------------------------------------------------------------------------------------------
test('the signature the setup check sends is exactly what the server verifies', async () => {
  const secret = 'fixture-signing-secret';
  const body = JSON.stringify({ type: 'url_verification', challenge: 'uncle-sam-setup-check' });
  const timestamp = 1791948000;
  const headers = signSlackBody({ secret, body, timestamp });
  assert.deepEqual(headers, { 'x-slack-request-timestamp': '1791948000',
    'x-slack-signature': `v0=${createHmac('sha256', secret).update(`v0:1791948000:${body}`).digest('hex')}` });
  const config = { signingSecret: secret, allowedAppIds: [APP_ID], allowedTeamIds: [TEAM_ID], now: () => timestamp * 1000 };
  const request = signature => new Request('https://uncle-sam.example/api/slack/events', { method: 'POST', body,
    headers: { 'content-type': 'application/json', ...signSlackBody({ secret: signature, body, timestamp }) } });
  const accepted = await handleSlackRequest(request(secret), config);
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { challenge: 'uncle-sam-setup-check' });
  assert.equal((await handleSlackRequest(request('another-secret'), config)).status, 401);
  assert.match(signSlackBody({ secret, body })['x-slack-request-timestamp'], /^\d{10}$/, 'defaults to the current time in seconds');
});

test('Vercel Deployment Protection is told apart from Uncle Sam answering', () => {
  const headers = init => new Headers(init);
  const html = '<!doctype html><title>Authentication Required</title>';
  assert.equal(looksLikeProtectionWall({ status: 401, headers: headers({ server: 'Vercel', 'content-type': 'text/html; charset=utf-8' }), text: html }), true);
  assert.equal(looksLikeProtectionWall({ status: 401, headers: headers({ 'x-vercel-id': 'iad1::abc', 'set-cookie': '_vercel_sso_nonce=1' }), text: '' }), true);
  assert.equal(looksLikeProtectionWall({ status: 403, headers: headers({ server: 'Vercel', 'content-type': 'text/html' }), text: html }), true);
  assert.equal(looksLikeProtectionWall({ status: 401, headers: headers({ server: 'Vercel', 'content-type': 'application/json', 'www-authenticate': 'Bearer' }), text: '{"error":"unauthorized"}' }), false, 'our own 401');
  assert.equal(looksLikeProtectionWall({ status: 200, headers: headers({ server: 'Vercel', 'content-type': 'text/html' }), text: html }), false);
  assert.equal(looksLikeProtectionWall({ status: 401, headers: headers({ 'content-type': 'text/html' }), text: html }), false, 'not a Vercel response');
});

// ---------------------------------------------------------------------------------------------------------------
// Drift guards: the files that must agree with each other
// ---------------------------------------------------------------------------------------------------------------
test('the example secrets file lists every setting, defaults to automatic activity OFF and is rejected until filled in', () => {
  const example = readJson('.env.secrets.example.json');
  const keys = Object.keys(example.secrets);
  for (const key of REQUIRED) assert.ok(keys.includes(key), `${key} is in the example file`);
  for (const key of keys) assert.ok([...REQUIRED, ...OPTIONAL].includes(key), `${key} is a known setting`);
  assert.equal(example.secrets.UNCLE_SAM_AUTOMATIC_ACTIVITY, 'off', 'the shipped default is the safe one');
  assert.match(example.secrets.ANTHROPIC_MODEL, /^[a-z0-9.-]{3,80}$/i);
  const { problems } = validateSecrets(example.secrets);
  for (const key of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'CRON_SECRET', 'SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'SLACK_BOT_USER_ID', 'SLACK_BOT_ID', 'NOTION_TOKEN', 'ANTHROPIC_API_KEY']) {
    assert.ok(problems.includes(`${key}: missing`), `${key} must be filled in before use`);
  }
  assert.ok(problems.some(problem => problem.startsWith('SLACK_ROUTE_MAP_JSON')), 'the route map template (D…/G… placeholders) is not accepted as is');
  assert.equal(problems.some(problem => problem.startsWith('INTERVIEWER_EMAILS_JSON')), false, 'the interviewer map in the example is valid');
});

test('the Slack app and workspace ids are the same everywhere they are written down', () => {
  assert.equal(APP_ID, 'A09DDB3817C'); assert.equal(TEAM_ID, 'T07011B7862');
  for (const file of ['service/lib/config.ts', 'service/lib/slack-dispatch.mjs']) {
    const text = read(file);
    assert.match(text, new RegExp(`APP_ID = '${APP_ID}'`), `${file} APP_ID`);
    assert.match(text, new RegExp(`TEAM_ID = '${TEAM_ID}'`), `${file} TEAM_ID`);
  }
  assert.match(read('.env.secrets.example.json'), new RegExp(APP_ID));
  assert.match(read('.env.secrets.example.json'), new RegExp(TEAM_ID));
});

test('vercel.json, package.json and the api folder agree', () => {
  const vercel = readJson('vercel.json');
  assert.equal(vercel.framework, null);
  for (const cron of vercel.crons) {
    assert.ok(existsSync(new URL(`${cron.path.slice(1)}.js`, root)), `${cron.path} has a function file`);
    assert.match(cron.schedule, /^\S+ \S+ \S+ \S+ \S+$/);
  }
  assert.deepEqual(vercel.crons.map(cron => cron.path), ['/api/cron/tick', '/api/cron/followups', '/api/cron/sourcing']);
  const pkg = readJson('package.json');
  assert.equal(pkg.type, 'module'); assert.equal(pkg.engines.node, '22.x');
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned to an exact version`);
  for (const [name, command] of Object.entries(pkg.scripts)) {
    const target = /node (?:--test )?(scripts\/[\w-]+\.mjs|test\/\*\.test\.mjs)/.exec(command)?.[1];
    assert.ok(target, `${name} runs a node script`);
    if (!target.includes('*')) assert.ok(existsSync(new URL(target, root)), `${name} -> ${target} exists`);
  }
  for (const route of ['api/slack/events.js', 'api/notion/webhook.js', 'api/portal/webhook.js', 'api/health.js', 'api/cron/tick.js']) {
    assert.ok(existsSync(new URL(route, root)), route);
  }
});

test('secrets can neither be committed nor uploaded to Vercel by accident', () => {
  const gitignore = read('.gitignore').split('\n').map(line => line.trim());
  assert.ok(gitignore.includes('.env*'));
  assert.ok(gitignore.indexOf('!.env.secrets.example.json') > gitignore.indexOf('.env*'), 'only the example file is un-ignored, after the broad rule');
  assert.equal(gitignore.filter(line => line.startsWith('!')).length, 1, 'nothing else is un-ignored');
  assert.ok(gitignore.includes('node_modules/') && gitignore.includes('.vercel/') && gitignore.includes('.local/'));
  const vercelignore = read('.vercelignore').split('\n').map(line => line.trim());
  for (const entry of ['.git', '.env*', '.local', 'node_modules', 'test']) assert.ok(vercelignore.includes(entry), `.vercelignore lists ${entry}`);
});

test('the model needs one key: OpenRouter\'s can stand in for Anthropic\'s, its model name is checked, and a placeholder line changes nothing', () => {
  const { ANTHROPIC_API_KEY, ...withoutAnthropic } = valid();
  assert.deepEqual(validateSecrets(withoutAnthropic).problems, ['ANTHROPIC_API_KEY: missing'], 'with neither key the model key is reported missing');
  const viaOpenRouter = { ...withoutAnthropic, OPENROUTER_API_KEY: 'sk-or-v1-fixture-key-value-0123456789' };
  const ok = validateSecrets(viaOpenRouter);
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.values.OPENROUTER_API_KEY, viaOpenRouter.OPENROUTER_API_KEY, 'the pasted key is deployed under its own name');
  assert.equal('ANTHROPIC_API_KEY' in ok.values, false);
  assert.deepEqual(validateSecrets({ ...viaOpenRouter, OPENROUTER_MODEL: 'anthropic/claude-sonnet-5.5' }).problems, []);
  assert.deepEqual(validateSecrets({ ...viaOpenRouter, OPENROUTER_MODEL: 'claude-sonnet-5-5' }).problems, ['OPENROUTER_MODEL: use a name like anthropic/claude-sonnet-5.5']);
  assert.deepEqual(validateSecrets({ ...valid(), OPENROUTER_API_KEY: '<optional alternative to ANTHROPIC_API_KEY>' }).problems, [], 'an unfilled placeholder is not a key');
  assert.deepEqual(validateSecrets({ ...withoutAnthropic, OPENROUTER_API_KEY: '<optional alternative to ANTHROPIC_API_KEY>' }).problems, ['ANTHROPIC_API_KEY: missing']);
  assert.ok(OPTIONAL.includes('OPENROUTER_API_KEY') && OPTIONAL.includes('OPENROUTER_MODEL') && REQUIRED.includes('ANTHROPIC_API_KEY'));
});

test('probeModel sends the service\'s own prompt and tools with an automatic tool choice over a synthetic event, and reports without echoing the reply', async () => {
  const seen = [];
  const client = { async complete(request) {
    seen.push(request);
    return { model: 'fixture-model', stopReason: 'tool_use', servedBy: 'Anthropic', usage: { input: 10, output: 5 },
      content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'propose', input: { kind: 'no_action', reason: 'SECRET_SENTINEL' } }] };
  } };
  let now = 1000;
  const result = await probeModel(client, { clock: () => (now += 250) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].system, POLICY_DIGEST); assert.deepEqual(seen[0].tools, TOOLS); assert.deepEqual(seen[0].toolChoice, { type: 'auto' });
  assert.match(seen[0].messages[0].content, /SYNTHETIC CONNECTION CHECK/);
  assert.equal(seen[0].messages.length, 1); assert.equal(seen[0].messages[0].role, 'user');
  assert.deepEqual(result, { ms: 250, model: 'fixture-model', stopReason: 'tool_use', calls: ['propose'], proposed: 'no_action', usage: { input: 10, output: 5 }, servedBy: 'Anthropic' });
  assert.equal(JSON.stringify(result).includes('SECRET_SENTINEL'), false, 'the model\'s words are not part of the report');
  const readFirst = await probeModel({ complete: async () => ({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'lookup_candidate', input: {} }] }) });
  assert.deepEqual([readFirst.calls, readFirst.proposed, readFirst.model, readFirst.servedBy], [['lookup_candidate'], null, null, null]);
  const talked = await probeModel({ complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'hello' }] }) });
  assert.deepEqual([talked.calls, talked.proposed], [[], null], 'a reply with no tool call is reported as such, not as a proposal');
  await assert.rejects(probeModel({ complete: async () => { throw new Error('claude_http_400'); } }), /claude_http_400/);
});
