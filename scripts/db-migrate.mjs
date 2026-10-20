#!/usr/bin/env node
/**
 * Applies service/drizzle/*.sql to the Turso database, once each, in order.
 *
 *   node scripts/db-migrate.mjs            apply pending migrations
 *   node scripts/db-migrate.mjs --status   list applied/pending, change nothing
 *
 * Reads TURSO_DATABASE_URL / TURSO_AUTH_TOKEN from the environment, falling back to .env.secrets.json
 * (secrets.*). When the Turso integration in the Vercel Marketplace owns them, pull them to a private file and load that:
 *   vercel env pull <file> --environment production   then   node --env-file=<file> scripts/db-migrate.mjs
 * Prints the database host and file names only, never a token.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTursoClient } from '../service/lib/turso.mjs';
import { applyMigrations, loadMigrationFiles, pendingMigrations } from '../service/lib/migrate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromFile = () => {
  const file = path.join(root, '.env.secrets.json');
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')).secrets ?? {}; } catch { return {}; }
};
const env = { ...fromFile(), ...Object.fromEntries(['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'].filter(k => process.env[k]).map(k => [k, process.env[k]])) };
if (!env.TURSO_DATABASE_URL || /^<.*>$/.test(env.TURSO_DATABASE_URL)) {
  console.error('✗ TURSO_DATABASE_URL is not set (environment or .env.secrets.json).');
  process.exit(1);
}
const client = await createTursoClient(env);
let host = 'local file';
try { host = /^file:/i.test(env.TURSO_DATABASE_URL) ? env.TURSO_DATABASE_URL : new URL(env.TURSO_DATABASE_URL.replace(/^libsql:/i, 'https:')).host; } catch { /* keep default */ }
const files = loadMigrationFiles(path.join(root, 'service/drizzle'));
try {
  if (process.argv.includes('--status')) {
    const pending = await pendingMigrations(client, files);
    console.log(`database ${host}: ${files.length - pending.length} applied, ${pending.length} pending${pending.length ? ` (${pending.join(', ')})` : ''}`);
  } else {
    const { applied, skipped } = await applyMigrations(client, files, { log: line => console.log(`  ${line}`) });
    console.log(`✓ database ${host}: ${applied.length} applied, ${skipped.length} already up to date`);
  }
} catch (error) {
  console.error(`✗ migration failed: ${String(error?.message ?? error).slice(0, 300)}`);
  process.exit(1);
} finally { client.close?.(); }
