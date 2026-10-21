import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBroker } from './model-eval/broker.mjs';
import { runEvaluation } from './model-eval/launcher.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const response = content => ({ content, usage: { input: 50, output: 20 }, model: 'fixture-model', stopReason: 'tool_use' });
const request = { maxTokens: 100, messages: [{ role: 'user', content: 'Synthetic data only' }] };
const context = { scenario: 'fixture', repetition: 1 };
test('model broker enforces request and reserved output budgets before another paid call', async () => {
  let calls = 0;
  const client = { complete: async () => { calls++; return response([]); } };
  const broker = createBroker({ client, maxCalls: 1, maxOutputTokens: 100 });
  await broker.complete(request, context);
  await assert.rejects(broker.complete(request, context), { code: 'eval_budget_exhausted' });
  assert.equal(calls, 1); assert.deepEqual(broker.totals, { input: 50, output: 20 });
  let finish;
  const concurrent = createBroker({ client: { complete: () => new Promise(resolve => { finish = resolve; }) }, maxCalls: 3, maxOutputTokens: 100 });
  const first = concurrent.complete(request, context);
  await assert.rejects(concurrent.complete(request, context), { code: 'eval_budget_exhausted' });
  finish(response([])); await first;
});
test('missing usage or a provider error stops further calls without exposing the provider body', async () => {
  const broker = createBroker({ client: { complete: async () => ({ content: [] }) } });
  await assert.rejects(broker.complete(request, context), { code: 'eval_usage_unavailable' });
  await assert.rejects(broker.complete(request, context), { code: 'eval_usage_unavailable' });
  assert.equal(broker.calls.length, 1);
  const broken = createBroker({ client: { complete: async () => { throw Object.assign(Error('PRIVATE_ERROR_BODY'), { code: 'http_401' }); } } });
  await assert.rejects(broken.complete(request, context), { code: 'http_401' });
  assert.ok(!JSON.stringify(broken.calls).includes('PRIVATE_ERROR_BODY'));
});
test('an incorrect real-model-shaped decision fails even if a downstream quote guard blocks delivery', async () => {
  const result = await runEvaluation({ root, repeat: 1, scenario: 'terms-tentative', client: { complete: async () => response([
    { type: 'tool_use', name: 'terms', input: { dates_agreed: true, start: '2026-10-24', end: '2026-10-25', date_quotes: [], rate_stated: false } },
  ]) } });
  assert.equal(result.passed, false); assert.equal(result.scenarios[0].modelCalls, 1);
  assert.match(result.scenarios[0].error, /bilateral/); assert.deepEqual(result.scenarios[0].effects.emails, []);
  assert.deepEqual(result.blockedIO, []);
});
test('missing or truncated model output cannot receive a safety pass', async () => {
  for (const reply of [response([]), { ...response([]), stopReason: 'max_tokens' }]) {
    const result = await runEvaluation({ root, repeat: 1, scenario: 'terms-tentative', client: { complete: async () => reply } });
    assert.equal(result.passed, false);
  }
});
test('isolated model worker accepts a valid interpretation and never inherits provider or database credentials', async () => {
  const previous = process.env.TURSO_AUTH_TOKEN; process.env.TURSO_AUTH_TOKEN = 'must-not-inherit';
  try {
    const result = await runEvaluation({ root, repeat: 1, scenario: 'terms-tentative', client: { complete: async () => response([
      { type: 'tool_use', name: 'terms', input: { dates_agreed: false, rate_stated: false, pay_concern: false } },
    ]) } });
    assert.equal(result.passed, true); assert.equal(result.calls.length, 1); assert.deepEqual(result.blockedIO, []);
    assert.ok(!JSON.stringify(result).includes('must-not-inherit'));
  } finally { if (previous === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = previous; }
});

test('lookup-only tool calls are not a completed model decision', async () => {
  const result = await runEvaluation({ root, repeat: 1, scenario: 'feedback-conditional', client: { complete: async () => response([
    { type: 'tool_use', id: 'lookup-only', name: 'read_candidate', input: {} },
  ]) } });
  assert.equal(result.passed, false);
  assert.match(result.scenarios[0].error, /eval_missing_model_decision/);
});
