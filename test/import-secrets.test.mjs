import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASTEABLE, PASTE_TEMPLATE, REQUIRED, OPTIONAL, parsePasteFile, planImport, blankPasteFile, validateSecrets } from '../service/lib/setup-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'import-secrets.mjs');
const exec = promisify(execFile);
const dirs = [];
const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'uncle-sam-import-')); dirs.push(dir); return dir; };
test.after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const GOOD = {
  SLACK_SIGNING_SECRET: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  SLACK_BOT_TOKEN: ['xoxb', '1'.repeat(10), '2'.repeat(10), 'fixture'.repeat(5)].join('-'),
  NOTION_TOKEN: 'ntn_fixtureNotionTokenValue0123456789abcdef',
  ANTHROPIC_API_KEY: 'sk-ant-api03-fixtureAnthropicKeyValue0123456789',
};
const pasteText = (values = GOOD) => `# header\n${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
const example = JSON.parse(readFileSync(path.join(root, '.env.secrets.example.json'), 'utf8'));

async function run(args = [], { paste, secrets, env = {} } = {}) {
  const dir = tmp();
  const pastePath = path.join(dir, 'PASTE-SECRETS-HERE.txt');
  const secretsPath = path.join(dir, '.env.secrets.json');
  if (paste !== null) writeFileSync(pastePath, paste ?? pasteText(), { mode: 0o600 });
  if (secrets !== null) writeFileSync(secretsPath, JSON.stringify(secrets ?? example, null, 2), { mode: 0o600 });
  let result;
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, ...args], { cwd: os.tmpdir(), timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, UNCLE_SAM_PASTE_FILE: pastePath, UNCLE_SAM_SECRETS_FILE: secretsPath, ...env } });
    result = { code: 0, stdout, stderr };
  } catch (error) { result = { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }; }
  const read = file => (existsSync(file) ? readFileSync(file, 'utf8') : null);
  return { ...result, output: result.stdout + result.stderr, pastePath, secretsPath, paste: () => read(pastePath), secrets: () => JSON.parse(read(secretsPath)).secrets, doc: () => JSON.parse(read(secretsPath)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------------------------
test('paste file parsing: comments, blank lines, CRLF, BOM, export, quotes and = inside values; bad lines are reported by number only', () => {
  const text = '﻿# comment\r\n\r\nSLACK_BOT_TOKEN = "xoxb-1-2-abc"\r\nexport NOTION_TOKEN=\'ntn_abc\'\r\n  ANTHROPIC_API_KEY=sk-ant-a=b=c  \r\nthis is not a pair\r\n“CURLY=1';
  const { entries, problems } = parsePasteFile(text);
  assert.deepEqual(entries, [
    { line: 3, key: 'SLACK_BOT_TOKEN', value: 'xoxb-1-2-abc' },
    { line: 4, key: 'NOTION_TOKEN', value: 'ntn_abc' },
    { line: 5, key: 'ANTHROPIC_API_KEY', value: 'sk-ant-a=b=c' },
  ]);
  assert.deepEqual(problems.map(problem => problem.line), [6, 7]);
  assert.equal(JSON.stringify(problems).includes('this is not'), false, 'the raw text is not echoed');
  assert.deepEqual(parsePasteFile('KEY=“wrapped”').entries[0].value, 'wrapped', 'curly quotes around a value are removed');
  assert.deepEqual(parsePasteFile(undefined), { entries: [], problems: [] });
});

// ---------------------------------------------------------------------------------------------------------------
// Planning an import
// ---------------------------------------------------------------------------------------------------------------
test('a clean paste imports the four values, generates CRON_SECRET once, and reports lengths only', () => {
  const plan = planImport(pasteText(), { ...example.secrets }, { generate: () => 'g'.repeat(64) });
  assert.deepEqual(plan.imported.map(item => item.key), Object.keys(GOOD));
  for (const item of plan.imported) assert.equal(item.length, GOOD[item.key].length);
  assert.deepEqual(plan.rejected, []);
  assert.deepEqual(plan.generated, ['CRON_SECRET']);
  assert.equal(plan.next.CRON_SECRET, 'g'.repeat(64));
  for (const [key, value] of Object.entries(GOOD)) assert.equal(plan.next[key], value);
  assert.equal(plan.next.UNCLE_SAM_AUTOMATIC_ACTIVITY, 'off', 'untouched settings stay as they were');
  const again = planImport(pasteText(), plan.next, { generate: () => { throw new Error('must not generate again'); } });
  assert.deepEqual(again.generated, []);
  assert.equal(again.next.CRON_SECRET, 'g'.repeat(64), 'an existing CRON_SECRET is kept');
  assert.match(planImport('', {}).next.CRON_SECRET, /^[0-9a-f]{64}$/, 'the default generator gives 256 random bits as hex');
});

test('values with the wrong shape are rejected by line and key, never echoed, and never reach the secrets', () => {
  const bad = {
    SLACK_SIGNING_SECRET: 'secretmarker1', SLACK_BOT_TOKEN: 'xoxp-secretmarker2-user-token-not-a-bot', NOTION_TOKEN: 'secretmarker3-not-a-notion-token',
    ANTHROPIC_API_KEY: 'sk-ant-secretmarker4 with spaces',
  };
  const plan = planImport(pasteText(bad), { ...example.secrets }, { generate: () => 'g'.repeat(64) });
  assert.deepEqual(plan.imported, []);
  assert.deepEqual(plan.rejected.map(item => item.key), Object.keys(bad));
  assert.deepEqual(plan.rejected.map(item => item.line), [2, 3, 4, 5]);
  assert.equal(/secretmarker/.test(JSON.stringify(plan.rejected)), false, 'no value leaks into a message');
  for (const key of Object.keys(bad)) assert.equal(plan.next[key], example.secrets[key], `${key} keeps its previous value`);
});

test('only the pasteable settings can be set from the paste file; the kill switch and Claude-owned settings cannot', () => {
  for (const key of PASTEABLE) assert.ok([...REQUIRED, ...OPTIONAL].includes(key), `${key} is a real setting`);
  for (const key of ['UNCLE_SAM_AUTOMATIC_ACTIVITY', 'CRON_SECRET', 'SLACK_BOT_USER_ID', 'SLACK_BOT_ID', 'SLACK_ROUTE_MAP_JSON', 'ANTHROPIC_MODEL', 'INTERVIEWER_EMAILS_JSON']) {
    assert.equal(PASTEABLE.includes(key), false, `${key} is not pasteable`);
  }
  const plan = planImport('UNCLE_SAM_AUTOMATIC_ACTIVITY=enabled\nSLACK_ROUTE_MAP_JSON={}\nTOTALLY_UNKNOWN=value12345\nlowercase_secret=value12345\n', { ...example.secrets });
  assert.equal(plan.next.UNCLE_SAM_AUTOMATIC_ACTIVITY, 'off');
  assert.deepEqual(plan.rejected.map(item => [item.line, item.key, item.reason]), [
    [1, 'UNCLE_SAM_AUTOMATIC_ACTIVITY', 'is not pasted here (Claude sets it)'],
    [2, 'SLACK_ROUTE_MAP_JSON', 'is not pasted here (Claude sets it)'],
    [3, 'TOTALLY_UNKNOWN', 'is not a setting Uncle Sam uses'],
    [4, null, 'is not a setting Uncle Sam uses'],
  ]);
});

test('blank and duplicate lines: blanks are "still empty", the last line for a key wins, earlier values are reported as replaced', () => {
  const plan = planImport(`SLACK_BOT_TOKEN=\nNOTION_TOKEN=\nSLACK_SIGNING_SECRET=${'0'.repeat(32)}\nSLACK_SIGNING_SECRET=${GOOD.SLACK_SIGNING_SECRET}\nSLACK_BOT_TOKEN=${GOOD.SLACK_BOT_TOKEN}\nPORTAL_WEBHOOK_SECRET=<fill me in later>\n`, {}, { generate: () => 'g'.repeat(64) });
  assert.deepEqual(plan.imported.map(item => item.key), ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN']);
  assert.equal(plan.next.SLACK_SIGNING_SECRET, GOOD.SLACK_SIGNING_SECRET);
  assert.deepEqual(plan.empty, ['NOTION_TOKEN', 'PORTAL_WEBHOOK_SECRET']);
  assert.deepEqual(plan.superseded, [{ line: 3, key: 'SLACK_SIGNING_SECRET' }]);
  assert.deepEqual(plan.rejected, []);
});

test('blanking keeps comments, other lines and line endings, and is idempotent', () => {
  const text = '# keep me\r\nSLACK_BOT_TOKEN=xoxb-secret\r\nexport NOTION_TOKEN = ntn_secret\r\nOTHER=value\r\nSLACK_BOT_TOKEN=xoxb-again';
  const blanked = blankPasteFile(text, ['SLACK_BOT_TOKEN', 'NOTION_TOKEN']);
  assert.equal(blanked, '# keep me\r\nSLACK_BOT_TOKEN=\r\nexport NOTION_TOKEN =\r\nOTHER=value\r\nSLACK_BOT_TOKEN=');
  assert.equal(blankPasteFile(blanked, ['SLACK_BOT_TOKEN', 'NOTION_TOKEN']), blanked);
  assert.equal(blankPasteFile(PASTE_TEMPLATE, PASTEABLE), PASTE_TEMPLATE, 'the template is already blank');
});

test('the template asks for the four values a person has to paste, plus the OpenRouter alternative to the model key, and nothing else', () => {
  const { entries, problems } = parsePasteFile(PASTE_TEMPLATE);
  assert.deepEqual(problems, []);
  assert.deepEqual(entries.map(entry => entry.key), ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'NOTION_TOKEN', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);
  assert.ok(entries.every(entry => entry.value === ''));
  assert.match(PASTE_TEMPLATE, /Never paste these into chat/);
  assert.match(PASTE_TEMPLATE, /only if you have no Anthropic key/);
  const needed = validateSecrets({}).problems.map(problem => problem.split(':')[0]);
  for (const entry of entries.filter(entry => entry.key !== 'OPENROUTER_API_KEY')) assert.ok(needed.includes(entry.key), `${entry.key} is a required setting`);
  assert.equal(needed.includes('OPENROUTER_API_KEY'), false, 'the OpenRouter line is an alternative, never a requirement');
});

// ---------------------------------------------------------------------------------------------------------------
// The command-line script
// ---------------------------------------------------------------------------------------------------------------
test('import: merges the values into the secrets file (private mode, other settings kept), blanks the paste file, prints no value', async () => {
  const r = await run();
  assert.equal(r.code, 0, 'the import itself succeeded even though other values are still needed');
  assert.equal(r.output.includes('✗'), false, r.output);
  assert.match(r.stdout, /✓ imported SLACK_SIGNING_SECRET \(32 characters\)/);
  assert.match(r.stdout, /✓ generated CRON_SECRET/);
  assert.match(r.stdout, /✓ blanked the imported values in PASTE-SECRETS-HERE\.txt/);
  assert.match(r.stdout, /Imported 4 values\./);
  assert.match(r.stdout, /Still needed before deploy: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, SLACK_BOT_USER_ID, SLACK_BOT_ID, SLACK_ROUTE_MAP_JSON/);
  assert.match(r.stdout, /npm run setup:slack fills the Slack bot ids/);
  for (const value of Object.values(GOOD)) assert.equal(r.output.includes(value), false, 'no pasted value is printed');
  const secrets = r.secrets();
  for (const [key, value] of Object.entries(GOOD)) assert.equal(secrets[key], value);
  assert.match(secrets.CRON_SECRET, /^[0-9a-f]{64}$/);
  assert.equal(secrets.UNCLE_SAM_AUTOMATIC_ACTIVITY, 'off');
  assert.equal(secrets.ANTHROPIC_MODEL, example.secrets.ANTHROPIC_MODEL);
  assert.deepEqual(Object.keys(r.doc()), Object.keys(example), 'top-level shape and comment are preserved');
  assert.equal(statSync(r.secretsPath).mode & 0o777, 0o600);
  assert.equal(statSync(r.pastePath).mode & 0o777, 0o600);
  assert.equal(r.paste(), `# header\n${Object.keys(GOOD).map(key => `${key}=`).join('\n')}\n`);
  assert.equal(Object.values(GOOD).some(value => r.paste().includes(value)), false, 'the paste file no longer holds the secrets');
});

