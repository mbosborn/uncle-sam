import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { prepareSlackUserLink, completeSlackUserConnection, runSlackDmWatch, findNotes, slackUserConfigured, SLACK_USER_SCOPES, SLACK_USER_WANTED } from '../service/lib/slack-dm-watch.mjs';
import { PEOPLE } from '../service/lib/agent-runner.mjs';
import { TEAM_ID } from '../service/lib/identity.mjs';

const KEY = Buffer.alloc(32, 7).toString('base64');
const ENV = { WISPR_TOKEN_KEY: KEY, SLACK_CLIENT_ID: '8912345678.9912345678', SLACK_CLIENT_SECRET: '0123456789abcdef0123456789abcdef', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
const NOW = Date.parse('2026-10-15T20:00:00Z');
const JANE = { pageId: '3f26ba36-8537-8000-8000-00000000000a', fullName: 'Jane Fixture', fields: { Stage: 'Take-home' } };
const JOHN = { pageId: '3f26ba36-8537-8000-8000-00000000000b', fullName: 'John Fixture', fields: { Stage: 'Interviewing' } };

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_wispr (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a) }) });
  return { prepare };
}
const claudeSays = notes => ({ calls: [], async complete(req) { this.calls.push(req); return { content: [{ type: 'tool_use', name: 'notes', input: { notes } }] }; } });

test('Slack DM access: Project\'s own account only, all four read scopes, one-use link', async () => {
  assert.equal(slackUserConfigured(ENV), true);
  assert.equal(slackUserConfigured({ ...ENV, SLACK_CLIENT_SECRET: 'short' }), false);
  const db = d1();
  const link = await prepareSlackUserLink({ env: ENV, db, clock: () => NOW });
  const url = new URL(link.url);
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('user_scope'), SLACK_USER_WANTED.join(','));
  assert.ok(SLACK_USER_WANTED.includes('files:read'), 'Project, Oct 16: screenshots');
  assert.equal(url.searchParams.get('scope'), '');
  assert.equal(url.searchParams.get('team'), TEAM_ID);
  const state = url.searchParams.get('state');
  const reply = body => async () => new Response(JSON.stringify(body));
  const wrong = { ok: true, team: { id: TEAM_ID }, authed_user: { id: PEOPLE.robin, token_type: 'user', access_token: 'xoxp-fixture', scope: SLACK_USER_SCOPES.join(',') } };
  await assert.rejects(completeSlackUserConnection({ env: ENV, db, fetchImpl: reply(wrong), clock: () => NOW, code: 'c', state }), { code: 'slack_user_wrong_account' });
  await assert.rejects(completeSlackUserConnection({ env: ENV, db, fetchImpl: reply(wrong), clock: () => NOW, code: 'c', state }), { code: 'slack_user_link_invalid' }, 'one use');
  const fresh = new URL((await prepareSlackUserLink({ env: ENV, db, clock: () => NOW })).url).searchParams.get('state');
  const partial = { ok: true, team: { id: TEAM_ID }, authed_user: { id: PEOPLE.project, token_type: 'user', access_token: 'xoxp-fixture', scope: 'im:history,im:read' } };
  await assert.rejects(completeSlackUserConnection({ env: ENV, db, fetchImpl: reply(partial), clock: () => NOW, code: 'c', state: fresh }), { code: 'slack_user_scope_missing' });
  const third = new URL((await prepareSlackUserLink({ env: ENV, db, clock: () => NOW })).url).searchParams.get('state');
  const good = { ok: true, team: { id: TEAM_ID }, authed_user: { id: PEOPLE.project, token_type: 'user', access_token: 'xoxp-fixture', scope: SLACK_USER_SCOPES.join(',') } };
  assert.equal((await completeSlackUserConnection({ env: ENV, db, fetchImpl: reply(good), clock: () => NOW, code: 'c', state: third })).account, PEOPLE.project);
  assert.equal((await prepareSlackUserLink({ env: ENV, db, clock: () => NOW })).status, 'connected');
});

