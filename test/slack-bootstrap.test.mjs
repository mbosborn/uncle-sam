import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PEOPLE, ROUTE_RECIPIENTS } from '../service/lib/agent-runner.mjs';
import { APP_ID, TEAM_ID } from '../service/lib/identity.mjs';
import { parseRouteMap } from '../service/lib/runtime.mjs';
import { validateSecrets } from '../service/lib/setup-checks.mjs';
import { RUNTIME_SCOPES, OPEN_SCOPES, parseScopes, scopeReport, checkPerson, routePlan, expectedMembers, buildRouteMapJson } from '../service/lib/slack-setup.mjs';
import { parseSlackBody } from './support/slack-wire.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'slack-bootstrap.mjs');
const exec = promisify(execFile);
const dirs = [];
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'uncle-sam-slack-')); dirs.push(dir); return dir; };
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const TOKEN = ['xoxb', '1'.repeat(10), '2'.repeat(10), 'fixture'.repeat(5)].join('-');
const BOT_USER = 'U0BOTFIXTURE';
const BOT_ID = 'B0BOTFIXTURE';
const NAMES = { project: 'Project Owner', jamie: 'Jamie Fixture', aa: 'Rory Marshall', robin: 'Robin Fixture', alexis: 'Alexis Fixture', interviewer: 'J Quinn Foster' };

