import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { runPreStartPaperwork, handlePreStartReply, paperworkState, preStartText } from '../service/lib/pre-start-paperwork.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', DM = 'D0C95KBR09J';
const at = s => Date.parse(s);
const RYLAN = { pageId: 'p-rk', fullName: 'Rylan King', email: 'rylanking@example.test', fields: { Stage: 'Trial', 'Trial Start': '2026-10-19', Paperwork: 'Sent' } };
const waitingEnvelope = { id: 'e1', status: 'sent', subject: 'Work Trial Docs -- Rylan King', sender: { name: 'Project Owner' },
  signers: [{ email: 'rylanking@example.test', status: 'delivered', sentAt: at('2026-10-15T20:00:00Z') }, { email: 'project@company.example', status: 'created' }] };
function world(people, envelopes) {
  const said = [];
  let n = 0;
  return { said, notion: { readControl: async () => ({ mode: 'Live' }), listTrialCandidates: async () => people, appendCandidateNote: async () => null },
    sender: { envelopesFor: async () => envelopes }, poster: async t => { said.push(t); return `17923${String(++n).padStart(5, '0')}.000100`; } };
}

test('Reminders go to the trialer (DocuSign) at noon PT the two days before; Project hears once, shortly before their first check-in; signed or later trials get nothing (Project, Oct 19)', async () => {
  const db = d1();
  const signed = { ...RYLAN, pageId: 'p-s', fullName: 'Morgan Ellis', email: 's@x.co', fields: { ...RYLAN.fields, Paperwork: 'Signed' } };
  const later = { ...RYLAN, pageId: 'p-l', fullName: 'Later Person', email: 'l@x.co', fields: { ...RYLAN.fields, 'Trial Start': '2026-10-25' } };
  // Skyler, India: Saturday Oct 24 there begins Friday 11:30 AM PT.
  const skyler = { pageId: 'p-sk', fullName: 'Skyler Dawson', email: 'dawson.skyler@example.test', fields: { Stage: 'Trial', Pipeline: 'India', 'India Stage': 'Pre Work Trial', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25', Paperwork: 'Sent' } };
  const env2 = { ...waitingEnvelope, id: 'e2', subject: 'Work Trial Docs -- Skyler Dawson', signers: [{ email: 'dawson.skyler@example.test', status: 'sent', sentAt: at('2026-10-20T20:00:00Z') }] };
  const w = world([RYLAN, signed, later, skyler], [waitingEnvelope, env2]);
  const resent = [];
  w.sender.envelopesFor = async email => [waitingEnvelope, env2].filter(e => e.signers.some(x => x.email === email));
  w.sender.resend = async id => { resent.push(id); return { ok: true }; };
  const run = (now, env = { UNCLE_SAM_PRESTART_MASON: 'on' }) => runPreStartPaperwork({ env, db, notion: w.notion, sender: w.sender, poster: w.poster, masonChannel: DM, clock: () => now, force: true });
  const r0 = await run(at('2026-10-18T17:00:00Z'));
  assert.deepEqual([r0.told, r0.reminded ?? 0], [0, 0], '10 AM PT the day before: nothing yet');
  // Rylan (Pacific, starts Mon Oct 19, first check-in 9:30 AM PT): Sunday noon a reminder to him, nothing to Project.
  const sun = await run(at('2026-10-18T19:05:00Z'));
  assert.deepEqual([sun.told, sun.reminded], [0, 1]);
  assert.deepEqual(resent, ['e1']);
  // Off by default (Project, Oct 19: "no other paper warning"): nothing to Project.
  assert.equal((await run(at('2026-10-19T15:05:00Z'), {})).told, 0);
  // With UNCLE_SAM_PRESTART_MASON=on: Monday 8:05 AM PT, about 90 minutes before his first check-in, one message.
  const early = await run(at('2026-10-19T15:05:00Z'));
  assert.deepEqual([early.told, early.reminded ?? 0], [1, 0]);
  assert.equal(w.said[0], '📋 Rylan King has their first check-in at 9:30 AM PT and still hasn\'t signed “Work Trial Docs -- Rylan King” (opened, not signed). DocuSign reminded them once. Reply resend for one more.');
  // Monday noon: one more reminder to him, nothing more to Project.
  const mon = await run(at('2026-10-19T19:05:00Z'));
  assert.deepEqual([mon.told, mon.reminded, resent.length], [0, 1, 2]);
  // Skyler (India, Sat Oct 24, first check-in 9:30 AM there = Fri 9:00 PM PT): reminders Thu and Fri noon; Project Fri evening.
  const thu = await run(at('2026-10-22T19:05:00Z'));
  assert.deepEqual([thu.told, thu.reminded, resent.at(-1)], [0, 1, 'e2']);
  const fri = await run(at('2026-10-23T19:05:00Z'));
  assert.deepEqual([fri.told, fri.reminded], [0, 1]);
  const { noticeStore: ns } = await import('../service/lib/stuck-rejections.mjs');
  await ns(db).put('onboarding:p-sk', { address: 'skyler@company.example', okta: { at: 1 } }, at('2026-10-23T07:00:00Z'));
  const friEve = await run(at('2026-10-24T02:35:00Z'));
  assert.equal(friEve.told, 1);
  assert.match(w.said.at(-1), /^📋 Skyler Dawson has their first check-in at 9:00 PM PT and still hasn't signed “Work Trial Docs -- Skyler Dawson” \(not opened yet\)\. DocuSign reminded them 2 times\. .* Their Company account \(skyler@company\.example\) is set up, Okta too\.$/);
  // The time of his real first check-in, once they're on the calendar.
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  assert.equal((await run(at('2026-10-24T03:05:00Z'))).told, 0, 'once');
  assert.equal(w.said.length, 2, 'Project: one message per trial');
});

test('nothing out: "send" at the standard rate; DocuSign already signed: no message; DocuSign down: the tracker\'s word', () => {
  assert.equal(preStartText({ name: 'Rylan King', start: '2026-10-19', state: { waiting: [], signedPacket: false }, rate: 100 }).text,
    '📋 Rylan King starts tomorrow (Mon, Oct 19) and no work trial documents are out to them in DocuSign. Reply send here and I\'ll send them at US$100 per day.');
  assert.equal(preStartText({ name: 'R K', start: '2026-10-19', state: null, paperwork: 'Sent' }).mode, 'resend');
  assert.deepEqual(paperworkState([{ status: 'completed', subject: 'Work Trial Docs -- R', signers: [{ email: 'r@x.co', status: 'completed' }] }], 'r@x.co'), { waiting: [], signedPacket: true });
});

test('Project\'s "resend" in the thread resends once; "send" sends; "hold" leaves it; other replies are not this', async () => {
  const db = d1();
  const w = world([RYLAN], [waitingEnvelope]);
  await runPreStartPaperwork({ env: { UNCLE_SAM_PRESTART_MASON: 'on' }, db, notion: w.notion, sender: w.sender, poster: w.poster, masonChannel: DM, clock: () => at('2026-10-19T15:05:00Z'), force: true });
  const ts = '1792300001.000100', did = [], replies = [];
  const reply = text => handlePreStartReply({ event: { authorId: PROJECT, channelId: DM, threadTs: ts, messageTs: `17923${Math.random().toString().slice(2, 7)}.000100`, text }, db, masonId: PROJECT,
    resend: async ask => { did.push(['resend', ask.pageId]); return { kind: 'docusign_resend' }; }, send: async ask => { did.push(['send', ask.pageId]); return { kind: 'packet' }; },
    poster: () => async t => replies.push(t) });
  assert.equal(await reply('thanks'), null);
  assert.equal((await reply('resend')).kind, 'docusign_resend');
  assert.deepEqual(did, [['resend', 'p-rk']]);
  assert.equal((await reply('resend')).kind, 'prestart_done_before');
  assert.equal(did.length, 1, 'never twice');
  assert.equal(await handlePreStartReply({ event: { authorId: 'U0A4F08721B', channelId: DM, threadTs: ts, messageTs: '1.2', text: 'resend' }, db, masonId: PROJECT }), null, 'only Project');
});

test('temporary document validation failure leaves the scheduled reminder retryable, then sends once', async () => {
  const db = d1(), w = world([RYLAN], [waitingEnvelope]); let calls = 0;
  w.sender.resend = async () => ++calls === 1 ? { ok: false, code: 'docusign_validation_unavailable', retryable: true } : { ok: true };
  const run = () => runPreStartPaperwork({ env: {}, db, ...w, masonChannel: DM, clock: () => at('2026-10-18T19:05:00Z'), force: true });
  await run(); await run(); await run();
  assert.equal(calls, 2); assert.equal(w.said.length, 0);
});