test('import: a second run has nothing to import, and a complete file is reported as complete', async () => {
  const complete = { ...example, vercel: { ...example.vercel, databaseFromIntegration: true }, secrets: { ...example.secrets,
    SLACK_BOT_USER_ID: 'U0FIXTURE1', SLACK_BOT_ID: 'B0FIXTURE1', CRON_SECRET: 'c'.repeat(40),
    SLACK_ROUTE_MAP_JSON: JSON.stringify({ project: { channelId: 'DMASON0001', type: 'im' } }) } };
  const first = await run([], { secrets: complete });
  assert.equal(first.code, 0, first.output);
  assert.match(first.stdout, /The secrets file is complete\./);
  assert.equal(first.secrets().CRON_SECRET, 'c'.repeat(40), 'an existing CRON_SECRET is never replaced');
  assert.equal(first.stdout.includes('generated'), false);
  const second = await run([], { secrets: first.doc(), paste: first.paste() });
  assert.equal(second.code, 0, second.output);
  assert.match(second.stdout, /Nothing to import: the paste file has no new values\./);
  assert.match(second.stdout, /still empty in the paste file: SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, NOTION_TOKEN, ANTHROPIC_API_KEY/);
});

test('import --dry-run changes nothing and --keep leaves the pasted values in place', async () => {
  const dry = await run(['--dry-run']);
  assert.match(dry.stdout, /would import SLACK_BOT_TOKEN/);
  assert.match(dry.stdout, /Would import 4 values\./);
  assert.deepEqual(dry.secrets(), example.secrets, 'the secrets file is untouched');
  assert.equal(dry.paste(), pasteText(), 'the paste file is untouched');
  const kept = await run(['--keep']);
  assert.equal(kept.secrets().SLACK_BOT_TOKEN, GOOD.SLACK_BOT_TOKEN);
  assert.equal(kept.paste(), pasteText(), '--keep does not blank anything');
  assert.equal(kept.stdout.includes('blanked'), false);
});

