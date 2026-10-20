import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handlePasswordReset, RESET_ASK } from '../service/lib/password-reset.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', NOW = Date.parse('2026-10-19T19:00:00Z');
const ROWAN = { pageId: 'p-adi', fullName: 'Rowan Blake', email: 'rowanb97@example.test' };
const ev = (text, ts = '5.1') => ({ authorId: PROJECT, channelId: 'D1', messageTs: ts, text });

test('"reset Rowan\'s password": new one-time Google password, the sign-in as a reply in the old thread, never shown to Project; once per message', async () => {
  const db = d1(), said = [], sent = [], resets = [];
  await noticeStore(db).put('onboarding:p-adi', { address: 'rowand@company.example' }, NOW);
  const admin = { get: async a => ({ primaryEmail: a, name: 'Rowan Blake', suspended: false, isAdmin: false }), resetPassword: async (a, p) => resets.push([a, p]) };
  const gmail = { listInbox: async () => [{ id: 'abc123', threadId: 't1', subject: 'Welcome to Company - account setup' }], send: async m => { sent.push(m); return { id: 'x' }; } };
  const run = ts => handlePasswordReset({ event: ev("can you reset rowan's google password", ts), db, findCandidate: async () => ROWAN, admin, gmail, masonId: PROJECT,
    poster: () => async t => said.push(t), clock: () => NOW, password: () => 'Tmp#Pass2345word' });
  assert.equal((await run('5.1')).reason, 'done');
  assert.deepEqual(resets, [['rowand@company.example', 'Tmp#Pass2345word']]);
  assert.equal(sent[0].to, 'rowanb97@example.test');
  assert.equal(sent[0].replyTo, 'abc123');
  assert.equal(sent[0].subject, 'Re: Welcome to Company - account setup');
  assert.match(sent[0].body, /Email: rowand@company\.example\nTemporary password: Tmp#Pass2345word/);
  assert.deepEqual(said, ['Roger that 🫡']);
  assert.ok(!said.join(' ').includes('Tmp#Pass'), 'the password never goes to Slack');
  assert.equal((await run('5.1')).reason, 'duplicate');
  assert.equal(resets.length, 1);
});

test('reset: someone else\'s account or an admin account is never touched; not Project or not a reset: nothing', async () => {
  const db = d1(), said = [], resets = [];
  await noticeStore(db).put('onboarding:p-adi', { address: 'rowand@company.example' }, NOW);
  const gmail = { listInbox: async () => [], send: async () => ({}) };
  const other = { get: async a => ({ primaryEmail: a, name: 'Rowan Brooks', isAdmin: false }), resetPassword: async (...a) => resets.push(a) };
  const r = await handlePasswordReset({ event: ev("reset Rowan Blake's password"), db, findCandidate: async () => ROWAN, admin: { ...other, get: async a => ({ primaryEmail: a, name: 'Someone Else', isAdmin: false }) }, gmail, masonId: PROJECT, poster: () => async t => said.push(t) });
  assert.equal(r.reason, 'mismatch');
  const adm = await handlePasswordReset({ event: ev("reset Rowan Blake's password", '6'), db, findCandidate: async () => ROWAN, admin: { ...other, get: async a => ({ primaryEmail: a, name: 'Rowan Blake', isAdmin: true }) }, gmail, masonId: PROJECT, poster: () => async t => said.push(t) });
  assert.equal(adm.reason, 'admin_account');
  assert.equal(resets.length, 0);
  assert.equal(await handlePasswordReset({ event: { ...ev("reset rowan's password"), authorId: 'U0X' }, db, findCandidate: async () => ROWAN, admin: other, gmail, masonId: PROJECT, poster: () => async () => {} }), null);
  assert.equal(RESET_ASK.test('what is the status of rowan'), false);
  assert.equal(RESET_ASK.test('send him a new password'), true);
});

import { takeHomeVerdict } from '../service/lib/agent-runner.mjs';
test('take-home questions get a plain verdict: skipped, submitted with score, or not started (Project, Oct 19)', () => {
  const rish = { fullName: 'Rylan King', fields: { Stage: 'Trial' } };
  assert.equal(takeHomeVerdict(rish, { status: 'Not started', sentOn: '2026-10-07', score: null }).verdict,
    'Rylan skipped the take-home: the link sent 2026-10-07 was never opened, and they went straight to the work trial.');
  assert.equal(takeHomeVerdict({ fullName: 'Sam Lee', fields: { Stage: 'Case Study' } }, { status: 'Complete', submittedAt: '2026-10-12T10:00:00Z', score: 82, santoshReview: 'Advance' }).verdict,
    'Sam submitted the take-home on 2026-10-12; portal score 82/100; Interviewer: Advance.');
  assert.match(takeHomeVerdict({ fullName: 'Ana B', fields: { Stage: 'Case Study' } }, { status: 'Not started', sentOn: '2026-10-18' }).verdict, /sent 2026-10-18 and hasn't been started/);
  assert.match(takeHomeVerdict(rish, null).verdict, /never had a take-home on the tracker; went straight to the work trial/);
});

import { looksLikeTakeHomeSend } from '../service/lib/project-commands.mjs';
test('a question about a take-home is never an order to send one', () => {
  for (const t of ['what score did he get on his take home', 'what did rylan get on the take home', 'did Sam pass the take-home?', 'how did Ana do on the case study']) assert.equal(looksLikeTakeHomeSend(t), false, t);
  for (const t of ['send Logan the take-home', 'get Sam the take home', 'start the take-home for Ana']) assert.equal(looksLikeTakeHomeSend(t), true, t);
});
