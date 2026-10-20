/**
 * Preloaded with `node --import` so a script that runs as a child process talks to fixtures instead of the internet.
 * FAKE_NET_SCENARIO picks how the model API answers; FAKE_NET_LOG names a file that receives one JSON line per request.
 * Only the hosts the setup checks call are faked; anything else answers 500 so a stray request cannot pass unnoticed.
 */
import { appendFileSync } from 'node:fs';

const scenario = process.env.FAKE_NET_SCENARIO ?? 'ok';
const record = entry => { if (process.env.FAKE_NET_LOG) appendFileSync(process.env.FAKE_NET_LOG, `${JSON.stringify(entry)}\n`); };
const reply = (content, stopReason) => ({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-model', stop_reason: stopReason,
  content, usage: { input_tokens: 21, output_tokens: 8 } });
const proposes = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_fixture', name: 'propose', input: { kind: 'no_action', reason: 'synthetic' } }];

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  record({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null });
  if (url === 'https://slack.com/api/auth.test') return Response.json({ ok: true, team_id: 'T07011B7862', user_id: 'UBOTFIXTURE', bot_id: 'BBOTFIXTURE' });
  if (url.startsWith('https://api.notion.com/v1/pages/')) return Response.json({ properties: { Mode: { select: { name: 'Live' } } } });
  if (url.startsWith('https://api.anthropic.com/v1/models/')) return new Response('{}', { status: scenario === 'unknown-model' ? 404 : 200 });
  if (url === 'https://api.anthropic.com/v1/messages' || url === 'https://openrouter.ai/api/v1/messages') {
    if (scenario === 'credit') return new Response(JSON.stringify({ error: { message: 'secret-sentinel' } }), { status: 402 });
    if (scenario === 'truncated') return Response.json(reply([{ type: 'thinking', thinking: '', signature: 'sig' }], 'max_tokens'));
    if (scenario === 'talks') return Response.json(reply([{ type: 'text', text: 'All good.' }], 'end_turn'));
    return Response.json({ ...reply(proposes, 'tool_use'), ...(url.startsWith('https://openrouter.ai') ? { provider: 'Anthropic' } : {}) });
  }
  return new Response('unexpected request', { status: 500 });
};
