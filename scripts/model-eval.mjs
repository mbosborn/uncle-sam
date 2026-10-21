#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createClaudeClient, ANTHROPIC_URL, OPENROUTER_URL } from '../service/lib/anthropic.mjs';
import { runEvaluation } from '../test/model-eval/launcher.mjs';
import { scenarios } from '../test/model-eval/scenarios.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const opts = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--list') { opts.list = true; continue; }
  if (!['--scenario', '--repeat', '--report', '--config', '--route', '--model', '--max-calls', '--max-output-tokens'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
    throw Error('Usage: npm run test:model -- [--list] [--scenario id] [--repeat 3] [--report file.json] [--config private-secrets.json] [--route anthropic|openrouter] [--model id] [--max-calls 120] [--max-output-tokens 65536]');
  opts[args[i].slice(2)] = args[++i];
}
function integer(name, fallback, min, max) { const n = Number(opts[name] ?? fallback); if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`Invalid --${name}`); return n; }
if (opts.list) { for (const s of scenarios) console.log(`${s.id} (${s.family})`); }
else {
  if (opts.scenario && !scenarios.some(x => x.id === opts.scenario)) throw Error('Unknown scenario');
  const repeat = integer('repeat', 3, 1, 10), maxCalls = integer('max-calls', 120, 1, 500), maxOutputTokens = integer('max-output-tokens', 65536, 8192, 1_000_000);
  // Explicit config only. Never load dotenv, database credentials or production data into a worker.
  const config = opts.config ? JSON.parse(readFileSync(path.resolve(opts.config), 'utf8')).secrets ?? {} : {};
  const value = name => { const x = process.env[name] ?? config[name]; return typeof x === 'string' && x && !x.startsWith('<') ? x : undefined; };
  const route = opts.route ?? (value('ANTHROPIC_API_KEY') ? 'anthropic' : 'openrouter');
  if (!['anthropic', 'openrouter'].includes(route)) throw Error('Invalid route');
  const apiKey = value(route === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY');
  if (!apiKey) throw Error('No model credential configured. Use the selected provider environment variable or an explicit private --config file.');
  const model = opts.model ?? value(route === 'anthropic' ? 'ANTHROPIC_MODEL' : 'OPENROUTER_MODEL');
  const endpoint = route === 'anthropic' ? ANTHROPIC_URL : OPENROUTER_URL;
  const client = createClaudeClient({ apiKey, route, model, fetchImpl: (url, init) => {
    if (url !== endpoint || init?.method !== 'POST') throw Object.assign(Error('Unexpected evaluation endpoint'), { code: 'eval_endpoint_denied' });
    return fetch(url, { ...init, redirect: 'error' });
  } });
  const digest = dirs => { const h = createHash('sha256'); const visit = dir => { for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || ['node_modules', 'dist'].includes(e.name)) continue;
    const file = path.join(dir, e.name); if (e.isDirectory()) visit(file); else h.update(path.relative(root, file)).update(readFileSync(file));
  } }; dirs.forEach(d => visit(path.join(root, d))); return h.digest('hex'); };
  console.log(`Real model evaluation: ${route}, ${repeat} repetitions, at most ${maxCalls} requests and ${maxOutputTokens} output tokens. All workflow effects are isolated.`);
  const sourceHash = digest(['service']), suiteHash = digest(['test/model-eval', 'test/replay']);
  const report = await runEvaluation({ root, client, scenario: opts.scenario, repeat, maxCalls, maxOutputTokens,
    onProgress: x => console.log(`${x.passed ? 'PASS' : 'FAIL'} ${x.id} [${x.repetition}]${x.error ? `: ${x.error}` : ''}`) });
  Object.assign(report, { createdAt: new Date().toISOString(), route, sourceHash, suiteHash });
  if (digest(['service']) !== sourceHash || digest(['test/model-eval', 'test/replay']) !== suiteHash) { report.passed = false; report.invalidated = 'Source or suite changed during evaluation; rerun against a stable revision'; }
  const output = path.resolve(opts.report ?? path.join(root, '.local/model-eval/latest.json'));
  mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`${report.scenarios.filter(s => s.passed).length}/${report.scenarios.length} passed; ${report.calls.length} model calls; ${report.usage.input} input / ${report.usage.output} output tokens. Report: ${output}`);
  if (!report.passed) process.exitCode = 1;
}
