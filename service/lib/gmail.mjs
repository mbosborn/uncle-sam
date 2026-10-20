/**
 * Uncle Sam sending the take-home invite itself from Project's Gmail (Project, 2026-10-15: "can you get Uncle Sam to send the
 * email instead of on the hourly run?").
 *
 * Project grants it once with Google sign-in, from a connect link the bot DMs him (like Wispr Flow). Three Gmail scopes:
 * gmail.send, gmail.settings.basic (to read his configured signature, so it appears exactly once) and, since Project's OK of
 * 2026-10-15, gmail.readonly, used only to search his Sent mail for an earlier email to the same address before a rejection
 * or invite goes out (nothing is ever deleted or changed). A grant from before readonly was added still sends; Uncle Sam DMs
 * him a link to add the missing box, and rejections wait for it. Only project@company.example is accepted. The tokens are kept sealed
 * (AES-GCM, WISPR_TOKEN_KEY, the bot's token key) in the same key/value table as Wispr's, under names starting "gmail:".
 * Needs GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET (a Web OAuth client in Google Cloud whose redirect is
 * <public url>/api/google/callback). Without them nothing here runs and the clerk sends, as before.
 *
 * A send is attempted once. A clear refusal before sending (not connected, a revoked grant, a 4xx) leaves the email for the
 * clerk; anything unclear after the request went out (timeout, network, 5xx, an odd answer) is "uncertain" and never retried.
 */
import { seal, unseal, wisprStore, wisprConfigured, DEFAULT_PUBLIC_URL } from './wispr.mjs';

export const GMAIL_OWNER = 'project@company.example';
export const GMAIL_CALLBACK_PATH = '/api/google/callback';
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.settings.basic', 'https://www.googleapis.com/auth/gmail.readonly'];
const READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
/** Read-only Calendar on the same grant (Project, 2026-10-15): Uncle Sam sees the interview calendars Project's account can see. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/** Creating and changing events (Project, 2026-10-15: "Set it so it can create events"), for the work-trial banners on his calendar. */
export const CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
/** Company's company directory, read-only (Project, 2026-10-16): a work-trial hire's new @company.example account, seen the moment it exists (directory.mjs). */
export const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/directory.readonly';
/** Creating Google Workspace users (accounts.mjs, Project 2026-10-16). Asked for only once UNCLE_SAM_ACCOUNT_CREATION=on. */
export const ADMIN_USER_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user';
const BASE_ASKED = [...GMAIL_SCOPES, CALENDAR_SCOPE, CALENDAR_WRITE_SCOPE, DIRECTORY_SCOPE];
/** The scopes Project's sign-in asks for: the admin box only once account creation is switched on. */
export const askedScopes = env => (env?.UNCLE_SAM_ACCOUNT_CREATION === 'on' ? [...BASE_ASKED, ADMIN_USER_SCOPE] : BASE_ASKED);
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const LINK_TTL_MS = 24 * 3600_000;

export class GmailError extends Error {
  constructor(code, { uncertain = false } = {}) { super(code); this.name = 'GmailError'; this.code = code; this.uncertain = uncertain; }
}
const fail = (code, opts) => { throw new GmailError(code, opts); };
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const random = n => crypto.getRandomValues(new Uint8Array(n));

export function gmailConfigured(env = {}) {
  return wisprConfigured(env) && /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(String(env.GMAIL_OAUTH_CLIENT_ID ?? ''))
    && typeof env.GMAIL_OAUTH_CLIENT_SECRET === 'string' && env.GMAIL_OAUTH_CLIENT_SECRET.length >= 10;
}
export const gmailCallbackUrlOf = env => `${String(env.UNCLE_SAM_PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, '')}${GMAIL_CALLBACK_PATH}`;

