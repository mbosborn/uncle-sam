import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSyntheticReport } from './replay/privacy.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('replay isolation blocks fetch, sockets, HTTPS and subprocesses before production imports', () => {
  const result = spawnSync(process.execPath, ['--import', path.join(root, 'test/replay/isolation.mjs'), '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { connect } from 'node:net'; import { request } from 'node:https'; import { execFileSync } from 'node:child_process';
    for (const call of [() => fetch('https://example.invalid'), () => connect(443, 'example.invalid'), () => request('https://example.invalid'), () => execFileSync('curl', ['https://example.invalid'])])
      assert.throws(call, { code: 'REPLAY_EXTERNAL_IO' });
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
test('privacy gate refuses a real-looking recipient and credential without printing it', () => {
  assert.doesNotThrow(() => assertSyntheticReport({ to: 'synthetic@example.invalid' }));
  assert.throws(() => assertSyntheticReport({ to: 'person@outside-fixture.invalid' }), /non-synthetic/);
  assert.throws(() => assertSyntheticReport({ token: 'ghp_' + 'a'.repeat(36) }), /credential-shaped/);
});
test('same-source version comparison uses one suite, clean env, isolated DBs and an auditable report', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-test-'));
  try {
    const output = path.join(dir, 'report.json');
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/replay.mjs'), '--scenario', 'unauthorized-recap', '--compare-ref', 'HEAD', '--report', output],
      { cwd: root, env: { ...process.env, TURSO_DATABASE_URL: 'https://never-contact.example.invalid', ANTHROPIC_API_KEY: 'must-not-inherit' }, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.comparison[0].status, 'passed-both');
    assert.equal(report.suiteHash, report.baseline.suiteHash); assert.match(report.sourceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.blockedIO, []); assert.deepEqual(report.baseline.blockedIO, []);
    assert.ok(!JSON.stringify(report).includes('must-not-inherit'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
