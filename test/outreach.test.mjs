import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { enqueueOutreach, runOutreach, handleUnipileEvent, handleOutreachDm, handleOutreachCommand, checkDraft, templateFor, decide, handleInbound } from '../service/lib/outreach.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const PROJECT = 'U0F9EF97D89', DM = 'D0C95KBR09J';
const NOW = Date.parse('2026-10-19T17:00:00Z');
const LINK = 'https://calendly.com/robin-company/intro';
const ENV = { UNIPILE_DSN: 'api8.unipile.com:13851', UNIPILE_API_KEY: 'k'.repeat(40), CRON_SECRET: 'c'.repeat(40), OUTREACH_BOOKING_URL: LINK };
const ACCOUNT = { ok: true, accountId: 'acc_1', owner: 'Project Owner', ownerProviderId: 'ME', premium: [] };
const PRIYA = { slug: 'priya-shah-1a2b', linkedin: 'https://www.linkedin.com/in/priya-shah-1a2b', name: 'Priya Shah', title: 'ML Engineer', company: 'Zepto' };
const notion = (extra = {}) => ({ readControl: async () => ({ mode: 'Live' }), getEmailTemplate: async () => 'Company AI is hiring ML engineers.\nProcess: intro call with Robin, take-home, paid work trial.', findCandidatesByLinkedIn: async () => [], findCandidatesByEmail: async () => [], ...extra });
function fakeLi({ connected = false, failInviteNote = false } = {}) {
  const li = { calls: [], connected };
  Object.assign(li, {
    profile: async (acc, slug) => { li.calls.push(['profile', slug]); return { providerId: `P-${slug}`, name: 'Priya Shah', headline: 'ML at Zepto', connected: li.connected, pending: false }; },
    invite: async (acc, pid, note) => { li.calls.push(['invite', pid, note]); if (failInviteNote && note) throw Object.assign(new Error('x'), { code: 'unipile_http_422' }); return { invitationId: 'inv1' }; },
    startChat: async (acc, pid, text, opts) => { li.calls.push(['chat', pid, text, opts ?? null]); return { chatId: `chat-${pid}`, messageId: 'm1' }; },
    sendMessage: async (chatId, text) => { li.calls.push(['send', chatId, text]); return { messageId: 'm2' }; },
    messages: async () => [],
  });
  return li;
}
async function setup() {
  const db = d1(), kv = noticeStore(db), dms = [];
  await kv.put('linkedin:probe', ACCOUNT, NOW);
  const masonPost = async (text, threadTs) => { dms.push({ text, threadTs }); return threadTs ?? `17924${String(dms.length).padStart(5, '0')}.000100`; };
  return { db, kv, dms, masonPost };
}

test('Queueing: once per person, never someone already on the tracker', async () => {
  const db = d1();
  assert.equal((await enqueueOutreach({ db, person: PRIYA, ctx: { requestedBy: 'Robin' }, channels: { linkedin: true }, clock: () => NOW })).status, 'queued');
  assert.equal((await enqueueOutreach({ db, person: PRIYA, clock: () => NOW })).status, 'already');
  assert.equal((await enqueueOutreach({ db, notion: notion({ findCandidatesByLinkedIn: async () => [{ pageId: 'x' }] }), person: { ...PRIYA, slug: 'other-one' }, clock: () => NOW })).status, 'on_tracker');
  assert.equal((await enqueueOutreach({ db, person: { ...PRIYA, slug: 'third-one' }, channels: {}, clock: () => NOW })).status, 'waiting');
});

