#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateTargets } from '../test/mutation/targets.mjs';
import { snapshotFiles, fingerprint, copySnapshot, summarize } from './lib/mutation.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length !== 2) throw Error('Usage: npm run test:mutate');
const temp = mkdtempSync(path.join(os.tmpdir(), 'sam-mutation-'));
const output = path.join(root, '.local/mutation/latest.json');
const files = snapshotFiles(root), before = fingerprint(root, files);
let summary = { passed: false, sourceHash: before, engine: 'StrykerJS 10.0.0', generatedAt: new Date().toISOString() };
try {
  copySnapshot(root, temp, files);
  if (fingerprint(temp, files) !== before) throw Error('Mutation source changed during snapshot');
  const targets = locateTargets(file => readFileSync(path.join(temp, file), 'utf8'));
  writeFileSync(path.join(temp, 'mutation-targets.json'), JSON.stringify(targets));
  // Dependencies are read from the installed tree; only source in temp is mutated.
  symlinkSync(path.join(root, 'node_modules'), path.join(temp, 'node_modules'), 'dir');
  writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  mkdirSync(path.join(temp, 'home'), { mode: 0o700 });
  const config = {
    testRunner: 'hiring-replay', plugins: ['./test/mutation/plugin.mjs'], ignorers: ['whole-guard-only'],
    mutate: targets.map(t => `${t.file}:${t.start.line}:${t.start.column}-${t.end.line}:${t.end.column}`),
    coverageAnalysis: 'off', concurrency: 2, incremental: false, disableTypeChecks: false,
    timeoutMS: 60_000, timeoutFactor: 2, dryRunTimeoutMinutes: 2,
    reporters: ['clear-text', 'json'], jsonReporter: { fileName: 'mutation-report.json' },
    thresholds: { high: 100, low: 100, break: 100 }, cleanTempDir: true,
    // No strings, comments, arithmetic or nested subconditions: remove each
    // complete safety gate and also force it to block legitimate work.
    mutator: { excludedMutations: ['ArithmeticOperator', 'ArrayDeclaration', 'ArrowFunction', 'BlockStatement', 'BooleanLiteral',
      'EmptyExpression', 'EqualityOperator', 'LogicalOperator', 'MethodExpression', 'ObjectLiteral', 'StringLiteral',
      'UnaryOperator', 'UpdateOperator', 'Regex', 'OptionalChaining', 'AssignmentOperator'] },
  };
  writeFileSync(path.join(temp, 'stryker.config.json'), JSON.stringify(config));
  const child = spawnSync(process.execPath, [path.join(root, 'node_modules/@stryker-mutator/core/bin/stryker.js'), 'run', 'stryker.config.json'], {
    cwd: temp, env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: path.join(temp, 'home'), TZ: 'UTC', LANG: 'en_US.UTF-8', NODE_NO_WARNINGS: '1' },
    stdio: 'inherit', timeout: 10 * 60_000,
  });
  const report = JSON.parse(readFileSync(path.join(temp, 'mutation-report.json'), 'utf8'));
  summary = { ...summary, ...summarize(report, targets) };
  if (child.error || child.status !== 0) summary.passed = false;
} catch (error) {
  summary.passed = false; summary.error = error.message;
} finally {
  summary.sourceUnchanged = fingerprint(root, files) === before;
  if (!summary.sourceUnchanged) summary.passed = false;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
}
console.log(`${summary.killed ?? 0}/${summary.tested ?? 0} targeted mutants detected; campaign ${summary.passed ? 'PASS' : 'FAIL'}.`);
if (summary.error) console.error(summary.error);
console.log('Local summary: .local/mutation/latest.json');
if (!summary.passed) process.exitCode = 1;
