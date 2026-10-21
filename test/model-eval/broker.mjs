import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = code => Object.assign(new Error(code), { code });

// Only this parent-side adapter receives a model credential. Workflow children
// have no credentials or network access. Tool calls are data returned to them.
export function createBroker({ client, maxCalls = 120, maxOutputTokens = 65536, timeoutMs = 25 * 60_000, clock = Date.now }) {
  const started = clock(), calls = [], totals = { input: 0, output: 0 };
  let reservedOutput = 0, fatal = null;
  return {
    calls, totals,
    async complete(request, context) {
      if (fatal) throw fail(fatal);
      const cap = request?.maxTokens ?? 8192;
      if (!request || !Array.isArray(request.messages) || !request.messages.length || !Number.isSafeInteger(cap) || cap < 1 || cap > 8192 ||
          Buffer.byteLength(JSON.stringify(request)) > 256 * 1024) throw fail('eval_invalid_model_request');
      if (clock() - started >= timeoutMs || calls.length >= maxCalls || totals.output + reservedOutput + cap > maxOutputTokens)
        throw fail('eval_budget_exhausted');
      const row = { scenario: context.scenario, repetition: context.repetition, requestHash: hash(request), requestedMaxOutput: cap, status: 'pending' };
      calls.push(row); reservedOutput += cap;
      try {
        const response = await client.complete(request);
        row.model = response.model; row.servedBy = response.servedBy ?? null; row.responseId = response.id ?? null;
        row.stopReason = response.stopReason; row.usage = response.usage;
        // Missing usage cannot silently defeat the spending bound.
        if (!Number.isSafeInteger(response.usage?.input) || response.usage.input < 0 || !Number.isSafeInteger(response.usage?.output) || response.usage.output < 0)
          throw fail('eval_usage_unavailable');
        totals.input += response.usage.input; totals.output += response.usage.output;
        if (!Array.isArray(response.content)) throw fail('eval_invalid_model_response');
        row.status = 'ok';
        return response;
      } catch (error) {
        // Never print provider error bodies, headers, prompts or credentials.
        row.status = 'error'; row.error = String(error.code ?? 'eval_model_failed').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 90);
        fatal = row.error;
        throw fail(row.error);
      } finally { reservedOutput -= cap; row.elapsedMs = clock() - started; }
    },
  };
}
