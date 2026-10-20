import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fillTrialConfirmation, sendTrialConfirmation, trialDatesText, datesLine, TRIAL_CONFIRM_TEMPLATE_ID } from '../service/lib/work-trial-offer.mjs';
import { parseTemplate } from '../service/lib/takehome-review.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

// The template as written in Notion on 2026-10-16 ("Email · Work Trial · Documents sent (confirmation)").
const FULL = `Subject: Your Company AI work trial

Hi {{first_name}},

Confirming the details of your work trial with Company AI.

Dates: {{trial_dates}}
Pay: {{daily_rate}} per day, as set out in the compensation addendum

I've sent you {{documents}}. Once they're signed, I'll send you an email with access to our Slack before your work trial starts.

During the work trial we'll have check-ins every morning and every night.

We look forward to working with you.`;
const NOW = Date.parse('2026-10-16T22:00:00Z');
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}

test('the confirmation email: dates, pay, the documents, Slack once signed, morning and night check-ins', () => {
  const t = parseTemplate(FULL);
  const filled = fillTrialConfirmation(t, { firstName: 'Jane', start: '2026-10-20', end: '2026-10-24', rate: 250, addendum: true });
  assert.equal(filled.subject, 'Your Company AI work trial');
  assert.equal(filled.body, `Hi Jane,

Confirming the details of your work trial with Company AI.

Dates: Tuesday, October 20 to Saturday, October 24, 2026
Pay: US$250 per day, as set out in the compensation addendum

I've sent you four documents to sign through DocuSign: the NDA, the CIIAA, our Terms of Service and your Work Trial Compensation Addendum. Please sign them as soon as you can. Once they're signed, I'll send you an email with access to our Slack before your work trial starts.

During the work trial we'll have check-ins every morning and every night.

We look forward to working with you.`);
  // No dates on the record; no addendum: the Pay line goes and three documents are named.
  const bare = fillTrialConfirmation(t, { firstName: 'Jane', rate: null, addendum: false });
  assert.match(bare.body, /Dates: to be confirmed with you shortly\n\nI've sent you three documents to sign through DocuSign: the NDA, the CIIAA and our Terms of Service\. Please sign them as soon as you can\./);
  // A template that already asks them to sign: not asked twice. One without "{{documents}}." gets the line under it.
  const asks = fillTrialConfirmation(parseTemplate(FULL.replace('Once they\'re signed', 'Please sign them today. Once they\'re signed')), { firstName: 'Jane', rate: 250 });
  assert.equal((asks.body.match(/please sign/gi) ?? []).length, 1);
  const own = fillTrialConfirmation(parseTemplate(FULL.replace("I've sent you {{documents}}. Once", "Here are {{documents}}\nOnce")), { firstName: 'Jane', rate: 250 });
  assert.match(own.body, /Here are four documents[^\n]*\nPlease sign them as soon as you can\.\nOnce/);
  assert.doesNotMatch(bare.body, /Pay:/);
  assert.equal(trialDatesText('2026-12-29', '2027-01-04'), 'Tuesday, December 29, 2026 to Monday, January 4, 2027');
  // A template that changed shape sends nothing.
  assert.equal(fillTrialConfirmation(parseTemplate(FULL.replace('{{documents}}', 'the documents')), { firstName: 'Jane', rate: 250 }), null);
  assert.equal(fillTrialConfirmation(parseTemplate(FULL + '\n{{start_time}}'), { firstName: 'Jane', rate: 250 }), null);
  assert.equal(datesLine('2026-10-20', '2026-10-24'), 'Dates: Tue, Oct 20, 2026 to Sat, Oct 24, 2026.');
});

test('the confirmation goes once per envelope, from Project\'s Gmail, and says so; no Gmail or a changed template says why', async () => {
  const kv = noticeStore(d1()), sent = [], notes = [];
  const gmail = { connected: async () => true, send: async m => { sent.push(m); return { id: 'abc123', url: 'https://mail.google.com/x' }; } };
  const notion = { getEmailTemplate: async id => { assert.equal(id, TRIAL_CONFIRM_TEMPLATE_ID); return FULL; }, appendCandidateNote: async n => notes.push(n) };
  const who = { pageId: 'p1', fullName: 'Jane Doe', email: 'jane@example.com', trialStart: '2026-10-20', trialEnd: '2026-10-24' };
  const go = (over = {}) => sendTrialConfirmation({ gmail, notion, kv, parseTemplate, who, rate: 250, addendum: true, envelopeId: 'env-1', now: NOW, ...over });
  assert.equal(await go(), 'Emailed Jane the confirmation from your Gmail.');
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'jane@example.com'); assert.match(sent[0].body, /check-ins every morning and every night/);
  assert.equal(notes.length, 1);
  assert.equal(await go(), '', 'never twice for one envelope');
  assert.equal(sent.length, 1);
  assert.match(await go({ envelopeId: 'env-2', gmail: { connected: async () => false } }), /your Gmail isn't connected/);
  assert.match(await go({ envelopeId: 'env-3', notion: { getEmailTemplate: async () => 'no subject line' } }), /template in Notion has changed shape/);
  assert.equal(sent.length, 1);
});

test('after the invitation: no second congratulations, and it goes as a reply in the invitation thread (Project, 2026-10-20)', async () => {
  const TEMPLATE = FULL.replace('Confirming the details of your work trial with Company AI.', "Congratulations, we'd like to move you forward with a work trial. Confirming the details:");
  const fresh = fillTrialConfirmation(parseTemplate(TEMPLATE), { firstName: 'Jane', start: '2026-10-24', end: '2026-10-25', rate: 100 });
  assert.match(fresh.body, /^Congratulations/m, 'no invitation before: the template as written');
  const kv = noticeStore(d1()), sent = [];
  await kv.put('trialinvite:p1', { pageId: 'p1', email: 'jane@example.com', sentAt: NOW - 86400_000, messageId: '18f0a1b2c3d4' }, NOW);
  const gmail = { connected: async () => true, send: async m => { sent.push(m); return { id: 'def456', url: 'https://mail.google.com/y' }; } };
  const notion = { getEmailTemplate: async () => TEMPLATE, appendCandidateNote: async () => ({}) };
  const who = { pageId: 'p1', fullName: 'Jane Doe', email: 'jane@example.com', trialStart: '2026-10-24', trialEnd: '2026-10-25' };
  await sendTrialConfirmation({ gmail, notion, kv, parseTemplate, who, rate: 100, addendum: true, envelopeId: 'env-9', now: NOW });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].body, /Congratulations/);
  assert.match(sent[0].body, /^Thanks for confirming your dates\.$/m);
  assert.doesNotMatch(sent[0].body, /Dates:|Pay:|If any of these dates/);
  assert.doesNotMatch(sent[0].body, /\n\n\n/);
  assert.equal(sent[0].replyTo, '18f0a1b2c3d4');
  assert.equal(sent[0].subject, 'Re: Your Company AI work trial');
});