test('Slack DM notes: only a listed candidate, a quote word for word from that message, never pay', async () => {
  const messages = [{ channelId: 'D1', ts: '1760558400.000100', kind: 'DM', speaker: 'Robin', day: 'Wed, Oct 15', text: 'Jane said on LinkedIn she will do the take-home over the weekend' },
    { channelId: 'D1', ts: '1760558460.000100', kind: 'DM', speaker: 'Robin', day: 'Wed, Oct 15', text: 'John wants $4000 a month for the trial' }];
  const notes = await findNotes({ candidates: [JANE, JOHN], messages, claude: claudeSays([
    { candidate_id: JANE.pageId, message_index: 0, quote: 'she will do the take-home over the weekend', fact: 'Robin says Jane will do the take-home over the weekend.' },
    { candidate_id: JANE.pageId, message_index: 0, quote: 'she will do it Friday', fact: 'Invented.' },
    { candidate_id: JOHN.pageId, message_index: 1, quote: 'John wants $4000 a month', fact: 'Pay ask.' },
    { candidate_id: '3f26ba36-8537-8000-8000-0000000000ff', message_index: 0, quote: 'Jane said on LinkedIn', fact: 'Unknown person.' }]) });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].candidate.pageId, JANE.pageId);
});

test('Slack DM watch: reads only team DMs and team-only group DMs, writes Note rows, moves the cursor only after', async () => {
  const db = d1();
  const link = await prepareSlackUserLink({ env: ENV, db, clock: () => NOW });
  const state = new URL(link.url).searchParams.get('state');
  await completeSlackUserConnection({ env: ENV, db, clock: () => NOW, code: 'c', state, fetchImpl: async () => new Response(JSON.stringify({ ok: true, team: { id: TEAM_ID },
    authed_user: { id: PEOPLE.project, token_type: 'user', access_token: 'xoxp-fixture', scope: SLACK_USER_WANTED.join(',') } })) });
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/api/')[1], params = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ method, params, auth: init.headers.authorization });
    if (method === 'conversations.list') return new Response(JSON.stringify({ ok: true, channels: [
      { id: 'D_RISHI', is_im: true, user: PEOPLE.robin }, { id: 'D_STRANGER', is_im: true, user: 'U0STRANGER' }, { id: 'D_SELF', is_im: true, user: PEOPLE.project },
      { id: 'G_TEAM', is_mpim: true }, { id: 'G_MIXED', is_mpim: true }] }));
    if (method === 'conversations.members') return new Response(JSON.stringify({ ok: true, members: params.channel === 'G_TEAM' ? [PEOPLE.project, PEOPLE.robin, PEOPLE.interviewer] : [PEOPLE.project, PEOPLE.robin, 'U0STRANGER'] }));
    if (method === 'conversations.history') {
      const messages = params.channel === 'D_RISHI' ? [{ type: 'message', ts: '1760558400.000100', user: PEOPLE.robin, text: 'Jane said on LinkedIn she will do the take-home over the weekend' }]
        : [{ type: 'message', ts: '1760558500.000100', user: PEOPLE.interviewer, text: 'lunch?' }];
      return new Response(JSON.stringify({ ok: true, messages }));
    }
    throw new Error(`unexpected ${method}`);
  };
  const rows = [];
  const notion = { readControl: async () => ({ mode: 'Live' }), listActiveCandidates: async () => [JANE, JOHN], upsertOperationsRecord: async r => { rows.push(r); return { verified: true }; } };
  const claude = claudeSays([{ candidate_id: JANE.pageId, message_index: 0, quote: 'she will do the take-home over the weekend', fact: 'Robin says Jane will do the take-home over the weekend.' }]);
  const posted = [];
  const out = await runSlackDmWatch({ env: ENV, db, notion, claude, poster: async t => posted.push(t), fetchImpl, clock: () => NOW });
  assert.equal(out.state, 'connected', JSON.stringify(out));
  assert.equal(out.conversations, 2, 'Robin\'s DM and the team-only group DM');
  const read = calls.filter(c => c.method === 'conversations.history').map(c => c.params.channel).sort();
  assert.deepEqual(read, ['D_RISHI', 'G_TEAM']);
  assert.ok(calls.every(c => c.auth === 'Bearer xoxp-fixture'));
  assert.ok(!calls.some(c => /postMessage/.test(c.method)), 'never posts');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recordKind, 'Note'); assert.equal(rows[0].action, 'slack-dm'); assert.equal(rows[0].candidatePageId, JANE.pageId);
  assert.match(rows[0].resultEvidence, /^Robin says Jane will do the take-home over the weekend\. Robin in a Slack DM, .+ PT: “she will do the take-home over the weekend”$/);
  assert.match(rows[0].sourceUrl, /\/archives\/D_RISHI\/p1760558400000100$/);
  assert.equal(posted.length, 0);
  // Next tick starts after the messages already read.
  calls.length = 0;
  await runSlackDmWatch({ env: ENV, db, notion, claude, poster: async t => posted.push(t), fetchImpl, clock: () => NOW + 300_000 });
  assert.equal(calls.find(c => c.method === 'conversations.history' && c.params.channel === 'D_RISHI').params.oldest, (NOW / 1000).toFixed(6));
});

