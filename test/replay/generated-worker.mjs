import { blocked } from './isolation.mjs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import fc from 'fast-check';
import { executePlan, explore, validatePlan } from './generated.mjs';
import { assertSyntheticReport } from './privacy.mjs';
const [root, output, options] = process.argv.slice(2), opts = JSON.parse(options);
delete process.env.__CF_USER_TEXT_ENCODING;
for (const key of Object.keys(process.env)) if (!['PATH', 'TZ', 'LANG', 'NODE_NO_WARNINGS'].includes(key)) throw Error('Generated replay requires a clean environment');
const regressions = [];
async function replay(file) {
  const saved = JSON.parse(await readFile(file, 'utf8')), item = saved.failure ?? saved;
  assertSyntheticReport(item); validatePlan(item.plan);
  if (!Array.isArray(item.ordering) || item.ordering.some(n => !Number.isSafeInteger(n) || n < 1) || item.ordering.length > 10000) throw Error('Invalid schedule');
  try { await executePlan(root, item.plan, fc.schedulerFor(item.ordering), { injectDuplicate: opts.injectDuplicate }); return { file: path.basename(file), passed: true }; }
  catch (error) { return { file: path.basename(file), passed: false, error: error.message, violations: error.exploration?.violations }; }
}
if (opts.replay) regressions.push(await replay(opts.replay));
else {
  const dir = path.join(root, 'test/replay/generated-regressions');
  for (const file of (await readdir(dir).catch(() => [])).filter(x => x.endsWith('.json')).sort()) regressions.push(await replay(path.join(dir, file)));
}
const generated = opts.replay || opts.regressions ? null : await explore(root, opts);
const report = { schemaVersion: 1, mode: 'generated-isolated-effects', fastCheckVersion: fc.__version, regressions, generated, blockedIO: blocked,
  passed: regressions.every(x => x.passed) && (generated?.passed ?? true) && blocked.length === 0 };
assertSyntheticReport(report);
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
