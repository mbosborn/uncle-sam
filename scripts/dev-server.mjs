#!/usr/bin/env node
/**
 * Local stand-in for Vercel: serves the same handlers as api/*.js on http://127.0.0.1:3000 against a local
 * SQLite file, so the whole inbound path (signature checks, dedupe, runner gating) can be exercised without
 * a Vercel or Turso account.
 *
 *   npm run dev                                   local database in .local/uncle-sam.db, automatic activity off
 *   node --env-file=.env.local scripts/dev-server.mjs   use your own variables (any TURSO_DATABASE_URL, secrets, …)
 */
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVercelApp } from '../service/lib/vercel-handlers.mjs';
import { createTursoClient } from '../service/lib/turso.mjs';
import { applyMigrations, loadMigrationFiles } from '../service/lib/migrate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 1024 * 1024;

export function routesFor(app) {
  return { '/api/slack/events': app.slackEvents, '/api/notion/webhook': app.notionWebhook, '/api/portal/webhook': app.portalWebhook,
    '/api/health': app.health, '/api/cron/tick': app.tick };
}

async function toRequest(req, origin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error('payload_too_large'); chunks.push(chunk); }
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  return new Request(new URL(req.url ?? '/', origin), { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks) });
}

export function startDevServer({ app, port = 3000, host = '127.0.0.1' } = {}) {
  const routes = routesFor(app);
  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url ?? '/', 'http://local');
      const handler = routes[pathname];
      const response = handler ? await handler(await toRequest(req, `http://${req.headers.host ?? 'local'}`))
        : new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(error?.message === 'payload_too_large' ? 413 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error?.message === 'payload_too_large' ? 'payload_too_large' : 'dev_server_error' }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}`,
      // A stopped dev server must not wait for keep-alive connections (or a half-read oversized upload) to drain.
      close: () => new Promise(done => { server.close(() => done()); server.closeAllConnections?.(); }) }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = { ...process.env };
  if (!env.TURSO_DATABASE_URL) {
    mkdirSync(path.join(root, '.local'), { recursive: true });
    env.TURSO_DATABASE_URL = `file:${path.join(root, '.local/uncle-sam.db')}`;
  }
  env.UNCLE_SAM_AUTOMATIC_ACTIVITY ??= 'off';
  if (/^file:/i.test(env.TURSO_DATABASE_URL)) {
    const client = await createTursoClient(env);
    const { applied } = await applyMigrations(client, loadMigrationFiles(path.join(root, 'service/drizzle')));
    if (applied.length) console.log(`applied ${applied.length} local migrations`);
    client.close?.();
  }
  const app = createVercelApp({ env });
  const { url } = await startDevServer({ app, port: Number(env.PORT) || 3000 });
  console.log(`Uncle Sam dev server on ${url}  (db: ${/^file:/i.test(env.TURSO_DATABASE_URL) ? 'local file' : 'remote'}, automatic activity: ${env.UNCLE_SAM_AUTOMATIC_ACTIVITY})`);
  console.log('  GET /api/health · POST /api/slack/events · POST /api/notion/webhook · POST /api/portal/webhook · GET /api/cron/tick (Bearer CRON_SECRET)');
}