async function http(fetchImpl, url, init, timeoutMs = 20_000, uncertain = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { redirect: 'error', ...init, signal: controller.signal }); }
  catch (error) { fail(error?.name === 'AbortError' ? 'gmail_timeout' : 'gmail_network_error', { uncertain }); }
  finally { clearTimeout(timer); }
}
async function jsonOf(response, code, uncertain = false) {
  try { const text = await response.text(); if (text.length > 1_000_000) throw new Error('large'); return JSON.parse(text); }
  catch { fail(code, { uncertain }); }
}
const store = db => {
  const kv = wisprStore(db);
  return { get: name => kv.get(`gmail:${name}`), put: (name, value, now) => kv.put(`gmail:${name}`, value, now), del: name => kv.del(`gmail:${name}`) };
};

/** connected | pending (an unexpired link is out) | link (a new link to DM Project). */
export async function prepareGmailConnectLink({ env, db, clock = Date.now }) {
  if (!gmailConfigured(env)) fail('gmail_not_configured');
  const now = clock(), kv = store(db);
  const tokens = await kv.get('tokens');
  const ASKED = askedScopes(env);
  if (tokens && ASKED.every(scope => tokens.scopes?.includes(scope))) return { status: 'connected' };
  const pending = await kv.get('pending');
  // A link out for fewer scopes than asked for now is replaced (a new one is DMed).
  if (pending && pending.expiresAt > now && pending.scopes === ASKED.join(' ')) return { status: 'pending', expiresAt: pending.expiresAt };
  const state = b64u(random(32)), verifier = b64u(random(48));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const expiresAt = now + LINK_TTL_MS;
  await kv.put('pending', { state, verifier: await seal(env, verifier), expiresAt, createdAt: now, scopes: ASKED.join(' ') }, now);
  const url = new URL(AUTH_URL);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: env.GMAIL_OAUTH_CLIENT_ID, redirect_uri: gmailCallbackUrlOf(env),
    scope: ['openid', 'email', ...ASKED].join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
    login_hint: GMAIL_OWNER, hd: 'company.example', state, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(k, v);
  return { status: 'link', url: url.toString(), expiresAt };
}
export async function dropGmailLink({ db }) { await store(db).del('pending'); }
export async function gmailConnected({ db }) { return !!(await store(db).get('tokens')); }
const fullGrant = record => Array.isArray(record?.scopes) && GMAIL_SCOPES.every(scope => record.scopes.includes(scope));
/** Calendar read granted on the same sign-in. */
export async function calendarGranted({ db }) { return !!(await store(db).get('tokens'))?.scopes?.includes(CALENDAR_SCOPE); }
/** Calendar event creation granted on the same sign-in. */
export async function calendarWriteGranted({ db }) { return !!(await store(db).get('tokens'))?.scopes?.includes(CALENDAR_WRITE_SCOPE); }
/** Company's directory (read-only) granted on the same sign-in. */
/** Creating Workspace users granted on the same sign-in. */
export async function adminUserGranted({ db }) { return !!(await store(db).get('tokens'))?.scopes?.includes(ADMIN_USER_SCOPE); }
export async function directoryGranted({ db }) { return !!(await store(db).get('tokens'))?.scopes?.includes(DIRECTORY_SCOPE); }
/** A fresh access token on Project's grant (for the Calendar reader); throws GmailError when not connected. */
export function googleTokenProvider({ env, db, fetchImpl = globalThis.fetch, clock = Date.now }) {
  return () => accessToken({ env, db, fetchImpl, now: clock() });
}
/** Connected with every Gmail scope, including the read-only search of Sent mail. */
export async function gmailFullyConnected({ db }) { return fullGrant(await store(db).get('tokens')); }

function claimsOf(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return null; }
}
const sameText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.equals(y); };