test('Not connected yet: an invite with a short note (no link); the accept webhook sends the message with Robin\'s link, once; Project sees it all in one thread', async () => {
  const { db, kv, dms, masonPost } = await setup(), li = fakeLi();
  await enqueueOutreach({ db, person: PRIYA, ctx: { requestedBy: 'Robin' }, clock: () => NOW });
  const out = await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW });
  assert.equal(out.invited, 1);
  const invite = li.calls.find(c => c[0] === 'invite');
  assert.equal(invite[1], 'P-priya-shah-1a2b');
  assert.ok(invite[2].length <= 280 && !/https?:/.test(invite[2]));
  assert.match(dms[0].text, /^📨 Reaching out to <https:\/\/www\.linkedin\.com\/in\/priya-shah-1a2b\|Priya Shah> \(ML Engineer at Zepto\) for Robin: LinkedIn invite with a note sent; the first message goes when they accept\. Robin's link goes once they reply with interest\./);
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW + 60_000 });
  assert.equal(li.calls.filter(c => c[0] === 'invite').length, 1, 'never twice');
  const accepted = { event: 'new_relation', account_id: 'acc_1', user_provider_id: 'P-priya-shah-1a2b', user_public_identifier: 'priya-shah-1a2b', user_full_name: 'Priya Shah' };
  const fetchImpl = async () => { throw new Error('the fake client is not used here'); };
  // handleUnipileEvent builds its own client: give it one through the module's fetch by checking the call shape instead.
  const sent = [];
  const realFetch = async (url, init) => { sent.push([url, init.method]); return Response.json({ chat_id: 'chat-9', message_id: 'm9' }); };
  assert.equal((await handleUnipileEvent({ env: ENV, db, body: accepted, notion: notion(), masonPost, fetchImpl: realFetch, clock: () => NOW + 3600_000 })).reason, 'messaged');
  assert.deepEqual(sent, [['https://api8.unipile.com:13851/api/v1/chats', 'POST']]);
  assert.equal((await kv.get('outreach:p:priya-shah-1a2b')).li.state, 'messaged');
  assert.equal((await handleUnipileEvent({ env: ENV, db, body: accepted, notion: notion(), masonPost, fetchImpl: realFetch, clock: () => NOW + 3700_000 })).reason, 'nothing_to_do');
  assert.equal(dms.at(-1).threadTs, dms[0].threadTs ?? '1792400001.000100');
  void fetchImpl;
});

test('Already connected: one message with the link; free accounts out of notes get the plain invite; the daily cap holds', async () => {
  const { db, masonPost } = await setup(), li = fakeLi({ connected: true });
  await enqueueOutreach({ db, person: PRIYA, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW });
  const chat = li.calls.find(c => c[0] === 'chat');
  assert.ok(!chat[2].includes(LINK), 'the link comes after they reply with interest');
  const s2 = await setup(), li2 = fakeLi({ failInviteNote: true });
  await enqueueOutreach({ db: s2.db, person: PRIYA, clock: () => NOW });
  await runOutreach({ env: ENV, db: s2.db, notion: notion(), li: li2, account: ACCOUNT, masonPost: s2.masonPost, clock: () => NOW });
  assert.deepEqual(li2.calls.filter(c => c[0] === 'invite').map(c => c[2] === null), [false, true]);
  const s3 = await setup(), li3 = fakeLi();
  for (let i = 0; i < 4; i++) await enqueueOutreach({ db: s3.db, person: { ...PRIYA, slug: `p-${i}`, linkedin: `https://www.linkedin.com/in/p-${i}` }, clock: () => NOW });
  await runOutreach({ env: { ...ENV, OUTREACH_DAILY_MAX: '2' }, db: s3.db, notion: notion(), li: li3, account: ACCOUNT, masonPost: s3.masonPost, clock: () => NOW });
  assert.equal(li3.calls.filter(c => c[0] === 'invite').length, 2);
});

