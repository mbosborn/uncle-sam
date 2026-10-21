import { declareClassPlugin, PluginKind } from '@stryker-mutator/api/plugin';
import { INSTRUMENTER_CONSTANTS as instrumentation } from '@stryker-mutator/api/core';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function classify(result, expectedIds, activeMutant = null) {
  if (!result || !Array.isArray(result.tests) || !Array.isArray(result.blockedIO)
    || result.tests.length !== expectedIds.length || new Set(result.tests.map(t => t.id)).size !== expectedIds.length
    || expectedIds.some(id => !result.tests.some(t => t.id === id))) return { status: 'error', errorMessage: 'Incomplete mutation replay results' };
  if (activeMutant !== null && result.activeMutant !== activeMutant) return { status: 'error', errorMessage: 'Requested mutant was not active in the replay worker' };
  if (result.blockedIO.length || result.tests.some(t => ![0, 1].includes(t.status) || (t.status === 1 && !t.assertion)))
    return { status: 'error', errorMessage: `Mutation replay had an execution error or attempted external I/O: ${result.blockedIO.join(', ')}; ${result.tests.filter(t => t.status === 1 && !t.assertion).map(t => `${t.id} (${t.errorCode})`).join(', ')}` };
  const failed = result.tests.filter(t => t.status === 1);
  return failed.length ? { status: 'killed', killedBy: failed.map(t => t.id), failureMessage: failed.map(t => t.failureMessage).join('\n'), nrOfTests: result.tests.length }
    : { status: 'survived', nrOfTests: result.tests.length };
}

class ReplayRunner {
  capabilities() { return { reloadEnvironment: true }; }
  run(activeMutant, timeout) {
    const root = process.cwd(), temp = mkdtempSync(path.join(os.tmpdir(), 'sam-mutation-worker-'));
    try {
      const output = path.join(temp, 'result.json');
      const env = { PATH: path.dirname(process.execPath), TZ: 'UTC', LANG: 'en_US.UTF-8', NODE_NO_WARNINGS: '1' };
      if (activeMutant) env[instrumentation.ACTIVE_MUTANT_ENV_VARIABLE] = activeMutant.id;
      const child = spawnSync(process.execPath, ['--import', path.join(root, 'test/replay/isolation.mjs'),
        path.join(root, 'test/mutation/worker.mjs'), root, output], { cwd: temp, env, timeout: Math.ceil(Math.min(timeout, 120_000)), encoding: 'utf8', maxBuffer: 1024 * 1024 });
      if (child.error?.code === 'ETIMEDOUT') return { status: 'timeout', reason: 'Mutation replay exceeded its time limit' };
      if (child.error || child.status !== 0) return { status: 'error', errorMessage: `Mutation replay worker did not complete (exit ${child.status}, ${child.error?.code ?? 'no process error'})` };
      try { return JSON.parse(readFileSync(output, 'utf8')); }
      catch { return { status: 'error', errorMessage: 'Mutation replay report missing or invalid' }; }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  }
  async dryRun({ timeout }) {
    const result = this.run(null, timeout);
    if (result.status) return result;
    const { scenarios } = await import(path.join(process.cwd(), 'test/replay/scenarios.mjs'));
    this.ids = scenarios.map(s => s.id);
    const check = classify(result, this.ids);
    return check.status === 'error' ? check : { status: 'complete', tests: result.tests };
  }
  async mutantRun({ activeMutant, timeout }) {
    // Stryker may create a new runner after the baseline; load the expected list.
    const { scenarios } = await import(path.join(process.cwd(), 'test/replay/scenarios.mjs'));
    const result = this.run(activeMutant, timeout);
    return result.status ? result : classify(result, scenarios.map(s => s.id), activeMutant.id);
  }
}

// Keep the two true/false replacements of each entire guard. Nested expression
// mutations are outside this deliberately bounded campaign, not score exemptions.
class WholeGuardOnly {
  constructor() { this.targets = JSON.parse(readFileSync('mutation-targets.json', 'utf8')); }
  shouldIgnore(nodePath) {
    const node = nodePath.node, loc = node?.loc;
    if (!loc) return;
    const before = (a, b) => a.line < b.line || (a.line === b.line && a.column < b.column);
    // The filename is provided by Babel. Compare paths relative to the snapshot.
    const file = nodePath.hub?.file?.opts?.filename?.replaceAll('\\', '/');
    for (const t of this.targets.filter(t => !file || file.endsWith(t.file))) {
      if (!before(loc.start, t.start) && !before(t.end, loc.end)
        && (before(t.start, loc.start) || before(loc.end, t.end))) return 'Only whole safeguard conditions are in this campaign';
    }
  }
}
export const strykerPlugins = [
  declareClassPlugin(PluginKind.TestRunner, 'hiring-replay', ReplayRunner),
  declareClassPlugin(PluginKind.Ignore, 'whole-guard-only', WholeGuardOnly),
];
