import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readTerms, runTrialTerms, handleTrialRateReply, rateIn, sendIfSettled, TERMS_UNREAD } from '../service/lib/trial-terms.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-19T02:00:00Z'); // Sun Oct 18, 7 PM PT
const model = input => ({ calls: 0, async complete() { this.calls++; return { content: [{ type: 'tool_use', name: 'terms', input: typeof input === 'function' ? input() : input }] }; } });
// Kendall, Oct 17-18 (Project 2026-10-18): Interviewer proposed a 2-day weekend trial, Project asked about next weekend, Kendall agreed.
const MAIL = [
  { id: 'm1', from: 'quinn@company.example', fromName: 'J Quinn Foster', receivedAt: '2026-10-17T10:03:00Z', text: 'Hi Kendall, We are flexible to work on weekends as well. How about a 2-day work trial?', url: 'https://mail/1' },
  { id: 'm2', from: 'kendall.porter@example.test', fromName: 'Kendall', receivedAt: '2026-10-17T13:01:43Z', text: 'Cool! Yes, that works for me.', url: 'https://mail/2' },
  { id: 'm3', from: 'project@company.example', fromName: 'Project Owner', receivedAt: '2026-10-18T21:48:37Z', text: 'Does next weekend work for you? We will adapt the work trial to fit your time zones.', url: 'https://mail/3' },
  { id: 'm4', from: 'kendall.porter@example.test', fromName: 'Kendall', receivedAt: '2026-10-19T00:24:35Z', text: "Yes, next weekend works for me. I'm only 4 hours ahead of PDT, so regular work hours still work for me.", url: 'https://mail/4' }];
const AGREED = { dates_agreed: true, start: '2026-10-24', end: '2026-10-25', date_quotes: [{ n: 3, quote: 'Does next weekend work for you?' }, { n: 4, quote: 'Yes, next weekend works for me.' }], rate_stated: false };
const KENDALL = { pageId: 'p-kendall', fullName: 'Kendall Porter', email: 'kendall.porter@example.test', fields: { Stage: 'Trial', Outcome: 'Proceeding' }, payment: {} };

function world({ candidate = KENDALL, mail = MAIL, setResult = null } = {}) {
  const w = { db: d1(), set: [], notes: [], said: [], queries: [] };
  w.notion = { readControl: async () => ({ mode: 'Live' }), listTrialCandidates: async () => [candidate], listCandidateNotes: async () => [],
    setTrialTerms: async a => { w.set.push(a); return setResult ?? { verified: true, set: [a.start ? 'dates' : null, a.rate ? 'rate' : null].filter(Boolean), conflicts: [] }; },
    appendCandidateNote: async n => { w.notes.push(n); } };
  w.gmail = { listInbox: async q => { w.queries.push(q); return mail; } };
  w.run = (claude, now = NOW, sendPacket = null) => runTrialTerms({ sendPacket, env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db: w.db, notion: w.notion, gmail: w.gmail, claude, poster: async t => { w.said.push(t); return `1792400000.00010${w.said.length}`; }, clock: () => now, force: true });
  return w;
}

test('Trial terms (Project, 2026-10-18): Kendall\'s "next weekend" agreed by email goes on the tracker as Sat Oct 24 - Sun Oct 25, with a note and one line to Project', async () => {
  const w = world(), claude = model(AGREED);
  const out = await w.run(claude);
  assert.equal(out.set, 1, JSON.stringify(out));
  assert.match(w.queries[0], /^\(from:kendall\.porter@example\.test OR to:kendall\.porter@example\.test OR cc:kendall\.porter@example\.test\) newer_than:30d$/);
  assert.deepEqual(w.set[0], { pageId: 'p-kendall', expectedEmail: 'kendall.porter@example.test', start: '2026-10-24', end: '2026-10-25', days: 2 });
  assert.equal(w.said[0], "🪖 Kendall confirmed Sat, Oct 24 – Sun, Oct 25. Need Kendall's daily rate; reply here and I'll send out the paperwork.");
  assert.match(w.notes[0].text, /Work-trial terms from what was agreed in writing/);
  // Nothing new in the conversation: not read again.
  await w.run(claude, NOW + 3600_000);
  assert.equal(claude.calls, 1);
});

