/**
 * LinkedIn through Unipile (outreach.mjs, Project 2026-10-18). LinkedIn has no API for messages or invitations; Unipile runs a
 * LinkedIn account that its owner connected in Unipile's dashboard and exposes it over a REST API (X-API-KEY) with webhooks.
 * This uses: the account list (the LinkedIn account), the profile of a person (provider id, whether already connected),
 * an invitation with a note, a new chat (to a connection; an InMail when the account has Premium/Recruiter/Sales Navigator
 * and UNIPILE_INMAIL=on), a message in a chat, and webhooks for new messages and accepted invitations, signed with a header
 * only Uncle Sam knows.
 *
 * UNIPILE_DSN (e.g. api8.unipile.com:13851) and UNIPILE_API_KEY turn it on; UNIPILE_ACCOUNT_ID picks the account when there
 * is more than one LinkedIn account. Sends that fail without a clear answer are "uncertain" and never retried.
 */
import { timingSafeEqual } from 'node:crypto';
import { noticeStore } from './stuck-rejections.mjs';
import { DEFAULT_PUBLIC_URL } from './wispr.mjs';

export const UNIPILE_WEBHOOK_PATH = '/api/unipile/webhook';
const DSN = /^[a-z0-9.-]+\.unipile\.com(?::\d{2,5})?$/i;
export const unipileConfigured = env => env?.UNCLE_SAM_LINKEDIN !== 'off' && DSN.test(String(env?.UNIPILE_DSN ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
  && /^[A-Za-z0-9._=+/-]{16,200}$/.test(String(env?.UNIPILE_API_KEY ?? '').trim());
const base = env => `https://${String(env.UNIPILE_DSN).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')}/api/v1`;
const clean = (v, n = 300) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };

/** The secret header value Unipile sends back with each webhook (derived from CRON_SECRET; never shown). */
export async function webhookSecret(env) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(env.CRON_SECRET ?? env.SLACK_SIGNING_SECRET ?? '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('uncle-sam:unipile-webhook'))).toString('hex');
}
export async function webhookAuthentic(env, headers) {
  const got = String(headers.get('x-uncle-sam-secret') ?? ''), want = await webhookSecret(env);
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function createUnipileClient({ env, fetchImpl = globalThis.fetch, timeoutMs = 25_000 }) {
  if (!unipileConfigured(env)) fail('unipile_not_configured');
  const call = async (path, { method = 'GET', json = null, form = null, uncertain = false } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${base(env)}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'x-api-key': env.UNIPILE_API_KEY.trim(), accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}) },
        ...(json ? { body: JSON.stringify(json) } : form ? { body: form } : {}) });
    } catch { fail('unipile_network', { uncertain }); }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.status === 404) return { status: 404, data };
    const reason = clean(data?.detail ?? data?.title ?? data?.message ?? data?.type, 200);
    if (response.status === 429) fail('unipile_rate_limited', { uncertain: false, reason });
    if (response.status >= 500) fail(`unipile_http_${response.status}`, { uncertain, reason });
    if (response.status >= 400) fail(`unipile_http_${response.status}`, { reason, type: clean(data?.type, 80) });
    return { status: response.status, data };
  };
  const formOf = fields => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) if (v != null) (Array.isArray(v) ? v : [v]).forEach(x => f.append(k, String(x))); return f; };
  return Object.freeze({
    /** The LinkedIn accounts connected in Unipile: [{ id, name, status, premium }]. */
    async linkedinAccounts() {
      const { data } = await call('/accounts?limit=50');
      return (Array.isArray(data?.items) ? data.items : []).filter(a => String(a?.type ?? '').toUpperCase() === 'LINKEDIN').map(a => ({
        id: String(a.id), name: clean(a.name, 120), status: String((a.sources ?? [])[0]?.status ?? a.status ?? 'OK'),
        premium: JSON.stringify(a.connection_params ?? {}).match(/premium|recruiter|sales_navigator/gi)?.map(s => s.toLowerCase()) ?? [] }));
    },
    /** The account owner's own profile: { providerId, name, publicIdentifier }. */
    async me(accountId) {
      const { data } = await call(`/users/me?account_id=${encodeURIComponent(accountId)}`);
      return { providerId: data?.provider_id ?? null, name: clean(`${data?.first_name ?? ''} ${data?.last_name ?? ''}`, 120), publicIdentifier: data?.public_identifier ?? null,
        premium: !!(data?.premium || data?.is_premium), recruiter: !!data?.recruiter, salesNavigator: !!(data?.sales_navigator ?? data?.salesNavigator) };
    },
    /** A person by public identifier (the /in/<slug>): { providerId, name, headline, connected, pending } or null. */
    async profile(accountId, slug) {
      const { status, data } = await call(`/users/${encodeURIComponent(slug)}?account_id=${encodeURIComponent(accountId)}`);
      if (status === 404 || !data) return null;
      const distance = String(data.network_distance ?? data.networkDistance ?? '').toUpperCase();
      return { providerId: data.provider_id ?? null, name: clean(`${data.first_name ?? ''} ${data.last_name ?? ''}`, 120), headline: clean(data.headline, 300),
        location: clean(data.location, 120), connected: distance === 'FIRST_DEGREE' || distance === 'DISTANCE_1' || data.is_relationship === true,
        pending: data.invitation?.status === 'PENDING' || data.pending_invitation === true, openProfile: data.is_open_profile === true || data.open_profile === true };
    },
    /** A connection request with a short note (LinkedIn caps notes at 300 characters). */
    async invite(accountId, providerId, message) {
      const { data } = await call('/users/invite', { method: 'POST', json: { provider_id: providerId, account_id: accountId, ...(message ? { message: message.slice(0, 300) } : {}) }, uncertain: true });
      return { invitationId: data?.invitation_id ?? data?.id ?? null };
    },
    /** A new chat with one person (a connection; with inmail, anyone). -> { chatId, messageId } */
    async startChat(accountId, providerId, text, { inmail = false, api = 'classic' } = {}) {
      const { data } = await call('/chats', { method: 'POST', uncertain: true,
        form: formOf({ account_id: accountId, attendees_ids: providerId, text, ...(inmail ? { 'linkedin[api]': api, 'linkedin[inmail]': 'true' } : {}) }) });
      return { chatId: data?.chat_id ?? data?.id ?? null, messageId: data?.message_id ?? null };
    },
    async sendMessage(chatId, text) {
      const { data } = await call(`/chats/${encodeURIComponent(chatId)}/messages`, { method: 'POST', uncertain: true, form: formOf({ text }) });
      return { messageId: data?.message_id ?? data?.id ?? null };
    },
    async messages(chatId, limit = 20) {
      const { data } = await call(`/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`);
      return (Array.isArray(data?.items) ? data.items : []).map(m => ({ id: m.id, text: clean(m.text, 4000), fromMe: m.is_sender === 1 || m.is_sender === true, at: Date.parse(m.timestamp) || null }));
    },
    async webhooks() { const { data } = await call('/webhooks?limit=100'); return Array.isArray(data?.items) ? data.items : []; },
    async addWebhook({ source, url, secret, name, accountId }) {
      const { data } = await call('/webhooks', { method: 'POST', json: { request_url: url, name, source, ...(accountId ? { account_ids: [accountId] } : {}), format: 'json',
        headers: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Uncle-Sam-Secret', value: secret }],
        ...(source === 'messaging' ? { events: ['message_received'] } : source === 'users' ? { events: ['new_relation'] } : {}) } });
      return { webhookId: data?.webhook_id ?? data?.id ?? null };
    },
  });
}

