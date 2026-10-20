import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { createLibsqlD1 } from '../service/lib/libsql-d1.mjs';
import { applyMigrations, hasMultipleStatements, JOURNAL_TABLE, pendingMigrations, splitMigration } from '../service/lib/migrate.mjs';
import { persistedFixture } from './support/d1.mjs';
import { libsqlFixture, migrationFiles } from './support/libsql.mjs';
import { START, trace } from './support/store-trace.mjs';


test('adapter: prepare/bind/first/all/run follow the D1 contract the store was written against', async () => {
  const f = await libsqlFixture({ migrate: false });
  try {
    await f.client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, note TEXT)');
    const insert = f.db.prepare('INSERT INTO t (id, name, flag, note) VALUES (?, ?, ?, ?)');
    const bound = insert.bind(1, 'alpha', true, null);
    assert.notEqual(bound, insert, 'bind returns a new statement and never mutates the prepared one');
    const run = await bound.run();
    assert.deepEqual({ success: run.success, changes: run.meta.changes, id: run.meta.last_row_id }, { success: true, changes: 1, id: 1 });
    await insert.bind(2, 'beta', false, 'n').run();
    assert.deepEqual(await f.db.prepare('SELECT * FROM t WHERE id = ?').bind(1).first(), { id: 1, name: 'alpha', flag: 1, note: null });
    assert.equal(await f.db.prepare('SELECT name FROM t WHERE id = ?').bind(2).first('name'), 'beta');
    assert.equal(await f.db.prepare('SELECT * FROM t WHERE id = ?').bind(99).first(), null);
    assert.equal(await f.db.prepare('SELECT * FROM t WHERE id = ?').bind(99).first('name'), null);
    await assert.rejects(() => f.db.prepare('SELECT * FROM t WHERE id = 1').first('missing'), /D1_ERROR: no such column: missing/);
    const all = await f.db.prepare('SELECT id, name AS label FROM t ORDER BY id').all();
    assert.equal(all.success, true);
    assert.deepEqual(all.results, [{ id: 1, label: 'alpha' }, { id: 2, label: 'beta' }]);
    const returning = await f.db.prepare("UPDATE t SET name = 'gamma' WHERE id = ? RETURNING id, name").bind(2).first();
    assert.deepEqual(returning, { id: 2, name: 'gamma' });
    assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM t').first('n')), 2);
    assert.throws(() => insert.bind(3, undefined, 0, null), /Cannot bind undefined \(parameter 2\)/);
    assert.throws(() => f.db.prepare('   '), /SQL string/);
    assert.throws(() => createLibsqlD1({}), /libSQL client/);
  } finally { f.close(); }
});

test('adapter: batch is atomic, returns per-statement results and rejects anything but prepared statements', async () => {
  const f = await libsqlFixture({ migrate: false });
  try {
    await f.client.execute('CREATE TABLE u (k TEXT PRIMARY KEY, v INTEGER)');
    const put = (k, v) => f.db.prepare('INSERT INTO u (k, v) VALUES (?, ?) RETURNING k').bind(k, v);
    const ok = await f.db.batch([put('a', 1), put('b', 2)]);
    assert.deepEqual(ok.map(r => r.results[0]?.k), ['a', 'b']);
    await assert.rejects(() => f.db.batch([put('c', 3), put('a', 9)]), /UNIQUE|constraint/i);
    assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM u WHERE k = 'c'").first('n'), 0, 'first statement rolled back with the failing one');
    assert.deepEqual(await f.db.batch([]), []);
    await assert.rejects(() => f.db.batch(['SELECT 1']), /prepared statements/);
    await assert.rejects(() => f.db.batch([{ sql: 'x' }]), /prepared statements/);
  } finally { f.close(); }
});