test('Trial terms: only what both sides wrote; quotes must be word for word; the team\'s rate in writing; a different value on the tracker is left and Project told once', async () => {
  const msgs = [{ who: 'Project Owner', at: NOW - 3600_000, text: 'Does next weekend work? Pay is $150 per day.' }, { who: 'Candidate', at: NOW, text: 'Sounds good' }];
  // A confirmation quote the candidate never wrote: no dates.
  assert.equal(await readTerms({ claude: model({ ...AGREED, date_quotes: [{ n: 1, quote: 'Does next weekend work?' }, { n: 2, quote: 'Yes next weekend' }] }), name: 'X', messages: msgs, now: NOW }), null);
  // Only the team asked: not agreed.
  assert.equal(await readTerms({ claude: model({ ...AGREED, date_quotes: [{ n: 1, quote: 'Does next weekend work?' }] }), name: 'X', messages: msgs, now: NOW }), null);
  // Both sides and the rate.
  const both = await readTerms({ claude: model({ ...AGREED, date_quotes: [{ n: 1, quote: 'Does next weekend work?' }, { n: 2, quote: 'Sounds good' }], rate_stated: true, daily_rate: 150, rate_quotes: [{ n: 1, quote: 'Pay is $150 per day.' }] }), name: 'X', messages: msgs, now: NOW });
  assert.deepEqual([both.start, both.end, both.days, both.rate], ['2026-10-24', '2026-10-25', 2, 150]);
  // A rate only the candidate wrote is never taken.
  const theirs = await readTerms({ claude: model({ dates_agreed: false, rate_stated: true, daily_rate: 300, rate_quotes: [{ n: 2, quote: 'Sounds good' }] }), name: 'X', messages: msgs, now: NOW });
  assert.equal(theirs, null);
  // Conflict with the tracker: told once, nothing changed.
  const w = world({ setResult: { verified: true, set: [], conflicts: [{ field: 'trial dates', have: '2026-10-23 – 2026-10-24', found: '2026-10-24 – 2026-10-25' }] } });
  await w.run(model(AGREED));
  assert.deepEqual(w.said, ['📋 Kendall Porter: the tracker has trial dates 2026-10-23 – 2026-10-24, but the emails say 2026-10-24 – 2026-10-25. I left the tracker as it is.']);
  w.gmail.listInbox = async () => [...MAIL, { id: 'm5', from: 'kendall.porter@example.test', receivedAt: '2026-10-19T03:00:00Z', text: 'Thanks', url: 'u' }];
  await w.run(model(AGREED), NOW + 3600_000);
  assert.equal(w.said.length, 1, 'once');
  // Everything already on the record, the same dates in writing: read (watched until it starts), nothing changes.
  const full = world({ candidate: { ...KENDALL, fields: { ...KENDALL.fields, 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }, payment: { dailyRate: 100 } } });
  await full.run(model(AGREED));
  assert.deepEqual([full.set.length, full.said.length], [0, 0]);
  // Already started: not read at all.
  const going = world({ candidate: { ...KENDALL, fields: { ...KENDALL.fields, 'Trial Start': '2026-10-18', 'Trial End': '2026-10-19' }, payment: { dailyRate: 100 } } });
  const c = model(AGREED);
  await going.run(c);
  assert.equal(c.calls, 0);
});

