import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistedFixture } from './support/d1.mjs';
import { relayOutbox } from '../service/lib/outbox.mjs';

const NOW = Date.parse('2026-10-16T16:10:00Z');
const ENV = Object.freeze({ UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', SLACK_BOT_TOKEN: 'xoxb-fixture-only', UNCLE_SAM_OUTBOX_CHANNEL: 'C0CAGSCLA1W' });
const ROUTES = Object.freeze({ project: { channelId: 'D0MASON001', type: 'im' } });
const PROJECT = 'U0F9EF97D89';
const ts = (msAgo, n = 1) => `${Math.floor((NOW - msAgo) / 1000)}.00000${n}`;

function setup(history) {
  const posts = [];
  const reads = [];
  const slackRead = { async readHistory(args) { reads.push(args); return history.filter(m => Number(m.ts) >= Number(args.oldest)); } };
  const fetchImpl = async (url, init) => { posts.push(JSON.parse(init.body)); return Response.json({ ok: true, ts: `9.${posts.length}` }); };
  return { posts, reads, slackRead, fetchImpl };
}

test('Project\'s new outbox messages are re-posted once into his DM by the bot; nobody else\'s, no thread replies, nothing older than an hour', async () => {
  const { db } = persistedFixture();
  const long = `*Daily checklist — Fri Oct 16*\n${'• item\n'.repeat(900)}`;
  const history = [
    { ts: ts(2 * 3600_000), user: PROJECT, text: 'too old' },
    { ts: ts(10 * 60_000), user: PROJECT, text: long },
    { ts: ts(9 * 60_000), user: 'U0A4F08721B', text: 'Robin wandered in' },
    { ts: ts(8 * 60_000), user: PROJECT, botId: 'B1', text: 'a bot post' },
    { ts: ts(7 * 60_000), user: PROJECT, threadTs: ts(10 * 60_000), text: 'a thread reply' },
    { ts: ts(6 * 60_000), user: PROJECT, text: '*Internal hiring* tracker *Sent using* <@U0A88TFE3RT|Claude>' },
  ];
  const s = setup(history);
  const run = () => relayOutbox({ env: ENV, db, slackRead: s.slackRead, routeMap: ROUTES, fetchImpl: s.fetchImpl, clock: () => NOW });
  assert.deepEqual(await run(), { relayed: 2, error: null });
  assert.deepEqual(s.posts.map(p => [p.channel, p.text]), [['D0MASON001', long], ['D0MASON001', '*Internal hiring* tracker']]);
  assert.equal(s.reads[0].channelId, 'C0CAGSCLA1W');
  assert.equal(s.reads[0].maxText, 39000);
  assert.deepEqual(await run(), { relayed: 0, error: null }, 'each message once');
  history.push({ ts: ts(60_000), user: PROJECT, text: 'clerk: a failure note' });
  assert.deepEqual(await run(), { relayed: 1, error: null });
  assert.equal(s.posts.at(-1).text, 'clerk: a failure note');
});

test('off without the outbox channel or with automatic activity off', async () => {
  const { db } = persistedFixture();
  const s = setup([{ ts: ts(60_000), user: PROJECT, text: 'x' }]);
  for (const env of [{ ...ENV, UNCLE_SAM_OUTBOX_CHANNEL: '' }, { ...ENV, UNCLE_SAM_AUTOMATIC_ACTIVITY: 'off' }]) {
    assert.deepEqual(await relayOutbox({ env, db, slackRead: s.slackRead, routeMap: ROUTES, fetchImpl: s.fetchImpl, clock: () => NOW }), { relayed: 0, error: null });
  }
  assert.equal(s.posts.length, 0);
});