test('Replies: answered toward the link from the fact sheet; pay questions and odd drafts go to Project; other people\'s LinkedIn messages are never touched', async () => {
  const { db, kv, dms, masonPost } = await setup(), li = fakeLi({ connected: true });
  await enqueueOutreach({ db, person: PRIYA, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW });
  const answers = [{ action: 'reply', reply: `Happy to. Grab any slot that works here: ${LINK}` }, { action: 'reply', reply: 'The salary is $90k.' }];
  const claude = { async complete() { return { content: [{ type: 'tool_use', name: 'respond', input: answers.shift() }] }; } };
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(url); return Response.json({ message_id: 'mx' }); };
  const msg = (id, text, extra = {}) => ({ event: 'message_received', account_id: 'acc_1', chat_id: 'chat-P-priya-shah-1a2b', message_id: id, message: text, sender: { attendee_provider_id: 'P-priya-shah-1a2b', attendee_name: 'Priya Shah' }, ...extra });
  assert.equal((await handleUnipileEvent({ env: ENV, db, body: msg('r1', 'Sure, what times work?'), claude, notion: notion(), masonPost, fetchImpl, clock: () => NOW + 3600_000 })).reason, 'reply');
  assert.deepEqual(sent, ['https://api8.unipile.com:13851/api/v1/chats/chat-P-priya-shah-1a2b/messages']);
  assert.match(dms.at(-1).text, /^💬 Priya Shah \(linkedin\): “Sure, what times work\?”\nI answered: “Happy to\. Grab any slot/);
  assert.equal((await handleUnipileEvent({ env: ENV, db, body: msg('r1', 'Sure, what times work?'), claude, notion: notion(), masonPost, fetchImpl, clock: () => NOW + 3600_000 })).reason, 'seen');
  assert.equal((await handleUnipileEvent({ env: ENV, db, body: msg('r2', 'What does it pay?'), claude, notion: notion(), masonPost, fetchImpl, clock: () => NOW + 7200_000 })).reason, 'handoff');
  assert.equal(sent.length, 1, 'nothing sent for the pay question');
  assert.match(dms.at(-1).text, /^🚨 Priya Shah needs you \(linkedin\): “What does it pay\?”/);
  assert.ok((await kv.get('outreach:p:priya-shah-1a2b')).handoff);
  assert.equal((await handleUnipileEvent({ env: ENV, db, body: msg('r3', 'hey', { chat_id: 'chat-someone-else', sender: { attendee_provider_id: 'P-stranger' } }), claude, notion: notion(), masonPost, fetchImpl, clock: () => NOW })).reason, 'not_outreach');
  assert.equal((await handleUnipileEvent({ env: ENV, db, body: msg('r4', 'my own message', { sender: { attendee_provider_id: 'ME' } }), claude, notion: notion(), masonPost, fetchImpl, clock: () => NOW })).reason, 'own_message');
});

test('Project in the person\'s thread: say: <text> goes out as written; stop ends it', async () => {
  const { db, kv, dms, masonPost } = await setup(), li = fakeLi({ connected: true });
  await enqueueOutreach({ db, person: PRIYA, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW });
  const thread = (await kv.get('outreach:p:priya-shah-1a2b')).masonTs;
  assert.ok(thread);
  const sent = [], replies = [];
  const fetchImpl = async (url, init) => { sent.push([url, init.body.get('text')]); return Response.json({ message_id: 'mz' }); };
  const say = text => handleOutreachDm({ event: { authorId: PROJECT, channelId: DM, threadTs: thread, messageTs: `1792${Math.floor(Math.random() * 1e6)}.0001`, text }, env: ENV, db, fetchImpl, clock: () => NOW, poster: () => async t => replies.push(t) });
  assert.equal(await say('nice'), null);
  assert.equal((await say('say: Robin is free Thursday too, grab any slot.')).reason, 'said');
  assert.deepEqual(sent, [['https://api8.unipile.com:13851/api/v1/chats/chat-P-priya-shah-1a2b/messages', 'Robin is free Thursday too, grab any slot.']]);
  assert.equal((await say('stop')).reason, 'stopped');
  assert.equal((await kv.get('outreach:p:priya-shah-1a2b')).state, 'done');
  void dms;
});

