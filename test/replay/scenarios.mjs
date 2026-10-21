import assert from 'node:assert/strict';
import { PERSON } from './world.mjs';
const MIN = 60_000;
const email = 'synthetic@example.invalid';
const workEmail = 'synthetic@company.example';
const checkins = w => w.events().filter(e => !e.allDay && e.status !== 'cancelled');
const noMail = w => assert.equal(w.emails.length, 0, 'no candidate email before its prerequisites');
const packetQueued = async w => assert.ok(await w.kv.get(`emailq:packet:${PERSON}`), 'missing documents queue');

async function finishTrial(w, { invite = true } = {}) {
  if (invite) {
    await w.step('invitation waits, then asks for dates once', async () => {
      await w.invites(); noMail(w); w.advance(35 * MIN); await w.invites();
      assert.equal(w.emails.length, 1); assert.equal(w.emails[0].to, email);
      assert.match(w.emails[0].body, /US\$150 per day/); assert.match(w.emails[0].body, /confirm your available dates/);
      await w.invites(); assert.equal(w.emails.length, 1);
    });
    await w.step('written agreement queues paperwork through the real terms parser', async () => {
      const out = await w.agreeDates(); assert.equal(out.error, null); await packetQueued(w);
      assert.equal((await w.candidate()).fields['Trial Start'], '2026-10-24');
    });
  } else await packetQueued(w);
  await w.step('documents and confirmation use agreed identity, dates and rate', async () => {
    await w.documents(); assert.equal(w.envelopes.length, 0);
    w.advance(30 * MIN); const out = await w.documents(); assert.equal(out.error, null);
    assert.equal(w.envelopes.length, 1); assert.equal(w.envelopes[0].email, email);
    assert.deepEqual(w.envelopes[0].terms, { dailyRate: 150, start: '2026-10-24', end: '2026-10-25', date: '2026-10-23' });
    assert.equal(w.emails.length, invite ? 2 : 1);
    const confirmation = w.emails.at(-1); assert.equal(confirmation.to, email);
    assert.match(confirmation.body, /four documents/); assert.match(confirmation.body, /Please sign them as soon as you can/);
    if (invite) { assert.equal(confirmation.replyTo, w.emails[0].id); assert.doesNotMatch(confirmation.body, /Congratulations/); }
    else { assert.match(confirmation.body, /Saturday, October 24 to Sunday, October 25, 2026/); assert.match(confirmation.body, /US\$150/); }
  });
  await w.step('calendar uses work account and the correct local trial days', async () => {
    const result = await w.schedule(); assert.equal(result.error, null);
    assert.equal(checkins(w).length, 0, 'no check-ins before the work account exists');
    w.set({ Paperwork: 'Signed' }); await w.onboard();
    assert.equal(w.createdAccounts.length, 0, 'account creation also waits');
    w.advance(30 * MIN); await w.onboard();
    assert.equal(w.createdAccounts.length, 1, 'one Company account');
    assert.equal(w.createdAccounts[0].address, workEmail); assert.equal(w.createdAccounts[0].recoveryEmail, email);
    const welcome = w.emails.at(-1); assert.equal(welcome.subject, 'Your Company AI accounts'); assert.equal(welcome.to, email);
    assert.ok(welcome.body.includes(w.createdAccounts[0].password));
    assert.ok(!JSON.stringify(w.notes).includes(w.createdAccounts[0].password), 'password never in tracker notes');
    const events = checkins(w); assert.equal(events.length, 4, 'two check-ins per trial day');
    assert.deepEqual(events.map(e => e.start).sort(), ['2026-10-24T04:00:00.000Z', '2026-10-24T16:00:00.000Z', '2026-10-25T04:00:00.000Z', '2026-10-25T16:00:00.000Z']);
    for (const event of events) {
      assert.equal(Date.parse(event.end) - Date.parse(event.start), 15 * MIN);
      assert.deepEqual(event.attendees.map(g => g.email).sort(), ['quinn@company.example', 'robin@company.example', workEmail, 'taylor@company.example'].sort());
      assert.ok(event.meetUrl); assert.equal(event.transparent, true);
    }
    const banner = w.events().find(e => e.allDay); assert.ok(banner);
    assert.equal(banner.start, '2026-10-24T00:00:00.000Z'); assert.equal(banner.end, '2026-10-26T00:00:00.000Z');
    assert.ok(banner.attendees.every(g => g.email !== email && g.email !== workEmail), 'banner is team-only');
  });
  await w.step('first-check-in email matches the actual invitation in both time zones', async () => {
    await w.confirm(); w.advance(30 * MIN); const r = await w.confirm(); assert.equal(r.sent, 1, JSON.stringify(r));
    const mail = w.emails.at(-1); assert.equal(mail.to, email);
    assert.match(mail.body, /Saturday, October 24, 2026 at 9:30 AM/);
    assert.match(mail.body, /Friday, October 23, 2026 at 9:00 PM PDT/);
    assert.match(mail.body, /synthetic@company\.example/); assert.match(mail.body, /https:\/\/meet.google.com\/abc-defg-hij/);
  });
  await w.step('restarted workers and repeated decisions do not repeat delivery', async () => {
    const before = [w.emails.length, w.envelopes.length, checkins(w).length]; await w.restart();
    await w.recap('Interviewer'); await w.invites(); await w.documents(); await w.schedule(); await w.confirm();
    assert.deepEqual([w.emails.length, w.envelopes.length, checkins(w).length], before);
  });
}
async function queuedInvite(w) { await w.recap(); assert.ok(await w.kv.get(`trialinvite:${PERSON}`)); w.advance(35 * MIN); }
async function queuedPacket(w) { w.set({ 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }); await w.recap(); await packetQueued(w); w.advance(30 * MIN); }
async function registered(w) {
  w.set({ Stage: 'Trial', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }); await w.accounts();
  await w.schedule(); assert.equal(checkins(w).length, 4); await w.confirm(); w.advance(30 * MIN);
}
export const scenarios = [];
const scenario = (id, title, run, options = {}) => scenarios.push({ id, title, run, options });
for (const [id, author, dates] of [['interview-feedback', 'robin', false], ['deep-dive-feedback', 'interviewer', false], ['fast-track-with-dates', 'robin', true]]) {
  scenario(id, `${id}: authorized feedback through documents and check-ins`, async w => {
    await w.step('authorized interview feedback reaches the trial queue', async () => {
      assert.equal(typeof w.m.agent.PEOPLE[author], 'string', 'entry path must use its intended authority');
      const r = await w.feedback({ author: w.m.agent.PEOPLE[author], dates }); assert.equal(r.outcome, 'record_feedback', JSON.stringify(r));
    }); await finishTrial(w, { invite: !dates });
  }, { dates });
}
scenario('recap-to-trial', 'Recap decision, dates reply, documents and check-ins', async w => {
  await w.step('recap reaches the same trial automation', async () => { const r = await w.recap('Interviewer'); assert.ok(!r.error, JSON.stringify(r)); });
  await finishTrial(w);
});
scenario('overlapping-funnels', 'Feedback and recap converge without duplicate emails', async w => {
  await w.step('two entry paths reach one invitation queue', async () => { await w.feedback(); await w.recap('Interviewer'); });
  await finishTrial(w);
});
scenario('unknown-rate-authorized-reply', 'Missing rate waits for an authorized answer', async w => {
  await w.step('unknown rate produces no candidate mail', async () => {
    await w.recap(); await w.invites(); noMail(w);
    const keys = await w.kv.names('trialterms:rateask:'); assert.equal(keys.length, 1);
    const threadTs = keys[0].slice('trialterms:rateask:'.length);
    const args = { db: w.db, notion: w.notion, masonId: w.m.agent.PEOPLE.project, poster: () => w.post, clock: w.clock,
      event: { authorId: w.m.agent.PEOPLE.jamie, channelId: 'DFIXTURE', threadTs, messageTs: `${w.now / 1000}.999999`, text: '$150' },
      sendPacket: ({ candidate, rate }) => w.packets.send({ who: w.m.docs.factsOf(candidate), rate }) };
    assert.equal(await w.m.terms.handleTrialRateReply(args), null);
    args.event.authorId = w.m.agent.PEOPLE.project;
    assert.equal((await w.m.terms.handleTrialRateReply(args)).reason, null);
  }); await finishTrial(w);
}, { rate: null });
scenario('unauthorized-recap', 'Unauthorized recap cannot start trial email', async w => {
  await w.step('recommendation does not become sending authority', async () => {
    assert.equal((await w.recap('Jamie')).skipped, 'not_authorized'); await w.invites(); await w.documents(); noMail(w);
    assert.equal(await w.kv.get(`trialinvite:${PERSON}`), null); assert.equal(await w.kv.get(`emailq:packet:${PERSON}`), null);
  });
});
for (const lane of ['invite', 'packet']) for (const change of ['hold', 'withdrawal', 'pay-concern', 'cancel']) {
  scenario(`${lane}-${change}`, `${change} stops queued ${lane} even after restart`, async w => {
    await w.step('queue the approved work', async () => { await (lane === 'invite' ? queuedInvite(w) : queuedPacket(w)); });
    await w.step('new evidence stops the pending send', async () => {
      if (change === 'cancel') await w.m.queue.cancelWaiting({ db: w.db, pageId: PERSON, clock: w.clock });
      else if (change === 'pay-concern') await w.kv.put(`trialterms:hold:${PERSON}`, { quote: 'Can you clarify the pay?', at: w.now }, w.now);
      else w.set({ Outcome: change === 'hold' ? 'On Hold' : 'Withdrawn or Unavailable' });
      await w.restart(); await w.invites(); await w.documents(); w.advance(60 * MIN); await w.invites(); await w.documents();
      noMail(w); assert.equal(w.envelopes.length, 0);
    });
  });
}
scenario('invite-outage-recovery', 'Mailbox outage waits, then invitation resumes once', async w => {
  await queuedInvite(w);
  await w.step('unavailable Sent mail cannot be treated as empty', async () => { w.fail('gmail.search'); await w.invites(); noMail(w); });
  await w.step('recovery survives restart without duplicate delivery', async () => { w.recover('gmail.search'); await w.restart(); w.advance(10 * MIN); await w.invites(); await w.invites(); assert.equal(w.emails.length, 1); });
});
for (const change of ['cancel', 'hold', 'withdrawal', 'rate']) scenario(`outage-newer-${change}`, `Recovery honors the newer ${change} instead of the old pending decision`, async w => {
  await queuedInvite(w);
  await w.step('outage leaves the original invitation pending', async () => {
    w.fail('gmail.search'); await w.invites(); noMail(w);
    assert.equal((await w.kv.get(`trialinvite:${PERSON}`)).retryAttempts, 1);
  });
  await w.step('a later decision survives restart and stops the stale send', async () => {
    if (change === 'cancel') await w.m.queue.cancelWaiting({ db: w.db, pageId: PERSON, clock: w.clock });
    if (change === 'hold') w.set({ Outcome: 'On Hold' });
    if (change === 'withdrawal') w.set({ Outcome: 'Withdrawn or Unavailable' });
    if (change === 'rate') w.set({ 'Daily Trial Rate': 225 });
    w.recover('gmail.search'); await w.restart(); w.advance(10 * MIN);
    await w.invites(); await w.invites(); noMail(w);
    assert.equal(w.envelopes.length, 0); assert.equal(w.calendarWrites.length, 0);
  });
  if (change === 'rate') await w.step('fresh authorized feedback sends the corrected rate once after a new delay', async () => {
    await w.feedback({ id: 'authorized-rate-correction' }); await w.invites(); noMail(w);
    w.advance(35 * MIN); await w.invites(); await w.restart(); await w.invites();
    assert.equal(w.emails.length, 1); assert.equal(w.emails[0].to, email);
    assert.match(w.emails[0].body, /US\$225 per day/); assert.doesNotMatch(w.emails[0].body, /US\$150/);
  });
});
scenario('uncertain-invite-delivery', 'Unknown email delivery never retries automatically', async w => {
  await queuedInvite(w);
  await w.step('timeout holds delivery across restarts and fresh funnel entry', async () => {
    w.fail('gmail.send', Object.assign(Error('timeout'), { code: 'gmail_timeout', uncertain: true })); await w.invites();
    w.recover('gmail.send'); await w.restart(); w.advance(60 * MIN); await w.feedback({ id: 'second-authority' }); await w.invites();
    noMail(w); assert.equal((await w.kv.get(`trialinvite:${PERSON}`)).deliveryUncertain, true);
  });
});
for (const lane of ['invite', 'packet']) scenario(`${lane}-identity-change`, `Changed recipient holds ${lane} for reconciliation`, async w => {
  await (lane === 'invite' ? queuedInvite(w) : queuedPacket(w));
  await w.step('queued authority does not transfer to a different email address', async () => {
    w.set({ Email: 'other-person@example.invalid' }); await w.invites(); await w.documents(); noMail(w); assert.equal(w.envelopes.length, 0);
  });
});
scenario('invite-rate-change', 'Changed pay cannot send a stale invitation', async w => {
  await queuedInvite(w);
  await w.step('rate correction holds the old offer', async () => { w.set({ 'Daily Trial Rate': 225 }); await w.invites(); noMail(w); });
});
scenario('cancel-during-invite-check', 'Cancellation during Sent-mail read wins over stale worker', async w => {
  await queuedInvite(w);
  await w.step('cancel while a send is being checked', async () => {
    w.hooks.set('gmail.search', () => w.m.queue.cancelWaiting({ db: w.db, pageId: PERSON, clock: w.clock }));
    await w.invites(); noMail(w);
  });
});
scenario('corrected-packet-terms', 'Corrected dates and pay reach the final packet exactly once', async w => {
  await queuedPacket(w);
  await w.step('new terms restart the delay and win over rediscovery', async () => {
    w.set({ 'Daily Trial Rate': 225, 'Trial Start': '2026-10-25', 'Trial End': '2026-10-26' });
    const who = w.m.docs.factsOf(await w.candidate()); await w.packets.send({ who, rate: 225, force: true });
    await w.packets.send({ who, rate: 150 }); await w.documents(); assert.equal(w.envelopes.length, 0);
    w.advance(30 * MIN); await w.restart(); await w.documents(); await w.documents();
    assert.equal(w.envelopes.length, 1); assert.deepEqual(w.envelopes[0].terms, { dailyRate: 225, start: '2026-10-25', end: '2026-10-26', date: '2026-10-23' });
    assert.match(w.emails[0].body, /US\$225/); assert.match(w.emails[0].body, /Sunday, October 25 to Monday, October 26/);
  });
});
scenario('document-validation-block', 'Invalid documents never trigger a documents-sent email', async w => {
  await queuedPacket(w);
  await w.step('validation failure remains held across restart', async () => {
    w.fail('documents.send', Object.assign(Error('synthetic stale name'), { code: 'docusign_document_validation_failed', detail: 'synthetic_identity_mismatch' }));
    await w.documents(); await w.restart(); w.recover('documents.send'); await w.documents(); noMail(w); assert.equal(w.envelopes.length, 0);
    assert.ok((await w.kv.get(`emailq:packet:${PERSON}`)).validationBlocked);
  });
});
for (const issue of ['calendar-outage', 'missing-work-guest', 'declined-interviewer', 'moved-first-meeting', 'changed-trial-dates', 'required-conflict', 'hold']) {
  scenario(`first-${issue}`, `${issue} blocks the first-meeting promise`, async w => {
    await registered(w);
    await w.step('changed evidence cannot produce a misleading confirmation', async () => {
      const first = checkins(w).sort((a, b) => a.start.localeCompare(b.start))[0];
      if (issue === 'calendar-outage') w.fail('calendar.read');
      if (issue === 'missing-work-guest') first.attendees = first.attendees.filter(g => g.email !== workEmail);
      if (issue === 'declined-interviewer') first.attendees.find(g => g.email === 'robin@company.example').responseStatus = 'declined';
      if (issue === 'moved-first-meeting') first.start = '2026-10-24T03:40:00.000Z';
      if (issue === 'changed-trial-dates') w.set({ 'Trial Start': '2026-10-25' });
      if (issue === 'hold') w.set({ Outcome: 'On Hold' });
      if (issue === 'required-conflict') w.calendars.get('robin@company.example').push({ id: 'busy', start: first.start, end: first.end, summary: 'Required meeting' });
      await w.confirm(); await w.restart(); await w.confirm(); noMail(w);
    });
  });
}
scenario('explicit-first-reschedule', 'Authorized reschedule sends one replacement after readback and delay', async w => {
  await registered(w); await w.confirm(); assert.equal(w.emails.length, 1);
  await w.step('explicit new time replaces the prior promise once', async () => {
    const first = checkins(w).sort((a, b) => a.start.localeCompare(b.start))[0];
    await w.kv.put('checkins:askts:fixture', { key: `checkins:${PERSON}`, instId: first.id, start: Date.parse(first.start), end: Date.parse(first.end) }, w.now);
    const args = { db: w.db, calendar: w.calendar, notion: w.notion, gmail: w.gmail, masonId: w.m.agent.PEOPLE.project, poster: () => w.post, clock: w.clock,
      event: { authorId: w.m.agent.PEOPLE.project, threadTs: 'fixture', messageTs: 'reply', text: 'make it 8:40 pm PT' } };
    assert.equal((await w.m.checkins.handleCheckinReply(args)).kind, 'checkin_moved');
    await w.confirm(); assert.equal(w.emails.length, 1); w.advance(30 * MIN); await w.restart(); await w.confirm(); await w.confirm();
    assert.equal(w.emails.length, 2); assert.match(w.emails[1].subject, /^Updated:/);
    assert.match(w.emails[1].body, /changed from Saturday, October 24, 2026 at 9:30 AM/);
    assert.match(w.emails[1].body, /confirmed for Saturday, October 24, 2026 at 9:10 AM/);
    assert.ok(w.calendarWrites.some(x => x.eventId === first.id && x.sendUpdates === 'all'));
  });
});
scenario('two-trials-calendar', 'Two candidates never share a check-in or receive each other’s invitations', async w => {
  await w.step('create two trials with identical dates', async () => {
    w.set({ Stage: 'Trial', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }); await w.accounts();
    w.secondId = '22222222-2222-4333-8444-555555555555';
    const page = structuredClone(w.rest.pages.get(PERSON)); page.id = w.secondId; page.url = `https://www.notion.so/Another-Candidate-${w.secondId.replaceAll('-', '')}`;
    page.properties.Candidate = { type: 'title', title: [{ plain_text: 'Another Candidate' }] };
    page.properties.Email = { type: 'email', email: 'another@example.invalid' }; w.rest.pages.set(w.secondId, page);
    await w.accounts(w.secondId, 'another@company.example'); await w.schedule(); await w.guard();
    const rows = checkins(w).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)); assert.equal(rows.length, 8);
    for (let i = 1; i < rows.length; i++) assert.ok(Date.parse(rows[i].start) - Date.parse(rows[i - 1].end) >= 5 * MIN, 'check-ins overlap or miss the five-minute buffer');
    for (const row of rows) { const guests = row.attendees.map(g => g.email);
      const address = row.summary.startsWith('Another') ? 'another@company.example' : workEmail;
      assert.ok(guests.includes(address)); assert.ok(!guests.includes(address === workEmail ? 'another@company.example' : workEmail));
    }
  });
});
scenario('withdrawal-calendar-cleanup', 'Withdrawal stops mail and removes future trial invitations', async w => {
  await registered(w);
  await w.step('withdrawal reconciles calendar without candidate emails', async () => {
    w.set({ Outcome: 'Withdrawn or Unavailable' }); await w.guard();
    await w.m.trials.clearClosedBanners({ db: w.db, notion: w.notion, calendar: w.calendar, clock: w.clock, force: true });
    await w.confirm(); assert.equal(w.events().filter(e => e.status !== 'cancelled').length, 0); noMail(w);
    assert.ok(w.calendarWrites.filter(e => e.body.status === 'cancelled').every(e => e.sendUpdates === 'none'));
    await w.restart(); const before = w.calendarWrites.length; await w.guard(); assert.equal(w.calendarWrites.length, before);
  });
});

