#!/usr/bin/env node
/**
 * Uncle Sam · deploy to Company's own Cloudflare account.
 *
 *   node scripts/deploy.mjs                 build, create/reuse D1, deploy, apply migrations, upload secrets, health-check
 *   node scripts/deploy.mjs --secrets-only  only re-upload secrets from .env.secrets.json (e.g. flipping UNCLE_SAM_AUTOMATIC_ACTIVITY)
 *   node scripts/deploy.mjs --check         preflight only (file shape, Slack/Notion/Anthropic credentials), nothing deployed
 *   node scripts/deploy.mjs --skip-build    reuse the existing dist/ output
 *
 * Reads ./.env.secrets.json (gitignored). Prints key NAMES and pass/fail only — never a value.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseRouteMap, parseInterviewerEmails } from '../lib/runtime.mjs';
import { CONTROL_PAGE_ID, NOTION_API_VERSION } from '../lib/notion-wake.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const flag = name => args.has(name);
const secretsPath = path.join(root, '.env.secrets.json');
const REQUIRED = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'SLACK_BOT_USER_ID', 'SLACK_BOT_ID', 'BRIDGE_MCP_TOKEN', 'NOTION_TOKEN',
  'ANTHROPIC_API_KEY', 'SLACK_ROUTE_MAP_JSON', 'UNCLE_SAM_AUTOMATIC_ACTIVITY'];
const OPTIONAL = ['ANTHROPIC_MODEL', 'NOTION_WEBHOOK_SECRET', 'PORTAL_WEBHOOK_SECRET', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_IDS',
  'GOOGLE_IMPERSONATE_SUBJECT', 'INTERVIEWER_EMAILS_JSON'];
const log = (...parts) => console.log(...parts);
const fail = message => { console.error(`✗ ${message}`); process.exit(1); };
const placeholder = value => typeof value !== 'string' || !value.trim() || /^<.*>$/.test(value.trim());

function loadSecrets() {
  if (!existsSync(secretsPath)) fail(`Missing ${path.relative(root, secretsPath)} — copy .env.secrets.example.json and fill it in.`);
  const ignored = spawnSync('git', ['check-ignore', '-q', secretsPath], { cwd: root });
  if (ignored.status !== 0) fail('.env.secrets.json is not gitignored; refusing to continue.');
  let file;
  try { file = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch { fail('.env.secrets.json is not valid JSON.'); }
  const secrets = file.secrets ?? {};
  const problems = [];
  for (const key of REQUIRED) if (placeholder(secrets[key])) problems.push(`${key}: missing`);
  if (!/^xoxb-[A-Za-z0-9-]+$/.test(secrets.SLACK_BOT_TOKEN ?? '')) problems.push('SLACK_BOT_TOKEN: must start with xoxb-');
  if (!/^[UW][A-Z0-9]+$/.test(secrets.SLACK_BOT_USER_ID ?? '')) problems.push('SLACK_BOT_USER_ID: must look like U…');
  if (!/^B[A-Z0-9]+$/.test(secrets.SLACK_BOT_ID ?? '')) problems.push('SLACK_BOT_ID: must look like B…');
  if (!['off', 'enabled'].includes(secrets.UNCLE_SAM_AUTOMATIC_ACTIVITY)) problems.push('UNCLE_SAM_AUTOMATIC_ACTIVITY: must be "off" or "enabled"');
  if ((secrets.BRIDGE_MCP_TOKEN ?? '').length < 32) problems.push('BRIDGE_MCP_TOKEN: use at least 32 random characters');
  try { if (Object.keys(parseRouteMap(secrets.SLACK_ROUTE_MAP_JSON)).length < 1) problems.push('SLACK_ROUTE_MAP_JSON: at least one route required'); }
  catch { problems.push('SLACK_ROUTE_MAP_JSON: invalid (see .env.secrets.example.json)'); }
  if (!placeholder(secrets.INTERVIEWER_EMAILS_JSON)) { try { parseInterviewerEmails(secrets.INTERVIEWER_EMAILS_JSON); } catch { problems.push('INTERVIEWER_EMAILS_JSON: invalid'); } }
  if (!placeholder(secrets.GOOGLE_SERVICE_ACCOUNT_JSON)) { try { if (JSON.parse(secrets.GOOGLE_SERVICE_ACCOUNT_JSON).type !== 'service_account') throw 0; } catch { problems.push('GOOGLE_SERVICE_ACCOUNT_JSON: not a service-account JSON string'); } }
  const cloud = file.cloudflare ?? {};
  if (!flag('--check') && (placeholder(cloud.accountId) || placeholder(cloud.apiToken))) problems.push('cloudflare.accountId / cloudflare.apiToken: missing');
  if (problems.length) fail(`Secrets file problems:\n  - ${problems.join('\n  - ')}`);
  const upload = {};
  for (const key of [...REQUIRED, ...OPTIONAL]) if (!placeholder(secrets[key])) upload[key] = String(secrets[key]);
  log(`✓ secrets file: ${Object.keys(upload).length} keys set (${Object.keys(upload).join(', ')}); automatic activity = ${upload.UNCLE_SAM_AUTOMATIC_ACTIVITY}`);
  return { cloud, worker: { name: file.worker?.name || 'uncle-sam', d1DatabaseName: file.worker?.d1DatabaseName || 'uncle-sam' }, upload };
}

async function preflight(upload) {
  const check = async (label, fn) => { try { const detail = await fn(); log(`✓ ${label}${detail ? ` — ${detail}` : ''}`); return true; } catch (error) { console.error(`✗ ${label} — ${error.message}`); return false; } };
  const results = await Promise.all([
    check('Slack bot token', async () => {
      const r = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { authorization: `Bearer ${upload.SLACK_BOT_TOKEN}` } });
      const body = await r.json();
      if (!body.ok) throw new Error(`auth.test failed (${body.error ?? r.status})`);
      if (body.team_id !== 'T07011B7862') throw new Error('token belongs to another workspace');
      if (body.user_id !== upload.SLACK_BOT_USER_ID || body.bot_id !== upload.SLACK_BOT_ID) throw new Error(`SLACK_BOT_USER_ID/SLACK_BOT_ID do not match auth.test (${body.user_id}/${body.bot_id})`);
      return `workspace ok, bot ${body.user_id}`;
    }),
    check('Notion integration can read the control row', async () => {
      const r = await fetch(`https://api.notion.com/v1/pages/${CONTROL_PAGE_ID}`, { headers: { authorization: `Bearer ${upload.NOTION_TOKEN}`, 'notion-version': NOTION_API_VERSION } });
      if (!r.ok) throw new Error(`HTTP ${r.status} — share "Uncle Sam Operations" and the Recruiting database with the integration`);
      const page = await r.json();
      return `Mode ${page.properties?.Mode?.select?.name ?? '?'}`;
    }),
    check('Anthropic key and model', async () => {
      const model = upload.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
      const r = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, { headers: { 'x-api-key': upload.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
      if (r.status === 401) throw new Error('key rejected');
      if (r.status === 404) throw new Error(`model "${model}" not found — set ANTHROPIC_MODEL to a current model id`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return model;
    }),
  ]);
  if (results.includes(false)) fail('Preflight failed; nothing was deployed.');
}

function wrangler(cloud, argv, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...argv], {
    cwd: root, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: cloud.apiToken, CLOUDFLARE_ACCOUNT_ID: cloud.accountId, WRANGLER_SEND_METRICS: 'false',
      WRANGLER_LOG_PATH: path.join(root, '.wrangler/logs'), CI: 'true' } });
  if (result.status !== 0) fail(`wrangler ${argv[0]} ${argv[1] ?? ''} failed${capture ? `: ${(result.stderr || result.stdout || '').trim().split('\n').slice(-5).join(' | ')}` : ''}`);
  return result.stdout ?? '';
}

function ensureDatabase(cloud, name) {
  const listed = wrangler(cloud, ['d1', 'list', '--json'], { capture: true });
  let databases = [];
  try { databases = JSON.parse(listed); } catch { fail('could not parse `wrangler d1 list --json`'); }
  const found = databases.find(db => db.name === name);
  if (found) { log(`✓ D1 database "${name}" exists (${found.uuid})`); return found.uuid; }
  log(`… creating D1 database "${name}"`);
  const created = wrangler(cloud, ['d1', 'create', name], { capture: true });
  const uuid = created.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (!uuid) fail('D1 create did not return an id');
  log(`✓ D1 database "${name}" created (${uuid})`);
  return uuid;
}

function patchedConfig(worker, databaseId) {
  const source = path.join(root, 'dist/server/wrangler.json');
  if (!existsSync(source)) fail('dist/server/wrangler.json missing — run without --skip-build');
  const config = JSON.parse(readFileSync(source, 'utf8'));
  config.name = worker.name;
  config.d1_databases = [{ binding: 'DB', database_name: worker.d1DatabaseName, database_id: databaseId, migrations_dir: '../../drizzle' }];
  config.triggers = config.triggers?.crons?.length ? config.triggers : { crons: ['*/5 * * * *'] };
  config.observability = { enabled: true };
  delete config.dev;
  const target = path.join(root, 'dist/server/wrangler.deploy.json');
  writeFileSync(target, JSON.stringify(config, null, 2));
  log(`✓ wrote ${path.relative(root, target)} (worker ${config.name}, D1 ${worker.d1DatabaseName}, cron ${config.triggers.crons.join(' ')})`);
  return target;
}