test('import: good lines are imported, bad lines are reported by number, kept for correction, and make the exit code non-zero', async () => {
  const text = pasteText({ ...GOOD, SLACK_BOT_TOKEN: 'xoxp-secretmarker-user-token-value-0123456789' });
  const r = await run([], { paste: `${text}not a pair\nUNCLE_SAM_AUTOMATIC_ACTIVITY=enabled\n` });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ line 3 SLACK_BOT_TOKEN does not look right; expected a Bot User OAuth Token that starts with xoxb-; not imported/);
  assert.match(r.stdout, /✗ line 6 is not in KEY=value form; not imported/);
  assert.match(r.stdout, /✗ line 7 UNCLE_SAM_AUTOMATIC_ACTIVITY is not pasted here \(Claude sets it\); not imported/);
  assert.match(r.stderr, /Some lines were not imported/);
  assert.equal(/secretmarker/.test(r.output), false);
  assert.equal(r.secrets().SLACK_SIGNING_SECRET, GOOD.SLACK_SIGNING_SECRET, 'the good ones were imported');
  assert.equal(r.secrets().SLACK_BOT_TOKEN, example.secrets.SLACK_BOT_TOKEN, 'the bad one was not');
  assert.equal(r.secrets().UNCLE_SAM_AUTOMATIC_ACTIVITY, 'off');
  assert.match(r.paste(), /SLACK_BOT_TOKEN=xoxp-secretmarker/, 'the line to correct is still there');
  assert.match(r.paste(), /SLACK_SIGNING_SECRET=\n/, 'the imported ones are blanked');
});

