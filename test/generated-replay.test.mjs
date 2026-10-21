import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(dir, opts) {
  const output = path.join(dir, 'report.json');
  const child = spawnSync(process.execPath, ['--import', path.join(root, 'test/replay/isolation.mjs'), path.join(root, 'test/replay/generated-worker.mjs'), root, output, JSON.stringify(opts)],
    { cwd: dir, env: { PATH: path.dirname(process.execPath), TZ: 'UTC', LANG: 'en_US.UTF-8', NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(readFileSync(output, 'utf8'));
}
test('generated replay detects an injected duplicate, shrinks it and replays the retained sequence', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'generated-replay-test-'));
  try {
    const report = run(dir, { runs: 30, maxEvents: 12, seed: 107, injectDuplicate: true });
    assert.equal(report.passed, false); assert.ok(report.generated.shrinks > 0);
    assert.ok(report.generated.failure.violations.some(x => x.includes('duplicate')));
    const file = path.join(dir, 'failure.json'); writeFileSync(file, JSON.stringify(report.generated.failure));
    const repro = run(dir, { replay: file, injectDuplicate: true });
    assert.equal(repro.passed, false); assert.deepEqual(repro.blockedIO, []);
    const clean = run(dir, { replay: file }); assert.equal(clean.passed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('retained real regressions are always replayed in the ordinary test run', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'generated-regressions-'));
  try { const result = run(dir, { regressions: true }); assert.equal(result.passed, true, JSON.stringify(result.regressions)); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