/**
 * Once per key: the LinkedIn account, its owner, the two webhooks; Project told once. -> { state, account? }
 * kv linkedin:probe = { ok, key, accountId, owner, ownerProviderId, premium[] }.
 */
export async function probeUnipile({ env, db, fetchImpl = globalThis.fetch, poster = null, clock = Date.now }) {
  if (!unipileConfigured(env) || !db?.prepare) return { state: 'not_configured' };
  const kv = noticeStore(db), now = clock();
  const keyHint = `${String(env.UNIPILE_DSN).trim()}:${env.UNIPILE_API_KEY.trim().length}:${env.UNIPILE_API_KEY.trim().slice(-4)}:${env.UNIPILE_ACCOUNT_ID ?? ''}`;
  const last = await kv.get('linkedin:probe');
  if (last?.ok && last.key === keyHint) return { state: 'ok', account: last };
  if (last && last.key === keyHint && now - last.at < 30 * 60_000) return { state: 'not_due' };
  const told = last?.failedTold === keyHint;
  const failWith = async (code, text) => {
    await kv.put('linkedin:probe', { ok: false, key: keyHint, error: code, at: now, failedTold: keyHint }, now);
    if (!told && poster) await poster(text).catch(() => {});
    return { state: 'failed', error: code };
  };
  try {
    const li = createUnipileClient({ env, fetchImpl });
    const accounts = await li.linkedinAccounts();
    const account = env.UNIPILE_ACCOUNT_ID ? accounts.find(a => a.id === env.UNIPILE_ACCOUNT_ID) : accounts.length === 1 ? accounts[0] : null;
    if (!account) return failWith('unipile_account_unclear', accounts.length
      ? `🚨 Unipile has ${accounts.length} LinkedIn accounts (${accounts.map(a => a.name).join(', ')}), so I don't know which to send from. Tell me which one.`
      : '🚨 The Unipile key works, but no LinkedIn account is connected in Unipile yet. Connect it in the Unipile dashboard (Accounts → LinkedIn).');
    const me = await li.me(account.id);
    const url = `${String(env.UNCLE_SAM_PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, '')}${UNIPILE_WEBHOOK_PATH}`;
    const have = await li.webhooks().catch(() => []);
    const secret = await webhookSecret(env);
    for (const source of ['messaging', 'users']) {
      if (have.some(w => (w.request_url ?? w.url) === url && String(w.source ?? '').toLowerCase() === source)) continue;
      await li.addWebhook({ source, url, secret, name: `Uncle Sam ${source}`, accountId: account.id });
    }
    const premium = [...new Set([...account.premium, ...(me.premium ? ['premium'] : []), ...(me.recruiter ? ['recruiter'] : []), ...(me.salesNavigator ? ['sales_navigator'] : [])])];
    const value = { ok: true, key: keyHint, at: now, accountId: account.id, owner: me.name || account.name, ownerProviderId: me.providerId, premium };
    await kv.put('linkedin:probe', value, now);
    if (poster) await poster(`🔗 LinkedIn is connected through Unipile as ${value.owner}${premium.length ? ` (${premium.join(', ')})` : ''}. When Robin picks profiles, I invite them with a short note, message them once they accept${premium.length && env.UNIPILE_INMAIL === 'on' ? ' (InMail for people who aren\'t connected)' : ''}, answer their replies toward Robin's booking link, and stop at ${Number(env.OUTREACH_DAILY_MAX) || 20} new people a day.`).catch(() => {});
    return { state: 'ok', account: value };
  } catch (error) {
    return failWith(error?.code ?? 'failed', `🚨 Unipile didn't work yet (${error?.code ?? 'failed'}${error?.reason ? `: ${error.reason}` : ''}). Check the DSN and API key in the Unipile dashboard. LinkedIn outreach waits; email outreach still runs.`);
  }
}

