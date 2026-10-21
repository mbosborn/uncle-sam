import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { agentFixture } from './agent-fixture.mjs';

export const START = Date.parse('2026-10-23T05:00:00Z'); // Fri 10:30 AM India; trial starts Saturday.
export const PERSON = '11111111-2222-4333-8444-555555555555';
export const TEAM_DOMAIN = 'company.example';
export const INVITE = `Subject: Your Company AI work trial\n\nHi {{first_name}},\n\nCongratulations, we'd like to move you forward with a work trial. Please confirm your available dates. Our rate is {{daily_rate}} per day.`;
export const CONFIRM = `Subject: Your Company AI work trial\n\nHi {{first_name}},\n\nConfirming the details of your work trial.\n\nDates: {{trial_dates}}\nPay: {{daily_rate}} per day\n\nI've sent you {{documents}}. Once they're signed, we'll set up your accounts.\n\nThere will be morning and night check-ins.`;
const clone = x => structuredClone(x);
const safeEmail = email => /^[^\s@]+@(?:company\.example|example\.(?:invalid|test|com))$/.test(email);
export async function loadModules(root) {
  const names = { agent: 'agent-runner', notion: 'notion-client', wake: 'notion-wake', policy: 'policy',
    slack: 'slack-read', dispatch: 'slack-dispatch', ui: 'slack-ui', store: 'store', migrate: 'migrate', adapter: 'libsql-d1',
    notices: 'stuck-rejections', invite: 'trial-invite', queue: 'email-queue', docs: 'docusign-send', offer: 'work-trial-offer',
    review: 'takehome-review', terms: 'trial-terms', trials: 'work-trial', checkins: 'checkins', first: 'first-checkin-confirmation', onboarding: 'onboarding', accountModule: 'accounts' };
  return Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, name]) =>
    [key, await import(pathToFileURL(path.join(root, 'service/lib', `${name}.mjs`)))])));
}

