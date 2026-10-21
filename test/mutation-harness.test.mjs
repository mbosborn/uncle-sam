import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify } from './mutation/plugin.mjs';
import { locateTargets, targets } from './mutation/targets.mjs';
import { snapshotFiles, copySnapshot, fingerprint, summarize } from '../scripts/lib/mutation.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('mutation runner counts assertion failures, never crashes, missing cases or blocked I/O', () => {
  const success = { id: 'one', status: 0 };
  const assertion = { id: 'one', status: 1, assertion: true, failureMessage: 'expected no email' };
  assert.equal(classify({ tests: [success], blockedIO: [] }, ['one']).status, 'survived');
  assert.equal(classify({ tests: [assertion], blockedIO: [] }, ['one']).status, 'killed');
  assert.equal(classify({ tests: [assertion], blockedIO: [], activeMutant: '7' }, ['one'], '7').status, 'killed');
  assert.equal(classify({ tests: [assertion], blockedIO: [], activeMutant: null }, ['one'], '7').status, 'error');
  for (const result of [null, { tests: [], blockedIO: [] }, { tests: [success, success], blockedIO: [] },
    { tests: [{ ...assertion, assertion: false }], blockedIO: [] }, { tests: [assertion], blockedIO: ['fetch'] }])
    assert.equal(classify(result, ['one']).status, 'error');
});

test('all safeguard anchors exist uniquely in current source and cannot silently drift away', () => {
  const read = file => readFileSync(path.join(root, file), 'utf8');
  assert.equal(locateTargets(read).length, targets.length);
  assert.throws(() => locateTargets(() => ''), /missing or ambiguous/);
  assert.throws(() => locateTargets(file => read(file) + '\n' + read(file)), /missing or ambiguous/);
});

test('mutation gate rejects survivors, timeouts, invalid mutants and unrelated killing tests', () => {
  const target = { id: 'recipient', file: 'service/lib/example.mjs', start: { line: 1, column: 4 }, end: { line: 1, column: 10 }, witnesses: ['wrong-recipient'] };
  const make = () => ({ testFiles: { fixture: { tests: ['wrong-recipient', 'valid-send'].map(id => ({ id, name: id })) } }, files: { [target.file]: { mutants: ['true', 'false'].map((replacement, id) => ({ id: String(id), replacement,
    mutatorName: 'ConditionalExpression', location: { start: { line: 1, column: 5 }, end: { line: 1, column: 11 } },
    status: 'Killed', killedBy: [replacement === 'false' ? 'wrong-recipient' : 'valid-send'] })) } } });
  assert.equal(summarize(make(), [target]).passed, true);
  const remapped = make(); remapped.testFiles.fixture.tests[0].id = '42'; remapped.files[target.file].mutants[1].killedBy = ['42'];
  assert.equal(summarize(remapped, [target]).passed, true);
  for (const status of ['Survived', 'Timeout', 'RuntimeError', 'CompileError', 'NoCoverage', 'Ignored']) {
    const report = make(); report.files[target.file].mutants[1].status = status;
    assert.equal(summarize(report, [target]).passed, false, status);
  }
  const unrelated = make(); unrelated.files[target.file].mutants[1].killedBy = ['valid-send'];
  assert.equal(summarize(unrelated, [target]).passed, false);
  const missing = make(); missing.files[target.file].mutants.pop();
  assert.throws(() => summarize(missing, [target]), /both guard mutations/);
  const unexpected = make(); unexpected.files[target.file].mutants.push({ id: 'extra', status: 'Survived' });
  assert.throws(() => summarize(unexpected, [target]), /unexpected active mutants/);
});

test('mutation snapshot excludes secrets, operational data and symlinks, and leaves source unchanged', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'mutation-snapshot-test-'));
  const source = path.join(temp, 'source'), dest = path.join(temp, 'copy');
  const put = (name, text) => { const file = path.join(source, name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text); };
  try {
    for (const dir of ['service/lib', 'service/drizzle', 'test/replay', 'test/support', 'test/mutation']) put(`${dir}/fixture.${dir.endsWith('drizzle') ? 'sql' : 'mjs'}`, 'synthetic');
    for (const name of ['fields', 'nda', 'ciiaa', 'terms']) put(`service/lib/document-schemas/${name}.json`, '{}');
    for (const name of ['.env.secrets.json', 'docs/candidate.txt', '.local/state.json', 'service/lib/export.json', 'test/replay/history.txt']) put(name, 'PRIVATE_CANARY');
    const files = snapshotFiles(source), before = fingerprint(source, files);
    copySnapshot(source, dest, files);
    assert.equal(fingerprint(source, files), before); assert.equal(fingerprint(dest, files), before);
    assert.ok(files.every(file => !readFileSync(path.join(dest, file), 'utf8').includes('PRIVATE_CANARY')));
    symlinkSync(path.join(source, '.env.secrets.json'), path.join(source, 'test/replay/escape.mjs'));
    assert.throws(() => snapshotFiles(source), /symlink/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
