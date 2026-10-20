import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runGmailNotes, santoshDeepDiveLink, transcriptParts, updateSantoshLink, wisprNotes, INTERVIEWER } from '../service/lib/record-notes.mjs';
import { addressesOf, composeMime } from '../service/lib/gmail.mjs';

const NOW = Date.parse('2026-10-16T05:00:00Z');
const ENV = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
const JANE = { pageId: '3f26ba36-8537-8000-8000-00000000000a', fullName: 'Jane Fixture', email: 'jane@example.com', fields: { Stage: 'Trial' } };
const JOHN = { pageId: '3f26ba36-8537-8000-8000-00000000000b', fullName: 'John Fixture', email: 'john@example.com', fields: { Stage: 'Interviewing' } };

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a) }) });
  return { prepare };
}
const claudeSays = notes => ({ calls: [], async complete(req) { this.calls.push(req); return { content: [{ type: 'tool_use', name: 'notes', input: { notes } }] }; } });
function fakeNotion({ booking = 'https://calendly.com/quinn-company-ai/technical-deep-dive' } = {}) {
  return {
    rows: [], links: [], booking,
    async readControl() { return { mode: 'Live' }; },
    async listActiveCandidates() { return [JANE, JOHN]; },
    async upsertOperationsRecord(r) { this.rows.push(r); return { pageId: 'x' }; },
    async setBookingLink(r) { this.links.push(r); if (r.url === this.booking) return { changed: false }; this.booking = r.url; return { changed: true }; },
  };
}

test('Interviewer link: one reusable deep-dive scheduling link only; single-use and unrelated links never count', () => {
  assert.equal(santoshDeepDiveLink('New link for the technical deep dive: https://calendly.com/quinn-company-ai/deep-dive-30.'), 'https://calendly.com/quinn-company-ai/deep-dive-30');
  assert.equal(santoshDeepDiveLink('Deep dive link <https://calendly.com/quinn-company-ai/tdd?month=2026-10|here>'), 'https://calendly.com/quinn-company-ai/tdd');
  assert.equal(santoshDeepDiveLink('deep dive: https://calendly.com/d/example-single-use/technical-deep-dive'), null, 'single-use');
  assert.equal(santoshDeepDiveLink('lunch? https://calendly.com/quinn-company-ai/coffee'), null, 'not about the deep dive');
  assert.equal(santoshDeepDiveLink('deep dive https://calendly.com/quinn-company-ai/a or https://calendly.com/quinn-company-ai/b'), null, 'two links: unclear');
  assert.equal(santoshDeepDiveLink('deep dive notes https://docs.google.com/document/d/1'), null, 'not a scheduling link');
  assert.equal(santoshDeepDiveLink('Technical deep dive: https://calendar.app.google/AbCd123'), 'https://calendar.app.google/AbCd123');
});

test('Interviewer link: replaces the board link once and tells Project; the same link again does nothing', async () => {
  const notion = fakeNotion(), db = d1(), said = [];
  const poster = async text => said.push(text);
  const first = await updateSantoshLink({ notion, db, poster, text: 'my new deep dive link https://calendly.com/quinn-company-ai/deep-dive-45', source: 'Slack', sourceUrl: 'https://company.slack.com/archives/D1/p1', clock: () => NOW });
  assert.equal(first.changed, true);
  assert.equal(notion.links[0].interviewer, INTERVIEWER.interviewer);
  assert.equal(notion.links[0].useFor, INTERVIEWER.useFor);
  assert.match(said[0], /deep-dive-45/);
  const again = await updateSantoshLink({ notion, db, poster, text: 'deep dive https://calendly.com/quinn-company-ai/deep-dive-45', source: 'Slack', clock: () => NOW });
  assert.equal(again.changed, false);
  assert.equal(notion.links.length, 1);
  assert.equal(said.length, 1);
});

test('Wispr notes: a meeting transcript in parts, facts with word-for-word quotes become Note rows', async () => {
  const parts = transcriptParts(`${'a'.repeat(1400)}\n${'b'.repeat(400)}\nRobin: Jane's paperwork is all signed and her Company email is set up.`);
  assert.equal(parts.length, 2);
  const notion = fakeNotion();
  const claude = claudeSays([{ candidate_id: JANE.pageId, message_index: 1, quote: "Jane's paperwork is all signed", fact: 'Robin says Jane signed her paperwork.' },
    { candidate_id: JANE.pageId, message_index: 0, quote: 'invented words', fact: 'Invented.' }]);
  const meeting = { id: 'AAAAAAAA-1111-2222-3333-444444444444', title: 'Recruiting sync', start: '2026-10-15T17:00:00Z', url: 'https://notes.wisprflow.ai/m/1' };
  const n = await wisprNotes({ claude, notion, meeting, transcript: `${'a'.repeat(1400)}\n${'b'.repeat(400)}\nRobin: Jane's paperwork is all signed and her Company email is set up.`, candidates: [JANE, JOHN], clock: () => NOW });
  assert.equal(n, 1);
  assert.equal(notion.rows[0].action, 'wispr');
  assert.equal(notion.rows[0].recordKind, 'Note');
  assert.equal(notion.rows[0].sourceEventKey, `wispr:aaaaaaaa-1111-2222-3333-444444444444:1:${JANE.pageId}`);
  assert.match(notion.rows[0].resultEvidence, /Recruiting sync/);
  assert.match(claude.calls[0].system, /recruiting meeting/);
});

