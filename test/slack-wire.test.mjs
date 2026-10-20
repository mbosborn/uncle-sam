import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSON_METHODS, slackWire } from '../service/lib/slack-wire.mjs';
import { createSlackReader } from '../service/lib/slack-read.mjs';
import { parseSlackBody, slackArguments } from './support/slack-wire.mjs';

/**
 * The live Slack API ignores the arguments of a JSON body on every method except chat.postMessage (checked 2026-10-14:
 * users.info answered user_not_found, bots.info an empty bot). Pretend Slacks that read JSON everywhere hid this from every
 * earlier test, so the fakes now read bodies the way Slack does (test/support/slack-wire.mjs) and these tests pin the encoding.
 */
const FORM = 'application/x-www-form-urlencoded';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('read methods go as a form; only chat.postMessage goes as JSON', () => {
  assert.deepEqual([...JSON_METHODS], ['chat.postMessage']);
  const history = slackWire('conversations.history', 'xoxb-fixture-only', { channel: 'C0123ABCD', limit: 30, inclusive: true, oldest: undefined, latest: null });
  assert.equal(history.headers.authorization, 'Bearer xoxb-fixture-only');
  assert.equal(history.headers['content-type'], FORM);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(history.body)), { channel: 'C0123ABCD', limit: '30', inclusive: 'true' }, 'numbers and booleans become text; empty values are left out');
  const open = slackWire('conversations.open', 't', { users: ['U1', 'U2'], return_im: false });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(open.body)), { users: 'U1,U2', return_im: 'false' });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(slackWire('x.y', 't', { metadata: { a: 1 } }).body)), { metadata: '{"a":1}' }, 'nested values travel as JSON text');
  const post = slackWire('chat.postMessage', 't', { channel: 'C0123ABCD', text: 'hi', unfurl_links: false });
  assert.equal(post.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(post.body), { channel: 'C0123ABCD', text: 'hi', unfurl_links: false });
});

test('the fake Slack reads bodies the way the real one does: JSON is ignored except for chat.postMessage', () => {
  assert.deepEqual(parseSlackBody('users.info', 'application/json; charset=utf-8', JSON.stringify({ user: 'U1' })).args, {}, 'the arguments of a JSON body are ignored');
  assert.deepEqual(parseSlackBody('bots.info', 'application/json', JSON.stringify({ bot: 'B1' })).args, {});
  assert.deepEqual(parseSlackBody('chat.postMessage', 'application/json; charset=utf-8', JSON.stringify({ text: 'x' })).args, { text: 'x' });
  assert.deepEqual(parseSlackBody('users.info', FORM, 'user=U1').args, { user: 'U1' });
  assert.deepEqual(parseSlackBody('users.info', undefined, 'user=U1').args, {}, 'no content type, no arguments');
  assert.deepEqual(slackArguments('https://slack.com/api/bots.info', { method: 'POST', headers: { 'Content-Type': FORM }, body: 'bot=B1' }), { method: 'bots.info', type: FORM, args: { bot: 'B1' } });
});

test('the reader sends every argument as a form field, the only place Slack reads them', async () => {
  const seen = [];
  const answers = {
    'conversations.replies': a => (a.channel === 'C0123ABCD' && a.ts === '1791926400.000001' && a.limit === '50' && a.inclusive === 'true'
      ? { ok: true, messages: [{ ts: '1791926400.000001', user: 'U1', text: 'root' }, { ts: '1791926400.000002', user: 'U2', text: 'reply' }] } : { ok: false, error: 'channel_not_found' }),
    'conversations.history': a => (a.channel === 'C0123ABCD' && a.oldest === '1791926400.000001' && a.latest === '1791926401.000001' && a.limit === '30' && a.inclusive === 'true'
      ? { ok: true, messages: [{ ts: '1791926400.000002', text: 'newer' }, { ts: '1791926400.000001', text: 'older' }] } : { ok: false, error: 'channel_not_found' }),
    'conversations.info': a => (a.channel === 'C0123ABCD' ? { ok: true, channel: { id: 'C0123ABCD', is_im: true } } : { ok: false, error: 'channel_not_found' }),
  };
  const fetchImpl = async (url, init) => {
    assert.equal(init.redirect, 'error');
    const request = slackArguments(url, init);
    seen.push({ ...request, authorization: init.headers.authorization });
    return Response.json(answers[request.method]?.(request.args) ?? { ok: false, error: 'unknown_method' });
  };
  const reader = createSlackReader({ env: { SLACK_BOT_TOKEN: 'xoxb-fixture-only' }, fetchImpl });
  assert.deepEqual((await reader.readThread({ channelId: 'C0123ABCD', threadTs: '1791926400.000001' })).map(m => m.text), ['root', 'reply']);
  assert.deepEqual((await reader.readHistory({ channelId: 'C0123ABCD', oldest: '1791926400.000001', latest: '1791926401.000001' })).map(m => m.text), ['older', 'newer']);
  assert.equal((await reader.conversationInfo('C0123ABCD')).isIm, true);
  assert.deepEqual([...new Set(seen.map(call => call.type))], [FORM]);
  assert.ok(seen.every(call => call.authorization === 'Bearer xoxb-fixture-only'));
});

test('every module that calls the Slack Web API builds its requests with slackWire', () => {
  // setup.mjs only calls auth.test, which takes no arguments, so it needs no encoding.
  const exempt = new Set([path.join('scripts', 'setup.mjs')]);
  const offenders = [];
  for (const dir of ['service/lib', 'scripts']) {
    for (const name of readdirSync(path.join(root, dir)).filter(file => file.endsWith('.mjs'))) {
      const file = path.join(dir, name);
      if (exempt.has(file) || file === path.join('service/lib', 'slack-wire.mjs')) continue;
      const source = readFileSync(path.join(root, file), 'utf8');
      if (/slack\.com\/api|\$\{apiBase\}/.test(source) && !source.includes('slackWire(')) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});