function uploadSecrets(cloud, configPath, upload) {
  mkdirSync(path.join(root, '.wrangler'), { recursive: true });
  const tmp = path.join(root, '.wrangler', `secrets-${randomBytes(6).toString('hex')}.json`);
  writeFileSync(tmp, JSON.stringify(upload), { mode: 0o600 });
  try { wrangler(cloud, ['secret', 'bulk', tmp, '--config', configPath]); }
  finally { rmSync(tmp, { force: true }); }
  log(`✓ ${Object.keys(upload).length} secrets uploaded`);
}

async function healthCheck(url) {
  const health = await fetch(`${url}/api/health`).then(r => r.json()).catch(error => ({ error: error.message }));
  log('health:', JSON.stringify(health));
  const bridge = await fetch(`${url}/api/bridge/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  log(`bridge without token: HTTP ${bridge?.status ?? 'n/a'} (expect 401)`);
}

const { cloud, worker, upload } = loadSecrets();
await preflight(upload);
if (flag('--check')) { log('Preflight passed. Nothing deployed.'); process.exit(0); }
if (!existsSync(path.join(root, 'node_modules/wrangler/bin/wrangler.js'))) fail('wrangler not installed — run npm install in service/');
const databaseId = ensureDatabase(cloud, worker.d1DatabaseName);
if (!flag('--secrets-only') && !flag('--skip-build')) {
  log('… building');
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) fail('build failed');
}
const configPath = patchedConfig(worker, databaseId);
let url = process.env.UNCLE_SAM_URL || null;
if (!flag('--secrets-only')) {
  log('… deploying');
  const output = wrangler(cloud, ['deploy', '--config', configPath], { capture: true });
  process.stdout.write(output);
  url ??= output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;
  log('… applying D1 migrations (idempotent)');
  wrangler(cloud, ['d1', 'migrations', 'apply', worker.d1DatabaseName, '--remote', '--config', configPath]);
}
uploadSecrets(cloud, configPath, upload);
if (!url) {
  const listed = wrangler(cloud, ['deployments', 'list', '--config', configPath], { capture: true });
  url = listed.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0] ?? null;
}
if (url) { log(`✓ worker URL ${url}`); await healthCheck(url); }
else log('ℹ could not infer the workers.dev URL; open the Cloudflare dashboard → Workers → uncle-sam → Settings → Domains & Routes.');
log(`
Next steps (see DEPLOY.md):
  1. Slack app A09DDB3817C → Event Subscriptions → Request URL: ${url ?? '<worker url>'}/api/slack/events (then re-save; bot events: message.im, message.mpim).
  2. Notion integration → Webhooks → ${url ?? '<worker url>'}/api/notion/webhook; copy the verification token from \`wrangler tail\` into NOTION_WEBHOOK_SECRET; run --secrets-only.
  3. Portal (Interviewer): POST ${url ?? '<worker url>'}/api/portal/webhook with header x-uncle-sam-secret.
  4. Flip UNCLE_SAM_AUTOMATIC_ACTIVITY to "enabled" in .env.secrets.json and run --secrets-only; the Notion control row (Mode Off/Test/Live) remains the operating switch.`);