test('Gmail notes: only emails with a candidate, never Uncle Sam\'s own sends, each read once; Interviewer\'s link from email', async () => {
  const db = d1(), notion = fakeNotion();
  let inbox = [];
  const gmail = { queries: [], async canSearch() { return true; }, async listInbox(q) { this.queries.push(q); return inbox.slice(); } };
  const claude = claudeSays([{ candidate_id: JANE.pageId, message_index: 0, quote: 'start on Monday Oct 20', fact: 'Jane confirmed she will start the trial on Monday Oct 20.' }]);
  // First run only starts the cursor: older mail is the clerk's.
  assert.equal((await runGmailNotes({ env: ENV, db, notion, gmail, claude, clock: () => NOW })).state, 'started');
  const at = n => new Date(NOW + n * 60_000).toISOString();
  inbox = [ // newest first, like Gmail
    { id: 'm4', threadId: 't4', from: 'quinn@company.example', fromName: 'Interviewer', to: ['project@company.example'], cc: [], subject: 'deep dive link', text: 'Use this for the technical deep dive: https://calendly.com/quinn-company-ai/td-new', receivedAt: at(4), url: 'https://mail.google.com/mail/u/0/#all/m4' },
    { id: 'm3', threadId: 't3', from: 'project@company.example', to: ['john@example.com'], cc: [], subject: 'Company — Technical Deep Dive', text: 'Here is the link', receivedAt: at(3), byUncleSam: true, url: 'https://mail.google.com/mail/u/0/#all/m3' },
    { id: 'm2', threadId: 't2', from: 'friend@example.org', to: ['project@company.example'], cc: [], subject: 'Dinner', text: 'see you', receivedAt: at(2), url: 'https://mail.google.com/mail/u/0/#all/m2' },
    { id: 'm1', threadId: 't1', from: 'jamie@company.example', fromName: 'Jamie', to: ['jane@example.com'], cc: ['project@company.example'], subject: 'Trial start', text: 'Great, so you will start on Monday Oct 20.', receivedAt: at(1), url: 'https://mail.google.com/mail/u/0/#all/m1' },
  ];
  const said = [];
  const summary = await runGmailNotes({ env: ENV, db, notion, gmail, claude, poster: async t => said.push(t), clock: () => NOW + 10 * 60_000 });
  assert.equal(summary.matched, 1, 'Jamie\'s email to Jane only; not the friend, not Uncle Sam\'s own send');
  assert.equal(summary.notes, 1);
  assert.equal(summary.santoshLink, true);
  assert.match(gmail.queries[0], /^after:\d+ /);
  const shown = claude.calls[0].messages[0].content;
  assert.match(shown, /Trial start/);
  assert.doesNotMatch(shown, /Dinner|Here is the link/);
  assert.equal(notion.rows[0].action, 'gmail');
  assert.equal(notion.rows[0].candidatePageId, JANE.pageId);
  assert.equal(notion.rows[0].sourceEventKey, `gmail:t1:m1:${JANE.pageId}`);
  assert.equal(notion.booking, 'https://calendly.com/quinn-company-ai/td-new');
  assert.equal(said.length, 1);
  // The same mail again is not read twice.
  const again = await runGmailNotes({ env: ENV, db, notion, gmail, claude, clock: () => NOW + 15 * 60_000 });
  assert.equal(again.seen, 0);
  assert.equal(claude.calls.length, 1);
});

test('Gmail notes: off unless Live and automatic activity is on', async () => {
  const notion = { ...fakeNotion(), async readControl() { return { mode: 'Off' }; } };
  const gmail = { async canSearch() { return true; }, async listInbox() { throw new Error('should not read'); } };
  assert.equal((await runGmailNotes({ env: ENV, db: d1(), notion, gmail, claude: claudeSays([]), clock: () => NOW })).state, 'not_live');
  assert.equal((await runGmailNotes({ env: {}, db: d1(), notion: fakeNotion(), gmail, claude: claudeSays([]), clock: () => NOW })).state, 'off');
});

test('Gmail: recipient addresses parsed; Uncle Sam marks its own sends', () => {
  assert.deepEqual(addressesOf('Jane Doe <Jane@Example.com>, bob@x.org; "C, D" <c.d@y.co.uk>'), ['jane@example.com', 'bob@x.org', 'c.d@y.co.uk']);
  const mime = composeMime({ to: 'jane@example.com', subject: 'Hi', body: 'Hello there', signatureHtml: '<div>Project Owner</div>' });
  assert.match(Buffer.from(mime.raw, 'base64url').toString(), /\r\nX-Uncle-Sam: sent\r\n/);
});