test('Trial terms: Project\'s "$150" under the rate question sets the Daily Trial Rate once', async () => {
  const w = world();
  await w.run(model(AGREED));
  // The record as read when he answers: no dates yet, so the invite asking for them goes (trial-invite.mjs).
  w.notion.getCandidate = async () => ({ ...KENDALL });
  const said = [];
  const reply = (text, ts = '1792400100.000100') => handleTrialRateReply({ event: { authorId: 'U0F9EF97D89', channelId: 'D0C95KBR09J', threadTs: '1792400000.000101', messageTs: ts, text }, db: w.db, notion: w.notion,
    poster: () => async t => said.push(t), masonId: 'U0F9EF97D89', clock: () => NOW });
  assert.equal((await reply('not sure yet')).reason, 'no_rate');
  assert.equal((await reply('$150\n*Sent using* <@U0A88TFE3RT|Claude>', '1792400100.000200')).reason, null);
  assert.deepEqual(w.set.at(-1), { pageId: 'p-kendall', expectedEmail: 'kendall.porter@example.test', rate: 150 });
  assert.equal(said.at(-1), 'Roger that 🫡 US$150 a day for Kendall. Sending the invite now.');
  assert.equal((await noticeStore(w.db).get('trialinvite:p-kendall')).rate, 150);
  assert.deepEqual([rateIn('120/day'), rateIn('100 a day'), rateIn('75'), rateIn('maybe 3 days')], [120, 100, 75, null]);
});

test('Dates and rate settled -> the paperwork goes: on Project\'s rate reply, and when the rate was already on the record (Project, 2026-10-18)', async () => {
  const w = world(), sends = [];
  const rec = { ...KENDALL, fields: { ...KENDALL.fields, 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }, payment: { dailyRate: 150 } };
  w.notion.getCandidate = async () => rec;
  const sendPacket = async ({ candidate, rate, force }) => { sends.push([candidate.pageId, rate, force]); return { reason: 'queued' }; };
  await w.run(model(AGREED));
  const said = [], answered = [];
  await noticeStore(w.db).put('trialterms:rateask:1792400000.000101', { ...(await noticeStore(w.db).get('trialterms:rateask:1792400000.000101')), offerKey: 'usam:v1:offer' }, NOW);
  const out = await handleTrialRateReply({ event: { authorId: 'U0F9EF97D89', channelId: 'D0C95KBR09J', threadTs: '1792400000.000101', messageTs: '1792400100.000300', text: '150' }, db: w.db, notion: w.notion,
    poster: () => async t => said.push(t), masonId: 'U0F9EF97D89', sendPacket, clock: () => NOW, onAnswered: (key, line) => answered.push([key, line]) });
  assert.equal(out.reason, null);
  assert.deepEqual(said, ["Roger that 🫡 US$150 a day for Kendall. Sending the paperwork now."]);
  assert.deepEqual(sends, [['p-kendall', 150, true]], "his reply is his word: force");
  assert.deepEqual(answered, [['usam:v1:offer', 'Roger that 🫡 US$150 a day for Kendall. Sending the paperwork now.']], 'the offer loses its buttons');
  // Already sent: nothing more, and he hears why.
  rec.fields.Paperwork = 'Sent';
  await handleTrialRateReply({ event: { authorId: 'U0F9EF97D89', channelId: 'D0C95KBR09J', threadTs: '1792400000.000101', messageTs: '1792400100.000400', text: '160' }, db: w.db, notion: w.notion,
    poster: () => async t => said.push(t), masonId: 'U0F9EF97D89', sendPacket, clock: () => NOW });
  assert.equal(sends.length, 1);
  assert.equal(said.at(-1), "Roger that 🫡 US$160 a day for Kendall. Kendall's paperwork is already out (Paperwork Sent).");
  // The rate already on the record and the dates just found in the emails: sent in the same run.
  const w2 = world({ candidate: { ...KENDALL, payment: { dailyRate: 120 } } }), sends2 = [];
  w2.notion.getCandidate = async () => ({ ...KENDALL, fields: { ...KENDALL.fields, 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }, payment: { dailyRate: 120 } });
  await runTrialTerms({ env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db: w2.db, notion: w2.notion, gmail: w2.gmail, claude: model(AGREED), poster: async t => { w2.said.push(t); return '1.1'; },
    sendPacket: async ({ rate }) => { sends2.push(rate); return { reason: 'sent', text: 'sent' }; }, clock: () => NOW, force: true });
  assert.deepEqual(sends2, [120]);
  assert.equal(w2.said[0], '🪖 Kendall confirmed Sat, Oct 24 – Sun, Oct 25. Got everything I need; sending the paperwork now.');
});

