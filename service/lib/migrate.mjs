/**
 * Applies the drizzle-generated SQL files in service/drizzle to a libSQL database, once each, in order.
 * A journal table records what ran; each migration and its journal row commit together or not at all.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const JOURNAL_TABLE = 'uncle_sam_schema_migrations';
const BREAKPOINT = /-->\s*statement-breakpoint/;
const FOREIGN_KEY_PRAGMA = /^PRAGMA\s+foreign_keys\s*=\s*(?:ON|OFF|0|1)$/i;

function skipQuoted(sql, start, quote) {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) { i += 2; continue; }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

/** True when `sql` holds a second statement: real SQL after a ';' outside quotes and comments. */
export function hasMultipleStatements(sql) {
  let ended = false;
  for (let i = 0; i < sql.length;) {
    const c = sql[i], next = sql[i + 1];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && next === '-') { const end = sql.indexOf('\n', i); i = end === -1 ? sql.length : end + 1; continue; }
    if (c === '/' && next === '*') { const end = sql.indexOf('*/', i + 2); i = end === -1 ? sql.length : end + 2; continue; }
    if (ended) return true;
    if (c === ';') { ended = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(sql, i, c); continue; }
    if (c === '[') { const end = sql.indexOf(']', i + 1); i = end === -1 ? sql.length : end + 1; continue; }
    i++;
  }
  return false;
}

/**
 * Splits one drizzle migration on its `--> statement-breakpoint` markers. Foreign-key pragmas are dropped
 * because client.migrate() switches enforcement off around the whole migration (the table-rebuild pattern).
 */
export function splitMigration(sql, name = 'migration') {
  const statements = [];
  for (const part of String(sql).split(BREAKPOINT)) {
    const statement = part.trim().replace(/;+\s*$/, '').trim();
    if (!statement || FOREIGN_KEY_PRAGMA.test(statement)) continue;
    if (hasMultipleStatements(statement)) throw new Error(`${name}: more than one statement without a "--> statement-breakpoint" marker`);
    statements.push(statement);
  }
  return statements;
}

export function loadMigrationFiles(directory) {
  const dir = directory instanceof URL ? directory : pathToFileURL(resolve(String(directory)) + sep);
  return readdirSync(dir).filter(name => name.endsWith('.sql')).sort()
    .map(name => ({ name, sql: readFileSync(new URL(name, dir), 'utf8') }));
}

async function readApplied(client) {
  const table = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", args: [JOURNAL_TABLE] });
  if (!table.rows.length) return new Set();
  const rows = (await client.execute(`SELECT name FROM ${JOURNAL_TABLE}`)).rows;
  return new Set(rows.map(row => String(row[0])));
}

export async function pendingMigrations(client, files) {
  const applied = await readApplied(client);
  return [...files].sort((a, b) => a.name.localeCompare(b.name)).filter(file => !applied.has(file.name)).map(file => file.name);
}

export async function applyMigrations(client, files, { log = () => {}, clock = Date.now } = {}) {
  await client.execute(`CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (name TEXT PRIMARY KEY NOT NULL, applied_at INTEGER NOT NULL)`);
  const applied = await readApplied(client);
  const run = typeof client.migrate === 'function' ? statements => client.migrate(statements) : statements => client.batch(statements, 'write');
  const result = { applied: [], skipped: [] };
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (applied.has(file.name)) { result.skipped.push(file.name); continue; }
    const statements = splitMigration(file.sql, file.name);
    await run([...statements.map(sql => ({ sql, args: [] })),
      { sql: `INSERT INTO ${JOURNAL_TABLE} (name, applied_at) VALUES (?, ?)`, args: [file.name, clock()] }]);
    result.applied.push(file.name);
    log(`applied ${file.name} (${statements.length} statements)`);
  }
  return result;
}
