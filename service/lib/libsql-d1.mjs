/**
 * D1-shaped adapter over a libSQL client (Turso).
 *
 * The store was written against Cloudflare D1's surface: prepare(sql).bind(...values) with
 * first(column?) / all() / run(), plus an atomic batch(). This module exposes exactly that surface on top
 * of @libsql/client, so the store, the runner and every policy module run unchanged on Vercel.
 *
 * The client is injected and never imported here, so tests can hand in a local file database and the
 * Vercel entry points choose the right build (see openDatabase in vercel-handlers.mjs).
 */
const isStatement = value => value !== null && typeof value === 'object'
  && typeof value.sql === 'string' && Array.isArray(value.params);

function bindable(values) {
  return values.map((value, index) => {
    if (value === undefined) throw new TypeError(`Cannot bind undefined (parameter ${index + 1})`);
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

const plain = value => (typeof value === 'bigint' && Number.isSafeInteger(Number(value)) ? Number(value) : value);

function toResult(set) {
  const columns = Array.isArray(set?.columns) ? set.columns : [];
  const results = (Array.isArray(set?.rows) ? set.rows : []).map(row => {
    const record = {};
    columns.forEach((name, index) => { record[name] = plain(row[index] ?? null); });
    return record;
  });
  const id = set?.lastInsertRowid;
  return { success: true, results, meta: { changes: set?.rowsAffected ?? 0, last_row_id: id === undefined || id === null ? null : Number(id) } };
}

function makeStatement(client, sql, params) {
  const execute = () => client.execute({ sql, args: params });
  return Object.freeze({
    sql,
    params,
    bind: (...values) => makeStatement(client, sql, bindable(values)),
    async first(column) {
      const row = toResult(await execute()).results[0] ?? null;
      if (column === undefined || row === null) return row;
      if (!Object.prototype.hasOwnProperty.call(row, column)) throw new Error(`D1_ERROR: no such column: ${column}`);
      return row[column];
    },
    async all() { return toResult(await execute()); },
    async run() { return { success: true, results: [], meta: toResult(await execute()).meta }; },
  });
}

export function createLibsqlD1(client) {
  if (!client || typeof client.execute !== 'function' || typeof client.batch !== 'function') {
    throw new TypeError('A libSQL client with execute() and batch() is required');
  }
  return Object.freeze({
    prepare(sql) {
      if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('prepare() takes an SQL string');
      return makeStatement(client, sql, []);
    },
    /** Atomic: libSQL runs the whole list in one write transaction and rolls back on the first error. */
    async batch(statements) {
      if (!Array.isArray(statements) || !statements.every(isStatement)) throw new TypeError('batch() takes prepared statements');
      if (!statements.length) return [];
      const sets = await client.batch(statements.map(statement => ({ sql: statement.sql, args: statement.params })), 'write');
      return sets.map(toResult);
    },
  });
}
