#!/usr/bin/env node
/**
 * Uncle Sam · Vercel setup helper. Reads ./.env.secrets.json (gitignored) and prints key NAMES and pass/fail only.
 *
 *   node scripts/setup.mjs check [--probe-model] validate the file, then test Slack, Notion, the model key (Anthropic or OpenRouter) and Turso (read-only;
 *                                                --probe-model adds one tiny real model call shaped like the service's own, over a synthetic event)
 *   node scripts/setup.mjs env [--dry-run]       load every value into the linked Vercel project as Production variables
 *                                                (not TURSO_*: with "databaseFromIntegration": true the Marketplace integration owns those)
 *   node scripts/setup.mjs verify <https://…> [--signed] [--tick]
 *                                                smoke-test a deployed URL: health, rejection of unsigned/unauthorized calls,
 *                                                (--signed) a signed Slack url_verification, (--tick) one real tick
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTROL_PAGE_ID, NOTION_API_VERSION } from '../service/lib/notion-wake.mjs';
import { createTursoClient } from '../service/lib/turso.mjs';
import { loadMigrationFiles, pendingMigrations } from '../service/lib/migrate.mjs';
import { validateSecrets, signSlackBody, looksLikeProtectionWall, probeModel, TURSO_KEYS } from '../service/lib/setup-checks.mjs';
import { createClaudeClient, ClaudeError } from '../service/lib/anthropic.mjs';
import { llmSettingsOf } from '../service/lib/runtime.mjs';
import { isIgnored as gitIgnores } from './lib/local-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// UNCLE_SAM_SECRETS_FILE lets the tests (and anyone with the file elsewhere) point at a different secrets file.
const secretsPath = process.env.UNCLE_SAM_SECRETS_FILE ? path.resolve(process.env.UNCLE_SAM_SECRETS_FILE) : path.join(root, '.env.secrets.json');
const [command = 'help', ...rest] = process.argv.slice(2);
const flag = name => rest.includes(name);
const log = (...parts) => console.log(...parts);
const fail = message => { console.error(`✗ ${message}`); process.exit(1); };

const isIgnored = file => gitIgnores(root, file, /^\.env\*\s*$/m);

function loadSecrets() {
  if (!existsSync(secretsPath)) fail('Missing .env.secrets.json — copy .env.secrets.example.json and fill it in.');
  if (!isIgnored(secretsPath)) fail('.env.secrets.json is not gitignored; refusing to continue.');
  let file;
  try { file = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch { fail('.env.secrets.json is not valid JSON.'); }
  // "databaseFromIntegration": true means the Turso integration in the Vercel Marketplace owns TURSO_DATABASE_URL / TURSO_AUTH_TOKEN:
  // the file need not hold them, `env` never pushes them, and `check` / `db-migrate` read them from the environment
  // (`vercel env pull <file> --environment production`, then `node --env-file=<file> scripts/…`).
  const integration = file.vercel?.databaseFromIntegration === true;
  const { problems, values } = validateSecrets(file.secrets ?? {}, { databaseFromIntegration: integration });
  if (problems.length) fail(`Secrets file problems:\n  - ${problems.join('\n  - ')}`);
  const owned = integration ? TURSO_KEYS : [];
  for (const key of owned) if (process.env[key]) values[key] = process.env[key];
  log(`✓ secrets file: ${Object.keys(values).length} keys set (${Object.keys(values).join(', ')}); automatic activity = ${values.UNCLE_SAM_AUTOMATIC_ACTIVITY}`);
  if (integration) log(`✓ database keys are owned by the Turso integration in Vercel (${owned.filter(key => values[key]).length} of ${owned.length} found in this environment); \`env\` will not push them`);
  const scope = typeof file.vercel?.scope === 'string' && !/^<.*>$/.test(file.vercel.scope.trim()) ? file.vercel.scope.trim() : null;
  return { values, scope, owned };
}

// Plain-language reasons for the model API's HTTP statuses. The client never keeps response bodies, so the status is all there is.
const LLM_HINTS = {
  400: 'the request was rejected; check the model name',
  401: 'the key was rejected (a typo, or it was deleted)',
  402: "out of credit, or the key's spending limit is used up",
  403: 'the key is disabled or access is blocked',
  404: "model name not found, or the account's privacy settings leave no Anthropic endpoint to use",
  429: 'rate limited; run it again in a minute',
};
const llmFailure = error => (error instanceof ClaudeError ? (LLM_HINTS[error.status] ? `${error.code} — ${LLM_HINTS[error.status]}` : error.code) : 'unexpected error');

async function check(values) {
  const llm = llmSettingsOf(values);
  if (!llm) fail('No model key: set ANTHROPIC_API_KEY, or OPENROUTER_API_KEY as the alternative.');
  if (values.ANTHROPIC_API_KEY && values.OPENROUTER_API_KEY) log('! Both model keys are set. The service uses Anthropic\'s own and ignores OPENROUTER_API_KEY.');
  const attempt = async (label, fn) => {
    try { const detail = await fn(); log(`✓ ${label}${detail ? ` — ${detail}` : ''}`); return true; }
    catch (error) { console.error(`✗ ${label} — ${error.message}`); return false; }
  };
  if (values.GOOGLE_SERVICE_ACCOUNT_JSON && values.GOOGLE_CALENDAR_IDS && !values.UNCLE_SAM_CALENDAR_FLOOR) {
    log('! Calendar interview prompts will stay off (and each tick reports calendar_floor_unset) until UNCLE_SAM_CALENDAR_FLOOR is set at cutover. See DEPLOY-VERCEL.md.');
  }
  if (values.UNCLE_SAM_QA === 'enabled' && values.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled') {
    log('! @-mention questions stay off until UNCLE_SAM_AUTOMATIC_ACTIVITY is "enabled" too. See DEPLOY-VERCEL.md, section 14.');
  }
  const results = await Promise.all([
    attempt('Slack bot token', async () => {
      const r = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${values.SLACK_BOT_TOKEN}` } });
      const body = await r.json();
      if (!body.ok) throw new Error(`auth.test failed (${body.error ?? r.status})`);
      if (body.team_id !== 'T07011B7862') throw new Error('token belongs to another workspace');
      if (body.user_id !== values.SLACK_BOT_USER_ID || body.bot_id !== values.SLACK_BOT_ID) throw new Error(`SLACK_BOT_USER_ID/SLACK_BOT_ID do not match auth.test (${body.user_id}/${body.bot_id})`);
      return `workspace ok, bot ${body.user_id}`;
    }),
    attempt('Notion integration can read the control row', async () => {
      const r = await fetch(`https://api.notion.com/v1/pages/${CONTROL_PAGE_ID}`, { headers: { authorization: `Bearer ${values.NOTION_TOKEN}`, 'notion-version': NOTION_API_VERSION } });
      if (!r.ok) throw new Error(`HTTP ${r.status} — share "Uncle Sam Operations" and the Recruiting database with the integration`);
      const page = await r.json();
      return `Mode ${page.properties?.Mode?.select?.name ?? '?'}`;
    }),
    attempt(llm.route === 'openrouter' ? 'OpenRouter key and model' : 'Anthropic key and model', async () => {
      if (llm.route === 'openrouter') {
        // OpenRouter has no free "does this model work for me" call, so this is one tiny real request through the service's own client.
        const client = createClaudeClient(llm);
        try { await client.complete({ system: 'Connection check. Reply with the single word OK.', messages: [{ role: 'user', content: 'ping' }], maxTokens: 256 }); }
        catch (error) { throw new Error(llmFailure(error)); }
        return `${client.model}, pinned to Anthropic's own endpoint`;
      }
      const model = values.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
      const r = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, { headers: { 'x-api-key': values.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
      if (r.status === 401) throw new Error('key rejected');
      if (r.status === 404) throw new Error(`model "${model}" not found — set ANTHROPIC_MODEL to a current model id`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return model;
    }),
    attempt('Turso database reachable', async () => {
      if (!values.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL is not in this environment — pull it (`vercel env pull <file> --environment production`) and run `node --env-file=<file> scripts/setup.mjs check`');
      const client = await createTursoClient(values);
      try {
        await client.execute('SELECT 1');
        const pending = await pendingMigrations(client, loadMigrationFiles(path.join(root, 'service/drizzle')));
        return pending.length ? `${pending.length} migration(s) pending — run \`npm run db:migrate\`` : 'schema up to date';
      } finally { client.close?.(); }
    }),
  ]);
  if (flag('--probe-model')) {
    results.push(await attempt(`Model probe over the ${llm.route} route (one tiny real call, synthetic event)`, async () => {
      const client = createClaudeClient(llm);
      let probe;
      try { probe = await probeModel(client); } catch (error) { throw new Error(llmFailure(error)); }
      if (probe.stopReason === 'max_tokens') throw new Error('the reply ran out of output tokens before it finished (thinking counts toward the limit)');
      if (probe.stopReason === 'refusal') throw new Error('the model declined the synthetic request');
      const tokens = probe.usage ? `${probe.usage.input ?? '?'} in / ${probe.usage.output ?? '?'} out tokens` : 'token counts not reported';
      return `${client.model}${probe.servedBy ? ` served by ${probe.servedBy}` : ''}: ${(probe.ms / 1000).toFixed(1)} s${probe.ms > 40000 ? ' (close to the 60 s the service allows per call)' : ''}, `
        + `stop_reason ${probe.stopReason}, ${probe.calls.length ? `called ${probe.calls.join(', ')}` : 'no tool call (the runner would nudge it)'}${probe.proposed ? `, proposed ${probe.proposed}` : ''}, ${tokens}`;
    }));
  }
  if (results.includes(false)) fail('Preflight failed; nothing was changed.');
  log(flag('--probe-model') ? 'Preflight passed. Nothing was changed (the model probe cost a fraction of a cent).' : 'Preflight passed. Nothing was changed.');
}

function vercelCommand() {
  const direct = spawnSync('vercel', ['--version'], { encoding: 'utf8' });
  return direct.status === 0 ? ['vercel'] : ['npx', '--yes', 'vercel'];
}

function pushEnv({ values, scope, owned = [] }) {
  const dry = flag('--dry-run');
  if (!dry && !existsSync(path.join(root, '.vercel', 'project.json'))) fail('This folder is not linked to a Vercel project. Run `vercel link` here first, then re-run.');
  const [bin, ...base] = vercelCommand();
  for (const [key, value] of Object.entries(values)) {
    if (owned.includes(key)) { log(`skipped ${key} (owned by the Turso integration)`); continue; }
    if (dry) { log(`would set ${key} (production)`); continue; }
    const args = [...base, 'env', 'add', key, 'production', '--force', '--yes', ...(scope ? ['--scope', scope] : [])];
    const r = spawnSync(bin, args, { cwd: root, input: value, encoding: 'utf8' });
    if (r.status !== 0) fail(`vercel env add ${key} failed: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' | ')}`);
    log(`✓ ${key}`);
  }
  log(dry ? 'Dry run: nothing was sent to Vercel.' : 'Variables set for Production. They apply to new deployments only: run `vercel deploy --prod` (or redeploy in the dashboard).');
}

async function verify(target) {
  // https for real deployments; plain http only for a server on this machine (npm run dev).
  if (!/^(https:\/\/[^/\s]+|http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?)\/?$/.test(target ?? '')) fail('Usage: node scripts/setup.mjs verify https://<production-domain> [--signed] [--tick]');
  const base = target.replace(/\/$/, '');
  const call = async (pathname, init = {}) => {
    const r = await fetch(`${base}${pathname}`, { redirect: 'manual', ...init });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text };
  };
  let ok = true;
  const expect = (label, pass, detail = '') => { log(`${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); if (!pass) ok = false; };
  const health = await call('/api/health');
  if (looksLikeProtectionWall(health)) {
    fail('Vercel Deployment Protection is answering instead of Uncle Sam. Use the production domain, and in Project → Settings → Deployment Protection choose "Standard Protection" so production stays reachable by Slack/Notion (or add an automation bypass).');
  }
  let body = null;
  try { body = JSON.parse(health.text); } catch { /* reported below */ }
  expect('GET /api/health', health.status === 200 && body?.service === 'Uncle Sam', `HTTP ${health.status}`);
  if (body) {
    const c = body.configuration ?? {};
    log(`  host=${body.host} phase=${body.phase} automaticActions=${body.automaticActionsEnabled} database=${c.database}/reachable=${c.databaseReachable} slackSigning=${c.slackSigning} slackBot=${c.slackBot} notion=${c.notion} llm=${c.llm ?? 'unknown'}${c.model ? `/${c.model}` : ''} cron=${c.cron} routes=${c.routes ?? 'unknown'}${c.routeMapValid === false ? ' (route map invalid)' : ''}`);
    log(`  inbound: notionWebhook=${c.notionWebhook} portalWebhook=${c.portalWebhook} calendar=${c.calendar} calendarIds=${c.calendarIds} interviewerEmails=${c.interviewerEmails}`);
    expect('database reachable from the deployment', c.databaseReachable === true);
  }
  const unsigned = await call('/api/slack/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"url_verification","challenge":"x"}' });
  expect('POST /api/slack/events without a Slack signature is refused', [400, 401, 403].includes(unsigned.status), `HTTP ${unsigned.status}`);
  const tickDenied = await call('/api/cron/tick');
  expect('GET /api/cron/tick without the cron secret is refused', [401, 503].includes(tickDenied.status), `HTTP ${tickDenied.status}`);
  const portal = await call('/api/portal/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect('POST /api/portal/webhook without the portal secret is refused', [401, 503].includes(portal.status), `HTTP ${portal.status}`);
  if (flag('--signed') || flag('--tick')) {
    const { values } = loadSecrets();
    if (flag('--signed')) {
      const payload = JSON.stringify({ type: 'url_verification', challenge: 'uncle-sam-setup-check' });
      const signed = await call('/api/slack/events', { method: 'POST', headers: { 'content-type': 'application/json', ...signSlackBody({ secret: values.SLACK_SIGNING_SECRET, body: payload }) }, body: payload });
      let answer = null; try { answer = JSON.parse(signed.text); } catch { /* handled below */ }
      expect('signed Slack url_verification is answered', signed.status === 200 && answer?.challenge === 'uncle-sam-setup-check', `HTTP ${signed.status}`);
    }
    if (flag('--tick')) {
      const tick = await call('/api/cron/tick', { headers: { authorization: `Bearer ${values.CRON_SECRET}` } });
      let summary = null; try { summary = JSON.parse(tick.text); } catch { /* handled below */ }
      expect('authorized tick runs', tick.status === 200 && summary?.ok === true, `HTTP ${tick.status}${summary ? ` status=${summary.status} reason=${summary.reason} mode=${summary.mode} events=${summary.events} prompts=${summary.prompts} dispatched=${summary.dispatched} errors=${summary.errors}` : ''}`);
    }
  }
  if (!ok) fail('Some checks failed.');
  log('All checks passed.');
}

if (command === 'check') { const { values } = loadSecrets(); await check(values); }
else if (command === 'env') pushEnv(loadSecrets());
else if (command === 'verify') await verify(rest.find(arg => !arg.startsWith('--')));
else log('Usage: node scripts/setup.mjs <check [--probe-model] | env [--dry-run] | verify <https://domain> [--signed] [--tick]>   (see DEPLOY-VERCEL.md)');
