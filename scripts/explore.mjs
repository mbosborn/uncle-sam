#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), args = process.argv.slice(2), opts = {};
for (let i = 0; i < args.length; i++) {
  if (['--regressions', '--retain'].includes(args[i])) { opts[args[i].slice(2)] = true; continue; }
  if (!['--runs', '--events', '--seed', '--path', '--report', '--replay'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
    throw Error('Usage: npm run test:explore -- [--runs 100] [--events 20] [--seed number] [--path shrink-path] [--report file.json] [--replay saved.json] [--retain] [--regressions]');
  opts[args[i].slice(2)] = args[++i];
}
for (const [key, fallback, min, max] of [['runs', 100, 1, 10000], ['events', 20, 1, 100], ['seed', undefined, -2147483648, 2147483647]]) {
  if (opts[key] === undefined && fallback === undefined) continue;
  opts[key] = Number(opts[key] ?? fallback);
  if (!Number.isInteger(opts[key]) || opts[key] < min || opts[key] > max) throw Error(`Invalid --${key}`);
}
if (opts.path && opts.seed === undefined) throw Error('--path requires --seed');
if (opts.retain && !opts.replay) throw Error('--retain requires a reviewed --replay file');
if (opts.replay) opts.replay = path.resolve(opts.replay);
const temp = mkdtempSync(path.join(os.tmpdir(), 'uncle-sam-explore-'));
const output = path.join(temp, 'result.json');
try {
  const child = spawnSync(process.execPath, ['--import', path.join(root, 'test/replay/isolation.mjs'), path.join(root, 'test/replay/generated-worker.mjs'), root, output,
    JSON.stringify({ ...opts, maxEvents: opts.events })], { cwd: temp,
    env: { PATH: path.dirname(process.execPath), TZ: 'UTC', LANG: 'en_US.UTF-8', NODE_NO_WARNINGS: '1' }, encoding: 'utf8', timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw Error(`Generated worker failed: ${child.error?.message ?? child.stderr}`);
  const report = JSON.parse(readFileSync(output, 'utf8'));
  const hash = createHash('sha256');
  const visit = dir => { for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || ['node_modules', 'dist'].includes(e.name)) continue;
    const f = path.join(dir, e.name); if (e.isDirectory()) visit(f); else hash.update(path.relative(root, f)).update(readFileSync(f));
  } };
  visit(path.join(root, 'service')); report.sourceHash = hash.digest('hex');
  report.createdAt = new Date().toISOString();
  const destination = path.resolve(opts.report ?? path.join(root, '.local/replay-generated/latest.json'));
  mkdirSync(path.dirname(destination), { recursive: true }); writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  for (const r of report.regressions) console.log(`${r.passed ? 'PASS' : 'FAIL'} regression ${r.file}${r.error ? `: ${r.error.split('\n')[0]}` : ''}`);
  const result = report.generated;
  if (result) {
    console.log(`${result.passed ? 'PASS' : 'FAIL'} generated replay: ${result.runs} runs, ${result.executions} executions, ${result.shrinks} shrinks; seed ${result.seed}${result.path ? `, path ${result.path}` : ''}.`);
    console.log(`Observed effects: ${JSON.stringify(result.effects)}. External I/O attempts: ${report.blockedIO.length}.`);
    if (result.failure) {
      const dir = path.join(root, '.local/replay-generated/failures'); mkdirSync(dir, { recursive: true });
      const name = createHash('sha256').update(JSON.stringify(result.failure.plan)).update(JSON.stringify(result.failure.ordering)).digest('hex').slice(0, 16);
      const file = path.join(dir, `${name}.json`);
      writeFileSync(file, JSON.stringify({ schemaVersion: 1, seed: result.seed, path: result.path, sourceHash: report.sourceHash, fastCheckVersion: report.fastCheckVersion, ...result.failure }, null, 2) + '\n', { mode: 0o600 });
      console.log(`Retained reduced failure: ${file}\n${result.failure.error}\nReplay with: npm run test:explore -- --replay ${file}`);
    }
  }
  if (opts.retain) {
    if (!report.passed) throw Error('Fix the failure before promoting it into the passing regression suite');
    const saved = JSON.parse(readFileSync(opts.replay, 'utf8')), item = saved.failure ?? saved;
    const normalized = { schemaVersion: 1, plan: item.plan, ordering: item.ordering };
    const name = createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
    const dir = path.join(root, 'test/replay/generated-regressions'); mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(normalized, null, 2) + '\n');
    console.log(`Retained passing regression ${name}.json`);
  }
  console.log(`Report: ${destination}`);
  if (!report.passed) process.exitCode = 1;
} finally { rmSync(temp, { recursive: true, force: true }); }