export async function linkedinReady({ env, db }) {
  if (!unipileConfigured(env) || !db?.prepare) return null;
  const p = await noticeStore(db).get('linkedin:probe');
  return p?.ok ? p : null;
}

/**
 * A Unipile webhook body -> { kind: 'message' | 'relation' | 'other', ... }. Shapes per Unipile's docs; anything unknown is 'other'.
 */
export function readWebhook(body) {
  const b = body && typeof body === 'object' ? body : {};
  const event = String(b.event ?? b.type ?? '').toLowerCase();
  if (event === 'message_received' || (b.message_id && b.chat_id)) {
    return { kind: 'message', accountId: b.account_id ?? null, chatId: b.chat_id ?? null, messageId: b.message_id ?? null, text: clean(b.message ?? b.text, 4000),
      senderProviderId: b.sender?.attendee_provider_id ?? b.sender?.provider_id ?? null, senderName: clean(b.sender?.attendee_name ?? b.sender?.name, 120),
      senderUrl: b.sender?.attendee_profile_url ?? null, at: Date.parse(b.timestamp) || null };
  }
  if (event === 'new_relation' || b.user_provider_id) {
    return { kind: 'relation', accountId: b.account_id ?? null, providerId: b.user_provider_id ?? null, slug: String(b.user_public_identifier ?? '').toLowerCase() || null,
      name: clean(b.user_full_name, 120), url: b.user_profile_url ?? null };
  }
  return { kind: 'other', event };
}
