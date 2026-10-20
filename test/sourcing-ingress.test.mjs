import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSlackIngress } from '../service/lib/slack-ingress.mjs';
import { persistedFixture } from './support/d1.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

const secret = 'local-fixture-signing-only';
const CH = 'C01D1A69CE3', ROBIN = 'U0A4F08721B', BOT = 'U0C4899BFC9';
function signed(at, event, eventId) {
  const body = JSON.stringify({ type: 'event_callback', event_id: eventId, api_app_id: 'A09DDB3817C', team_id: 'T07011B7862', event });
  const seconds = String(at / 1000);
  const mac = createHmac('sha256', secret).update('v0:' + seconds + ':' + body).digest('hex');
  return new Request('https://local.test/api/slack/events', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': seconds, 'x-slack-signature': 'v0=' + mac } });
}

test('Thread replies in #int-recruitment: kept for the sourcing lane under a known list, or when a teammate\'s reply reads like picks; other chatter dropped', async () => {
  const f = persistedFixture();
  await noticeStore(f.db).put(`sourcing:thread:${CH}:1792000000.000100`, { batchId: 'post-1' }, f.at);
  const receive = createSlackIngress({ env: { NOTION_TOKEN: 'fixture-token', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'off', DB: f.db, SLACK_BOT_USER_ID: BOT }, store: f.store, schedule: () => {},
    signatureConfig: { signingSecret: secret, allowedAppIds: ['A09DDB3817C'], allowedTeamIds: ['T07011B7862'], allowedConversations: { im: ['DFIXTURE'] }, botUserId: BOT, questions: true, now: () => f.at } });
  const ts = n => `${f.at / 1000 + n}.000001`;
  const reply = (id, threadTs, text, user = ROBIN) => receive(signed(f.at, { type: 'message', channel: CH, channel_type: 'channel', ts: ts(id), thread_ts: threadTs, user, text }, `Ev${id}`));
  assert.equal((await reply(1, '1792000000.000100', 'the second one')).status, 200);
  const known = await f.store.getEvent('Ev1');
  assert.equal(known?.type, 'qa_question');
  assert.equal(known?.sourcingThread, true);
  await reply(2, '1792000000.000999', 'reach out to 2 and 5');
  const maybe = await f.store.getEvent('Ev2');
  assert.equal(maybe?.sourcingMaybe, true);
  await reply(3, '1792000000.000999', 'see you at standup');
  assert.equal(await f.store.getEvent('Ev3'), null, 'chatter is not kept');
  await reply(4, '1792000000.000999', 'reach out to 2', 'U0SOMEONE1');
  assert.equal(await f.store.getEvent('Ev4'), null, 'only the team');
});
