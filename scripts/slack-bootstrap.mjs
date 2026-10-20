#!/usr/bin/env node
/**
 * Uncle Sam · Slack bootstrap. Uses the bot token in the gitignored .env.secrets.json (never printed).
 *
 *   node scripts/slack-bootstrap.mjs                      verify the token (workspace, app, bot), write SLACK_BOT_USER_ID and
 *                                                         SLACK_BOT_ID, and compare the app's scopes with what Uncle Sam needs
 *   node scripts/slack-bootstrap.mjs --open               also look up the six people, check each really is who they should be,
 *                                                         open the direct and group conversations (Slack creates each one if it
 *                                                         does not exist and posts nothing), verify their exact members, and
 *                                                         write SLACK_ROUTE_MAP_JSON. Run it only with Project's explicit OK.
 *   node scripts/slack-bootstrap.mjs [--open] --dry-run   do the read-only checks, print the plan, write and open nothing
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ID, TEAM_ID } from '../service/lib/identity.mjs';
import { slackWire } from '../service/lib/slack-wire.mjs';
import { PEOPLE } from '../service/lib/agent-runner.mjs';
import { isPlaceholder } from '../service/lib/setup-checks.mjs';
import { parseScopes, scopeReport, checkPerson, routePlan, expectedMembers, buildRouteMapJson, PEOPLE_KEYS } from '../service/lib/slack-setup.mjs';
import { isIgnored, writePrivate } from './lib/local-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// UNCLE_SAM_SECRETS_FILE and UNCLE_SAM_SLACK_API_BASE (this computer only) let the tests point at other files and a fake Slack.
const secretsPath = process.env.UNCLE_SAM_SECRETS_FILE ? path.resolve(process.env.UNCLE_SAM_SECRETS_FILE) : path.join(root, '.env.secrets.json');
const args = process.argv.slice(2);
const open = args.includes('--open');
const dry = args.includes('--dry-run');
const log = (...parts) => console.log(...parts);
const fail = message => { console.error(`✗ ${message}`); process.exit(1); };

if (args.some(arg => !['--open', '--dry-run'].includes(arg))) fail('Usage: node scripts/slack-bootstrap.mjs [--open] [--dry-run]');

const apiBase = (() => {
  const override = process.env.UNCLE_SAM_SLACK_API_BASE;
  if (!override) return 'https://slack.com/api';
  let url;
  try { url = new URL(override); } catch { return fail('UNCLE_SAM_SLACK_API_BASE is not a URL.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('UNCLE_SAM_SLACK_API_BASE may only point at this computer (http://127.0.0.1:<port>/api).');
  return override.replace(/\/$/, '');
})();

function readSecretsDoc() {
  if (!existsSync(secretsPath)) fail('Missing .env.secrets.json — copy .env.secrets.example.json and fill it in.');
  if (!isIgnored(root, secretsPath, /^\.env\*\s*$/m)) fail('.env.secrets.json is not gitignored; refusing to continue.');
  let doc;
  try { doc = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch { return fail('.env.secrets.json is not valid JSON.'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('.env.secrets.json must be a JSON object.');
  doc.secrets = doc.secrets && typeof doc.secrets === 'object' ? doc.secrets : {};
  return doc;
}
/** Re-reads the file right before writing so an edit made while this script ran is not lost. */
function updateSecrets(patch) {
  const doc = readSecretsDoc();
  Object.assign(doc.secrets, patch);
  writePrivate(secretsPath, `${JSON.stringify(doc, null, 2)}\n`);
}

const token = readSecretsDoc().secrets.SLACK_BOT_TOKEN;
if (isPlaceholder(token) || !/^xoxb-[A-Za-z0-9-]+$/.test(token)) fail('SLACK_BOT_TOKEN is missing or is not a bot token (xoxb-…). Paste it into PASTE-SECRETS-HERE.txt and run `npm run setup:import` first.');