test('Dates from a proposal, then the candidate writes back other dates before the trial: the record follows, once; Project\'s own dates are never replaced (Project, Oct 19: "if he replies and changes you can always adjust them")', async () => {
  // Skyler: Robin proposed Sat Oct 24 – Sun Oct 25; he answers that the next weekend works better.
  const SKYLER = { pageId: 'p-skyler', fullName: 'Skyler Dawson', email: 'dawson.skyler@example.test', fields: { Stage: 'Trial', Outcome: 'Proceeding', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }, payment: { dailyRate: 100 } };
  const mail = [
    { id: 's1', from: 'robin@company.example', fromName: 'Robin Cooper', receivedAt: '2026-10-19T19:55:18Z', text: "let's run it Saturday Oct 24 through Sunday Oct 25 (IST). Can you reply to confirm the dates work?", url: 'https://mail/s1' },
    { id: 's2', from: 'dawson.skyler@example.test', fromName: 'Skyler', receivedAt: '2026-10-20T05:00:00Z', text: 'Thanks! This weekend is tight, could we do Oct 31 and Nov 1 instead? That works for me.', url: 'https://mail/s2' }];
  const MOVED = { dates_agreed: true, start: '2026-10-31', end: '2026-11-01', date_quotes: [{ n: 1, quote: "let's run it Saturday Oct 24 through Sunday Oct 25" }, { n: 2, quote: 'could we do Oct 31 and Nov 1 instead? That works for me.' }], rate_stated: false };
  const T = Date.parse('2026-10-20T06:00:00Z');
  const w = world({ candidate: SKYLER, mail }), claude = model(MOVED);
  const out = await w.run(claude, T);
  assert.equal(out.set, 1, JSON.stringify(out));
  assert.deepEqual(w.set[0], { pageId: 'p-skyler', expectedEmail: 'dawson.skyler@example.test', start: '2026-10-31', end: '2026-11-01', days: 2, replaceDates: true });
  assert.match(w.said[0], /^📅 Skyler Dawson changed his work trial to Sat, Oct 31 – Sun, Nov 1 \(their time\)\. Tracker, calendar block and check-ins follow\.$/);
  const { noticeStore } = await import('../service/lib/stuck-rejections.mjs');
  assert.deepEqual(await noticeStore(w.db).get('checkins:redate:p-skyler').then(r => [r.start, r.end, r.from]), ['2026-10-31', '2026-11-01', '2026-10-24']);
  // Same conversation: not read again. Dates already started: no longer watched.
  await w.run(claude, T + 3600_000);
  assert.equal(claude.calls, 1);
  const started = world({ candidate: { ...SKYLER, fields: { ...SKYLER.fields, 'Trial Start': '2026-10-19', 'Trial End': '2026-10-21' } }, mail });
  await started.run(model(MOVED), T);
  assert.equal(started.set.length, 0);
  // He confirms the dates on the record and the rate is known: the papers go by themselves, and Project hears one line; once
  // (Project, Oct 19: "you might already know the rate and in that case you should auto send the documents and just let me know").
  const same = world({ candidate: SKYLER, mail }), sends = [];
  same.notion.getCandidate = async () => SKYLER;
  const sendPacket = async ({ candidate, rate }) => { sends.push([candidate.pageId, rate]); return { reason: 'sent', text: 'sent' }; };
  await same.run(model({ ...MOVED, start: '2026-10-24', end: '2026-10-25' }), T, sendPacket);
  assert.equal(same.set.length, 0);
  assert.deepEqual(sends, [['p-skyler', 100]]);
  assert.deepEqual(same.said, ['🪖 Skyler confirmed Sat, Oct 24 – Sun, Oct 25. Got everything I need; sending the paperwork now.']);
  same.gmail.listInbox = async () => [...mail, { id: 's3', from: 'dawson.skyler@example.test', receivedAt: '2026-10-20T07:00:00Z', text: 'Great, thanks', url: 'u' }];
  await same.run(model({ ...MOVED, start: '2026-10-24', end: '2026-10-25' }), T + 3600_000, sendPacket);
  assert.equal(sends.length, 1, 'once');
  // Papers already out: nothing.
  const out2 = world({ candidate: { ...SKYLER, fields: { ...SKYLER.fields, Paperwork: 'Sent' } }, mail });
  await out2.run(model({ ...MOVED, start: '2026-10-24', end: '2026-10-25' }), T, sendPacket);
  assert.equal(out2.said.length, 0);
  // No rate on the record: Project is asked, short; his reply sends them (handleTrialRateReply).
  const norate = world({ candidate: { ...SKYLER, payment: {} }, mail, setResult: { verified: true, set: [], conflicts: [] } });
  await norate.run(model({ ...MOVED, start: '2026-10-24', end: '2026-10-25' }), T, sendPacket);
  assert.deepEqual(norate.said, ["🪖 Skyler confirmed Sat, Oct 24 – Sun, Oct 25. Need Skyler's daily rate; reply here and I'll send out the paperwork."]);
  assert.ok(await noticeStore(norate.db).get('trialterms:rateask:1792400000.000101'));
  // Project set the dates himself: left, and he hears once.
  const project = world({ candidate: SKYLER, mail });
  await noticeStore(project.db).put('trialdates:project:p-skyler', { start: '2026-10-24', end: '2026-10-25', at: T }, T);
  await project.run(model(MOVED), T);
  assert.equal(project.set.length, 0);
  assert.match(project.said[0], /you set Sat, Oct 24 – Sun, Oct 25, but the emails now say Sat, Oct 31 – Sun, Nov 1\. I left your dates\./);
  // ...but an agreement in writing after Project set them overrules his word (Project, Oct 19).
  const later = world({ candidate: SKYLER, mail });
  await noticeStore(later.db).put('trialdates:project:p-skyler', { start: '2026-10-24', end: '2026-10-25', at: Date.parse('2026-10-19T20:00:00Z') }, T);
  await later.run(model(MOVED), T);
  assert.equal(later.set.length, 1);
  assert.equal(later.set[0].replaceDates, true);
  assert.equal(await noticeStore(later.db).get('trialdates:project:p-skyler'), null);
});