test('Slack DM watch: not connected yet, Project gets one Allow link (not again while it is open)', async () => {
  const db = d1(), posted = [];
  const notion = { readControl: async () => ({ mode: 'Live' }) };
  assert.equal((await runSlackDmWatch({ env: ENV, db, notion, claude: null, poster: async t => posted.push(t), clock: () => NOW })).state, 'link_sent');
  assert.equal((await runSlackDmWatch({ env: ENV, db, notion, claude: null, poster: async t => posted.push(t), clock: () => NOW + 300_000 })).state, 'waiting_for_mason');
  assert.equal(posted.length, 1);
  assert.match(posted[0], /^📯 Let me read your Slack DMs with the recruiting team .*<https:\/\/slack\.com\/oauth\/v2\/authorize\?.+\|Allow Slack read access>/);
});

test("Robin's work-trial call in a DM and his asks to Project (Oct 16): the call is flagged for the Send offer; asks become one line each, never with an amount", async () => {
  const { findNotes, askText } = await import('../service/lib/slack-dm-watch.mjs');
  const messages = [
    { channelId: 'D0BP77UDHQE', ts: '1792201864.000100', kind: 'DM', speaker: 'Robin', day: 'Fri, Oct 16, 6:51 PM', text: 'Reagan Turner' },
    { channelId: 'D0BP77UDHQE', ts: '1792201881.000100', kind: 'DM', speaker: 'Robin', day: 'Fri, Oct 16, 6:51 PM', text: 'he should start work trial' },
    { channelId: 'D0BP77UDHQE', ts: '1792202236.000100', kind: 'DM', speaker: 'Robin', day: 'Fri, Oct 16, 6:57 PM', text: 'pay Rowan Brooks out his hours end of day and then we can remove him off everything so slack archive his google worspace' },
    { channelId: 'D0BP77UDHQE', ts: '1792202240.000100', kind: 'DM', speaker: 'Project', day: 'Fri, Oct 16, 6:57 PM', text: 'he should start work trial too' }];
  const candidates = [{ pageId: 'p-prox', fullName: 'Reagan Turner', fields: { Stage: 'Case Study' } }];
  const claude = { complete: async () => ({ content: [{ type: 'tool_use', name: 'notes', input: {
    notes: [{ candidate_id: 'p-prox', message_index: 1, quote: 'he should start work trial', fact: 'Robin says Reagan Turner should start a work trial.', work_trial_call: true },
      { candidate_id: 'p-prox', message_index: 3, quote: 'he should start work trial too', fact: 'Project says so too.', work_trial_call: true }],
    asks: [{ message_index: 2, quote: 'pay Rowan Brooks out his hours end of day', task: 'Pay Rowan Brooks for his hours ($500) at end of day, then remove him from Slack and archive his Google Workspace.' },
      { message_index: 3, quote: 'he should start work trial too', task: 'Project is not an asker of himself.' }] } }] }) };
  const notes = await findNotes({ claude, messages, candidates });
  assert.deepEqual(notes.map(n => [n.message.speaker, n.workTrialCall]), [['Robin', true], ['Project', false]], 'only Robin or Interviewer can call it');
  assert.equal(notes.asks.length, 1);
  const line = askText(notes.asks[0], 'https://example-workspace.slack.com/archives/D0BP77UDHQE/p1792202236000100');
  assert.equal(line, '📋 Robin asked you (Fri, Oct 16, 6:57 PM PT, <https://example-workspace.slack.com/archives/D0BP77UDHQE/p1792202236000100|message>): Pay Rowan Brooks for his hours at end of day, then remove him from Slack and archive his Google Workspace. The payment is yours to send; I never send money. Taking people off Slack and Google Workspace is Jamie’s to finish, unless you do it.');
});