/** The /api/google/callback step: one use, 24 hours, Project's own Google account, at least the send and signature scopes. */
export async function completeGmailConnection({ env, db, fetchImpl = globalThis.fetch, clock = Date.now, code, state }) {
  if (!gmailConfigured(env)) fail('gmail_not_configured');
  const now = clock(), kv = store(db);
  if (typeof code !== 'string' || !code || code.length > 2000 || typeof state !== 'string' || !state || state.length > 200) fail('gmail_callback_invalid');
  const pending = await kv.get('pending');
  if (!pending || !sameText(pending.state, state)) fail('gmail_link_invalid');
  await kv.del('pending'); // single use, whatever happens next
  if (pending.expiresAt <= now) fail('gmail_link_expired');
  const response = await http(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: gmailCallbackUrlOf(env), client_id: env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: env.GMAIL_OAUTH_CLIENT_SECRET, code_verifier: await unseal(env, pending.verifier) }).toString() });
  if (!response.ok) fail(`gmail_token_http_${response.status}`);
  const tokens = await jsonOf(response, 'gmail_token_invalid');
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) fail('gmail_token_invalid');
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) fail('gmail_no_refresh_token');
  const claims = claimsOf(tokens.id_token);
  if (String(claims?.email ?? '').toLowerCase() !== GMAIL_OWNER || claims?.email_verified !== true || claims?.aud !== env.GMAIL_OAUTH_CLIENT_ID) fail('gmail_wrong_account');
  const granted = String(tokens.scope ?? '').split(/\s+/);
  // Sending needs send + settings; the read-only search (rejections) is checked separately and asked for again if missing.
  if (!GMAIL_SCOPES.filter(scope => scope !== READONLY).every(scope => granted.includes(scope))) fail('gmail_scope_missing');
  const saved = { access: tokens.access_token, refresh: tokens.refresh_token, expiresAt: now + 1000 * (Number(tokens.expires_in) > 0 ? Number(tokens.expires_in) : 3600) };
  await kv.put('tokens', { sealed: await seal(env, JSON.stringify(saved)), account: GMAIL_OWNER, connectedAt: now, scopes: askedScopes(env).filter(x => granted.includes(x)) }, now);
  return { account: GMAIL_OWNER, connectedAt: now };
}

async function accessToken({ env, db, fetchImpl, now }) {
  const kv = store(db);
  const record = await kv.get('tokens');
  if (!record) fail('gmail_not_connected');
  const tokens = JSON.parse(await unseal(env, record.sealed));
  if (tokens.expiresAt - 120_000 > now) return tokens.access;
  const response = await http(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: env.GMAIL_OAUTH_CLIENT_ID, client_secret: env.GMAIL_OAUTH_CLIENT_SECRET }).toString() });
  if (response.status === 400 || response.status === 401) {
    const body = await jsonOf(response, 'gmail_refresh_invalid').catch(() => ({}));
    if (body?.error === 'invalid_grant' || response.status === 401) { await kv.del('tokens'); fail('gmail_disconnected'); }
    fail(`gmail_refresh_http_${response.status}`);
  }
  if (!response.ok) fail(`gmail_refresh_http_${response.status}`);
  const fresh = await jsonOf(response, 'gmail_refresh_invalid');
  if (typeof fresh.access_token !== 'string' || !fresh.access_token) fail('gmail_refresh_invalid');
  const next = { ...tokens, access: fresh.access_token, expiresAt: now + 1000 * (Number(fresh.expires_in) > 0 ? Number(fresh.expires_in) : 3600) };
  await kv.put('tokens', { ...record, sealed: await seal(env, JSON.stringify(next)) }, now);
  return next.access;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Google's redirect wrappers (https://www.google.com/url?q=<target>&…) back to the direct address. */