scenario('direct-packet-command', 'Authorized direct document command converges with automatic funnel', async w => {
  await w.step('direct command and later recap share packet receipt', async () => {
    const sender = { envelopesFor: async () => [], sendPacket: async input => {
      w.envelopes.push({ email: input.email, terms: input.addendum?.terms }); return { ok: true, envelopeId: 'direct-envelope' };
    } };
    const args = { event: { authorId: w.m.agent.PEOPLE.project, channelId: 'DFIXTURE', messageTs: 'direct', text: 'send the work trial docs to Synthetic Candidate at $150/day' },
      env: w.env, db: w.db, sender, masonId: w.m.agent.PEOPLE.project, clock: w.clock,
      findCandidate: async () => w.m.docs.factsOf(await w.candidate()), poster: () => w.post,
      afterSend: async input => {
        await w.m.offer.recordPacketOnTracker({ notion: w.notion, ...input, now: w.now });
        return w.m.offer.sendTrialConfirmation({ gmail: w.gmail, notion: w.notion, kv: w.kv, parseTemplate: w.m.review.parseTemplate, ...input, now: w.now });
      } };
    assert.equal(await w.m.docs.handleDocusignSend({ ...args, event: { ...args.event, authorId: w.m.agent.PEOPLE.jamie } }), null);
    assert.equal((await w.m.docs.handleDocusignSend(args)).reason, 'sent');
    await w.restart(); await w.recap(); await w.documents(); await w.invites();
    assert.equal(w.envelopes.length, 1); assert.equal(w.emails.length, 1); assert.equal(w.emails[0].to, email);
  });
}, { dates: true });
for (const change of ['cancel', 'hold', 'pay-concern', 'identity']) scenario(`account-email-${change}`, `${change} prevents sending account credentials to the wrong person`, async w => {
  await w.step('propose the account without sending credentials', async () => {
    w.set({ Stage: 'Trial', Paperwork: 'Signed', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' });
    await w.onboard(); noMail(w); assert.equal(w.createdAccounts.length, 0);
  });
  await w.step('revalidate identity and holds before account creation', async () => {
    if (change === 'cancel') await w.m.queue.cancelWaiting({ db: w.db, pageId: PERSON, clock: w.clock });
    if (change === 'hold') w.set({ Outcome: 'On Hold' });
    if (change === 'pay-concern') await w.kv.put(`trialterms:hold:${PERSON}`, { quote: 'Please clarify compensation', at: w.now }, w.now);
    if (change === 'identity') w.set({ Email: 'other-person@example.invalid' });
    w.advance(30 * MIN); await w.restart(); await w.onboard();
    noMail(w); assert.equal(w.createdAccounts.length, 0);
  });
});
scenario('truncated-calendar-read', 'Incomplete calendar data cannot authorize a new invitation', async w => {
  w.set({ Stage: 'Trial', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' }); await w.accounts();
  await w.step('calendar page limit holds check-in creation', async () => {
    w.calendars.set('robin@company.example', Array.from({ length: 1000 }, (_, i) => ({ id: `busy-${i}`, start: '2026-10-23T01:00:00Z', end: '2026-10-25T01:00:00Z' })));
    await w.schedule(); assert.equal(checkins(w).length, 0); await w.confirm(); noMail(w);
  });
});

scenario('account-recipient-changes-during-template-read', 'Credential delivery rechecks identity after account creation', async w => {
  await w.step('recipient changes while preparing the welcome email', async () => {
    w.set({ Stage: 'Trial', Paperwork: 'Signed', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' });
    await w.onboard(); w.advance(30 * MIN);
    w.hooks.set('notion.template', () => w.set({ Email: 'other-person@example.invalid' }));
    await w.onboard(); assert.equal(w.createdAccounts.length, 1); noMail(w);
    await w.restart(); await w.onboard(); noMail(w);
  });
});

for (const change of ['identity', 'rate', 'hold']) scenario(`invite-${change}-during-check`, `A ${change} correction during Sent-mail verification stops the stale invitation`, async w => {
  await queuedInvite(w);
  await w.step('fresh evidence wins over the earlier candidate snapshot', async () => {
    w.hooks.set('gmail.search', () => w.set(change === 'identity' ? { Email: 'other-person@example.invalid' }
      : change === 'rate' ? { 'Daily Trial Rate': 225 } : { Outcome: 'On Hold' }));
    await w.invites(); noMail(w);
  });
});
scenario('packet-unapproved-rate-change', 'A changed tracker rate cannot silently reuse old packet approval', async w => {
  await queuedPacket(w);
  await w.step('mismatched pay holds documents and confirmation', async () => {
    w.set({ 'Daily Trial Rate': 225 }); await w.documents();
    noMail(w); assert.equal(w.envelopes.length, 0);
  });
});
scenario('cancel-during-packet-check', 'Cancellation during candidate verification wins over the stale packet worker', async w => {
  await queuedPacket(w);
  await w.step('cancel after the queue was read but before dispatch is reserved', async () => {
    w.hooks.set('notion.candidate', () => w.m.queue.cancelWaiting({ db: w.db, pageId: PERSON, clock: w.clock }));
    await w.documents(); noMail(w); assert.equal(w.envelopes.length, 0);
  });
});
scenario('first-recipient-change', 'A queued calendar confirmation cannot transfer to a different recipient', async w => {
  await registered(w);
  await w.step('recipient correction holds the previous confirmation across restart', async () => {
    w.set({ Email: 'other-person@example.invalid' }); await w.restart(); await w.confirm(); noMail(w);
  });
});
scenario('account-credentials-delivered-once', 'Valid account setup sends credentials to the approved recipient once', async w => {
  w.set({ Stage: 'Trial', Paperwork: 'Signed', 'Trial Start': '2026-10-24', 'Trial End': '2026-10-25' });
  await w.step('valid setup waits, then sends to the authorized personal email', async () => {
    await w.onboard(); noMail(w); assert.equal(w.createdAccounts.length, 0);
    w.advance(30 * MIN); await w.onboard();
    assert.equal(w.createdAccounts.length, 1); assert.equal(w.emails.length, 1);
    assert.equal(w.createdAccounts[0].recoveryEmail, email); assert.equal(w.emails[0].to, email);
    assert.ok(w.emails[0].body.includes(w.createdAccounts[0].address));
    assert.ok(w.emails[0].body.includes(w.createdAccounts[0].password));
    await w.restart(); await w.onboard(); assert.equal(w.emails.length, 1); assert.equal(w.createdAccounts.length, 1);
  });
});