test('import --init creates the private paste file once and never overwrites it; missing files are explained', async () => {
  const init = await run(['--init'], { paste: null });
  assert.equal(init.code, 0, init.output);
  assert.equal(init.paste(), PASTE_TEMPLATE);
  assert.equal(statSync(init.pastePath).mode & 0o777, 0o600);
  const again = await run(['--init'], { paste: 'SLACK_BOT_TOKEN=keep-me-as-is-1234\n' });
  assert.match(again.stdout, /already exists; left as it is/);
  assert.equal(again.paste(), 'SLACK_BOT_TOKEN=keep-me-as-is-1234\n');
  const noPaste = await run([], { paste: null });
  assert.equal(noPaste.code, 1);
  assert.match(noPaste.stderr, /Missing PASTE-SECRETS-HERE\.txt .*--init/);
  const noSecrets = await run([], { secrets: null });
  assert.equal(noSecrets.code, 1);
  assert.match(noSecrets.stderr, /Missing \.env\.secrets\.json/);
  const notJson = await run([], { secrets: null });
  writeFileSync(notJson.secretsPath, '{ not json');
  assert.match((await exec(process.execPath, [script], { env: { PATH: process.env.PATH, UNCLE_SAM_PASTE_FILE: notJson.pastePath, UNCLE_SAM_SECRETS_FILE: notJson.secretsPath } }).catch(error => error)).stderr, /not valid JSON/);
  const usage = await run(['--force']);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /Usage: node scripts\/import-secrets\.mjs/);
});

