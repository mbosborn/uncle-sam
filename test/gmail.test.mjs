import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { takeHomeMime, composeMime, gmailMessageIdOf, gmailFullyConnected, calendarGranted, googleTokenProvider, signatureText, unwrapGoogleRedirects, prepareGmailConnectLink, completeGmailConnection, createGmailSender, gmailConfigured,
  GMAIL_SCOPES, runGmailConnect } from '../service/lib/gmail.mjs';

const KEY = Buffer.alloc(32, 7).toString('base64');
const ENV = { WISPR_TOKEN_KEY: KEY, GMAIL_OAUTH_CLIENT_ID: '123456789-abcdef.apps.googleusercontent.com', GMAIL_OAUTH_CLIENT_SECRET: 'fixture-secret-0123', UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
const URL_ = 'https://company-takehome.vercel.app/c/vth_abc123';
const BODY = `Hi Jane,\n\nWe’d like to move you forward to the next step. Here’s your take-home assessment link (${URL_}).\n\nSign in with this email address.\n\nLet me know if you have any trouble accessing it.`;
const SIG = '<table><tr><td><b>Project Owner</b><br>Strategic Project Associate<br>Company AI</td><td><a href="https://www.google.com/url?q=https://company.example&amp;sa=D">company.example</a><br>project@company.example</td></tr></table>';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_wispr (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a) }) });
  return { prepare };
}
const idToken = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

test('the take-home email: template text exactly, the link clickable in HTML, Project\'s configured signature exactly once', () => {
  const mime = takeHomeMime({ to: 'jane@example.invalid', subject: 'Company AI Take-Home Assessment', body: BODY, url: URL_, signatureHtml: SIG });
  assert.equal(mime.plain, `${BODY}\n\nProject Owner\nStrategic Project Associate\nCompany AI\ncompany.example\nproject@company.example\n`);
  assert.equal(mime.plain.split('Project Owner').length, 2);
  assert.ok(mime.html.includes(`<a href="${URL_}">your take-home assessment link</a>`));
  assert.ok(!mime.html.includes('google.com/url'), 'redirect wrappers stripped');
  assert.equal(mime.html.split('Project Owner').length, 2);
  const raw = Buffer.from(mime.raw, 'base64url').toString();
  assert.match(raw, /^From: Project Owner <project@company\.example>\r\nTo: jane@example\.invalid\r\nSubject: Company AI Take-Home Assessment\r\n/);
  assert.equal(takeHomeMime({ to: 'jane@example.invalid', subject: 'S', body: BODY.replace(URL_, '[Unique candidate Vercel link]'), url: URL_, signatureHtml: SIG }), null);
  assert.equal(takeHomeMime({ to: 'jane@example.invalid', subject: 'S', body: BODY, url: URL_, signatureHtml: '' }), null, 'no signature: not sent');
  const cc = composeMime({ to: 'jane@example.invalid', cc: 'quinn@company.example', subject: 'S', body: 'Hi', signatureHtml: SIG });
  assert.match(Buffer.from(cc.raw, 'base64url').toString(), /\r\nTo: jane@example\.invalid\r\nCc: quinn@company\.example\r\nSubject: S\r\n/);
  assert.equal(composeMime({ to: 'jane@example.invalid', cc: 'x@y.z\r\nBcc: e@v.il', subject: 'S', body: 'Hi', signatureHtml: SIG }), null);
  assert.equal(takeHomeMime({ to: 'a@b.c\r\nBcc: x@y.z', subject: 'S', body: BODY, url: URL_, signatureHtml: SIG }), null);
  assert.equal(signatureText('A&amp;B&nbsp;<br>C'), 'A&B\nC');
  assert.equal(unwrapGoogleRedirects('href="https://www.google.com/url?q=https%3A%2F%2Fx.io&sa=D"'), 'href="https://x.io"');
});