test('Asks (Oct 18): reminders only for that kind of ask; an ask Project already answered is never sent; others wait 10 minutes and go once', async () => {
  const { askText, ASK_WAIT_MS } = await import('../service/lib/slack-dm-watch.mjs');
  const link = 'https://example-workspace.slack.com/archives/D0BP77UDHQE/p1';
  const visitor = { message: { speaker: 'Robin', day: 'Sun, Oct 18, 4:07 PM' }, task: "Send the Industrious visitor access email for Hayden tonight so Payton sees it first thing Monday, cc'ing Robin" };
  assert.equal(askText(visitor, link), `📋 Robin asked you (Sun, Oct 18, 4:07 PM PT, <${link}|message>): Send the Industrious visitor access email for Hayden tonight so Payton sees it first thing Monday, cc'ing Robin.`);
  assert.doesNotMatch(askText({ ...visitor, kind: 'other' }, link), /payment|Jamie/);
  assert.match(askText({ ...visitor, task: 'Pay Sam for his hours', kind: 'payment' }, link), /The payment is yours to send/);
  // The run: two asks from Robin; Project already answered the first in the same read; the second waits, then goes once.
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_wispr (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const db = { prepare: sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) }) };
  const state = new URL((await prepareSlackUserLink({ env: ENV, db, clock: () => NOW })).url).searchParams.get('state');
  await completeSlackUserConnection({ env: ENV, db, clock: () => NOW, code: 'c', state, fetchImpl: async () => new Response(JSON.stringify({ ok: true, team: { id: TEAM_ID },
    authed_user: { id: PEOPLE.project, token_type: 'user', access_token: 'xoxp-fixture', scope: SLACK_USER_WANTED.join(',') } })) });
  let masonLater = false;
  const fetchImpl = async (url, init) => {
    const method = url.split('/api/')[1], params = Object.fromEntries(new URLSearchParams(init.body));
    if (method === 'conversations.list') return new Response(JSON.stringify({ ok: true, channels: [{ id: 'D_RISHI', is_im: true, user: PEOPLE.robin }] }));
    if (method === 'conversations.history') {
      if (params.oldest === '1760558400.000100') return new Response(JSON.stringify({ ok: true, messages: [] }));
      if (params.oldest === '1760558500.000100') return new Response(JSON.stringify({ ok: true, messages: masonLater ? [{ type: 'message', ts: '1760558900.000100', user: PEOPLE.project, text: 'done' }] : [] }));
      return new Response(JSON.stringify({ ok: true, messages: [
        { type: 'message', ts: '1760558300.000100', user: PEOPLE.robin, text: 'email industrious about Hayden tonight' },
        { type: 'message', ts: '1760558350.000100', user: PEOPLE.project, text: 'i just sent it a few mins ago' },
        { type: 'message', ts: '1760558400.000100', user: PEOPLE.robin, text: 'pay Sam for his hours' }] }));
    }
    throw new Error(`unexpected ${method}`);
  };
  const notion = { readControl: async () => ({ mode: 'Live' }), listActiveCandidates: async () => [], upsertOperationsRecord: async () => ({ verified: true }) };
  const claude = { async complete() { return { content: [{ type: 'tool_use', name: 'notes', input: { notes: [], asks: [
    { message_index: 0, quote: 'email industrious about Hayden tonight', task: 'Email Industrious about Hayden tonight', kind: 'other' },
    { message_index: 2, quote: 'pay Sam for his hours', task: 'Pay Sam for his hours', kind: 'payment' }] } }] }; } };
  const posted = [];
  const out = await runSlackDmWatch({ env: ENV, db, notion, claude, poster: async t => posted.push(t), fetchImpl, clock: () => NOW });
  assert.equal(out.asksAnswered, 1, JSON.stringify(out));
  assert.equal(posted.length, 0, 'nothing at once');
  await runSlackDmWatch({ env: ENV, db, notion, claude, poster: async t => posted.push(t), fetchImpl, clock: () => NOW + ASK_WAIT_MS + 60_000 });
  assert.equal(posted.length, 1);
  assert.match(posted[0], /Pay Sam for his hours\. The payment is yours to send/);
  await runSlackDmWatch({ env: ENV, db, notion, claude, poster: async t => posted.push(t), fetchImpl, clock: () => NOW + 2 * ASK_WAIT_MS });
  assert.equal(posted.length, 1, 'once');
  void masonLater;
});

