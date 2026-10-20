import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runReplyWatch, replyMessage, NEXT_STEP } from '../service/lib/reply-watch.mjs';
import { replyText, plainBody } from '../service/lib/gmail.mjs';

const NOW = Date.parse('2026-10-16T18:00:00.000Z');
const ENV = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a),
    all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const JANE = { pageId: '3f26ba36-8537-8000-8000-000000000001', fullName: 'Jane Doe', email: 'jane@example.invalid', url: 'https://www.notion.so/x', profile: { linkedin: 'linkedin.com/in/jane-doe-12' } };
const msg = (id, from, text, at = NOW - 60_000) => ({ id, threadId: id, from, fromName: 'X', subject: 'Re: Company AI Take-Home Assessment', receivedAt: new Date(at).toISOString(), text, url: `https://mail.google.com/mail/?authuser=project@company.example#all/${id}` });
const claudeSays = (kind, extra = {}) => ({ calls: 0, async complete() { this.calls++; return { content: [{ type: 'tool_use', name: 'classify', input: { kind, ...extra } }] }; } });

test('a quoted earlier message is cut off; the plain part is preferred', () => {
  assert.equal(replyText('Can we move it to Friday?\n\nOn Thu, Oct 15, 2026 at 4:00 PM Project Owner <project@company.example> wrote:\n> Hi Jane'), 'Can we move it to Friday?');
  const payload = { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Hello there').toString('base64url') } }, { mimeType: 'text/html', body: { data: Buffer.from('<p>x</p>').toString('base64url') } }] };
  assert.equal(plainBody(payload), 'Hello there');
});

test('Project, Oct 15: a candidate\'s reply reaches Project once with a suggested next step and lands on the record; strangers, thanks and old mail do not', async () => {
  const db = d1(), posts = [], notes = [];
  const notion = { readControl: async () => ({ mode: 'Live' }), findCandidatesByEmail: async e => (e === JANE.email ? [JANE] : []), appendCandidateNote: async n => { notes.push(n); } };
  let inbox = [msg('aaa111', JANE.email, 'old one', NOW - 86400_000)];
  let sentMail = [];
  const gmail = { canSearch: async () => true, listInbox: async () => inbox, searchSent: async () => sentMail };
  const claude = claudeSays('reschedule');
  const run = (at = NOW) => runReplyWatch({ env: ENV, db, notion, gmail, claude, post: async t => posts.push(t), clock: () => at });
  assert.equal((await run(NOW - 3600_000)).state, 'started', 'the first run only marks the start');
  inbox = [msg('bbb222', JANE.email, 'Could we move the call to Friday?'), msg('ccc333', 'someone@client.example', 'Invoice attached'), msg('aaa111', JANE.email, 'old one', NOW - 86400_000)];
  const r = await run();
  assert.deepEqual([r.matched, r.notified, r.waiting], [1, 0, 1], 'held: Project sees the email himself first');
  assert.equal(posts.length, 0);
  // Received 10:59 AM PT: 4 working hours later is 2:59 PM PT. Still no reply from Project: the line goes then, once.
  assert.equal((await run(NOW + 3 * 3600_000)).notified, 0);
  const due = await run(NOW + 4 * 3600_000);
  assert.equal(due.notified, 1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].split('\nNo reply from you yet')[0], `📬 <https://www.linkedin.com/in/jane-doe-12|Jane Doe> wants to reschedule (re: Re: Company AI Take-Home Assessment): “Could we move the call to Friday?”\nSuggested: ${NEXT_STEP.reschedule} <https://mail.google.com/mail/?authuser=project@company.example#all/bbb222|Open in Gmail> · <https://www.notion.so/x|Their record>`);
  assert.match(notes[0].text, /Email from the candidate \(wants to reschedule, seen by Uncle Sam\): “Could we move the call to Friday\?”/);
  assert.match(posts[0], /\nNo reply from you yet after 4 working hours\.$/);
  await run(NOW + 5 * 3600_000);
  assert.equal(posts.length, 1, 'once per message'); assert.equal(claude.calls, 1);
  inbox = [msg('ddd444', JANE.email, 'Thanks, got it!', NOW + 5 * 3600_000 + 60_000)];
  await runReplyWatch({ env: ENV, db, notion, gmail, claude: claudeSays('thanks'), post: async t => posts.push(t), clock: () => NOW + 5 * 3600_000 + 120_000 });
  assert.equal(posts.length, 1, 'a plain thanks is only noted'); assert.equal(notes.length, 2);
  // Project answered within the 4 working hours: nothing. An email at 2 AM waits for the working day (due 2 PM PT).
  const night = Date.parse('2026-10-17T09:00:00Z');
  inbox = [msg('iii999', JANE.email, 'Quick question about the take-home', night)];
  await runReplyWatch({ env: ENV, db, notion, gmail, claude: claudeSays('question'), post: async t => posts.push(t), clock: () => night + 60_000 });
  assert.equal((await run(Date.parse('2026-10-17T20:30:00Z'))).notified, 0, 'not yet at 1:30 PM PT');
  sentMail = [{ id: 'x', sentAt: '2026-10-17T20:45:00Z' }];
  const answered = await run(Date.parse('2026-10-17T21:05:00Z'));
  assert.deepEqual([answered.notified, answered.answered], [0, 1]);
  assert.equal(posts.length, 1);
});

test('a reply\'s text cannot break the DM: angle brackets are escaped', () => {
  const text = replyMessage({ candidate: { ...JANE, profile: {} }, kind: 'question', subject: 'x', text: 'see <https://evil.example|click> & more', url: 'https://mail.google.com/x' });
  assert.ok(text.includes('&lt;https://evil.example|click&gt; &amp; more'));
});