/** A pretend Slack Web API on 127.0.0.1 that reads arguments the way the real one does (a form for these methods; a JSON body is ignored, see test/support/slack-wire.mjs). */
async function fakeSlack(options = {}) {
  const calls = [];
  const settings = { team: TEAM_ID, appId: APP_ID, scopes: [...RUNTIME_SCOPES, ...OPEN_SCOPES, 'groups:history', 'groups:read'], scopeHeader: true,
    names: { ...NAMES }, userOverrides: {}, extraMember: null, shared: false, failOn: {}, ...options };
  const users = Object.fromEntries(Object.entries(PEOPLE).map(([person, id]) => [id, { id, name: person, real_name: settings.names[person], team_id: TEAM_ID, deleted: false, is_bot: false,
    profile: { display_name: settings.names[person].split(' ')[0] }, ...(settings.userOverrides[person] ?? {}) }]));
  const channels = new Map();
  const send = (response, body, headers = {}) => { response.writeHead(200, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(body)); };
  const server = http.createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const method = request.url.replace(/^\/api\//, '');
      const { args: params } = parseSlackBody(method, request.headers['content-type'], raw);
      calls.push({ method, params, authorization: request.headers.authorization, contentType: request.headers['content-type'] });
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(response, { ok: false, error: 'invalid_auth' });
      if (settings.failOn[method]) return send(response, { ok: false, error: settings.failOn[method] });
      if (method === 'auth.test') return send(response, { ok: true, team_id: settings.team, user_id: BOT_USER, bot_id: BOT_ID }, settings.scopeHeader ? { 'x-oauth-scopes': settings.scopes.join(',') } : {});
      if (method === 'bots.info') return send(response, { ok: true, bot: { id: params.bot, user_id: BOT_USER, app_id: settings.appId, deleted: false } });
      if (method === 'users.info') return users[params.user] ? send(response, { ok: true, user: users[params.user] }) : send(response, { ok: false, error: 'user_not_found' });
      if (method === 'conversations.open') {
        const ids = params.users.split(',').sort();
        const key = ids.join(',');
        if (!channels.has(key)) channels.set(key, { id: `${ids.length === 1 ? 'D' : 'G'}${String(channels.size + 1).padStart(3, '0')}FIXTURE`, ids });
        return send(response, { ok: true, channel: { id: channels.get(key).id } });
      }
      const entry = [...channels.values()].find(item => item.id === params.channel);
      if (method === 'conversations.info') return entry ? send(response, { ok: true, channel: { id: entry.id, is_im: entry.ids.length === 1, is_mpim: entry.ids.length > 1, is_archived: false, is_shared: settings.shared } }) : send(response, { ok: false, error: 'channel_not_found' });
      if (method === 'conversations.members') return entry ? send(response, { ok: true, members: [...entry.ids, BOT_USER, ...(settings.extraMember && entry.ids.length === 2 ? [settings.extraMember] : [])] }) : send(response, { ok: false, error: 'channel_not_found' });
      return send(response, { ok: false, error: 'unknown_method' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { calls, url: `http://127.0.0.1:${server.address().port}/api`, close: () => new Promise(resolve => server.close(resolve)),
    methods: () => calls.map(call => call.method) };
}

const baseSecrets = (overrides = {}) => ({ vercel: { scope: '<optional>' }, secrets: { SLACK_BOT_TOKEN: TOKEN, CRON_SECRET: 'c'.repeat(40), UNCLE_SAM_AUTOMATIC_ACTIVITY: 'off',
  SLACK_BOT_USER_ID: '<U… bot user id>', SLACK_BOT_ID: '<B… bot id>', ...overrides } });

async function run(args, { slack, secrets = baseSecrets(), env = {} } = {}) {
  const dir = tmp();
  const file = path.join(dir, 'secrets.json');
  writeFileSync(file, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  let result;
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { cwd: os.tmpdir(), timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, UNCLE_SAM_SECRETS_FILE: file, ...(slack ? { UNCLE_SAM_SLACK_API_BASE: slack.url } : {}), ...env } });
    result = { code: 0, stdout, stderr };
  } catch (error) { result = { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  return { ...result, output: result.stdout + result.stderr, file, doc: () => JSON.parse(readFileSync(file, 'utf8')) };
}

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------
test('scopes: the report separates what the service needs, what only opening conversations needs, and what Uncle Sam never uses', () => {
  assert.deepEqual(parseScopes(' chat:write, im:read ,,'), ['chat:write', 'im:read']);
  assert.deepEqual(parseScopes(null), []);
  const granted = parseScopes('chat:write,groups:history,groups:read,im:history,im:read,im:write,mpim:history,mpim:read,mpim:write,users:read');
  assert.deepEqual(scopeReport(granted), { missingRuntime: [], missingOpen: [], unused: ['groups:history', 'groups:read'] });
  assert.deepEqual(scopeReport(['chat:write']).missingRuntime, ['im:history', 'im:read', 'mpim:history', 'mpim:read', 'users:read']);
  assert.deepEqual(scopeReport(RUNTIME_SCOPES).missingOpen, ['im:write', 'mpim:write']);
});

test('people: an id only passes when Slack says it is that person, active, human and in Company’s workspace', () => {
  const user = (person, extra = {}) => ({ id: PEOPLE[person], name: person, real_name: NAMES[person], team_id: TEAM_ID, ...extra });
  for (const person of Object.keys(PEOPLE)) assert.equal(checkPerson(person, user(person)).ok, true, person);
  assert.match(checkPerson('aa', user('aa', { real_name: 'Rowan Brooks', name: 'rowan.brooks' })).reason, /does not match who aa should be/, 'AA is Rory Marshall, never Rowan Brooks');
  assert.match(checkPerson('project', user('jamie')).reason, /different user id/);
  assert.match(checkPerson('robin', user('robin', { deleted: true })).reason, /deactivated/);
  assert.match(checkPerson('robin', user('robin', { is_bot: true })).reason, /bot/);
  assert.match(checkPerson('robin', user('robin', { team_id: 'T0OTHER' })).reason, /another workspace/);
  assert.equal(checkPerson('interviewer', user('interviewer')).ok, true, 'Interviewer appears in Slack as J Quinn Foster');
  assert.equal(checkPerson('nobody', {}).ok, false);
  assert.equal(checkPerson('project', undefined).ok, false);
});

test('routes: eight routes, a group DM exactly when two people are involved, and the member set includes the bot once', () => {
  const plan = routePlan();
  assert.deepEqual(plan.map(route => route.key), Object.keys(ROUTE_RECIPIENTS).filter(k => !k.startsWith('group_')));
  assert.equal(plan.length, 8);
  for (const route of plan) {
    assert.equal(route.type, route.people.length === 2 ? 'mpim' : 'im', route.key);
    assert.deepEqual(route.userIds, route.people.map(person => PEOPLE[person]));
  }
  assert.deepEqual(expectedMembers(plan.find(route => route.key === 'jamie_group'), BOT_USER), [BOT_USER, PEOPLE.jamie, PEOPLE.project].sort());
  assert.deepEqual(expectedMembers(plan.find(route => route.key === 'project'), PEOPLE.project), [PEOPLE.project], 'the bot is not counted twice');
  const opened = plan.map((route, index) => ({ key: route.key, type: route.type, channelId: `${route.type === 'im' ? 'D' : 'G'}0000${index}ABC` }));
  assert.deepEqual(Object.keys(parseRouteMap(buildRouteMapJson(opened))), Object.keys(ROUTE_RECIPIENTS).filter(k => !k.startsWith('group_')));
  assert.throws(() => buildRouteMapJson([{ key: 'project', type: 'mpim', channelId: 'D1ABC' }]), /invalid_route_map/);
  assert.throws(() => buildRouteMapJson([{ key: 'project', type: 'im', channelId: 'not-a-channel' }]), /invalid_route_map/);
});

// ---------------------------------------------------------------------------------------------------------------
// The script, against a pretend Slack
// ---------------------------------------------------------------------------------------------------------------
test('default run: verifies workspace, app and bot, writes the two bot ids, compares scopes, and touches no conversation', async () => {
  const slack = await fakeSlack();
  try {
    const r = await run([], { slack });
    assert.equal(r.code, 0, r.output);
    assert.match(r.stdout, new RegExp(`✓ Slack token: workspace ${TEAM_ID}, app ${APP_ID}, bot user ${BOT_USER}, bot ${BOT_ID}`));
    assert.match(r.stdout, /✓ scopes: every scope the service needs is present \(including the two for opening conversations\)/);
    assert.match(r.stdout, /• granted but not used by Uncle Sam: groups:history, groups:read/);
    assert.match(r.stdout, /✓ wrote SLACK_BOT_USER_ID and SLACK_BOT_ID/);
    assert.equal(r.output.includes(TOKEN), false, 'the token is never printed');
    const secrets = r.doc().secrets;
    assert.equal(secrets.SLACK_BOT_USER_ID, BOT_USER);
    assert.equal(secrets.SLACK_BOT_ID, BOT_ID);
    assert.equal(secrets.SLACK_BOT_TOKEN, TOKEN);
    assert.equal(secrets.CRON_SECRET, 'c'.repeat(40), 'other settings are untouched');
    assert.equal(statSync(r.file).mode & 0o777, 0o600);
    assert.deepEqual(slack.methods(), ['auth.test', 'bots.info']);
    assert.ok(slack.calls.every(call => call.authorization === `Bearer ${TOKEN}` && call.contentType === 'application/x-www-form-urlencoded'), 'a form with a bearer token, like the service');
  } finally { await slack.close(); }
});

test('default run refuses another workspace, another app, a missing scope, or a rejected token, and writes nothing', async () => {
  const cases = [
    [{ team: 'T0OTHERTEAM' }, /different Slack workspace/],
    [{ appId: 'A0OTHERAPP' }, /different Slack app than Uncle Sam/],
    [{ scopes: ['chat:write', 'im:read'] }, /missing scopes the service needs: im:history, mpim:history, mpim:read, users:read/],
    [{ failOn: { 'auth.test': 'invalid_auth' } }, /auth\.test: invalid_auth/],
    [{ failOn: { 'bots.info': 'missing_scope' } }, /bots\.info: missing_scope/],
  ];
  for (const [options, expected] of cases) {
    const slack = await fakeSlack(options);
    try {
      const r = await run([], { slack });
      assert.equal(r.code, 1, JSON.stringify(options));
      assert.match(r.stderr, expected, JSON.stringify(options));
      assert.equal(r.output.includes(TOKEN), false);
      assert.equal(r.doc().secrets.SLACK_BOT_USER_ID, '<U… bot user id>', 'nothing was written');
    } finally { await slack.close(); }
  }
  const quiet = await fakeSlack({ scopeHeader: false });
  try {
    const r = await run([], { slack: quiet });
    assert.equal(r.code, 0, r.output);
    assert.match(r.stdout, /Slack did not report scopes for this token; skipping the scope comparison/);
  } finally { await quiet.close(); }
});

test('opening conversations needs its two scopes, and without them nothing is opened', async () => {
  const slack = await fakeSlack({ scopes: [...RUNTIME_SCOPES] });
  try {
    const plain = await run([], { slack });
    assert.equal(plain.code, 0, plain.output);
    assert.match(plain.stdout, /missing im:write, mpim:write \(only needed to open conversations\)/);
    const opened = await run(['--open'], { slack });
    assert.equal(opened.code, 1);
    assert.match(opened.stderr, /Opening conversations needs im:write, mpim:write/);
    assert.equal(slack.methods().includes('conversations.open'), false);
  } finally { await slack.close(); }
});

test('--open --dry-run checks the people, prints the plan, and writes and opens nothing', async () => {
  const slack = await fakeSlack();
  try {
    const r = await run(['--open', '--dry-run'], { slack });
    assert.equal(r.code, 0, r.output);
    assert.match(r.stdout, /✓ project\s+U0F9EF97D89\s+Project Owner/);
    assert.match(r.stdout, /✓ aa\s+U0BF89D1279\s+Rory Marshall/);
    assert.match(r.stdout, /✓ interviewer\s+U030A09DBFF\s+J Quinn Foster/);
    assert.match(r.stdout, /Conversations \(8 routes, 7 distinct; dry run, nothing will be opened\)/);
    assert.match(r.stdout, /jamie_group\s+mpim\s+project \+ jamie \+ bot/);
    assert.match(r.stdout, /dry run: SLACK_BOT_USER_ID and SLACK_BOT_ID were not written/);
    assert.equal(slack.methods().filter(method => method === 'users.info').length, 6);
    for (const method of ['conversations.open', 'conversations.info', 'conversations.members']) assert.equal(slack.methods().includes(method), false, method);
    assert.equal(r.doc().secrets.SLACK_ROUTE_MAP_JSON, undefined);
    assert.equal(r.doc().secrets.SLACK_BOT_USER_ID, '<U… bot user id>');
  } finally { await slack.close(); }
});

test('--open opens each distinct conversation once, verifies its exact members, and writes a route map the service accepts', async () => {
  const slack = await fakeSlack();
  try {
    const r = await run(['--open'], { slack });
    assert.equal(r.code, 0, r.output);
    assert.match(r.stdout, /✓ opened and verified 7 conversations \(exact members\); wrote SLACK_ROUTE_MAP_JSON with 8 routes/);
    const opens = slack.calls.filter(call => call.method === 'conversations.open');
    assert.equal(opens.length, 7, 'interviewer and interviewer_santosh share one conversation');
    assert.deepEqual(opens.map(call => call.params.users.split(',').length).sort(), [1, 1, 1, 1, 1, 2, 2]);
    assert.equal(opens.every(call => call.params.return_im === 'false'), true);
    assert.equal(slack.methods().some(method => method === 'chat.postMessage'), false, 'nothing is posted');
    const secrets = r.doc().secrets;
    const map = parseRouteMap(secrets.SLACK_ROUTE_MAP_JSON);
    assert.deepEqual(Object.keys(map), Object.keys(ROUTE_RECIPIENTS).filter(k => !k.startsWith('group_')));
    assert.equal(map.interviewer.channelId, map.interviewer_santosh.channelId);
    assert.equal(map.jamie_group.type, 'mpim');
    assert.equal(map.aa_group.type, 'mpim');
    assert.notEqual(map.jamie_group.channelId, map.aa_group.channelId);
    assert.equal(secrets.SLACK_BOT_USER_ID, BOT_USER);
    const { problems } = validateSecrets({ ...secrets, TURSO_DATABASE_URL: 'libsql://x.turso.io', TURSO_AUTH_TOKEN: 'eyJfixturefixturefixturefixture', SLACK_SIGNING_SECRET: 'a'.repeat(32),
      NOTION_TOKEN: 'ntn_fixture', ANTHROPIC_API_KEY: 'sk-ant-fixture' });
    assert.deepEqual(problems, [], 'with the other values in place the file is complete');
    assert.equal(r.output.includes(TOKEN), false);
    // Opening again is harmless: the same conversations come back and the same map is written.
    const again = await run(['--open'], { slack, secrets: r.doc() });
    assert.equal(again.code, 0, again.output);
    assert.equal(again.doc().secrets.SLACK_ROUTE_MAP_JSON, secrets.SLACK_ROUTE_MAP_JSON);
  } finally { await slack.close(); }
});

test('--open stops before opening anything when a Slack id is not who it should be', async () => {
  const cases = [
    [{ names: { ...NAMES, aa: 'Rowan Brooks' } }, /✗ aa\s+U0BF89D1279\s+Rowan Brooks\s+— the name \(Rowan Brooks\) does not match who aa should be/],
    [{ userOverrides: { jamie: { deleted: true } } }, /✗ jamie .*deactivated/],
    [{ userOverrides: { alexis: { is_bot: true } } }, /✗ alexis .*bot/],
  ];
  for (const [options, expected] of cases) {
    const slack = await fakeSlack(options);
    try {
      const r = await run(['--open'], { slack });
      assert.equal(r.code, 1, JSON.stringify(options));
      assert.match(r.stdout, expected, JSON.stringify(options));
      assert.match(r.stderr, /No conversation was opened and nothing was written/);
      assert.equal(slack.methods().includes('conversations.open'), false, 'no conversation was opened');
      assert.equal(r.doc().secrets.SLACK_ROUTE_MAP_JSON, undefined);
    } finally { await slack.close(); }
  }
});

test('--open refuses a conversation with an unexpected member and does not write the route map', async () => {
  const slack = await fakeSlack({ extraMember: 'U0STRANGER1' });
  try {
    const r = await run(['--open'], { slack });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not have exactly those people plus the bot; nothing was written/);
    assert.equal(r.doc().secrets.SLACK_ROUTE_MAP_JSON, undefined);
  } finally { await slack.close(); }
  const shared = await fakeSlack({ shared: true });
  try {
    const r = await run(['--open'], { slack: shared });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not a private (direct message|group DM) inside Company's workspace; nothing was written/);
    assert.equal(r.doc().secrets.SLACK_ROUTE_MAP_JSON, undefined);
  } finally { await shared.close(); }
  const failing = await fakeSlack({ failOn: { 'conversations.open': 'missing_scope' } });
  try {
    const r = await run(['--open'], { slack: failing });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /conversations\.open: missing_scope/);
    assert.equal(r.doc().secrets.SLACK_ROUTE_MAP_JSON, undefined);
  } finally { await failing.close(); }
});

test('input guards: usage, a missing or placeholder token, files git would not ignore, and a Slack base that is not this computer', async () => {
  const slack = await fakeSlack();
  try {
    assert.match((await run(['--force'], { slack })).stderr, /Usage: node scripts\/slack-bootstrap\.mjs/);
    const placeholder = await run([], { slack, secrets: baseSecrets({ SLACK_BOT_TOKEN: '<xoxb-… from OAuth & Permissions>' }) });
    assert.equal(placeholder.code, 1);
    assert.match(placeholder.stderr, /SLACK_BOT_TOKEN is missing or is not a bot token/);
    const userToken = await run([], { slack, secrets: baseSecrets({ SLACK_BOT_TOKEN: 'xoxp-secretmarker-user-token' }) });
    assert.match(userToken.stderr, /not a bot token/);
    assert.equal(/secretmarker/.test(userToken.output), false);
    for (const base of ['https://slack.example.com/api', 'http://example.com/api', 'not a url']) {
      const remote = await run([], { env: { UNCLE_SAM_SLACK_API_BASE: base } });
      assert.equal(remote.code, 1, base);
      assert.match(remote.stderr, /UNCLE_SAM_SLACK_API_BASE (may only point at this computer|is not a URL)/, base);
    }
    assert.deepEqual(slack.calls, [], 'no request reached the fake Slack in the guard cases');
    const stray = path.join(root, 'test', `.not-ignored-slack-${process.pid}.json`);
    writeFileSync(stray, JSON.stringify(baseSecrets()));
    try {
      const strayRun = await run([], { slack, env: { UNCLE_SAM_SECRETS_FILE: stray } });
      assert.match(strayRun.stderr, /not gitignored; refusing to continue/);
      assert.deepEqual(slack.calls, []);
    } finally { rmSync(stray, { force: true }); }
  } finally { await slack.close(); }
  const unreachable = await run([], { env: { UNCLE_SAM_SLACK_API_BASE: 'http://127.0.0.1:9/api' } });
  assert.equal(unreachable.code, 1);
  assert.match(unreachable.stderr, /auth\.test: could not reach Slack/);
});