test('DM history drains every page before moving the conversation timestamp', async () => {
  const db = d1(), seen = [], windows = [];
  const state = new URL((await prepareSlackUserLink({ env: ENV, db, clock: () => NOW })).url).searchParams.get('state');
  await completeSlackUserConnection({ env: ENV, db, clock: () => NOW, code: 'c', state, fetchImpl: async () => Response.json({ ok: true, team: { id: TEAM_ID },
    authed_user: { id: PEOPLE.project, token_type: 'user', access_token: 'xoxp-fixture', scope: SLACK_USER_WANTED.join(',') } }) });
  const messages = Array.from({ length: 105 }, (_, i) => ({ type: 'message', ts: ((NOW - (i + 1) * 1000) / 1000).toFixed(6), user: PEOPLE.robin, text: `Candidate context ${i}` }));
  const fetchImpl = async (url, init) => {
    const method = url.split('/api/')[1], p = Object.fromEntries(new URLSearchParams(init.body));
    if (method === 'conversations.list') return Response.json({ ok: true, channels: [{ id: 'D_RISHI', is_im: true, user: PEOPLE.robin }] });
    if (method === 'conversations.history') {
      windows.push({ oldest: p.oldest, latest: p.latest });
      const offset = Number(p.cursor || 0), limit = Number(p.limit), next = offset + limit;
      return Response.json({ ok: true, messages: messages.slice(offset, next), has_more: next < messages.length,
        response_metadata: { next_cursor: next < messages.length ? String(next) : '' } });
    }
    throw Error(method);
  };
  const notion = { readControl: async () => ({ mode: 'Live' }), listActiveCandidates: async () => [] };
  for (let i = 0; i < 7; i++) {
    const out = await runSlackDmWatch({ env: ENV, db, notion, claude: claudeSays([]), poster: async () => {}, fetchImpl,
      clock: () => NOW + i * 300000, onBatch: async batch => seen.push(...batch.map(m => m.ts)) });
    assert.equal(out.error, null);
  }
  assert.equal(new Set(seen).size, 105); assert.equal(seen.length, 105);
  assert.equal(new Set(windows.map(w => JSON.stringify(w))).size, 1, 'fixed interval while draining');
});