test('migrations: drizzle files apply once, in order, journaled; reruns change nothing', async () => {
  const f = await libsqlFixture({ migrate: false });
  try {
    const files = migrationFiles();
    assert.deepEqual(files.map(file => file.name), ['0000_unknown_silver_fox.sql', '0001_motionless_doctor_doom.sql', '0002_candidate_threads.sql', '0003_wispr_connection.sql', '0004_notices.sql']);
    assert.deepEqual(await pendingMigrations(f.client, files), files.map(file => file.name), 'everything is pending before the journal exists');
    const first = await applyMigrations(f.client, files, { clock: () => START });
    assert.deepEqual(first.applied, files.map(file => file.name));
    assert.deepEqual(first.skipped, []);
    const journal = (await f.client.execute(`SELECT name, applied_at FROM ${JOURNAL_TABLE} ORDER BY name`)).rows.map(row => [row[0], row[1]]);
    assert.deepEqual(journal, files.map(file => [file.name, START]));
    const second = await applyMigrations(f.client, files);
    assert.deepEqual(second, { applied: [], skipped: files.map(file => file.name) });
    assert.deepEqual(await pendingMigrations(f.client, files), []);
    const tables = (await f.client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).rows.map(row => row[0]);
    for (const name of ['uncle_sam_action_holds', 'uncle_sam_candidate_threads', 'uncle_sam_control', 'uncle_sam_events', 'uncle_sam_request_events', 'uncle_sam_requests', 'uncle_sam_wispr', 'uncle_sam_notices', JOURNAL_TABLE]) {
      assert.ok(tables.includes(name), `${name} exists`);
    }
    assert.equal(tables.some(name => name.startsWith('__new_')), false, 'the table-rebuild migration left no scratch tables behind');
  } finally { f.close(); }
});

test('migrations: a failing migration leaves neither partial schema nor a journal row, and foreign keys do not block the table rebuild', async () => {
  const f = await libsqlFixture({ migrate: false });
  try {
    await f.client.execute('PRAGMA foreign_keys = ON');
    const files = [
      { name: '0000_ok.sql', sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY);--> statement-breakpoint\nCREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));' },
      { name: '0001_bad.sql', sql: 'CREATE TABLE c (id INTEGER PRIMARY KEY);--> statement-breakpoint\nCREATE TABLE a (id INTEGER PRIMARY KEY);' },
    ];
    await assert.rejects(() => applyMigrations(f.client, files), /already exists/i);
    const tables = (await f.client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")).rows.map(row => row[0]);
    assert.ok(tables.includes('a') && tables.includes('b'));
    assert.equal(tables.includes('c'), false, 'the failed migration rolled back completely');
    assert.deepEqual((await f.client.execute(`SELECT name FROM ${JOURNAL_TABLE}`)).rows.map(row => row[0]), ['0000_ok.sql']);
    // Table rebuild (drop + rename of a referenced parent) with rows present: only works because foreign keys are off during migrate().
    await f.client.execute('INSERT INTO a (id) VALUES (1)');
    await f.client.execute('INSERT INTO b (id, a_id) VALUES (1, 1)');
    const rebuild = { name: '0002_rebuild.sql', sql: 'PRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `__new_a` (id INTEGER PRIMARY KEY, extra TEXT);--> statement-breakpoint\nINSERT INTO `__new_a` (id) SELECT id FROM a;--> statement-breakpoint\nDROP TABLE a;--> statement-breakpoint\nALTER TABLE `__new_a` RENAME TO a;--> statement-breakpoint\nPRAGMA foreign_keys=ON;' };
    assert.deepEqual((await applyMigrations(f.client, [files[0], rebuild])).applied, ['0002_rebuild.sql']);
    assert.equal((await f.client.execute('SELECT COUNT(*) FROM b')).rows[0][0], 1, 'child rows survive');
  } finally { f.close(); }
});

