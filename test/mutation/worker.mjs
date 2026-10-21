// This child has no credentials, provider access or subprocess access. The only
// extra environment value is Stryker's selected mutation identifier.
import { blocked } from '../replay/isolation.mjs';
import { writeFileSync } from 'node:fs';
import { createWorld } from '../replay/world.mjs';
import { scenarios } from '../replay/scenarios.mjs';
import { INSTRUMENTER_CONSTANTS as instrumentation } from '@stryker-mutator/api/core';
const [root, output] = process.argv.slice(2);
delete process.env.__CF_USER_TEXT_ENCODING;
for (const key of Object.keys(process.env)) {
  if (!['PATH', 'TZ', 'LANG', 'NODE_NO_WARNINGS', instrumentation.ACTIVE_MUTANT_ENV_VARIABLE].includes(key)) throw Error('Mutation worker inherited unexpected environment');
}
const requested = process.env[instrumentation.ACTIVE_MUTANT_ENV_VARIABLE];
if (requested && !/^\d+$/.test(requested)) throw Error('Invalid mutant identifier');
const tests = [];
for (const scenario of scenarios) {
  let world;
  const row = { id: scenario.id, name: scenario.id, status: 0 }, start = performance.now();
  try {
    world = await createWorld(root, scenario.options);
    await scenario.run(world);
  } catch (error) {
    row.status = 1;
    row.assertion = error?.code === 'ERR_ASSERTION' && error?.name === 'AssertionError';
    row.errorCode = error?.code ?? error?.name ?? 'unknown';
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && error.url) row.errorCode += `: ${new URL(error.url).pathname.split('/').slice(-2).join('/')}`;
    // Never export mail bodies, generated credentials, source text or raw stacks.
    row.failureMessage = `${scenario.id}: ${row.assertion ? 'safety assertion failed' : 'scenario execution failed'}`;
    row.step = world?.timeline.at(-1)?.label ?? null;
  } finally {
    await world?.close();
    row.timeSpentMs = performance.now() - start;
    tests.push(row);
  }
}
writeFileSync(output, JSON.stringify({ tests, blockedIO: blocked,
  activeMutant: globalThis[instrumentation.NAMESPACE]?.[instrumentation.ACTIVE_MUTANT] ?? null }), { mode: 0o600 });
