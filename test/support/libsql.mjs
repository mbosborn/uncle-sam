import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { createLibsqlD1 } from '../../service/lib/libsql-d1.mjs';
import { applyMigrations, loadMigrationFiles } from '../../service/lib/migrate.mjs';
import { createStore } from '../../service/lib/store.mjs';

export const migrationFiles = () => loadMigrationFiles(new URL('../../service/drizzle/', import.meta.url));

/**
 * A real libSQL database (a temporary file, the same engine and client Turso uses) migrated by the
 * production migration runner and wrapped in the production D1 adapter. One pooled connection keeps
 * PRAGMA foreign_keys deterministic, mirroring the node:sqlite fixture in d1.mjs.
 */
export async function libsqlFixture({ at = Date.parse('2026-10-14T00:00:00Z'), migrate = true, foreignKeys = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'uncle-sam-libsql-'));
  const client = createClient({ url: `file:${path.join(dir, 'test.db')}`, concurrency: 1 });
  if (migrate) await applyMigrations(client, migrationFiles());
  await client.execute(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  const db = createLibsqlD1(client);
  const store = createStore(db, { authorized: true, clock: () => at });
  return { client, db, store, at, dir, close() { client.close(); rmSync(dir, { recursive: true, force: true }); } };
}