test('migration splitting: breakpoints, foreign-key pragmas and multi-statement guard', () => {
  const sql = 'PRAGMA foreign_keys=OFF;--> statement-breakpoint\nCREATE TABLE `x` (a text DEFAULT \'a;b\');\n--> statement-breakpoint\nDROP TABLE `y`;--> statement-breakpoint\nPRAGMA foreign_keys=ON;';
  assert.deepEqual(splitMigration(sql), ["CREATE TABLE `x` (a text DEFAULT 'a;b')", 'DROP TABLE `y`']);
  assert.throws(() => splitMigration('CREATE TABLE a (x int); CREATE TABLE b (y int);', '0009_hand.sql'), /0009_hand\.sql: more than one statement/);
  assert.equal(hasMultipleStatements("INSERT INTO t VALUES ('a;b'); -- trailing comment"), false);
  assert.equal(hasMultipleStatements('SELECT 1; /* c */ SELECT 2'), true);
  assert.equal(hasMultipleStatements('SELECT "a;b" FROM t;'), false);
  const real = migrationFiles().flatMap(file => splitMigration(file.sql, file.name));
  assert.ok(real.length >= 15 && real.every(statement => !/^PRAGMA/i.test(statement)));
});

// ------------------------------------------------------------------------------------------------------------
// Differential test: the same long sequence of real store operations must produce identical results on the
// node:sqlite D1 fixture (what the 125 original tests ran on) and on libSQL through the production adapter.
// ------------------------------------------------------------------------------------------------------------
const normalize = value => JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>'));

test('the store behaves identically on libSQL (production adapter + migrations) and on the D1-shaped SQLite fixture', async () => {
  const reference = await trace(persistedFixture(START).store);
  const f = await libsqlFixture({ at: START });
  let actual;
  try { actual = await trace(f.store); } finally { f.close(); }
  assert.ok(reference.length >= 50, 'the trace covers the whole store surface');
  assert.deepEqual(actual.map(([label]) => label), reference.map(([label]) => label));
  for (let i = 0; i < reference.length; i++) assert.deepEqual(normalize(actual[i]), normalize(reference[i]), `step ${i}: ${reference[i][0]}`);
  const at = label => normalize(reference.find(([name]) => name === label)[1]);
  // Guard against a trace that only compares two identical failures: the success paths really succeeded.
  assert.equal(at('event: record').created, true);
  assert.equal(at('event: duplicate').created, false);
  assert.equal(at('event: claim').claimed, true);
  assert.equal(at('event: claim again').claimed, false);
  assert.equal(at('request: ensure + link').created, true);
  assert.equal(at('request: ensure again').created, false);
  assert.equal(at('request: claim').claimed, true);
  assert.equal(at('request: claim twice').claimed, false);
  assert.equal(at('request: complete').updated, true);
  assert.equal(at('thread: reserve first').verified, true);
  assert.equal(at('thread: reserve racing').verified, false);
  assert.equal(at('hold: set').changed, true);
  assert.equal(at('hold: repeat is a no-op').changed, false);
  assert.deepEqual(at('hold: missing source event'), { threw: 'FOREIGN KEY' });
  assert.equal(at('hold: failed batch left control untouched'), true);
  assert.equal(at('hold: release').changed, true);
  assert.deepEqual(at('request: link to a missing event'), { threw: 'FOREIGN KEY' });
});

test('the store never depends on foreign-key enforcement for its own rules (Turso does not document its default)', async () => {
  const reference = (await trace(persistedFixture(START).store)).filter(([label]) => !/missing/.test(label) && !/failed batch/.test(label));
  const f = await libsqlFixture({ at: START, foreignKeys: false });
  let actual;
  try {
    assert.equal((await f.client.execute('PRAGMA foreign_keys')).rows[0][0], 0, 'this fixture really runs with foreign keys off');
    actual = await trace(f.store, { probeForeignKeys: false });
  } finally { f.close(); }
  assert.equal(actual.length, reference.length);
  for (let i = 0; i < reference.length; i++) assert.deepEqual(normalize(actual[i]), normalize(reference[i]), `step ${i}: ${reference[i][0]}`);
});