test('import refuses a secrets or paste file that git would not ignore', async () => {
  const stray = path.join(root, 'test', `.not-ignored-${process.pid}.json`);
  writeFileSync(stray, JSON.stringify(example));
  try {
    const r = await run([], { env: { UNCLE_SAM_SECRETS_FILE: stray } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\.env\.secrets\.json is not gitignored; refusing to continue/);
    assert.deepEqual(JSON.parse(readFileSync(stray, 'utf8')), example, 'nothing was written');
    const strayPaste = await run([], { env: { UNCLE_SAM_PASTE_FILE: stray } });
    assert.match(strayPaste.stderr, /PASTE-SECRETS-HERE\.txt is not gitignored; refusing to continue/);
  } finally { rmSync(stray, { force: true }); }
});

test('the paste file and the pulled environment can neither be committed nor uploaded to Vercel by accident', () => {
  const lines = file => readFileSync(path.join(root, file), 'utf8').split('\n').map(line => line.trim());
  assert.ok(lines('.gitignore').includes('PASTE-SECRETS-HERE.txt'), '.gitignore lists the paste file');
  for (const entry of ['PASTE-SECRETS-HERE.txt', '.vercel', '.env*']) assert.ok(lines('.vercelignore').includes(entry), `.vercelignore lists ${entry}`);
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['setup:import'], 'node scripts/import-secrets.mjs');
});

const OPENROUTER_KEY = 'sk-or-v1-fixtureOpenRouterKeyValue0123456789abcdef';

test('an OpenRouter key can replace the Anthropic key: the right shape imports, a look-alike for the other service is refused without being echoed', () => {
  const plan = planImport(pasteText({ ...GOOD, ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: OPENROUTER_KEY }), { ...example.secrets }, { generate: () => 'g'.repeat(64) });
  assert.deepEqual(plan.imported.map(item => item.key), ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'NOTION_TOKEN', 'OPENROUTER_API_KEY']);
  assert.equal(plan.imported.at(-1).length, OPENROUTER_KEY.length);
  assert.deepEqual(plan.empty, ['ANTHROPIC_API_KEY']); assert.deepEqual(plan.rejected, []);
  assert.equal(plan.next.OPENROUTER_API_KEY, OPENROUTER_KEY);
  assert.equal(validateSecrets(plan.next).problems.includes('ANTHROPIC_API_KEY: missing'), false, 'one model key is enough');
  const swapped = planImport(`OPENROUTER_API_KEY=${GOOD.ANTHROPIC_API_KEY}\nANTHROPIC_API_KEY=${OPENROUTER_KEY}\n`, { ...example.secrets });
  assert.deepEqual(swapped.imported, []);
  assert.deepEqual(swapped.rejected.map(item => [item.line, item.key]), [[1, 'OPENROUTER_API_KEY'], [2, 'ANTHROPIC_API_KEY']]);
  assert.match(swapped.rejected[0].reason, /expected an API key that starts with sk-or-v1-/);
  assert.equal(/fixtureAnthropicKeyValue|fixtureOpenRouterKeyValue/.test(JSON.stringify(swapped.rejected)), false, 'neither key leaks into a message');
});

test('import: an OpenRouter key alone completes the model requirement; with neither key the script says the model needs one of the two', async () => {
  const complete = { ...example, vercel: { ...example.vercel, databaseFromIntegration: true }, secrets: { ...example.secrets,
    SLACK_BOT_USER_ID: 'U0FIXTURE1', SLACK_BOT_ID: 'B0FIXTURE1', CRON_SECRET: 'c'.repeat(40),
    SLACK_ROUTE_MAP_JSON: JSON.stringify({ project: { channelId: 'DMASON0001', type: 'im' } }) } };
  const viaOpenRouter = await run([], { secrets: complete, paste: pasteText({ ...GOOD, ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: OPENROUTER_KEY }) });
  assert.equal(viaOpenRouter.code, 0, viaOpenRouter.output);
  assert.match(viaOpenRouter.stdout, /✓ imported OPENROUTER_API_KEY \(\d+ characters\)/);
  assert.match(viaOpenRouter.stdout, /The secrets file is complete\./);
  assert.equal(viaOpenRouter.output.includes(OPENROUTER_KEY), false, 'the key is never printed');
  assert.equal(viaOpenRouter.secrets().OPENROUTER_API_KEY, OPENROUTER_KEY);
  assert.equal(viaOpenRouter.paste().includes(OPENROUTER_KEY), false, 'the paste file is blanked afterwards');
  assert.match(viaOpenRouter.paste(), /OPENROUTER_API_KEY=\n/);
  const neither = await run([], { secrets: complete, paste: pasteText({ ...GOOD, ANTHROPIC_API_KEY: '' }) });
  assert.equal(neither.code, 0, neither.output);
  assert.match(neither.stdout, /Still needed before deploy: ANTHROPIC_API_KEY/);
  assert.match(neither.stdout, /the model needs ONE key: an Anthropic key on the ANTHROPIC_API_KEY line, or an OpenRouter key on the OPENROUTER_API_KEY line/);
});