test('A pay concern from them holds every automatic send; Project hears once with their words; it resumes once the team answers (Project, 2026-10-20)', async () => {
  const mail = [...MAIL, { id: 'm5', from: 'kendall.porter@example.test', fromName: 'Kendall', receivedAt: '2026-10-19T01:00:00Z', text: 'One question: is the rate flexible? I was hoping for $150 a day.', url: 'https://mail/5' }];
  const w = world({ candidate: { ...KENDALL, payment: { dailyRate: 100 } }, mail }), sends = [];
  w.notion.getCandidate = async () => ({ ...KENDALL, fields: { ...KENDALL.fields, 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }, payment: { dailyRate: 100 } });
  const sendPacket = async ({ rate }) => { sends.push(rate); return { reason: 'sent', text: 'sent' }; };
  const concern = { ...AGREED, pay_concern: true, concern_quote: { n: 5, quote: 'is the rate flexible?' } };
  const out = await w.run(model(concern), NOW, sendPacket);
  assert.equal(out.held, 1, JSON.stringify(out));
  assert.equal(sends.length, 0, 'nothing sent to them');
  assert.equal(w.set.length, 0, 'nothing written either');
  assert.match(w.said[0], /^✋ Kendall pushed back on the pay: “is the rate flexible\?”/);
  // A quote they never wrote does not hold anything.
  const w2 = world({ candidate: { ...KENDALL, payment: { dailyRate: 100 } } }), sends2 = [];
  w2.notion.getCandidate = w.notion.getCandidate;
  await w2.run(model({ ...AGREED, pay_concern: true, concern_quote: { n: 4, quote: 'can you pay more' } }), NOW, async ({ rate }) => { sends2.push(rate); return { reason: 'sent', text: 'sent' }; });
  assert.deepEqual(sends2, [100]);
});

