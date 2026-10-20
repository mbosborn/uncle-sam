import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createStore } from '../../service/lib/store.mjs';

export function persistedFixture(at = Date.parse('2026-10-14T00:00:00Z')) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../../service/drizzle/', import.meta.url);
  for (const name of readdirSync(directory).filter(n => n.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  const prepare = (sql, params = []) => ({
    sql, params, bind(...values) { return prepare(sql, values); },
    async first(column) { const r = sqlite.prepare(sql).get(...params); return column ? r?.[column] ?? null : r ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...params), success: true }; },
    async run() { const r = sqlite.prepare(sql).run(...params); return { success: true, meta: { changes: r.changes } }; },
  });
  const db = { prepare, async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const r = statements.map(s => ({ success: true, results: sqlite.prepare(s.sql).all(...s.params) }));
      sqlite.exec('COMMIT'); return r;
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } };
  const store = createStore(db, { authorized: true, clock: () => at });
  return { sqlite, db, store, at };
}