test('connecting: one-use link for Project only, both Gmail scopes required, tokens sealed', async () => {
  assert.equal(gmailConfigured({}), false); assert.equal(gmailConfigured(ENV), true);
  const db = d1(); let now = 1_800_000_000_000;
  const link = await prepareGmailConnectLink({ env: ENV, db, clock: () => now });
  const u = new URL(link.url);
  assert.equal(u.searchParams.get('scope'), ['openid', 'email', ...GMAIL_SCOPES, 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/directory.readonly'].join(' '));
  assert.equal(u.searchParams.get('access_type'), 'offline'); assert.equal(u.searchParams.get('login_hint'), 'project@company.example');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://your-project.example.com/api/google/callback');
  assert.equal((await prepareGmailConnectLink({ env: ENV, db, clock: () => now })).status, 'pending');
  const state = u.searchParams.get('state');
  const reply = claims => async () => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: [...GMAIL_SCOPES, 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/directory.readonly', 'openid'].join(' '), id_token: idToken(claims) });
  await assert.rejects(completeGmailConnection({ env: ENV, db, code: 'c', state, clock: () => now,
    fetchImpl: reply({ email: 'robin@company.example', email_verified: true, aud: ENV.GMAIL_OAUTH_CLIENT_ID }) }), /gmail_wrong_account/);
  await assert.rejects(completeGmailConnection({ env: ENV, db, code: 'c', state, clock: () => now, fetchImpl: reply({}) }), /gmail_link_invalid/, 'single use');
  const again = new URL((await prepareGmailConnectLink({ env: ENV, db, clock: () => now })).url).searchParams.get('state');
  const done = await completeGmailConnection({ env: ENV, db, code: 'c', state: again, clock: () => now,
    fetchImpl: reply({ email: 'Project@company.example', email_verified: true, aud: ENV.GMAIL_OAUTH_CLIENT_ID }) });
  assert.equal(done.account, 'project@company.example');
  const stored = await db.prepare('SELECT value FROM uncle_sam_wispr WHERE name = ?').bind('gmail:tokens').first();
  assert.ok(!stored.value.includes('rt') || !stored.value.includes('"refresh"'), 'sealed');
  assert.equal((await prepareGmailConnectLink({ env: ENV, db, clock: () => now })).status, 'connected');

  // Sending: the signature is read, the message goes once; a 5xx after the send is uncertain, a 4xx before it is not.
  const calls = [];
  let sendStatus = 200;
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes('/settings/sendAs/')) return Response.json({ signature: SIG });
    if (String(url).endsWith('/messages/send')) return sendStatus === 200 ? Response.json({ id: 'abc123def', threadId: 'abc123def', labelIds: ['SENT'] }) : new Response('{}', { status: sendStatus });
    return new Response('{}', { status: 404 });
  };
  const gmail = createGmailSender({ env: ENV, db, fetchImpl, clock: () => now });
  assert.equal(await gmail.connected(), true);
  const sent = await gmail.sendTakeHomeInvite({ to: 'jane@example.invalid', subject: 'Company AI Take-Home Assessment', body: BODY, url: URL_ });
  assert.equal(sent.url, 'https://mail.google.com/mail/?authuser=project@company.example#all/abc123def');
  assert.equal(calls.filter(c => c.endsWith('/messages/send')).length, 1);
  sendStatus = 503;
  await assert.rejects(gmail.sendTakeHomeInvite({ to: 'jane@example.invalid', subject: 'S', body: BODY, url: URL_ }), e => e.code === 'gmail_send_http_503' && e.uncertain === true);
  sendStatus = 400;
  await assert.rejects(gmail.sendTakeHomeInvite({ to: 'jane@example.invalid', subject: 'S', body: BODY, url: URL_ }), e => e.code === 'gmail_send_http_400' && e.uncertain === false);
  // Sent search: each hit carries its subject (so a reply can thread under "Re: <it>") and its thread.
  const searched = [];
  const finder = createGmailSender({ env: ENV, db, clock: () => now, fetchImpl: async url => {
    searched.push(String(url));
    if (/\/messages\?/.test(String(url))) return Response.json({ messages: [{ id: 'f00d01', threadId: 't00d01' }] });
    if (String(url).includes('/messages/f00d01?')) return Response.json({ id: 'f00d01', threadId: 't00d01', internalDate: String(now), payload: { headers: [{ name: 'Subject', value: 'Work trial at Company' }] } });
    return new Response('{}', { status: 404 });
  } });
  const hits = await finder.searchSent('to:jane@example.invalid "work trial" newer_than:60d');
  assert.deepEqual(hits.map(h => [h.id, h.threadId, h.subject]), [['f00d01', 't00d01', 'Work trial at Company']]);
  assert.match(searched[1], /format=metadata&metadataHeaders=Subject/);
  // A revoked grant: forgotten, and the next tick DMs a fresh connect link.
  now += 2 * 3600_000;
  const revoked = createGmailSender({ env: ENV, db, clock: () => now, fetchImpl: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
  await assert.rejects(revoked.sendTakeHomeInvite({ to: 'jane@example.invalid', subject: 'S', body: BODY, url: URL_ }), e => e.code === 'gmail_disconnected' && !e.uncertain);
  const posts = [];
  const tick = await runGmailConnect({ env: ENV, db, notion: { readControl: async () => ({ mode: 'Live' }) }, routeMap: { project: { channelId: 'D0MASON' } },
    poster: async text => posts.push(text), clock: () => now });
  assert.equal(tick.state, 'link_sent');
  assert.match(posts[0], /^📯 Connect your Google account so I can send take-home invites, deep-dive invites and rejections myself.*<https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^|]+\|Connect Google>/);
});

test('a grant without the read box still sends, cannot search, and Project is asked once to add it', async () => {
  const db = d1(); const now = 1_800_000_000_000;
  const state = new URL((await prepareGmailConnectLink({ env: ENV, db, clock: () => now })).url).searchParams.get('state');
  const two = GMAIL_SCOPES.filter(x => !x.endsWith('readonly'));
  await completeGmailConnection({ env: ENV, db, code: 'c', state, clock: () => now,
    fetchImpl: async () => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: two.join(' '), id_token: idToken({ email: 'project@company.example', email_verified: true, aud: ENV.GMAIL_OAUTH_CLIENT_ID }) }) });
  assert.equal(await gmailFullyConnected({ db }), false);
  const gmail = createGmailSender({ env: ENV, db, clock: () => now, fetchImpl: async () => Response.json({}) });
  assert.equal(await gmail.connected(), true); assert.equal(await gmail.canSearch(), false);
  await assert.rejects(gmail.searchSent('to:a@b.c'), /gmail_search_not_granted/);
  const posts = [];
  const tick = await runGmailConnect({ env: ENV, db, notion: { readControl: async () => ({ mode: 'Live' }) }, routeMap: { project: { channelId: 'D0MASON' } }, poster: async t => posts.push(t), clock: () => now });
  assert.equal(tick.state, 'link_sent'); assert.match(posts[0], /^📯 One more box: <https:\/\/accounts\.google\.com[^|]+\|Reconnect Google>\. .*tick every box, including Calendar\. It lets me search your Sent mail .* and see your team's interview calendars/);
  assert.equal((await runGmailConnect({ env: ENV, db, notion: { readControl: async () => ({ mode: 'Live' }) }, routeMap: { project: { channelId: 'D0MASON' } }, poster: async t => posts.push(t), clock: () => now })).state, 'waiting_for_mason');
});

test('the deep-dive invite links "Interviewer’s scheduling link"; a forward carries the original below the signature', () => {
  const link = 'https://calendly.com/interviewer/deep-dive';
  const body = `Hi Jane,\n\nPlease select the times that work for you using Interviewer’s scheduling link: ${link}`;
  const mime = composeMime({ to: 'jane@example.invalid', subject: 'Company — Technical Deep Dive', body, signatureHtml: SIG, links: [{ phrase: `Interviewer’s scheduling link: ${link}`, text: 'Interviewer’s scheduling link', url: link }] });
  assert.ok(mime.html.includes(`using <a href="${link}">Interviewer’s scheduling link</a></p>`));
  assert.match(Buffer.from(mime.raw, 'base64url').toString(), /Subject: =\?UTF-8\?B\?/);
  const fwd = composeMime({ to: 'quinn@company.example', subject: 'Fwd: X', body: 'Hi Interviewer,\n\nForwarding.', signatureHtml: SIG, after: `---------- Forwarded message ---------\n\n${body}` });
  assert.ok(fwd.plain.indexOf('Project Owner') < fwd.plain.indexOf('Forwarded message'));
  assert.equal(fwd.plain.split('Project Owner').length, 2);
});

test('Calendar on the same grant: the reader uses Project\'s token; the probe reports what each calendar shows; nothing without the box', async () => {
  const { createCalendarReader } = await import('../service/lib/google-calendar.mjs');
  const { runCalendarProbe } = await import('../service/lib/calendar-probe.mjs');
  const db = d1(); const now = 1_800_000_000_000;
  assert.equal((await runCalendarProbe({ env: ENV, db, clock: () => now })).state, 'not_granted');
  const state = new URL((await prepareGmailConnectLink({ env: ENV, db, clock: () => now })).url).searchParams.get('state');
  await completeGmailConnection({ env: ENV, db, code: 'c', state, clock: () => now,
    fetchImpl: async () => Response.json({ access_token: 'at-project', refresh_token: 'rt', expires_in: 3600, scope: [...GMAIL_SCOPES, 'https://www.googleapis.com/auth/calendar.readonly'].join(' '),
      id_token: idToken({ email: 'project@company.example', email_verified: true, aud: ENV.GMAIL_OAUTH_CLIENT_ID }) }) });
  assert.equal(await calendarGranted({ db }), true);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.authorization });
    if (String(url).includes('robin%40')) return new Response('{}', { status: 404 });
    return Response.json({ items: [{ id: 'e1', summary: 'Interview · Jane', start: { dateTime: new Date(now - 7200_000).toISOString() }, end: { dateTime: new Date(now - 3600_000).toISOString() },
      attendees: [{ email: 'project@company.example' }, { email: 'jane@example.invalid' }] }] });
  };
  const reader = createCalendarReader({ tokenProvider: googleTokenProvider({ env: ENV, db, fetchImpl, clock: () => now }), fetchImpl, clock: () => now });
  assert.equal((await reader.listEvents({ calendarId: 'project@company.example', timeMin: now - 86400_000, timeMax: now }))[0].attendees.length, 2);
  assert.equal(seen[0].auth, 'Bearer at-project');
  const probe = await runCalendarProbe({ env: { ...ENV, GOOGLE_CALENDAR_IDS: 'project@company.example,robin@company.example' }, db, fetchImpl, clock: () => now });
  assert.deepEqual(probe.calendars, [{ calendarId: 'project@company.example', ok: true, ended: 1, withGuests: 1, titled: 1 }, { calendarId: 'robin@company.example', ok: false, error: 'calendar_http_404' }]);
  assert.equal((await runCalendarProbe({ env: ENV, db, fetchImpl, clock: () => now + 60_000 })).state, 'recent', 'hourly at most');
});