export async function createWorld(root, { dates = false, rate = 150, now = START, claude = null } = {}) {
  const m = await loadModules(root), a = agentFixture(m, START), rest = a.world({ candidateOverrides: {
    Pipeline: a.sel('India'), 'Daily Trial Rate': { type: 'number', number: rate },
    ...(dates ? { 'Trial Start': { type: 'date', date: { start: '2026-10-24' } }, 'Trial End': { type: 'date', date: { start: '2026-10-25' } } } : {}),
  } });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'uncle-sam-replay-'));
  const w = { m, a, rest, dir, now, emails: [], envelopes: [], calendarWrites: [], notes: [], notices: [], inbox: [], timeline: [],
    faults: new Map(), hooks: new Map(), calendars: new Map(), modelCalls: 0, createdAccounts: [], mode: 'Live', restarts: 0 };
  w.clock = () => w.now;
  w.at = iso => { const value = typeof iso === 'number' ? iso : Date.parse(iso); assert.ok(value >= w.now, 'replay clock cannot run backwards'); w.now = value; };
  w.advance = ms => w.at(w.now + ms);
  w.fail = (name, error = Object.assign(Error('simulated outage'), { code: 'fixture_unavailable' })) => w.faults.set(name, error);
  w.recover = name => w.faults.delete(name);
  w.before = async name => {
    const hook = w.hooks.get(name); if (hook) { w.hooks.delete(name); await hook(); }
    if (w.faults.has(name)) throw w.faults.get(name);
  };
  // Test observers run at the simulated provider boundary. They never replace a
  // production guard; generated tests retain violations even if a worker catches one.
  w.observeEffect = () => {};
  w.set = (fields, id = PERSON) => { const props = rest.pages.get(id).properties; for (const [key, value] of Object.entries(fields)) {
    props[key] = key === 'Email' ? { type: 'email', email: value } : key === 'Daily Trial Rate' ? { type: 'number', number: value }
      : /^Trial (Start|End)$/.test(key) ? { type: 'date', date: value ? { start: value } : null } : a.sel(value);
  } };
  w.post = async text => { w.notices.push({ at: w.now, text }); return `${w.now / 1000}.${String(w.notices.length).padStart(6, '0')}`; };
  const own = () => w.calendars.get('project@company.example') ?? [];
  w.calendar = {
    async listEvents({ calendarId, timeMin = 0, timeMax = Infinity, q, maxResults = 1000 }) {
      await w.before('calendar.read'); await w.before(`calendar.read:${calendarId}`);
      return clone((w.calendars.get(calendarId) ?? []).filter(e => Date.parse(e.end) > Number(timeMin) && Date.parse(e.start) < Number(timeMax)
        && (!q || e.summary?.toLowerCase().includes(q.toLowerCase()))).slice(0, maxResults));
    },
    async writeEvent(input) {
      await w.before('calendar.write');
      w.observeEffect('calendar', clone(input));
      assert.ok(['primary', 'project@company.example', 'robin@company.example', 'quinn@company.example', 'taylor@company.example'].includes(input.calendarId));
      for (const guest of input.body.attendees ?? []) assert.ok(safeEmail(guest.email), 'non-synthetic calendar guest');
      w.calendarWrites.push({ at: w.now, ...clone(input) });
      const cal = input.calendarId === 'primary' ? 'project@company.example' : input.calendarId;
      if (input.eventId) {
        let matched = false;
        for (const [owner, events] of w.calendars) for (const e of events) {
          if ((cal === 'project@company.example' || owner === cal) && (e.id === input.eventId || e.recurringEventId === input.eventId)) {
            matched = true;
            for (const [key, value] of Object.entries(input.body)) {
              if (key === 'start' || key === 'end') e[key] = value.dateTime ?? `${value.date}T00:00:00Z`;
              else if (key === 'transparency') e.transparent = value === 'transparent';
              else e[key] = clone(value);
            }
          }
        }
        assert.ok(matched, `unknown calendar event: ${input.eventId}`);
        return { id: input.eventId };
      }
      const body = input.body, id = body.id ?? `series${w.calendarWrites.length}`;
      const rdates = body.recurrence?.find(r => r.startsWith('RDATE:'));
      const parseStamp = s => Date.parse(s.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
      const startAt = Date.parse(body.start.dateTime ?? `${body.start.date}T00:00:00Z`);
      const length = Date.parse(body.end.dateTime ?? `${body.end.date}T00:00:00Z`) - startAt;
      const count = Number(/COUNT=(\d+)/.exec(body.recurrence?.[0] ?? '')?.[1] ?? 1);
      assert.ok(count <= 21, 'fixture recurrence bound');
      if (body.recurrence && !rdates) assert.equal(body.start.timeZone, 'Asia/Kolkata', 'legacy fixture expands only fixed-offset India recurrences');
      const starts = rdates ? [...new Set([startAt, ...rdates.slice(6).split(',').map(parseStamp)])].sort((a,b)=>a-b)
        : Array.from({length:count},(_,i)=>startAt+i*86400_000);
      assert.ok(starts.length <= 21 && starts.every(Number.isFinite), 'fixture explicit recurrence bound');
      for (const [i, occurrence] of starts.entries()) {
        const event = { id: body.recurrence ? `${id}_${i}` : id, ...(body.recurrence ? { recurringEventId: id } : {}),
          originalStart: new Date(occurrence).toISOString(),
          start: new Date(occurrence).toISOString(),
          end: new Date(occurrence + length).toISOString(),
          allDay: !!body.start.date, status: 'confirmed', summary: body.summary, description: body.description,
          transparent: body.transparency === 'transparent', attendees: clone(body.attendees ?? []), organizer: 'project@company.example',
          ...(body.conferenceData ? { meetUrl: 'https://meet.google.com/abc-defg-hij' } : {}) };
        for (const owner of new Set([cal, ...event.attendees.map(g => g.email)])) {
          if (!w.calendars.has(owner)) w.calendars.set(owner, []);
          w.calendars.get(owner).push(clone(event));
        }
      }
      return { id, htmlLink: `https://calendar.google.com/event?eid=${id}` };
    },
  };
  w.events = own;
  w.gmail = {
    connected: async () => true,
    async searchSent(query) {
      await w.before('gmail.search');
      const recipients = [...query.matchAll(/to:([^\s}]+)/g)].map(x => x[1]);
      return clone(w.emails.filter(e => recipients.includes(e.to) && (/first check/.test(query) ? /first.*check-in/.test(e.subject)
        : /move you forward/.test(query) ? /move you forward/.test(e.body) : /work trial/.test(e.subject.toLowerCase()))));
    },
    async send(mail) {
      await w.before('gmail.send'); assert.ok(safeEmail(mail.to), 'non-synthetic email recipient');
      w.observeEffect('email', clone(mail));
      assert.ok(!mail.cc && !mail.bcc, 'unexpected copied recipient');
      if (mail.replyTo) assert.equal(w.emails.find(e => e.id === mail.replyTo)?.to, mail.to, 'reply bound to another candidate');
      const sent = { ...clone(mail), at: w.now, id: (0xabc000 + w.emails.length).toString(16), url: 'https://mail.google.com/fixture' };
      w.emails.push(sent); return clone(sent);
    },
    async listInbox() { await w.before('gmail.inbox'); return clone(w.inbox); },
  };
  w.open = async () => {
    w.client = createClient({ url: `file:${path.join(dir, 'workflow.db')}`, concurrency: 1 });
    await m.migrate.applyMigrations(w.client, m.migrate.loadMigrationFiles(pathToFileURL(path.join(root, 'service/drizzle/'))));
    w.db = m.adapter.createLibsqlD1(w.client);
    w.store = m.store.createStore(w.db, { authorized: true, clock: w.clock }); w.kv = m.notices.noticeStore(w.db);
    w.env = { DB: w.db, UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled', UNCLE_SAM_PACKET_ADDENDUM: 'on',
      NOTION_TOKEN: 'ntn_synthetic_fixture_token', SLACK_BOT_TOKEN: 'xoxb-fixture-only', SLACK_BOT_USER_ID: a.BOT_USER, SLACK_BOT_ID: a.BOT_ID };
    const realNotion = m.notion.createNotionClient({ env: w.env, fetchImpl: rest.fetchImpl, clock: w.clock });
    w.notion = { ...realNotion,
      getCandidate: async id => { await w.before('notion.candidate'); return realNotion.getCandidate(id); },
      getEmailTemplate: async id => { await w.before('notion.template');
        if (id === m.invite.INVITE_TEMPLATE_ID) return INVITE;
        if (id === m.offer.TRIAL_CONFIRM_TEMPLATE_ID) return CONFIRM;
        if (id === m.accountModule.ACCOUNT_TEMPLATE_ID) return 'Subject: Your Company AI accounts\n\nHi [First name],\nStarts [Start day]. Email: [Company email]\nPassword: [Temporary password]\nSlack: [Slack join link]';
        throw Error(`Unscripted template ${id}`); },
      listCandidateNotes: async () => [], appendCandidateNote: async note => { w.notes.push(clone(note)); return { verified: true }; },
      listTrialCandidates: async () => (await Promise.all([...rest.pages.keys()].filter(id => id === PERSON || id === w.secondId).map(id => realNotion.getCandidate(id))))
        .filter(c => !c.archived && c.fields.Stage === 'Trial' && !['Not Selected', 'Withdrawn or Unavailable', 'Hired'].includes(c.fields.Outcome)),
    };
    w.packets = {
      ready: async () => true, onRecord: email => m.docs.packetOnRecord({ db: w.db, email }),
      outElsewhere: async () => ({ docs: null, pay: null }),
      send: args => m.docs.queueWorkTrialPacket({ db: w.db, ...args, clock: w.clock, queue: m.queue.queuePacket, envelopesFor: async () => [] }),
      sendNow: async ({ who, rate }) => m.docs.sendWorkTrialPacket({ env: w.env, db: w.db, clock: w.clock,
        who: await m.docs.withFreshDates({ notion: w.notion, who }), rate,
        sender: { envelopesFor: async () => [], sendPacket: async input => {
          await w.before('documents.send'); const envelopeId = `envelope-${w.envelopes.length + 1}`;
          w.observeEffect('packet', clone(input));
          assert.ok(safeEmail(input.email));
          w.envelopes.push({ at: w.now, envelopeId, email: input.email, name: input.name, terms: clone(input.addendum?.terms ?? null) });
          return { ok: true, envelopeId };
        } },
        afterSend: async args => {
          await m.offer.recordPacketOnTracker({ notion: w.notion, ...args, now: w.now });
          return m.offer.sendTrialConfirmation({ gmail: w.gmail, notion: w.notion, kv: w.kv, parseTemplate: m.review.parseTemplate, ...args, now: w.now });
        },
      }),
    };
    const slackRead = m.slack.createSlackReader({ env: w.env, fetchImpl: rest.fetchImpl });
    const dispatcher = m.dispatch.createSlackDispatcher({ env: w.env, store: w.store, routes: a.routeMap,
      ...m.agent.createDispatcherDeps({ store: w.store, notion: w.notion, slackRead, routeMap: a.routeMap, clock: w.clock }),
      fetchImpl: rest.fetchImpl, clock: w.clock });
    w.runner = m.agent.createAgentRunner({ env: w.env, store: w.store, notion: w.notion, slackRead, dispatcher, routeMap: a.routeMap,
      ui: m.ui.createSlackUi({ env: w.env, fetchImpl: rest.fetchImpl }), gmail: w.gmail, packets: w.packets, clock: w.clock,
      claude: claude ?? { complete: async () => { throw Error('Unscripted model call'); } }, fetchImpl: rest.fetchImpl });
  };
  try { await w.open(); } catch (e) { w.client?.close(); await rm(dir, { recursive: true, force: true }); throw e; }
  // A fake connection receipt, never real credentials or OAuth requests.
  await w.db.prepare('INSERT INTO uncle_sam_wispr (name,value,updated_at) VALUES (?,?,?)').bind('docusign:tokens', '{"fixture":true}', now).run();
  w.restart = async () => { w.client.close(); await w.open(); w.restarts++; };
  // Competing workers use separate connections to the same durable database.
  // Their external adapters still terminate in this synthetic world.
  w.peer = () => {
    const client = createClient({ url: `file:${path.join(dir, 'workflow.db')}`, concurrency: 1 });
    const db = m.adapter.createLibsqlD1(client);
    return { close: () => client.close(),
      invites: () => m.invite.runTrialInvites({ db, notion: w.notion, gmail: w.gmail, parseTemplate: m.review.parseTemplate, poster: w.post, clock: w.clock }),
      documents: () => m.queue.runEmailQueue({ db, notion: w.notion, packets: w.packets, poster: w.post, clock: w.clock }),
      schedule: () => m.trials.runWorkTrials({ env: w.env, db, notion: w.notion, calendar: w.calendar, canWrite: true, poster: w.post, clock: w.clock, force: true }),
      confirm: () => m.first.runFirstCheckinConfirmations({ env: w.env, db, notion: w.notion, calendar: w.calendar, gmail: w.gmail, poster: w.post, clock: w.clock }),
    };
  };
  w.close = async () => { w.client.close(); await rm(dir, { recursive: true, force: true }); };
  w.candidate = (id = PERSON) => w.notion.getCandidate(id);
  w.feedback = async ({ author = m.agent.PEOPLE.robin, dates: givenDates = false, id = 'feedback-1' } = {}) => {
    const requestKey = await a.seedSentPrompt(w, { author, occurrenceId: `interview:${id}` });
    await w.store.recordEvent({ eventId: id, source: 'slack', type: 'feedback_form', occurredAt: w.now, isFixture: false, authorId: author, requestKey,
      form: { decision: 'advance', nextStep: 'work_trial', observations: 'Completed the synthetic assessment.',
        ...(givenDates ? { trialStart: '2026-10-24', trialEnd: '2026-10-25' } : {}), focus: 'Synthetic project', arrangement: 'Remote' } });
    return w.runner.runEvent({ eventId: id, attemptId: `${id}-attempt` });
  };
  w.recap = (by = 'Robin') => w.runner.packetOfferFromRecap({ candidatePageId: PERSON, by, round: 'technical', quote: 'Move forward to a work trial.', at: w.now });
  w.invites = () => m.invite.runTrialInvites({ db: w.db, notion: w.notion, gmail: w.gmail, parseTemplate: m.review.parseTemplate, poster: w.post, clock: w.clock });
  w.documents = () => m.queue.runEmailQueue({ db: w.db, notion: w.notion, packets: w.packets, poster: w.post, clock: w.clock });
  w.schedule = () => m.trials.runWorkTrials({ env: w.env, db: w.db, notion: w.notion, calendar: w.calendar, canWrite: true, poster: w.post, clock: w.clock, force: true });
  w.confirm = () => m.first.runFirstCheckinConfirmations({ env: w.env, db: w.db, notion: w.notion, calendar: w.calendar, gmail: w.gmail, poster: w.post, clock: w.clock });
  w.guard = () => m.checkins.runCheckinGuard({ env: w.env, db: w.db, notion: w.notion, calendar: w.calendar, poster: w.post, clock: w.clock, force: true });
  w.accounts = async (id = PERSON, address = 'synthetic@company.example') => w.kv.put(`onboarding:${id}`, { address, jamieDone: { at: w.now }, aaDone: { at: w.now } }, w.now);
  w.onboard = () => m.onboarding.runOnboarding({ env: w.env, db: w.db, notion: w.notion, routeMap: a.routeMap, clock: w.clock, poster: w.post,
    fetchImpl: (url, init) => url === 'https://slack.com/api/users.list' ? Response.json({ ok: true, members: [] }) : rest.fetchImpl(url, init),
    directory: async () => w.createdAccounts.map(c => c.address),
    addressChecks: { directoryOwners: async () => [], slackMembers: async () => [], mail: async () => 0 },
    accounts: { missing: async () => [], joinUrl: 'https://example-workspace.slack.com/signup', gmail: w.gmail,
      admin: { exists: async address => w.createdAccounts.some(c => c.address === address), create: async input => {
        await w.before('accounts.create'); assert.ok(safeEmail(input.recoveryEmail));
        w.createdAccounts.push(clone(input)); return { primaryEmail: input.address };
      } } },
    onEmailReady: candidate => m.trials.ensureCheckins({ db: w.db, calendar: w.calendar, canWrite: true, candidate, notion: w.notion, clock: w.clock, poster: w.post }),
  });
  w.agreeDates = async () => {
    w.inbox = [{ id: 'proposal', from: 'project@company.example', receivedAt: new Date(w.now - 2000).toISOString(), text: 'How about October 24 to October 25 for your work trial?' },
      { id: 'agreement', from: 'synthetic@example.invalid', receivedAt: new Date(w.now - 1000).toISOString(), text: 'Yes, October 24 to October 25 works for me.' }];
    return m.terms.runTrialTerms({ env: w.env, db: w.db, notion: w.notion, gmail: w.gmail, clock: w.clock, force: true, poster: w.post,
      sendPacket: ({ candidate, rate }) => w.packets.send({ who: m.docs.factsOf(candidate), rate }),
      claude: { complete: async () => { w.modelCalls++; return { content: [{ type: 'tool_use', name: 'terms', input: {
        dates_agreed: true, start: '2026-10-24', end: '2026-10-25', date_quotes: [{ n: 1, quote: w.inbox[0].text }, { n: 2, quote: w.inbox[1].text }], rate_stated: false,
      } }] }; } } });
  };
  w.step = async (label, fn) => {
    const step = { label, at: new Date(w.now).toISOString(), before: { emails: w.emails.length, envelopes: w.envelopes.length, calendarWrites: w.calendarWrites.length } };
    w.timeline.push(step);
    try { await fn(); step.passed = true; } catch (error) { step.passed = false; step.error = error.message; throw error; }
    finally { step.after = { emails: w.emails.length, envelopes: w.envelopes.length, calendarWrites: w.calendarWrites.length }; }
  };
  return w;
}