export function unwrapGoogleRedirects(html) {
  return String(html).replace(/https?:\/\/(?:www\.)?google\.com\/url\?q=([^"&\s]+)[^"\s]*/g, (_, target) => { try { return decodeURIComponent(target); } catch { return target; } });
}
/** The signature as plain text: one line per row, cell or break, entities decoded, blank lines dropped. */
export function signatureText(html) {
  return String(html).replace(/<(?:br|\/p|\/div|\/tr|\/td|\/th|\/h[1-6]|\/li)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m))
    .split('\n').map(line => line.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * One email as a MIME message: `body` exactly, then Project's signature once (plain and HTML). Each of `links` turns its exact
 * `phrase` (which must appear once in the body) into a link with `text` in the HTML part. `after` is plain text placed below
 * the signature (a forwarded message). Null when anything is not as expected, so nothing odd is ever sent.
 */
/** Lower-case addresses in a To/Cc header ("A <a@x.com>, b@y.com" -> ["a@x.com", "b@y.com"]). */
export const addressesOf = value => [...String(value ?? '').matchAll(/[^\s<>",;:]+@[^\s<>",;]+\.[^\s<>",;]+/g)].map(m => m[0].toLowerCase()).slice(0, 50);

export function composeMime({ to, cc = null, subject, body, links = [], signatureHtml, after = '', inReplyTo = null }) {
  if (inReplyTo !== null && !/^<[^\s<>\r\n]{3,300}>$/.test(inReplyTo)) return null;
  const address = /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/;
  if (cc !== null && !address.test(cc)) return null;
  if (!address.test(to ?? '') || typeof subject !== 'string' || !subject.trim() || /[\r\n]/.test(subject)) return null;
  if (typeof body !== 'string' || !body.trim() || /\[[^\]]*\]|\{\{/.test(body)) return null;
  for (const link of links) {
    if (typeof link?.phrase !== 'string' || body.split(link.phrase).length !== 2 || !/^https:\/\/[^\s"<>]+$/.test(link.url ?? '') || !link.text) return null;
  }
  const sigHtml = unwrapGoogleRedirects(signatureHtml ?? '').trim(), sigText = signatureText(sigHtml);
  if (!sigText.includes('Project Owner')) return null;
  const tail = String(after ?? '').trim();
  const plain = `${body.trim()}\n\n${sigText}\n${tail ? `\n${tail}\n` : ''}`;
  let paragraphs = body.trim().split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  for (const link of links) paragraphs = paragraphs.replace(escapeHtml(link.phrase), `<a href="${escapeHtml(link.url)}">${escapeHtml(link.text)}</a>`);
  const quoted = tail ? `<br><div class="gmail_quote">${tail.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n')}</div>` : '';
  const html = `<div dir="ltr">${paragraphs}\n<br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${sigHtml}</div>${quoted}</div>`;
  const boundary = `us_${b64u(random(12))}`;
  const encodedSubject = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const part = (type, text) => `--${boundary}\r\nContent-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text).toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n`;
  const mime = `From: Project Owner <${GMAIL_OWNER}>\r\nTo: ${to}\r\n${cc ? `Cc: ${cc}\r\n` : ''}${inReplyTo ? `In-Reply-To: ${inReplyTo}\r\nReferences: ${inReplyTo}\r\n` : ''}Subject: ${encodedSubject}\r\nX-Uncle-Sam: sent\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`
    + part('text/plain', plain) + part('text/html', html) + `--${boundary}--\r\n`;
  return { raw: Buffer.from(mime).toString('base64url'), plain, html };
}

/** The take-home invite: "your take-home assessment link (<url>)" is the link. */
export function takeHomeMime({ to, subject, body, url, signatureHtml }) {
  return composeMime({ to, subject, body, signatureHtml, links: [{ phrase: `your take-home assessment link (${url})`, text: 'your take-home assessment link', url }] });
}

/**
 * The sender the runner uses. send() returns { id, threadId, url }; it throws GmailError with uncertain:true when the email
 * may have gone out, and uncertain:false when it certainly did not.
 */
export function createGmailSender({ env, db, fetchImpl = globalThis.fetch, clock = Date.now }) {
  if (!gmailConfigured(env) || !db) return null;
  const authed = async () => ({ authorization: `Bearer ${await accessToken({ env, db, fetchImpl, now: clock() })}`, accept: 'application/json' });
  const viewUrl = id => `https://mail.google.com/mail/?authuser=${GMAIL_OWNER}#all/${id}`;
  async function send(message) {
    const auth = await authed();
    // A reply in an existing thread: the original's Message-ID (read-only scope) threads it for the candidate too.
    let threadId = null, inReplyTo = null;
    if (message.replyTo) {
      if (!/^[0-9a-f]{6,40}$/.test(message.replyTo)) fail('gmail_reply_target_invalid');
      const original = await http(fetchImpl, `${API}/messages/${message.replyTo}?format=metadata&metadataHeaders=Message-ID`, { headers: auth });
      if (!original.ok) fail(`gmail_reply_target_http_${original.status}`);
      const meta = await jsonOf(original, 'gmail_reply_target_invalid');
      inReplyTo = (meta?.payload?.headers ?? []).find(h => String(h?.name).toLowerCase() === 'message-id')?.value ?? null;
      threadId = /^[0-9a-f]{6,40}$/.test(meta?.threadId ?? '') ? meta.threadId : null;
      if (!inReplyTo || !threadId) fail('gmail_reply_target_invalid');
    }
    const sig = await http(fetchImpl, `${API}/settings/sendAs/${encodeURIComponent(GMAIL_OWNER)}`, { headers: auth });
    if (!sig.ok) fail(`gmail_signature_http_${sig.status}`);
    const { replyTo: _r, ...fields } = message;
    const mime = composeMime({ ...fields, inReplyTo, signatureHtml: (await jsonOf(sig, 'gmail_signature_invalid'))?.signature });
    if (!mime) fail('gmail_message_invalid');
    // From here on the email may have gone out: every unclear failure is uncertain, and nothing is retried.
    const response = await http(fetchImpl, `${API}/messages/send`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: mime.raw, ...(threadId ? { threadId } : {}) }) }, 30_000, true);
    if (response.status >= 400 && response.status < 500) fail(`gmail_send_http_${response.status}`);
    if (!response.ok) fail(`gmail_send_http_${response.status}`, { uncertain: true });
    const sent = await jsonOf(response, 'gmail_send_invalid', true);
    if (typeof sent?.id !== 'string' || !/^[0-9a-f]{6,40}$/.test(sent.id) || !Array.isArray(sent.labelIds) || !sent.labelIds.includes('SENT')) fail('gmail_send_unverified', { uncertain: true });
    const thread = /^[0-9a-f]{6,40}$/.test(sent.threadId ?? '') ? sent.threadId : sent.id;
    return { id: sent.id, threadId: thread, url: viewUrl(sent.id), sentAt: new Date(clock()).toISOString(), plain: mime.plain };
  }
  return Object.freeze({
    connected: () => gmailConnected({ db }),
    canSearch: () => gmailFullyConnected({ db }),
    send,
    sendTakeHomeInvite: ({ to, cc = null, subject, body, url }) =>
      send({ to, cc, subject, body, links: [{ phrase: `your take-home assessment link (${url})`, text: 'your take-home assessment link', url }] }),
    /**
     * Recent messages in Project's inbox matching a Gmail query (newest first, at most `max`, 25 by default): [{ id, threadId,
     * from, fromName, subject, receivedAt, text, url }], `text` being the plain-text body with quoted earlier mail cut off.
     */
    async listInbox(query, max = 25, { pageToken = null, paged = false } = {}) {
      if (typeof query !== 'string' || !query.trim() || query.length > 500) fail('gmail_query_invalid');
      if (!(await gmailFullyConnected({ db }))) fail('gmail_search_not_granted');
      const auth = await authed();
      const list = await http(fetchImpl, `${API}/messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(max, 1), 50)), ...(pageToken ? { pageToken } : {}) })}`, { headers: auth });
      if (!list.ok) fail(`gmail_search_http_${list.status}`);
      const page = await jsonOf(list, 'gmail_search_invalid');
      const out = [];
      for (const m of (page?.messages ?? []).slice(0, max)) {
        if (!/^[0-9a-f]{6,40}$/.test(m?.id ?? '')) continue;
        const one = await http(fetchImpl, `${API}/messages/${m.id}?format=full`, { headers: auth });
        if (!one.ok) fail(`gmail_search_http_${one.status}`);
        const msg = await jsonOf(one, 'gmail_search_invalid');
        const header = name => (msg?.payload?.headers ?? []).find(h => String(h?.name).toLowerCase() === name)?.value ?? '';
        const fromHeader = header('from');
        const address = (/<([^<>\s]+@[^<>\s]+)>/.exec(fromHeader)?.[1] ?? fromHeader.trim()).toLowerCase();
        out.push({ id: m.id, threadId: msg?.threadId ?? m.threadId ?? m.id, from: address, fromName: fromHeader.replace(/<[^>]*>/, '').replace(/"/g, '').trim().slice(0, 120),
          subject: header('subject').slice(0, 300), receivedAt: Number(msg?.internalDate) > 0 ? new Date(Number(msg.internalDate)).toISOString() : null,
          to: addressesOf(header('to')), cc: addressesOf(header('cc')), byUncleSam: /^sent$/i.test(header('x-uncle-sam').trim()),
          text: replyText(plainBody(msg?.payload)), url: viewUrl(m.id) });
      }
      return paged ? { messages: out, nextPageToken: page.nextPageToken ?? null } : out;
    },
    /** Messages in Project's Sent mail matching a Gmail query (newest first, at most 5): [{ id, threadId, subject, sentAt, url }]. */
    async searchSent(query) {
      if (typeof query !== 'string' || !query.trim() || query.length > 500) fail('gmail_query_invalid');
      if (!(await gmailFullyConnected({ db }))) fail('gmail_search_not_granted');
      const auth = await authed();
      const list = await http(fetchImpl, `${API}/messages?${new URLSearchParams({ q: `in:sent ${query}`, maxResults: '5' })}`, { headers: auth });
      if (!list.ok) fail(`gmail_search_http_${list.status}`);
      const found = (await jsonOf(list, 'gmail_search_invalid'))?.messages ?? [];
      const out = [];
      for (const m of found.slice(0, 5)) {
        if (!/^[0-9a-f]{6,40}$/.test(m?.id ?? '')) continue;
        const one = await http(fetchImpl, `${API}/messages/${m.id}?format=metadata&metadataHeaders=Subject`, { headers: auth });
        if (!one.ok) fail(`gmail_search_http_${one.status}`);
        const meta = await jsonOf(one, 'gmail_search_invalid');
        // The subject too, so a reply in that thread can carry "Re: <it>" (Gmail only threads a reply whose subject matches).
        const subject = String((meta?.payload?.headers ?? []).find(h => String(h?.name).toLowerCase() === 'subject')?.value ?? '').slice(0, 300) || null;
        out.push({ id: m.id, threadId: meta?.threadId ?? m.threadId ?? m.id, subject, sentAt: Number(meta?.internalDate) > 0 ? new Date(Number(meta.internalDate)).toISOString() : null, url: viewUrl(m.id) });
      }
      return out;
    },
  });
}

/** The text/plain body of a Gmail message payload (or the HTML part with tags removed when there is no plain part). */
export function plainBody(payload) {
  const parts = [];
  const walk = part => { if (!part) return; parts.push(part); for (const child of part.parts ?? []) walk(child); };
  walk(payload);
  const decode = part => { try { return Buffer.from(String(part?.body?.data ?? ''), 'base64url').toString('utf8'); } catch { return ''; } };
  const plain = parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
  if (plain) return decode(plain);
  const html = parts.find(p => p.mimeType === 'text/html' && p.body?.data);
  return html ? signatureText(decode(html).replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')) : '';
}
/** Just the new part of a reply: everything before the quoted earlier message ("On … wrote:", "> …", a forwarded header). */
export function replyText(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^On .{4,200}wrote:\s*$/.test(line.trim()) || /^-{2,} ?(Original|Forwarded) (Message|message) ?-{2,}/.test(line.trim()) || /^From: .+/.test(line.trim()) && out.length) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

export function gmailConnectMessage(url) {
  return `📯 Connect your Google account so I can send take-home invites, deep-dive invites and rejections myself, on time, and see interviews end: <${url}|Connect Google>. `
    + `Sign in as ${GMAIL_OWNER} and tick every box. I send email, read your signature, search your Sent mail only so nobody gets the same email twice, and read calendars you can see. I never delete or change anything. The link works for 24 hours.`;
}
export function gmailUpgradeMessage(url, missing = []) {
  const calendar = missing.includes(CALENDAR_SCOPE) || missing.includes(CALENDAR_WRITE_SCOPE), read = missing.includes(READONLY), write = missing.includes(CALENDAR_WRITE_SCOPE);
  const why = [read && 'search your Sent mail before a rejection or invite so nobody gets two', missing.includes(CALENDAR_SCOPE) && 'see your team\'s interview calendars (read-only), so I can ask for feedback minutes after a call ends',
    write && 'put confirmed work trials on your calendar as the all-day banner with the team invited, the way you do it now',
    missing.includes(ADMIN_USER_SCOPE) && 'create a work-trial hire\'s Company Google account myself (your account needs a Workspace admin role that can create users)',
    missing.includes(DIRECTORY_SCOPE) && 'see Company\'s company directory (read-only), so I know the moment Jamie has created a work-trial hire\'s @company.example email and can tell AA to set up Okta'].filter(Boolean).join(', and ');
  return `📯 One more box: <${url}|Reconnect Google>. Sign in as ${GMAIL_OWNER} and tick every box${calendar ? ', including Calendar' : ''}. `
    + `It lets me ${why || 'finish setting up'}. Everything else keeps working meanwhile. The link works for 24 hours.`;
}

/**
 * One tick's Gmail setup: when configured but not yet granted, DM Project a connect link (a fresh one once the last expires).
 * Live only, with automatic activity on. Never throws; returns a small state.
 */
export async function runGmailConnect({ env, db, notion, routeMap, poster, clock = Date.now }) {
  try {
    if (!gmailConfigured(env) || env.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !db || !routeMap?.project?.channelId) return { state: 'off' };
    const record = await store(db).get('tokens');
    const missing = askedScopes(env).filter(scope => !record?.scopes?.includes(scope));
    if (record && !missing.length) return { state: 'connected' };
    const upgrade = !!record;
    if ((await notion.readControl())?.mode !== 'Live') return { state: 'not_live' };
    const link = await prepareGmailConnectLink({ env, db, clock });
    if (link.status !== 'link') return { state: 'waiting_for_mason' };
    try { await poster(upgrade ? gmailUpgradeMessage(link.url, missing) : gmailConnectMessage(link.url)); } catch (error) { await dropGmailLink({ db }); throw error; }
    return { state: 'link_sent' };
  } catch (error) { return { state: 'error', error: typeof error?.code === 'string' ? error.code : 'gmail_setup_failed' }; }
}

/** The Gmail API message id behind a Gmail web link: "#all/<hex>" (Uncle Sam's) or "msg-f:<decimal>" (Gmail's own view links). */
export function gmailMessageIdOf(url) {
  const text = String(url ?? '');
  const hex = /#(?:all|sent|inbox)\/([0-9a-f]{10,20})\b/.exec(text)?.[1];
  if (hex) return hex;
  const dec = /msg-f:(\d{10,25})/.exec(text)?.[1];
  try { return dec ? BigInt(dec).toString(16) : null; } catch { return null; }
}