test('Rate reply that cannot send says why: closed, On Hold, a pay concern, no email; never a bare "Roger that"', async () => {
  const cases = [
    [{ fields: { Stage: 'Closed', Outcome: 'Withdrawn or Unavailable' } }, "Nothing is going to Kendall: they're closed on the tracker."],
    [{ fields: { Stage: 'Interview', Outcome: 'On Hold' } }, "Nothing is going to Kendall: they're On Hold on the tracker."],
    [{ fields: { Stage: 'Interview' }, hold: true }, "Nothing is going to Kendall: they pushed back on the pay and haven't had an answer."],
    [{ fields: { Stage: 'Interview' }, email: null }, "Not sending the invite: there's no email on their record."],
  ];
  for (const [over, why] of cases) {
    const w = world(), said = [];
    await noticeStore(w.db).put('trialterms:rateask:9.1', { pageId: 'p-kendall', email: KENDALL.email, name: 'Kendall Porter' }, NOW);
    if (over.hold) await noticeStore(w.db).put('trialterms:hold:p-kendall', { at: NOW }, NOW);
    w.notion.getCandidate = async () => ({ ...KENDALL, ...('email' in over ? { email: over.email } : {}), fields: over.fields });
    await handleTrialRateReply({ event: { authorId: 'M', channelId: 'D', threadTs: '9.1', messageTs: '9.2', text: '$100' }, db: w.db, notion: w.notion,
      poster: () => async t => said.push(t), masonId: 'M', sendPacket: async () => { throw new Error('never'); }, clock: () => NOW });
    assert.equal(said[0], `Roger that 🫡 US$100 a day for Kendall. ${why}`);
    assert.equal(await noticeStore(w.db).get('trialinvite:p-kendall'), null);
  }
});

