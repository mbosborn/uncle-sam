import test from 'node:test';
import assert from 'node:assert/strict';
import { answerThreadIdentity, isThreadIdentityQuestion } from '../service/lib/thread-identity.mjs';
import { entryOf } from '../service/lib/qa.mjs';
import { createSlackReader } from '../service/lib/slack-read.mjs';

function fixture() {
  const event = { channelId: 'C01D1A69CE3', threadTs: '1792523665.081279', messageTs: '1792527000.000001', text: '<@U0BOT> which one is it?' };
  const rows = [{ ts: event.threadTs, text: 'FYI', files: [{ mimetype: 'image/png', id: 'F1' }] },
    { ts: '1792523873.560659', text: 'yep tell him thats fine and note on tracker' },
    { ts: '1792523878.725249', text: 'is this proximal or mercor one?' }];
  const candidates = ['Proximal', 'Mercor'].map((from, i) => ({ pageId: `0000000${i + 1}-1111-4222-8333-444444444444`,
    fullName: 'Reagan Turner', email: `reagan${i}@example.com`, inRecruitingSource: true, fields: { Stage: 'Case Study', Outcome: 'Proceeding' },
    profile: { from, linkedin: `https://www.linkedin.com/in/reagan-${i}/`,
      ...(i ? { latestEvidence: 'https://example-workspace.slack.com/archives/C01D1A69CE3/p1792523665081279' } : {}) } }));
  let target = { name: 'Reagan Turner', email: '', ambiguous: false };
  const calls = [];
  const args = { event, entryOf, slackRead: { readThread: async p => { assert.equal(p.requireComplete, true); return rows; } },
    readImages: async () => ['Reagan Turner', 'Company AI Take-Home Assessment'],
    claude: { complete: async request => { calls.push(request); return { content: [{ type: 'tool_use', name: 'identify_subject', input: target }] }; } },
    notion: { findCandidatesByName: async name => { assert.equal(name, 'Reagan Turner'); return candidates; },
      findCandidatesByEmail: async email => candidates.filter(c => c.email === email), getCandidate: async id => structuredClone(candidates.find(c => c.pageId === id)) } };
  return { args, rows, candidates, calls, setTarget: t => { target = t; }, run: () => answerThreadIdentity(args) };
}
test('recognizes contextual identity questions without hijacking actions, schedules or general questions', () => {
  for (const q of ['which one is it?', '<@U0BOT> which one?', 'who is this?', 'is this proximal or mercor one?']) assert.ok(isThreadIdentityQuestion(q), q);
  for (const q of ['which time works?', 'which one is it and reject him', 'send him the take home', 'what is his status?', 'which calendar is it?']) assert.equal(isThreadIdentityQuestion(q), false, q);
});
test('screenshot plus all replies and exact tracker-thread evidence yield the short linked answer', async () => {
  const f = fixture(), before = structuredClone(f.candidates);
  const out = await f.run();
  assert.equal(out.text, '🎖️ That’s Reagan Turner from Mercor.');
  assert.equal(out.parts[1].link.label, 'Reagan Turner from Mercor');
  assert.equal(out.parts[1].link.url, 'https://www.linkedin.com/in/reagan-1');
  assert.match(f.calls[0].messages[0].content, /note on tracker/);
  assert.match(f.calls[0].messages[0].content, /Reagan Turner/);
  assert.deepEqual(f.candidates, before);
  assert.deepEqual(f.calls[0].tools.map(t => t.name), ['identify_subject']);
});
test('alternative company names alone never choose between namesakes', async () => {
  const f = fixture(); delete f.candidates[1].profile.latestEvidence;
  assert.equal((await f.run()).reason, 'identity_ambiguous');
});
test('a shared thread pointer on both records remains ambiguous', async () => {
  const f = fixture(); f.candidates[0].profile.latestEvidence = f.candidates[1].profile.latestEvidence;
  assert.equal((await f.run()).reason, 'identity_ambiguous');
});
test('candidate email visible in the screenshot can distinguish namesakes without quoting it in the answer', async () => {
  const f = fixture(); delete f.candidates[1].profile.latestEvidence;
  f.args.readImages = async () => ['Reagan Turner', 'reagan1@example.com'];
  f.setTarget({ name: 'Reagan Turner', email: 'reagan1@example.com', ambiguous: false });
  const out = await f.run(); assert.equal(out.candidatePageId, f.candidates[1].pageId); assert.doesNotMatch(out.text, /@/);
});
for (const [name, change] of [
  ['unreadable image', f => { f.args.readImages = async () => null; }],
  ['failed thread read', f => { f.args.slackRead.readThread = async () => { throw Error('offline'); }; }],
  ['truncated thread', f => { f.args.slackRead.readThread = async () => Array(100).fill(f.rows[0]); }],
  ['hallucinated identifier', f => f.setTarget({ name: 'Someone Else', email: '', ambiguous: false })],
  ['invented email', f => f.setTarget({ name: 'Reagan Turner', email: 'reagan1@example.com', ambiguous: false })],
  ['unreadable candidate lookup', f => { f.args.notion.findCandidatesByName = async () => { throw Error('offline'); }; }],
  ['record changed during final read', f => { f.args.notion.getCandidate = async id => ({ ...f.candidates.find(c => c.pageId === id), archived: true }); }],
]) test(`does not guess after ${name}`, async () => { const f = fixture(); change(f); await assert.rejects(f.run()); });
test('later messages and earlier bot guesses do not supply identity evidence', async () => {
  const f = fixture(); f.args.readImages = async () => ['Company'];
  f.rows.push({ ts: '1792528000.000001', text: 'Reagan Turner' }, { ts: '1792524000.000001', text: 'Reagan Turner', botId: 'B1' });
  await assert.rejects(f.run(), /identity_identifier_unsupported/);
});
test('malicious, unrelated-channel and future-message evidence URLs never select a namesake', async () => {
  for (const url of ['https://example-workspace.slack.com.evil.test/archives/C01D1A69CE3/p1792523665081279',
    'https://example-workspace.slack.com/archives/COTHER/p1792523665081279', 'https://example-workspace.slack.com/archives/C01D1A69CE3/p1792528000000001']) {
    const f = fixture(); f.candidates[1].profile.latestEvidence = url;
    assert.equal((await f.run()).reason, 'identity_ambiguous');
  }
});
test('an unsafe LinkedIn value falls back to the verified tracker link', async () => {
  const f = fixture(); f.candidates[1].profile.linkedin = 'https://linkedin.com.evil.test/in/guess';
  assert.match((await f.run()).parts[1].link.url, /^https:\/\/www.notion.so\//);
});
test('Slack adapter reports incomplete identity threads instead of returning a misleading partial result', async () => {
  const reader = createSlackReader({ env: { SLACK_BOT_TOKEN: 'xoxb-fixture-token' }, fetchImpl: async () => Response.json({ ok: true,
    messages: [{ ts: '1792523665.081279', text: 'FYI' }], has_more: true, response_metadata: { next_cursor: 'next' } }) });
  await assert.rejects(reader.readThread({ channelId: 'C01D1A69CE3', threadTs: '1792523665.081279', requireComplete: true }), /slack_thread_incomplete/);
  assert.equal((await reader.readThread({ channelId: 'C01D1A69CE3', threadTs: '1792523665.081279' })).length, 1);
});