test('threading: Gmail message ids from Uncle Sam\'s and Gmail\'s own links; In-Reply-To in the message', () => {
  assert.equal(gmailMessageIdOf('Sent by Uncle Sam from Project\'s Gmail https://mail.google.com/mail/?authuser=project@company.example#all/18f0a1b2c3d4e5f6; x'), '18f0a1b2c3d4e5f6');
  assert.equal(gmailMessageIdOf('Sent https://mail.google.com/mail/?authuser=project@company.example#all/thread-f:1879150673013281461|msg-f:1879150673013281461'), '1a141594b86492b5');
  assert.equal(gmailMessageIdOf('nothing'), null);
  const mime = composeMime({ to: 'a@b.co', subject: 'Re: X', body: 'Hi', signatureHtml: SIG, inReplyTo: '<abc@mail.gmail.com>' });
  assert.match(Buffer.from(mime.raw, 'base64url').toString(), /\r\nIn-Reply-To: <abc@mail\.gmail\.com>\r\nReferences: <abc@mail\.gmail\.com>\r\nSubject: Re: X/);
});

test('paged inbox transport preserves provider continuation tokens and supports the existing array API', async () => {
  const db = d1(), now = 1_800_000_000_000, seen = [];
  const state = new URL((await prepareGmailConnectLink({ env: ENV, db, clock: () => now })).url).searchParams.get('state');
  await completeGmailConnection({ env: ENV, db, code: 'c', state, clock: () => now,
    fetchImpl: async () => Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: GMAIL_SCOPES.join(' '),
      id_token: idToken({ email: 'project@company.example', email_verified: true, aud: ENV.GMAIL_OAUTH_CLIENT_ID }) }) });
  const gmail = createGmailSender({ env: ENV, db, clock: () => now, fetchImpl: async url => {
    const u = new URL(url); seen.push(u);
    if (u.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'abc123' }], ...(u.searchParams.has('pageToken') ? {} : { nextPageToken: 'opaque+page/2' }) });
    return Response.json({ id: 'abc123', internalDate: String(now - 1000), payload: { headers: [{ name: 'From', value: 'person@example.test' }], mimeType: 'text/plain', body: { data: Buffer.from('hello').toString('base64url') } } });
  } });
  const first = await gmail.listInbox('in:inbox', 25, { paged: true });
  assert.equal(first.nextPageToken, 'opaque+page/2'); assert.equal(first.messages[0].id, 'abc123');
  const last = await gmail.listInbox('in:inbox', 25, { paged: true, pageToken: first.nextPageToken });
  assert.equal(last.nextPageToken, null); assert.equal(seen[2].searchParams.get('pageToken'), first.nextPageToken);
  assert.ok(Array.isArray(await gmail.listInbox('in:inbox')));
});
