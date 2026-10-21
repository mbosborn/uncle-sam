import { blocked } from '../replay/isolation.mjs';
import { writeFile } from 'node:fs/promises';
import { createWorld, TEAM_DOMAIN } from '../replay/world.mjs';
import { assertSyntheticReport } from '../replay/privacy.mjs';
import { scenarios } from './scenarios.mjs';

const [root, output, filter, repeatText = '3'] = process.argv.slice(2);
delete process.env.__CF_USER_TEXT_ENCODING;
for (const key of Object.keys(process.env)) if (!['PATH', 'TZ', 'LANG', 'NODE_NO_WARNINGS'].includes(key)) throw Error('Model evaluation requires a clean child environment');
if (!process.send) throw Error('Model evaluation requires the isolated IPC launcher');
const selected = scenarios.filter(s => !filter || s.id === filter);
if (!selected.length) throw Error('Unknown model scenario');
let nextId = 0, context;
const pending = new Map();
process.on('message', message => {
  const call = pending.get(message.id); if (!call) return;
  pending.delete(message.id); clearTimeout(call.timer);
  if (message.error) call.reject(Object.assign(Error(message.error), { code: message.error }));
  else call.resolve(message.response);
});
const report = { schemaVersion: 1, mode: 'real-model-isolated-effects', scenarios: [] };
for (let repetition = 1; repetition <= Number(repeatText); repetition++) for (const s of selected) {
  const row = { id: s.id, family: s.family, repetition, passed: false, decisions: [], modelErrors: [], modelCalls: 0 };
  let w;
  context = { scenario: s.id, repetition };
  const claude = { complete: async request => {
    row.modelCalls++;
    try {
      const id = ++nextId;
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(Error('eval_broker_timeout')); }, 90_000);
        pending.set(id, { resolve, reject, timer });
        process.send({ type: 'model', id, context, request });
      });
      if (response.stopReason === 'max_tokens') throw Error('eval_truncated_response');
      for (const block of response.content ?? []) if (block.type === 'tool_use') row.decisions.push({ name: block.name, input: block.input });
      return response;
    } catch (error) { row.modelErrors.push(error.code ?? error.message); throw error; }
  } };
  try {
    w = await createWorld(root, { ...s.options, claude });
    await s.run(w, { root, claude, tools: name => row.decisions.filter(x => x.name === name).map(x => x.input) });
    if (row.modelErrors.length) throw Error(row.modelErrors[0]);
    const terminal = { feedback: 'propose', recap: 'report_recap', terms: 'terms', dates: 'dates' }[s.family];
    if (!s.options.allowNoModel && (!row.modelCalls || !row.decisions.some(x => x.name === terminal))) throw Error('eval_missing_model_decision');
    row.passed = true;
  } catch (error) { row.error = String(error.message).slice(0, 2000); }
  finally {
    if (w) {
      // No generated credentials, raw prompts, hidden reasoning or operational records in reports.
      row.effects = { emails: w.emails.map(({ to, subject }) => ({ to, subject })), envelopes: w.envelopes, calendarWrites: w.calendarWrites };
      await w.close();
    }
  }
  report.scenarios.push(row);
  process.send({ type: 'progress', id: row.id, repetition, passed: row.passed, error: row.error?.split('\n')[0] });
}
report.blockedIO = blocked;
report.passed = report.scenarios.every(x => x.passed) && blocked.length === 0;
const text = JSON.stringify(report, null, 2).replaceAll(`@${TEAM_DOMAIN}`, '@company.example');
assertSyntheticReport(JSON.parse(text));
await writeFile(output, text + '\n', { mode: 0o600 });
process.disconnect();