test('Email, when on: Clay finds the address, one email with the link from Project\'s Gmail, their reply answered in the same thread', async () => {
  const { db, kv, masonPost } = await setup();
  const said = [];
  await handleOutreachCommand({ event: { authorId: PROJECT, channelId: DM, messageTs: '1.1', text: 'outreach email on' }, db, clock: () => NOW, poster: () => async t => said.push(t) });
  assert.match(said[0], /^Roger that 🫡 Email outreach is on/);
  await enqueueOutreach({ db, person: PRIYA, clock: () => NOW });
  const mails = [];
  const gmail = { send: async m => { mails.push(m); return { id: `abc${mails.length}`, threadId: 't1' }; },
    listInbox: async () => (replied ? [{ id: 'def111', from: 'priya@example.test', text: 'Booked for Thursday, thanks' }] : []) };
  let replied = false;
  let ready = false;
  const clay = { startWith: async () => 'run1', results: async () => (ready ? new Map([['p0', { result: { work_email: 'Priya@example.test' } }]]) : null) };
  await runOutreach({ env: ENV, db, notion: notion(), gmail, clay, masonPost, clock: () => NOW });
  ready = true;
  await runOutreach({ env: ENV, db, notion: notion(), gmail, clay, masonPost, clock: () => NOW + 300_000 });
  await runOutreach({ env: ENV, db, notion: notion(), gmail, clay, masonPost, clock: () => NOW + 600_000 });
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'priya@example.test');
  assert.ok(!mails[0].body.includes(LINK) && !/Thanks,\n/.test(mails[0].body), 'no link yet; the Gmail signature does the sign-off');
  const claude = { async complete({ tools }) { return { content: [{ type: 'tool_use', name: tools[0].name, input: tools[0].name === 'respond' ? { action: 'reply', reply: 'Great, see you Thursday.' } : { text: '' } }] }; } };
  replied = true;
  await runOutreach({ env: ENV, db, notion: notion(), gmail, clay, claude, masonPost, clock: () => NOW + 2 * 3600_000 });
  assert.equal(mails.at(-1).replyTo, 'def111');
  assert.equal(mails.at(-1).body, 'Great, see you Thursday.');
  assert.equal((await kv.get('outreach:p:priya-shah-1a2b')).state, 'talking');
});

test('Booked: they appear on the tracker, the person is done and the batch thread hears it', async () => {
  const { db, kv, masonPost } = await setup(), li = fakeLi({ connected: true }), posts = [];
  await enqueueOutreach({ db, person: PRIYA, ctx: { channelId: 'C01D1A69CE3', threadTs: '1792428000.000100' }, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion({ findCandidatesByLinkedIn: async () => [{ pageId: 'pg' }] }), li, account: ACCOUNT, masonPost, clock: () => NOW + 3 * 3600_000,
    channelPost: async (c, t, text) => posts.push([c, t, text]) });
  assert.equal((await kv.get('outreach:p:priya-shah-1a2b')).done, 'booked');
  assert.deepEqual(posts, [['C01D1A69CE3', '1792428000.000100', '📅 Priya Shah booked with Robin.']]);
});