test('an invitation Project sent by hand counts too: found in his Sent mail, no second congratulations, a reply in that thread', async () => {
  const TEMPLATE = FULL.replace('Confirming the details of your work trial with Company AI.', "Congratulations, we'd like to move you forward with a work trial. Confirming the details:");
  const kv = noticeStore(d1()), sent = [], queries = [];
  const gmail = { connected: async () => true, searchSent: async q => { queries.push(q); return [{ id: 'abc999', threadId: 't1', subject: 'Next step: a paid work trial' }]; }, send: async m => { sent.push(m); return { id: 'n1' }; } };
  const notion = { getEmailTemplate: async () => TEMPLATE, appendCandidateNote: async () => ({}) };
  const who = { pageId: 'p2', fullName: 'Jane Doe', email: 'jane@example.com', trialStart: '2026-10-24', trialEnd: '2026-10-25' };
  await sendTrialConfirmation({ gmail, notion, kv, parseTemplate, who, rate: 100, addendum: true, envelopeId: 'env-h', now: NOW });
  assert.match(queries[0], /^to:jane@example\.com "move you forward with a work trial" newer_than:60d$/);
  assert.doesNotMatch(sent[0].body, /Congratulations/);
  assert.equal(sent[0].replyTo, 'abc999');
  assert.equal(sent[0].subject, 'Re: Next step: a paid work trial', "his invitation's own subject, so Gmail keeps it in that thread");
  // Nothing in Sent: the first email, with the congratulations.
  const sent2 = [];
  await sendTrialConfirmation({ gmail: { ...gmail, searchSent: async () => [], send: async m => { sent2.push(m); return { id: 'n2' }; } }, notion, kv, parseTemplate, who: { ...who, pageId: 'p3' }, rate: 100, addendum: true, envelopeId: 'env-i', now: NOW });
  assert.match(sent2[0].body, /^Congratulations/m);
});

