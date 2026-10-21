import { blocked } from './isolation.mjs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './world.mjs';
import { scenarios } from './scenarios.mjs';
import { assertSyntheticReport } from './privacy.mjs';
const [root, output, filter] = process.argv.slice(2);
delete process.env.__CF_USER_TEXT_ENCODING; // macOS adds this even to an explicit child env.
for (const key of Object.keys(process.env)) if (!['PATH', 'TZ', 'LANG', 'NODE_NO_WARNINGS'].includes(key)) throw Error('Replay worker must be launched with a clean environment');
const redactions = [];
const digest = createHash('sha256');
const directory = path.dirname(fileURLToPath(import.meta.url));
for (const name of readdirSync(directory).filter(n => n.endsWith('.mjs')).sort()) digest.update(name).update(readFileSync(path.join(directory, name)));
function hashSource(folder) {
  const hash = createHash('sha256');
  function visit(dir) { for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) hash.update(path.relative(folder, file)).update(readFileSync(file));
  } }
  visit(folder); return hash.digest('hex');
}
digest.update('support/slack-wire.mjs').update(readFileSync(path.join(directory, '../support/slack-wire.mjs')));
const report = { schemaVersion: 1, sourceHash: hashSource(path.join(root, 'service')), suiteHash: digest.digest('hex'), mode: 'deterministic-recorded-responses', scenarios: [] };
const selected = scenarios.filter(s => !filter || s.id === filter);
if (!selected.length) throw Error(`Unknown scenario: ${filter}`);
for (const s of selected) {
  const row = { id: s.id, title: s.title, passed: false }; let world;
  try { world = await createWorld(root, s.options); await s.run(world); row.passed = true; }
  catch (error) { row.error = { message: error.message, code: error.code ?? null, stack: error.stack }; }
  finally {
    if (world) {
      redactions.push(...world.createdAccounts.map(a => a.password));
      row.steps = world.timeline;
      row.finalState = { candidate: await world.candidate().catch(() => null),
        invitation: await world.kv.get('trialinvite:11111111-2222-4333-8444-555555555555'),
        packet: await world.kv.get('emailq:packet:11111111-2222-4333-8444-555555555555'),
        checkins: await world.kv.get('checkins:11111111-2222-4333-8444-555555555555'), notices: world.notices };
      row.metrics = { emails: world.emails.length, envelopes: world.envelopes.length, calendarWrites: world.calendarWrites.length,
        notices: world.notices.length, recordedModelCalls: world.modelCalls, restarts: world.restarts, simulatedMinutes: (world.now - Date.parse('2026-10-23T05:00:00Z')) / 60000 };
      row.effects = { emails: world.emails, envelopes: world.envelopes, calendarWrites: world.calendarWrites };
      await world.close();
    }
  }
  report.scenarios.push(row);
}
report.blockedIO = blocked;
report.passed = report.scenarios.every(s => s.passed) && blocked.length === 0;
// Even synthetic generated passwords never leave the replay process.
let serialized = JSON.stringify(report, null, 2);
for (const value of redactions) serialized = serialized.replaceAll(value, '[REDACTED]');
assertSyntheticReport(JSON.parse(serialized));
await writeFile(output, serialized + '\n', { mode: 0o600 });