test('Drafts: notes short and link-free; messages carry the link and no other; pay talk never; templates when the model fails', async () => {
  assert.equal(checkDraft('note', 'Hi Priya, would love to connect.', LINK), 'Hi Priya, would love to connect.');
  assert.equal(checkDraft('note', `Hi ${LINK}`, LINK), null);
  // The booking link comes only after they reply with interest (Project, 2026-10-18).
  assert.equal(checkDraft('first', 'Want to chat about the role?', LINK), 'Want to chat about the role?');
  assert.equal(checkDraft('first', `Chat? ${LINK}`, LINK), null, 'no link in a first message');
  assert.equal(checkDraft('first', 'Chat? https://evil.example', LINK), null);
  assert.equal(checkDraft('first', 'The role pays $100/day.', LINK), null);
  // Robin's opener (Project, 2026-10-20, second version): his text, name and company swapped in, a chat with the team on the next two weekdays.
  const SUN = Date.parse('2026-10-18T19:00:00Z'), FRI = Date.parse('2026-10-23T19:00:00Z');
  assert.equal(templateFor('first', { person: { name: 'Ramneet Wells', company: 'Proximal' }, link: LINK, sender: 'Robin', now: SUN }),
    "Hey Ramneet, your background at Proximal caught my eye. I'm Robin, cofounder of Company AI. We build training data and RL environments for frontier AI teams and have grown to an eight-figure revenue run rate.\n\nWe're expanding our research and ML team, and I'd love to learn more about your work and share what we're building. Would you be open to a 30-minute chat with our team sometime this week or next to explore a potential fit?");
  assert.match(templateFor('first', { person: PRIYA, link: LINK, sender: 'Robin K', now: FRI }), /^Hey Priya, your background at Zepto caught my eye\. .* chat with our team sometime this week or next to explore a potential fit\?$/s);
  assert.match(templateFor('first', { person: PRIYA, link: LINK, sender: 'Project Owner', now: SUN }), /I'm Project from Company AI\. .*chat with our team sometime this week or next to explore a potential fit\?$/s);
  assert.match(templateFor('first', { person: { name: 'Sam Lee', title: 'ML Engineer' }, link: LINK, sender: 'Robin', now: SUN }), /your background as an ML Engineer caught my eye/);
  assert.match(templateFor('first_after_note', { person: PRIYA, link: LINK, sender: 'Robin', now: SUN }), /^Thanks for connecting, Priya\. Company AI builds/);
  assert.ok(templateFor('note', { person: { name: 'Ramneet Wells', company: 'A Very Long Company Name Incorporated Worldwide Holdings' }, link: LINK, sender: 'Robin', now: SUN }).length <= 280);
  for (const kind of ['note', 'first', 'first_after_note']) assert.equal(checkDraft(kind === 'note' ? 'note' : 'first', templateFor(kind, { person: PRIYA, link: LINK, sender: 'Robin', now: SUN }), LINK) !== null, true, kind);
  for (const kind of ['first', 'followup', 'email_first', 'email_followup']) assert.doesNotMatch(templateFor(kind, { person: PRIYA, link: LINK, sender: 'Project Owner' }), /https?:/, kind);
  const d = await decide({ claude: null, person: PRIYA, history: [], facts: '', link: LINK, sender: 'Project', channel: 'LinkedIn' });
  assert.equal(d.action, 'handoff');
  void handleInbound;
});

test('Paused or off: nothing goes out', async () => {
  const { db, kv, masonPost } = await setup(), li = fakeLi();
  await enqueueOutreach({ db, person: PRIYA, clock: () => NOW });
  await kv.put('outreach:config', { paused: true }, NOW);
  assert.equal((await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW })).state, 'paused');
  assert.equal((await runOutreach({ env: { ...ENV, UNCLE_SAM_OUTREACH: 'off' }, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW })).state, 'off');
  assert.equal(li.calls.length, 0);
});

test('One LinkedIn follow-up after 4 quiet days, never a second; none after they reply', async () => {
  const { db, masonPost } = await setup(), li = fakeLi({ connected: true });
  await enqueueOutreach({ db, person: PRIYA, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW + 3 * 86400_000 });
  assert.equal(li.calls.filter(c => c[0] === 'send').length, 0);
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW + 4.2 * 86400_000 });
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW + 9 * 86400_000 });
  const sends = li.calls.filter(c => c[0] === 'send');
  assert.equal(sends.length, 1);
  assert.ok(!sends[0][2].includes(LINK));
});

