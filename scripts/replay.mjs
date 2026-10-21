#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), opts = {};
for (let i = 0; i < argv.length; i++) {
  if (!['--report', '--compare-ref', '--scenario'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Usage: node scripts/replay.mjs [--report file.json] [--compare-ref git-ref] [--scenario id]');
  opts[argv[i].slice(2)] = argv[++i];
}
const temp = mkdtempSync(path.join(os.tmpdir(), 'uncle-sam-comparison-'));
// Do not inherit tokens, NODE_OPTIONS, .env loaders, deployment settings or home.
const cleanEnv = { PATH: path.dirname(process.execPath), TZ: 'UTC', LANG: 'en_US.UTF-8', NODE_NO_WARNINGS: '1' };
function run(source, name) {
  const output = path.join(temp, `${name}.json`);
  const child = spawnSync(process.execPath, ['--import', path.join(root, 'test/replay/isolation.mjs'), path.join(root, 'test/replay/worker.mjs'), source, output, ...(opts.scenario ? [opts.scenario] : [])],
    { cwd: temp, env: cleanEnv, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw Error(`Replay worker failed: ${child.error?.message ?? child.stderr ?? child.status}`);
  return JSON.parse(readFileSync(output, 'utf8'));
}
function git(args, options = {}) {
  const out = spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
  if (out.error || out.status !== 0) throw Error(`git ${args[0]} failed: ${out.error?.message ?? out.stderr}`);
  return out.stdout;
}
try {
  let baseline = null, baselineRef = null;
  if (opts['compare-ref']) {
    baselineRef = git(['rev-parse', '--verify', '--end-of-options', `${opts['compare-ref']}^{commit}`]).trim();
    if (git(['show', `${baselineRef}:package-lock.json`]) !== readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
      throw Error('Baseline dependencies differ. Compare revisions with the same lockfile; this runner does not install historical dependencies.');
    // Both versions use the CURRENT scenarios and harness. Never run old tests as the baseline.
    const target = path.join(temp, 'baseline'); mkdirSync(target);
    const archive = git(['archive', baselineRef, 'service'], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
    const tar = spawnSync('tar', ['-xf', '-', '-C', target], { input: archive, encoding: 'utf8' });
    if (tar.error || tar.status !== 0) throw Error(`Cannot extract baseline: ${tar.error?.message ?? tar.stderr}`);
    symlinkSync(path.join(root, 'node_modules'), path.join(target, 'node_modules'), 'dir');
    baseline = run(target, 'baseline');
  }
  const candidate = run(root, 'candidate');
  const comparison = baseline ? candidate.scenarios.map(s => {
    const old = baseline.scenarios.find(x => x.id === s.id);
    return { id: s.id, status: old.passed && !s.passed ? 'regressed' : !old.passed && s.passed ? 'improved' : s.passed ? 'passed-both' : 'failed-both',
      effectsChanged: JSON.stringify(old.effects) !== JSON.stringify(s.effects),
      metricDelta: Object.fromEntries(Object.keys(s.metrics ?? {}).map(k => [k, s.metrics[k] - (old.metrics?.[k] ?? 0)])) };
  }) : null;
  if (baseline && baseline.suiteHash !== candidate.suiteHash) throw Error('Incomparable replay suites');
  const result = { ...candidate, source: { commit: git(['rev-parse', 'HEAD']).trim(), workingTree: git(['status', '--porcelain']).trim() ? 'modified' : 'clean' },
    ...(baseline ? { baselineRef, baseline, comparison } : {}) };
  for (const s of candidate.scenarios) console.log(`${s.passed ? 'PASS' : 'FAIL'} ${s.id}${s.error ? `: ${s.error.message.split('\n')[0]}` : ''}`);
  console.log(`${candidate.scenarios.filter(s => s.passed).length}/${candidate.scenarios.length} scenarios passed; external I/O attempts: ${candidate.blockedIO.length}.`);
  if (comparison) console.log(`Compared with ${baselineRef.slice(0, 12)}: ${comparison.filter(x => x.status === 'improved').length} improved, ${comparison.filter(x => x.status === 'regressed').length} regressed, ${comparison.filter(x => x.status === 'failed-both').length} failed both.`);
  if (opts.report) { const output = path.resolve(opts.report); mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 }); console.log(`Report: ${output}`); }
  if (!candidate.passed || comparison?.some(s => s.status === 'regressed')) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