test('Invited but not at Stage Trial: their reply with dates is still read and the paperwork goes (no Stage gate)', async () => {
  const INVITED = { ...KENDALL, fields: { Stage: 'Interview', Outcome: 'Proceeding' }, payment: { dailyRate: 100 } };
  const w = world({ candidate: null }), sends = [];
  w.notion.listTrialCandidates = async () => [];
  w.notion.getCandidate = async () => ({ ...INVITED, fields: { ...INVITED.fields, 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' } });
  await noticeStore(w.db).put('trialinvite:p-kendall', { pageId: 'p-kendall', email: KENDALL.email, sentAt: NOW - 86400_000, messageId: 'abc123' }, NOW);
  const listed = w.notion.getCandidate;
  w.notion.getCandidate = async id => (w.set.length ? listed(id) : INVITED);
  await w.run(model(AGREED), NOW, async ({ rate }) => { sends.push(rate); return { reason: 'queued' }; });
  assert.equal(w.set.length, 1);
  assert.deepEqual(sends, [100]);
  assert.deepEqual(w.said, ['🪖 Kendall confirmed Sat, Oct 24 – Sun, Oct 25. Got everything I need; sending the paperwork now.']);
});

test('A model failure keeps the pay-concern hold and reads again next run; an unverified concern does not lift it', async () => {
  const w = world({ candidate: { ...KENDALL, payment: { dailyRate: 100 } } }), kv = noticeStore(w.db);
  await kv.put('trialterms:hold:p-kendall', { at: NOW, quote: 'is the rate flexible?' }, NOW);
  const down = { calls: 0, async complete() { this.calls++; throw new Error('overloaded'); } };
  assert.equal(await readTerms({ claude: down, name: 'X', messages: [{ who: 'Candidate', at: NOW, text: 'hi' }], now: NOW }), TERMS_UNREAD);
  const out = await w.run(down);
  assert.equal(out.unread, 1);
  assert.ok(await kv.get('trialterms:hold:p-kendall'), 'hold kept');
  await w.run(down, NOW + 1);
  assert.equal(down.calls, 3, 'read again (no fingerprint saved)');
  await w.run(model({ ...AGREED, pay_concern: true, concern_quote: { n: 4, quote: 'words they never wrote' } }), NOW + 2);
  assert.ok(await kv.get('trialterms:hold:p-kendall'), 'an unverified concern is not the all-clear');
  w.gmail.listInbox = async () => [...MAIL, { id: 'm9', from: 'project@company.example', receivedAt: '2026-10-19T01:30:00Z', text: 'We can do $120.', url: 'u' }];
  await w.run(model(AGREED), NOW + 3);
  assert.equal(await kv.get('trialterms:hold:p-kendall'), null, 'answered: lifted');
});

test("Cancel sticks: the dates path takes the confirmed claim, and a send Project cancelled is not re-queued by reading their reply", async () => {
  const w = world({ candidate: { ...KENDALL, payment: { dailyRate: 100 } } }), calls = [];
  const rec = { ...KENDALL, fields: { ...KENDALL.fields, 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }, payment: { dailyRate: 100 } };
  w.notion.getCandidate = async () => rec;
  let cancelled = false;
  const sendPacket = async ({ force }) => { calls.push(force ?? false); return cancelled && !force ? { reason: 'cancelled' } : { reason: 'queued' }; };
  await w.run(model(AGREED), NOW, sendPacket);
  assert.deepEqual(calls, [false]);
  assert.ok(await noticeStore(w.db).get('trialterms:confirmed:p-kendall:2026-10-24:2026-10-25'), 'claimed in the main path');
  // Project cancels; "thanks!" arrives; the record now has everything (watched): the same dates read again -> nothing new.
  cancelled = true;
  const watched = world({ candidate: rec }); watched.db = w.db; watched.notion.getCandidate = async () => rec;
  watched.gmail.listInbox = async () => [...MAIL, { id: 'm7', from: KENDALL.email, receivedAt: '2026-10-19T01:40:00Z', text: 'Thanks!', url: 'u' }];
  const again = runTrialTerms({ sendPacket, env: { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' }, db: w.db, notion: watched.notion, gmail: watched.gmail, claude: model(AGREED), poster: async t => { watched.said.push(t); return '1.2'; }, clock: () => NOW + 3600_000, force: true });
  await again;
  assert.deepEqual(calls, [false], 'not sent again');
  assert.deepEqual(watched.said, []);
  // sendIfSettled itself: cancelled is quiet; reasons when nothing goes.
  assert.deepEqual(await sendIfSettled({ notion: { getCandidate: async () => rec }, sendPacket: async () => ({ reason: 'cancelled' }), pageId: 'p-kendall' }), { sent: false, quiet: true, text: null });
  assert.equal((await sendIfSettled({ notion: { getCandidate: async () => ({ ...rec, fields: { ...rec.fields, Outcome: 'On Hold' } }) }, sendPacket, pageId: 'p-kendall' })).text, "📋 Not sending Kendall's paperwork: they're On Hold on the tracker.");
  const kv = noticeStore(w.db); await kv.put('trialterms:hold:p-kendall', { at: NOW }, NOW);
  assert.match((await sendIfSettled({ db: w.db, notion: { getCandidate: async () => rec }, sendPacket, pageId: 'p-kendall' })).text, /pushed back on the pay/);
});