test('Project\'s "reach out to <links>" queues them as his picks; "outreach preview" shows the drafts and sends nothing; LinkedIn invites wait for daytime', async () => {
  const { handleMasonOutreach, inSendWindow } = await import('../service/lib/outreach.mjs');
  const { profilesInText } = await import('../service/lib/sourcing.mjs');
  const { db, masonPost } = await setup(), said = [], queued = [];
  const say = text => handleMasonOutreach({ event: { authorId: PROJECT, channelId: DM, messageTs: '1.1', text }, env: ENV, db, notion: notion(), profilesOf: profilesInText, clock: () => NOW,
    poster: () => async t => said.push(t), enqueue: async (p, ctx) => { queued.push([p.slug, ctx.requestedBy]); return { status: 'queued', note: 'LinkedIn' }; }, account: ACCOUNT });
  assert.equal(await say('reach out to him tomorrow'), null, 'no profile, not this');
  assert.equal((await say('reach out to <https://www.linkedin.com/in/priya-shah-1a2b|Priya Shah> and https://www.linkedin.com/in/arjunrao')).queued, 2);
  assert.deepEqual(queued, [['priya-shah-1a2b', 'Project'], ['arjunrao', 'Project']]);
  assert.equal(said[0], 'Roger that 🫡 Reaching out to Priya Shah, Arjunrao (LinkedIn).');
  assert.equal((await say('outreach preview https://www.linkedin.com/in/priya-shah-1a2b')).kind, 'outreach_preview');
  assert.match(said[1], /^📋 What Priya Shah would get \(nothing sent\):\n\*LinkedIn note:\* Hey Priya, your background caught my eye\. I'm Project from Company AI\./);
  assert.ok(!said[1].includes(LINK));
  assert.equal(inSendWindow(Date.parse('2026-10-19T17:00:00Z')), true, '10 AM PT');
  assert.equal(inSendWindow(Date.parse('2026-10-20T05:00:00Z')), false, '10 PM PT');
  const li = fakeLi();
  await enqueueOutreach({ db, person: PRIYA, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => Date.parse('2026-10-20T05:00:00Z') });
  assert.equal(li.calls.length, 0, 'not at night');
});

test('Interest in a reply puts them on the tracker at Outreach once (India Stage from their LinkedIn); still at Outreach is not booked (Project, 2026-10-18)', async () => {
  const { toOutreachStage } = await import('../service/lib/outreach.mjs');
  const { db } = await setup(), made = [];
  const n = notion({ createCandidate: async a => { made.push(a); return { verified: true, pageId: 'pg1', url: 'https://notion.so/pg1' }; } });
  const p = { ...PRIYA, location: 'Bengaluru, Karnataka, India', email: null };
  const told = [];
  assert.equal((await toOutreachStage({ db, notion: n, p, via: 'linkedin', now: NOW, tell: async t => told.push(t) })).status, 'added');
  assert.deepEqual([made[0].stage, made[0].outcome, made[0].pipeline, made[0].indiaStage, made[0].source, made[0].email], ['Outreach', 'Not Yet Decided', 'India', 'Outreach', 'LinkedIn outbound', null]);
  assert.match(made[0].nextAction, /^Answered Robin's LinkedIn message with interest/);
  assert.match(told[0], /on the tracker at Outreach/);
  assert.equal((await toOutreachStage({ db, notion: n, p, via: 'linkedin', now: NOW })).status, 'already');
  const { db: db2 } = await setup();
  assert.equal((await toOutreachStage({ db: db2, notion: notion({ findCandidatesByLinkedIn: async () => [{ pageId: 'x' }], createCandidate: async () => { throw new Error('no'); } }), p, via: 'linkedin', now: NOW })).status, 'on_tracker');
  // The model's interest flag comes through decide; a close is never interest.
  const model = answer => ({ async complete() { return { content: [{ type: 'tool_use', name: 'respond', input: answer }] }; } });
  assert.equal((await decide({ claude: model({ action: 'reply', reply: `Sure, here it is: ${LINK}`, interested: true }), person: PRIYA, history: [], facts: '', link: LINK, sender: 'Robin', channel: 'LinkedIn' })).interested, true);
  assert.equal((await decide({ claude: model({ action: 'close', reply: 'No worries, all the best.', interested: true }), person: PRIYA, history: [], facts: '', link: LINK, sender: 'Robin', channel: 'LinkedIn' })).interested, false);
});

test('Booked means past Outreach: a record still at Outreach keeps the conversation going', async () => {
  const { db, kv, masonPost } = await setup(), li = fakeLi({ connected: true });
  await enqueueOutreach({ db, person: PRIYA, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion(), li, account: ACCOUNT, masonPost, clock: () => NOW });
  await runOutreach({ env: ENV, db, notion: notion({ findCandidatesByLinkedIn: async () => [{ pageId: 'pg', fields: { Stage: 'Outreach' } }] }), li, account: ACCOUNT, masonPost, clock: () => NOW + 3 * 3600_000 });
  assert.notEqual((await kv.get('outreach:p:priya-shah-1a2b')).done, 'booked');
  await runOutreach({ env: ENV, db, notion: notion({ findCandidatesByLinkedIn: async () => [{ pageId: 'pg', fields: { Stage: 'Intro Call' } }] }), li, account: ACCOUNT, masonPost, clock: () => NOW + 6 * 3600_000 });
  assert.equal((await kv.get('outreach:p:priya-shah-1a2b')).done, 'booked');
});
