#!/usr/bin/env node
/**
 * Uncle Sam · secrets importer. Project pastes values into PASTE-SECRETS-HERE.txt (one KEY=value per line, never into chat).
 * This reads them, checks their shape, merges them into the gitignored .env.secrets.json, generates CRON_SECRET if it is still
 * empty, and blanks the imported lines in the paste file. It prints key NAMES, lengths and line numbers, never values.
 *
 *   node scripts/import-secrets.mjs [--init] [--dry-run] [--keep]
 *     --init      create PASTE-SECRETS-HERE.txt (private, empty values) if it does not exist yet, then stop
 *     --dry-run   show what would be imported and change nothing
 *     --keep      leave the pasted values in PASTE-SECRETS-HERE.txt (by default they are blanked after a successful import)
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planImport, blankPasteFile, validateSecrets, PASTE_TEMPLATE } from '../service/lib/setup-checks.mjs';
import { isIgnored, writePrivate } from './lib/local-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// UNCLE_SAM_SECRETS_FILE / UNCLE_SAM_PASTE_FILE let the tests (and anyone with the files elsewhere) point at different files.
const secretsPath = process.env.UNCLE_SAM_SECRETS_FILE ? path.resolve(process.env.UNCLE_SAM_SECRETS_FILE) : path.join(root, '.env.secrets.json');
const pastePath = process.env.UNCLE_SAM_PASTE_FILE ? path.resolve(process.env.UNCLE_SAM_PASTE_FILE) : path.join(root, 'PASTE-SECRETS-HERE.txt');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const keep = args.includes('--keep');
const init = args.includes('--init');
const log = (...parts) => console.log(...parts);
const fail = message => { console.error(`✗ ${message}`); process.exit(1); };

const unknown = args.filter(arg => !['--init', '--dry-run', '--keep'].includes(arg));
if (unknown.length) fail('Usage: node scripts/import-secrets.mjs [--init] [--dry-run] [--keep]');
if (init) {
  if (!isIgnored(root, pastePath, /^PASTE-SECRETS-HERE\.txt\s*$/m)) fail('PASTE-SECRETS-HERE.txt is not gitignored; refusing to create it.');
  if (existsSync(pastePath)) log('✓ PASTE-SECRETS-HERE.txt already exists; left as it is.');
  else { writePrivate(pastePath, PASTE_TEMPLATE); log('✓ created PASTE-SECRETS-HERE.txt (private, values empty).'); }
  process.exit(0);
}
if (!existsSync(pastePath)) fail('Missing PASTE-SECRETS-HERE.txt in the uncle-sam folder (run with --init to create it).');
if (!existsSync(secretsPath)) fail('Missing .env.secrets.json — copy .env.secrets.example.json to .env.secrets.json first.');
if (!isIgnored(root, secretsPath, /^\.env\*\s*$/m)) fail('.env.secrets.json is not gitignored; refusing to continue.');
if (!isIgnored(root, pastePath, /^PASTE-SECRETS-HERE\.txt\s*$/m)) fail('PASTE-SECRETS-HERE.txt is not gitignored; refusing to continue.');

let doc;
try { doc = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch { fail('.env.secrets.json is not valid JSON.'); }
if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('.env.secrets.json must be a JSON object.');
doc.secrets = doc.secrets && typeof doc.secrets === 'object' ? doc.secrets : {};
const pasteText = readFileSync(pastePath, 'utf8');

const plan = planImport(pasteText, doc.secrets);
for (const { key, length } of plan.imported) log(`✓ ${dry ? 'would import' : 'imported'} ${key} (${length} characters)`);
for (const key of plan.generated) log(`✓ ${dry ? 'would generate' : 'generated'} ${key}`);
for (const { line, key } of plan.superseded) log(`• line ${line}${key ? ` (${key})` : ''} was replaced by a later line for the same key`);
for (const { line, key, reason } of plan.rejected) log(`✗ line ${line}${key ? ` ${key}` : ''} ${reason}; not imported`);
if (plan.empty.length) log(`• still empty in the paste file: ${plan.empty.join(', ')}`);

if (!dry && (plan.imported.length || plan.generated.length)) {
  doc.secrets = plan.next;
  writePrivate(secretsPath, `${JSON.stringify(doc, null, 2)}\n`);
  if (!keep && plan.imported.length) {
    writePrivate(pastePath, blankPasteFile(pasteText, plan.imported.map(item => item.key)));
    log('✓ blanked the imported values in PASTE-SECRETS-HERE.txt');
  }
}

const { problems } = validateSecrets(plan.next, { databaseFromIntegration: doc.vercel?.databaseFromIntegration === true });
// The shipped route-map template (D…/G… placeholders) is "invalid" until `setup:slack --open` fills it in; report it as still needed.
const routeMapPending = problems.some(problem => problem.startsWith('SLACK_ROUTE_MAP_JSON:'));
const missing = [...problems.filter(problem => problem.endsWith(': missing')).map(problem => problem.split(':')[0]), ...(routeMapPending ? ['SLACK_ROUTE_MAP_JSON'] : [])];
const other = problems.filter(problem => !problem.endsWith(': missing') && !problem.startsWith('SLACK_ROUTE_MAP_JSON:'));
log(plan.imported.length
  ? `${dry ? 'Would import' : 'Imported'} ${plan.imported.length} value${plan.imported.length === 1 ? '' : 's'}.`
  : 'Nothing to import: the paste file has no new values.');
if (missing.length) log(`Still needed before deploy: ${missing.join(', ')}`);
if (missing.includes('ANTHROPIC_API_KEY')) log('  (the model needs ONE key: an Anthropic key on the ANTHROPIC_API_KEY line, or an OpenRouter key on the OPENROUTER_API_KEY line)');
if (missing.some(key => ['SLACK_BOT_USER_ID', 'SLACK_BOT_ID', 'SLACK_ROUTE_MAP_JSON'].includes(key))) log('  (npm run setup:slack fills the Slack bot ids; with --open it also fills the route map)');
for (const problem of other) log(`Check: ${problem}`);
if (!missing.length && !other.length) log('The secrets file is complete.');
if (plan.rejected.length) fail('Some lines were not imported; fix them in PASTE-SECRETS-HERE.txt and run this again.');