test('Project, Oct 15: a clear withdrawal closes the candidate by itself, cancels queued invites and tells Project after; unsure or on-trial ones are only reported', async () => {
  const db = d1(), posts = [], notes = [], closed = [], cancelled = [];
  let record = { ...JANE, archived: false, fields: { Stage: 'Interview', Outcome: null } };
  const notion = { readControl: async () => ({ mode: 'Live' }), findCandidatesByEmail: async () => [JANE], appendCandidateNote: async n => { notes.push(n); },
    getCandidate: async () => record, closeCandidate: async c => { closed.push(c); return { verified: true }; },
    findOperationsForCandidate: async ({ action }) => (action === 'email.takehome_invite' ? [{ state: 'Held', requestKey: 'email:takehome:x' }] : []),
    cancelQueuedEmail: async c => { cancelled.push(c.requestKey); return { cancelled: true }; } };
  let inbox = [];
  const gmail = { canSearch: async () => true, listInbox: async () => inbox, searchSent: async () => [] };
  const run = (claude, at) => runReplyWatch({ env: ENV, db, notion, gmail, claude, post: async t => posts.push(t), clock: () => at });
  await run(claudeSays('other'), NOW - 3600_000);
  inbox = [msg('eee555', JANE.email, "Hi Project, thanks for the opportunity. I've decided to withdraw my application as I accepted another offer.")];
  await run(claudeSays('withdraw', { withdraw_quote: "I've decided to withdraw my application as I accepted another offer." }), NOW);
  assert.equal(closed.length, 1); assert.equal(closed[0].outcome, 'Withdrawn or Unavailable');
  assert.match(closed[0].nextAction, /^None\. Withdrew by email \(Oct 16\): "I've decided to withdraw/);
  assert.deepEqual(cancelled, ['email:takehome:x']);
  assert.match(posts[0], /^🫡 <https:\/\/www\.linkedin\.com\/in\/jane-doe-12\|Jane Doe> withdrew by email: .* I marked them Withdrawn or Unavailable and closed them in the tracker, and cancelled the queued take-home invite\./);
  // A quote that is not in the email: nothing changes, Project gets the usual suggestion.
  inbox = [msg('fff666', JANE.email, 'I might need to step back for a week, busy with exams.')];
  await run(claudeSays('withdraw', { withdraw_quote: 'I withdraw my candidacy.' }), NOW + 300_000);
  assert.equal(closed.length, 1);
  await run(claudeSays('other'), NOW + 4 * 3600_000 + 300_000);
  assert.match(posts.at(-1), /may be withdrawing/);
  // On a work trial: never closed by itself.
  record = { ...record, fields: { Stage: 'Trial', Outcome: null } };
  inbox = [msg('ggg777', JANE.email, 'I want to withdraw from the trial.')];
  await run(claudeSays('withdraw', { withdraw_quote: 'I want to withdraw from the trial.' }), NOW + 600_000);
  assert.equal(closed.length, 1);
  await run(claudeSays('other'), NOW + 4 * 3600_000 + 600_000);
  assert.match(posts.at(-1), /may be withdrawing/);
  // A link problem is Interviewer's (he is cc'd): noted, no DM.
  const before = posts.length;
  inbox = [msg('hhh888', JANE.email, 'The download link gives me a 404.')];
  await run(claudeSays('link_problem'), NOW + 900_000);
  assert.equal(posts.length, before); assert.match(notes.at(-1).text, /has a problem with a link/);
});

test('a candidate naming the day they will do the take-home is remembered (word for word, within 3 weeks); vague timing is not', async () => {
  const { classifyReply } = await import('../service/lib/reply-watch.mjs');
  const said = await classifyReply({ claude: claudeSays('thanks', { planned_date: '2026-10-23', plan_quote: "I'll do it Friday" }), subject: 'Re', text: "Thanks! I'll do it Friday.", receivedAt: '2026-10-19T17:00:00.000Z' });
  assert.deepEqual(said.plan, { date: '2026-10-23', quote: "I'll do it Friday" });
  const invented = await classifyReply({ claude: claudeSays('thanks', { planned_date: '2026-10-23', plan_quote: 'I will do it on Friday' }), subject: 'Re', text: 'Thanks, will get to it soon.', receivedAt: '2026-10-19T17:00:00.000Z' });
  assert.equal(invented.plan, null, 'not in the email');
  const far = await classifyReply({ claude: claudeSays('thanks', { planned_date: '2026-12-23', plan_quote: 'in December' }), subject: 'Re', text: 'I can do it in December', receivedAt: '2026-10-19T17:00:00.000Z' });
  assert.equal(far.plan, null, 'more than 3 weeks out');
  const db = d1();
  const notion = { readControl: async () => ({ mode: 'Live' }), findCandidatesByEmail: async () => [JANE], appendCandidateNote: async () => {} };
  let inbox = [];
  const gmail = { canSearch: async () => true, listInbox: async () => inbox };
  const run = (claude, at) => runReplyWatch({ env: ENV, db, notion, gmail, claude, post: async () => {}, clock: () => at });
  await run(claudeSays('other'), NOW - 3600_000);
  inbox = [msg('iii999', JANE.email, "Thanks! I'll do it Friday.")];
  await run(claudeSays('thanks', { planned_date: '2026-10-23', plan_quote: "I'll do it Friday" }), NOW);
  const row = await db.prepare('SELECT value FROM uncle_sam_notices WHERE name = ?').bind(`takehome-plan:${JANE.pageId}`).first();
  assert.equal(JSON.parse(row.value).date, '2026-10-23');
});