test('after the invitation, whatever the template looks like: no congratulations line, "Thanks for confirming your dates." first, please sign kept', () => {
  const shapes = [
    FULL, // "Confirming the details of your work trial with Company AI." (2026-10-16)
    FULL.replace('Confirming the details of your work trial with Company AI.', "Congratulations, we'd like to move you forward with a work trial. Confirming the details:"),
    FULL.replace('Confirming the details of your work trial with Company AI.', 'Congrats again!\nConfirming the details:'),
    FULL.replace('Hi {{first_name}},\n\n', 'Hi {{first_name}},\n\nCONGRATULATIONS on making it to the work trial.\n'),
  ];
  for (const t of shapes) {
    const out = fillTrialConfirmation(parseTemplate(t), { firstName: 'Jane', start: '2026-10-24', end: '2026-10-25', rate: 100, afterInvite: true });
    assert.ok(out, t.slice(0, 80));
    assert.doesNotMatch(out.body, /congrat/i);
    assert.match(out.body, /^Hi Jane,\n\nThanks for confirming your dates\.\n\nI've sent you/);
    assert.doesNotMatch(out.body, /Dates:|Pay:|Confirming the details|\n\n\n/);
    assert.match(out.body, /Please sign them as soon as you can\./);
  }
});

test("a bot invite's stored subject is the reply's subject; an invite Project sent that Uncle Sam found (sent_by_hand) is the thread", async () => {
  const kv = noticeStore(d1()), sent = [];
  const gmail = { connected: async () => true, searchSent: async () => { throw new Error('not searched'); }, send: async m => { sent.push(m); return { id: 'z1' }; } };
  const notion = { getEmailTemplate: async () => FULL.replace('Subject: Your Company AI work trial', 'Subject: Your work trial documents'), appendCandidateNote: async () => ({}) };
  const who = { pageId: 'p5', fullName: 'Jane Doe', email: 'jane@example.com', trialStart: '2026-10-24', trialEnd: '2026-10-25' };
  await kv.put('trialinvite:p5', { pageId: 'p5', email: 'Jane@Example.com', sentAt: NOW - 86400_000, messageId: '18f0aa', subject: 'Your Company AI work trial' }, NOW);
  await sendTrialConfirmation({ gmail, notion, kv, parseTemplate, who, rate: 100, addendum: true, envelopeId: 'env-s1', now: NOW });
  assert.equal(sent[0].replyTo, '18f0aa'); assert.equal(sent[0].subject, 'Re: Your Company AI work trial');
  await kv.put('trialinvite:p6', { pageId: 'p6', email: 'jane@example.com', dropped: 'sent_by_hand', handSent: { messageId: '18f0bb', subject: 'Re: Work trial at Company' } }, NOW);
  await sendTrialConfirmation({ gmail, notion, kv, parseTemplate, who: { ...who, pageId: 'p6' }, rate: 100, addendum: true, envelopeId: 'env-s2', now: NOW });
  assert.equal(sent[1].replyTo, '18f0bb'); assert.equal(sent[1].subject, 'Re: Work trial at Company');
  assert.match(sent[1].body, /^Hi Jane,\n\nThanks for confirming your dates\./);
});