/** Same request encoding as the running service (service/lib/slack-wire.mjs: a form, except JSON for chat.postMessage; bearer token). Error messages carry only Slack's error code. */
async function slack(method, params = {}) {
  let response;
  try {
    response = await fetch(`${apiBase}/${method}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), ...slackWire(method, token, params) });
  } catch (error) { throw new Error(`${method}: could not reach Slack (${error?.cause?.code ?? error?.name ?? 'network error'})`); }
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error(`${method}: unreadable response`); }
  if (body?.ok !== true) throw new Error(`${method}: ${/^[a-z_]{2,40}$/.test(String(body?.error)) ? body.error : 'failed'}`);
  return { body, headers: response.headers };
}

async function main() {
  // 1. Is this token really Uncle Sam's bot in Company's workspace?
  const { body: identity, headers } = await slack('auth.test');
  if (identity.team_id !== TEAM_ID) fail('This token belongs to a different Slack workspace than Company AI; nothing was changed.');
  const { body: { bot } } = await slack('bots.info', { bot: identity.bot_id });
  if (bot?.app_id !== APP_ID || bot.user_id !== identity.user_id || bot.deleted !== false) fail(`This token belongs to a different Slack app than Uncle Sam (${APP_ID}); nothing was changed.`);
  log(`✓ Slack token: workspace ${identity.team_id}, app ${bot.app_id}, bot user ${identity.user_id}, bot ${identity.bot_id}`);

  // 2. Scopes
  const header = headers.get('x-oauth-scopes');
  if (header == null) log('• Slack did not report scopes for this token; skipping the scope comparison.');
  else {
    const scopes = scopeReport(parseScopes(header));
    if (scopes.missingRuntime.length) fail(`The Slack app is missing scopes the service needs: ${scopes.missingRuntime.join(', ')}. Add them under OAuth & Permissions and reinstall the app (Project approves the reinstall), then paste the new bot token.`);
    log(`✓ scopes: every scope the service needs is present${scopes.missingOpen.length ? `; missing ${scopes.missingOpen.join(', ')} (only needed to open conversations)` : ' (including the two for opening conversations)'}`);
    if (scopes.unused.length) log(`• granted but not used by Uncle Sam: ${scopes.unused.join(', ')}`);
    if (open && scopes.missingOpen.length) fail(`Opening conversations needs ${scopes.missingOpen.join(', ')}. Add them under OAuth & Permissions and reinstall the app (Project approves the reinstall), then paste the new bot token.`);
  }

  // 3. The bot ids
  if (dry) log('• dry run: SLACK_BOT_USER_ID and SLACK_BOT_ID were not written.');
  else { updateSecrets({ SLACK_BOT_USER_ID: identity.user_id, SLACK_BOT_ID: identity.bot_id }); log('✓ wrote SLACK_BOT_USER_ID and SLACK_BOT_ID'); }
  if (!open) return;

  // 4. The six people: the ids in the code must be the people they are supposed to be.
  log('People (looked up in Slack):');
  let allMatch = true;
  for (const person of PEOPLE_KEYS) {
    const { body: { user } } = await slack('users.info', { user: PEOPLE[person] });
    const verdict = checkPerson(person, user);
    log(`  ${verdict.ok ? '✓' : '✗'} ${person.padEnd(8)} ${PEOPLE[person]}  ${verdict.names[0] ?? '(no name)'}${verdict.ok ? '' : `  — ${verdict.reason}`}`);
    allMatch &&= verdict.ok;
  }
  if (!allMatch) fail('At least one Slack id does not match who it should be. No conversation was opened and nothing was written; tell Project which line failed.');

  // 5. The conversations
  const plan = routePlan();
  const distinct = [...new Map(plan.map(route => [route.userIds.slice().sort().join(','), route])).values()];
  log(`Conversations (${plan.length} routes, ${distinct.length} distinct; ${dry ? 'dry run, nothing will be opened' : 'Slack posts nothing when it opens one'}):`);
  for (const route of plan) log(`  ${route.key.padEnd(20)} ${route.type.padEnd(4)} ${route.people.join(' + ')} + bot`);
  if (dry) return;
  const channels = new Map();
  for (const route of distinct) {
    const { body: { channel } } = await slack('conversations.open', { users: route.userIds.join(','), return_im: false });
    if (typeof channel?.id !== 'string') fail(`Slack did not return a conversation for ${route.people.join(' + ')}; nothing was written.`);
    const { body: { channel: info } } = await slack('conversations.info', { channel: channel.id });
    if (info?.id !== channel.id || info.is_archived || info.is_shared || info.is_ext_shared || info.is_org_shared || (route.type === 'im' ? info.is_im !== true : info.is_mpim !== true)) {
      fail(`The conversation for ${route.people.join(' + ')} is not a private ${route.type === 'im' ? 'direct message' : 'group DM'} inside Company's workspace; nothing was written.`);
    }
    const members = [];
    let cursor;
    for (let page = 0; page < 5; page++) {
      const { body } = await slack('conversations.members', { channel: channel.id, limit: 200, ...(cursor ? { cursor } : {}) });
      members.push(...body.members);
      cursor = body.response_metadata?.next_cursor?.trim();
      if (!cursor) break;
    }
    if (cursor || JSON.stringify([...new Set(members)].sort()) !== JSON.stringify(expectedMembers(route, identity.user_id))) {
      fail(`The conversation for ${route.people.join(' + ')} does not have exactly those people plus the bot; nothing was written.`);
    }
    channels.set(route.userIds.slice().sort().join(','), channel.id);
  }
  const opened = plan.map(route => ({ key: route.key, type: route.type, channelId: channels.get(route.userIds.slice().sort().join(',')) }));
  updateSecrets({ SLACK_ROUTE_MAP_JSON: buildRouteMapJson(opened) });
  log(`✓ opened and verified ${distinct.length} conversations (exact members); wrote SLACK_ROUTE_MAP_JSON with ${opened.length} routes`);
  for (const route of opened) log(`  ${route.key.padEnd(20)} ${route.type.padEnd(4)} ${route.channelId}`);
}

try { await main(); } catch (error) { fail(String(error?.message ?? error).slice(0, 300)); }
