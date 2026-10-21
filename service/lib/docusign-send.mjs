/**
 * Uncle Sam resending DocuSign envelopes (Project, 2026-10-16: "Give permission so Uncle Sam can send or resend documents").
 *
 * DocuSign's eSignature API with the "Uncle Sam" app (integration key DOCUSIGN_INTEGRATION_KEY, secret DOCUSIGN_SECRET_KEY),
 * acting as Project: he grants it once with DocuSign sign-in from a link the bot DMs him (Authorization Code Grant with PKCE,
 * callback /api/docusign/callback). Tokens are sealed with the bot's token key, like Gmail's.
 *
 * What it does, only when Project asks in his DM ("resend Morgan's DocuSign", "resend the thing to him via docusign"):
 *   - finds the candidate (named in the message, else the one Uncle Sam's last message in that DM was about),
 *   - lists their envelopes still waiting on them, and resends each one DocuSign lets Project resend;
 *   - one DocuSign will not let him resend (another sender's, e.g. Jamie's) is named with its sender, so Project can ask them;
 *   - says who else an envelope is waiting on (a Company countersignature), and when the candidate has already signed.
 * Nothing is voided, corrected or created. A resend is the same envelope sent again; it is never repeated within an hour.
 */
import { seal, unseal, wisprStore } from './wispr.mjs';
import { noticeStore } from './stuck-rejections.mjs';
import { renderAddendum, ANCHORS } from './compensation-addendum.mjs';
import { followUpPromise } from './paperwork-followup.mjs';
import { checkDocumentContent, validateDocumentInputs } from './document-content-check.mjs';
import { checkDocumentFields } from './document-field-check.mjs';
import fieldSchema from './document-schemas/fields.json' with { type: 'json' };

export const DOCUSIGN_CALLBACK_PATH = '/api/docusign/callback';
export const COMPANY_ACCOUNT_ID = 'dcd9d815-f64e-4870-a725-4e81cb766cc0';
/** Jamie's "Work Trial" template: Company_NDA, Company_CIIAA, Company_Terms_of_Service; roles Company (signs first) and Signer. */
export const PACKET_TEMPLATE_ID = '596b3287-75fc-489d-95e1-c595a542f34e';
const packetTemplateOf = env => String(env.DOCUSIGN_PACKET_TEMPLATE_ID || PACKET_TEMPLATE_ID);
/** Who countersigns for Company after the candidate (Project, 2026-10-16: Jamie no longer sends them). */
export const companySignerOf = env => ({ name: clean(env.DOCUSIGN_COMPANY_SIGNER_NAME || 'Project Owner', 120), email: String(env.DOCUSIGN_COMPANY_SIGNER_EMAIL || 'project@company.example').toLowerCase() });
const OWNER = 'project@company.example';
const LINK_TTL_MS = 7 * 86_400_000;
const RESEND_GAP_MS = 3600_000;
const FRESH_MS = 6 * 3600_000;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const agoText = ms => (ms < 3600_000 ? plural(Math.max(1, Math.round(ms / 60_000)), 'minute') : plural(Math.round(ms / 3600_000), 'hour'));
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const random = n => crypto.getRandomValues(new Uint8Array(n));
const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export class DocusignError extends Error {
  constructor(code, detail = null) { super(code); this.name = 'DocusignError'; this.code = code; this.detail = detail; }
}
const fail = (code, detail) => { throw new DocusignError(code, detail); };

export function docusignSendConfigured(env = {}) {
  return /^[0-9a-f-]{36}$/i.test(String(env.DOCUSIGN_INTEGRATION_KEY ?? '')) && typeof env.DOCUSIGN_SECRET_KEY === 'string'
    && env.DOCUSIGN_SECRET_KEY.trim().length >= 20 && typeof env.WISPR_TOKEN_KEY === 'string' && env.UNCLE_SAM_DOCUSIGN_SEND !== 'off';
}
const authHost = env => (env.DOCUSIGN_ENV === 'demo' ? 'account-d.docusign.com' : 'account.docusign.com');
const accountIdOf = env => String(env.DOCUSIGN_ACCOUNT_ID || (env.DOCUSIGN_ENV === 'demo' ? '' : COMPANY_ACCOUNT_ID));
export const docusignCallbackUrlOf = env => `${String(env.UNCLE_SAM_PUBLIC_URL || 'https://your-project.example.com').replace(/\/+$/, '')}${DOCUSIGN_CALLBACK_PATH}`;
const store = db => {
  const kv = wisprStore(db);
  return { get: n => kv.get(`docusign:${n}`), put: (n, v, now) => kv.put(`docusign:${n}`, v, now), del: n => kv.del(`docusign:${n}`) };
};

async function http(fetchImpl, url, init = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { redirect: 'error', ...init, signal: controller.signal }); }
  catch (error) { fail(error?.name === 'AbortError' ? 'docusign_timeout' : 'docusign_network_error'); }
  finally { clearTimeout(timer); }
}
async function jsonOf(response) { try { return JSON.parse(await response.text()); } catch { return {}; } }
const basic = env => `Basic ${Buffer.from(`${env.DOCUSIGN_INTEGRATION_KEY}:${String(env.DOCUSIGN_SECRET_KEY).trim()}`).toString('base64')}`;

/** connected | pending | link (a new one to DM Project). */
export async function prepareDocusignLink({ env, db, clock = Date.now }) {
  if (!docusignSendConfigured(env)) fail('docusign_not_configured');
  const now = clock(), kv = store(db);
  if (await kv.get('tokens')) return { status: 'connected' };
  const out = await kv.get('link');
  if (out && out.expiresAt > now && out.url) return { status: 'pending', url: out.url, expiresAt: out.expiresAt };
  const state = `ds.${b64u(random(32))}`, verifier = b64u(random(48));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL(`https://${authHost(env)}/oauth/auth`);
  for (const [k, v] of Object.entries({ response_type: 'code', scope: 'signature extended', client_id: env.DOCUSIGN_INTEGRATION_KEY,
    redirect_uri: docusignCallbackUrlOf(env), state, login_hint: OWNER, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(k, v);
  const expiresAt = now + LINK_TTL_MS;
  await kv.put('pending', { state, verifier: await seal(env, verifier), expiresAt }, now);
  await kv.put('link', { url: url.toString(), expiresAt }, now);
  return { status: 'link', url: url.toString(), expiresAt };
}

/** The /api/docusign/callback step: one use, Project's own DocuSign login, the Company AI account on it. */
export async function completeDocusignConnection({ env, db, fetchImpl = globalThis.fetch, clock = Date.now, code, state }) {
  if (!docusignSendConfigured(env)) fail('docusign_not_configured');
  const now = clock(), kv = store(db);
  if (typeof code !== 'string' || !code || code.length > 4000 || typeof state !== 'string' || state.length > 200) fail('docusign_callback_invalid');
  const pending = await kv.get('pending');
  if (!pending || pending.state !== state) fail('docusign_link_invalid');
  await kv.del('pending'); await kv.del('link');
  if (pending.expiresAt <= now) fail('docusign_link_expired');
  const response = await http(fetchImpl, `https://${authHost(env)}/oauth/token`, { method: 'POST',
    headers: { authorization: basic(env), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: docusignCallbackUrlOf(env), code_verifier: await unseal(env, pending.verifier) }).toString() });
  if (!response.ok) fail(`docusign_token_http_${response.status}`);
  const got = await jsonOf(response);
  if (typeof got.access_token !== 'string' || typeof got.refresh_token !== 'string') fail('docusign_token_invalid');
  const info = await jsonOf(await http(fetchImpl, `https://${authHost(env)}/oauth/userinfo`, { headers: { authorization: `Bearer ${got.access_token}`, accept: 'application/json' } }));
  if (String(info.email ?? '').toLowerCase() !== OWNER) fail('docusign_wrong_account');
  const wanted = accountIdOf(env);
  const account = (info.accounts ?? []).find(a => (wanted ? a.account_id === wanted : a.is_default));
  if (!account?.base_uri) fail('docusign_account_missing');
  const saved = { access: got.access_token, refresh: got.refresh_token, expiresAt: now + 1000 * (Number(got.expires_in) > 0 ? Number(got.expires_in) : 3600) };
  await kv.put('tokens', { sealed: await seal(env, JSON.stringify(saved)), userId: info.sub, accountId: account.account_id, baseUri: account.base_uri, connectedAt: now }, now);
  return { accountId: account.account_id, connectedAt: now };
}
export async function isDocusignState({ db, state }) { return typeof state === 'string' && state.startsWith('ds.') && (await store(db).get('pending'))?.state === state; }
export async function docusignConnected({ db }) { return !!(await store(db).get('tokens')); }

async function session({ env, db, fetchImpl, now }) {
  const kv = store(db), record = await kv.get('tokens');
  if (!record) fail('docusign_not_connected');
  let t = JSON.parse(await unseal(env, record.sealed));
  if (t.expiresAt - 120_000 <= now) {
    const response = await http(fetchImpl, `https://${authHost(env)}/oauth/token`, { method: 'POST',
      headers: { authorization: basic(env), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh }).toString() });
    if (response.status === 400 || response.status === 401) { await kv.del('tokens'); fail('docusign_disconnected'); }
    if (!response.ok) fail(`docusign_refresh_http_${response.status}`);
    const fresh = await jsonOf(response);
    if (typeof fresh.access_token !== 'string') fail('docusign_refresh_invalid');
    t = { access: fresh.access_token, refresh: fresh.refresh_token || t.refresh, expiresAt: now + 1000 * (Number(fresh.expires_in) > 0 ? Number(fresh.expires_in) : 3600) };
    await kv.put('tokens', { ...record, sealed: await seal(env, JSON.stringify(t)) }, now);
  }
  return { token: t.access, api: `${record.baseUri.replace(/\/+$/, '')}/restapi/v2.1/accounts/${record.accountId}`, userId: record.userId };
}

export function createDocusignSender({ env, db, fetchImpl = globalThis.fetch, clock = Date.now }) {
  const validationStore = noticeStore(db);
  const call = async (path, init = {}) => {
    const s = await session({ env, db, fetchImpl, now: clock() });
    const response = await http(fetchImpl, `${s.api}${path}`, { ...init, headers: { authorization: `Bearer ${s.token}`, accept: 'application/json', 'content-type': 'application/json', ...(init.headers ?? {}) } });
    return { ok: response.ok, status: response.status, body: await jsonOf(response) };
  };
  const readDocument = async (id, documentId) => {
    const s = await session({ env, db, fetchImpl, now: clock() });
    const response = await http(fetchImpl, `${s.api}/envelopes/${id}/documents/${documentId}`,
      { headers: { authorization: `Bearer ${s.token}`, accept: 'application/pdf' } });
    if (!response.ok) fail('docusign_validation_unavailable', `http_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 10_000_000) fail('docusign_document_validation_failed', `document_too_large:${documentId}`);
    return bytes;
  };
  const validateEnvelope = async (id, context) => {
    try {
      if (context.terms && Object.keys(context.terms).some(k => !['dailyRate', 'start', 'end', 'date'].includes(k))) fail('docusign_document_validation_failed', 'unexpected_terms_field');
      validateDocumentInputs({ ...(context.terms ?? {}), candidate: context.candidate, company: context.company });
      if (context.mode === 'addendum' && !context.terms) fail('docusign_document_validation_failed', 'trusted_terms_missing');
      const expectedAddendumBytes = context.terms ? await renderAddendum({
        ...context.terms, name: context.candidate.name, email: context.candidate.email, company: context.company }) : undefined;
      const recipients = await call(`/envelopes/${id}/recipients?include_tabs=true`);
      const inventory = await call(`/envelopes/${id}/documents`);
      if (!recipients.ok || !inventory.ok) fail('docusign_validation_unavailable', `http_${!recipients.ok ? recipients.status : inventory.status}`);
      if (!Array.isArray(inventory.body?.envelopeDocuments)) fail('docusign_document_validation_failed', 'inventory_unreadable');
      if (inventory.body.envelopeDocuments.some(d => !['content', 'summary'].includes(d.type))) fail('docusign_document_validation_failed', 'unknown_document_type');
      const documents = inventory.body.envelopeDocuments.filter(d => d.type === 'content');
      const documentTabs = {};
      for (const doc of documents) {
        if (!/^\d{1,10}$/.test(String(doc.documentId))) fail('docusign_document_validation_failed', 'document_id_invalid');
        const tabs = await call(`/envelopes/${id}/documents/${doc.documentId}/tabs`);
        if (!tabs.ok) fail('docusign_validation_unavailable', `http_${tabs.status}`);
        documentTabs[doc.documentId] = tabs.body;
        doc.bytes = await readDocument(id, doc.documentId);
      }
      const content = await checkDocumentContent({ documents, candidate: context.candidate, envelopeId: id, expectedAddendumBytes, mode: context.mode });
      const fields = checkDocumentFields({ recipients: recipients.body, documents, documentTabs, ...context, expectedAddendumAnchors: content.expectedAddendumAnchors });
      return { ...content, ...fields, context, checkedAt: clock() };
    } catch (error) {
      const detail = error?.detail ?? error?.code ?? 'validation_unavailable';
      const unavailable = error?.code === 'docusign_validation_unavailable' || /(?:timeout|network_error|disconnected|refresh_http_)/.test(error?.code ?? '');
      const retryable = unavailable && /(?:http_(?:408|429|5\d\d)|timeout|network_error)$/.test(detail);
      const attempt = { status: unavailable ? 'unavailable' : 'blocked', envelopeId: id, detail, retryable, checkedAt: clock() };
      await validationStore.put(`docusign:validation-attempt:${id}`, attempt, clock());
      // Approved hashes are immutable evidence. A failed read/check must never erase them.
      const previous = await validationStore.get(`docusign:validation:${id}`);
      if (!previous?.documents) await validationStore.put(`docusign:validation:${id}`, { ...attempt, status: 'blocked', context }, clock());
      const blocked = new DocusignError('docusign_document_validation_failed', detail);
      blocked.retryable = retryable;
      blocked.unavailable = unavailable;
      blocked.envelopeId = id;
      throw blocked;
    }
  };
  const sendValidated = async (id, context) => {
    const receipt = await validateEnvelope(id, context);
    // Durable before the irreversible request: a timeout must never free the
    // candidate claim and let a retry create a second envelope.
    await validationStore.put(`docusign:validation:${id}`, { ...receipt, status: 'send_pending' }, clock());
    const claimKey = `docusign:${context.mode === 'addendum' ? 'addendum' : 'packet'}:${context.candidate.email}`;
    const claim = await validationStore.get(claimKey);
    if (claim) await validationStore.put(claimKey, { ...claim, envelopeId: id, status: 'send_pending' }, clock());
    let sent;
    try { sent = await call(`/envelopes/${id}`, { method: 'PUT', body: JSON.stringify({ status: 'sent' }) }); }
    catch (error) { sent = { ok: false, status: 0, body: { errorCode: error?.code ?? 'network_error' } }; }
    let uncertain = !sent.ok && (sent.status === 0 || sent.status >= 500);
    if (uncertain) {
      const current = await call(`/envelopes/${id}`).catch(() => null);
      if (current?.ok && ['sent', 'delivered', 'completed'].includes(String(current.body.status).toLowerCase())) {
        sent = { ok: true }; uncertain = false;
      }
    }
    const result = { ok: sent.ok, envelopeId: id, ...(sent.ok ? {} : { uncertain, code: String(sent.body?.errorCode ?? `http_${sent.status}`).slice(0, 60) }) };
    // A receipt write failing after send cannot be reported as "nothing sent".
    await validationStore.put(`docusign:validation:${id}`, { ...receipt, status: sent.ok ? 'sent' : uncertain ? 'uncertain' : 'refused' }, clock()).catch(() => {});
    return result;
  };
  return Object.freeze({
    /** Envelopes from the last 90 days that list this email as a signer, with every signer's status and the sender. */
    async envelopesFor(email) {
      const who = String(email ?? '').toLowerCase();
      const from = new Date(clock() - 90 * 86_400_000).toISOString().slice(0, 10);
      const r = await call(`/envelopes?from_date=${from}&search_text=${encodeURIComponent(who)}&include=recipients&count=40`);
      if (!r.ok) fail(`docusign_list_http_${r.status}`, r.body?.errorCode ?? null);
      return (r.body.envelopes ?? []).map(e => ({ id: e.envelopeId, status: String(e.status ?? '').toLowerCase(), subject: clean(e.emailSubject, 160).replace(/^Complete with Docusign:\s*/i, ''),
        sender: { name: clean(e.sender?.userName, 80), email: String(e.sender?.email ?? '').toLowerCase() }, sentAt: e.sentDateTime ?? null,
        signers: (e.recipients?.signers ?? []).map(s => ({ name: clean(s.name, 80), email: String(s.email ?? '').toLowerCase(), status: String(s.status ?? '').toLowerCase(), sentAt: Date.parse(s.sentDateTime ?? '') || null })) }))
        .filter(e => e.signers.some(s => s.email === who));
    },
    /** The same envelope sent again to whoever has not signed. { ok } or { ok: false, code }. */
    /** One document of an envelope as base64 (read-only; for Claude to look at a document Uncle Sam must reproduce). */
    async documentBase64(envelopeId, documentId = '1') {
      if (!/^[0-9a-f-]{36}$/i.test(envelopeId) || !/^[0-9a-z]{1,20}$/i.test(String(documentId))) fail('docusign_document_invalid');
      const s = await session({ env, db, fetchImpl, now: clock() });
      const response = await http(fetchImpl, `${s.api}/envelopes/${envelopeId}/documents/${documentId}`, { headers: { authorization: `Bearer ${s.token}`, accept: 'application/pdf' } });
      if (!response.ok) fail(`docusign_document_http_${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 3_000_000) fail('docusign_document_too_large');
      return bytes.toString('base64');
    },
    /** One envelope: its status, why it was voided, and each signer (status, when sent / signed, why declined). */
    async envelope(envelopeId) {
      if (!/^[0-9a-f-]{36}$/i.test(envelopeId)) fail('docusign_envelope_invalid');
      const r = await call(`/envelopes/${envelopeId}?include=recipients`);
      if (!r.ok) fail(`docusign_envelope_http_${r.status}`, r.body?.errorCode ?? null);
      const e = r.body ?? {};
      return { id: envelopeId, status: String(e.status ?? '').toLowerCase(), voidedReason: clean(e.voidedReason, 200) || null,
        signers: (e.recipients?.signers ?? []).map(s => ({ name: clean(s.name, 80), email: String(s.email ?? '').toLowerCase(), status: String(s.status ?? '').toLowerCase(),
          routingOrder: Number(s.routingOrder) || null, sentAt: Date.parse(s.sentDateTime ?? '') || null, signedAt: Date.parse(s.signedDateTime ?? '') || null,
          declinedReason: clean(s.declinedReason, 200) || null })) };
    },
    /** Whether DocuSign itself sends reminders for this envelope. */
    async reminders(envelopeId) {
      if (!/^[0-9a-f-]{36}$/i.test(envelopeId)) fail('docusign_envelope_invalid');
      const r = await call(`/envelopes/${envelopeId}/notification`);
      if (!r.ok) fail(`docusign_notification_http_${r.status}`);
      return { enabled: String(r.body?.reminders?.reminderEnabled ?? 'false') === 'true', delayDays: Number(r.body?.reminders?.reminderDelay) || null };
    },
    async resend(envelopeId) {
      if (!/^[0-9a-f-]{36}$/i.test(envelopeId)) fail('docusign_envelope_invalid');
      const previous = await validationStore.get(`docusign:validation:${envelopeId}`);
      if (!previous?.context || !['sent', 'passed'].includes(previous.status)) return { ok: false, code: 'docusign_document_validation_failed' };
      try {
        const fresh = await validateEnvelope(envelopeId, previous.context);
        const fingerprint = r => JSON.stringify(r.documents.map(d => ({ id: d.documentId, sha256: d.sha256, pages: d.pages, schema: d.schemaVersion })));
        if (fresh.fieldSha256 !== previous.fieldSha256 || fingerprint(fresh) !== fingerprint(previous)) fail('docusign_document_validation_failed', 'envelope_changed_since_validation');
      } catch (error) {
        if (!error?.retryable) await validationStore.put(`docusign:validation-attempt:${envelopeId}`, { status: 'blocked', detail: error?.detail ?? 'validation_failed', checkedAt: clock() }, clock());
        return error?.retryable ? { ok: false, code: 'docusign_validation_unavailable', retryable: true }
          : { ok: false, code: 'docusign_document_validation_failed' };
      }
      await validationStore.put(`docusign:validation-attempt:${envelopeId}`, { status: 'passed', checkedAt: clock() }, clock());
      const r = await call(`/envelopes/${envelopeId}?resend_envelope=true`, { method: 'PUT', body: '{}' });
      return r.ok ? { ok: true } : { ok: false, code: String(r.body?.errorCode ?? `http_${r.status}`).slice(0, 60) };
    },
    /**
     * The standard work-trial packet (NDA, CIIAA, Terms of Service) from Jamie's "Work Trial" template: the candidate signs
     * everything first, then Company countersigns. The template still names its last recipients, so it is built as a draft, its two
     * signers are set to Company's signer and the candidate, anything else is removed, and it is checked (exactly those two
     * signers, each with signature fields, the three documents) before it is sent. Any doubt: the draft is discarded, nothing sent.
     */
    async sendPacket({ name, email, company, addendum = null }) {
      const who = String(email ?? '').toLowerCase();
      validateDocumentInputs({ ...(addendum?.terms ?? {}), candidate: { name, email: who }, company });
      if (addendum && !addendum.terms) fail('docusign_document_validation_failed', 'trusted_terms_missing');
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(who) || !clean(name, 120)) fail('docusign_recipient_invalid');
      const created = await call('/envelopes', { method: 'POST', body: JSON.stringify({ templateId: packetTemplateOf(env), status: 'created', emailSubject: `Work Trial Docs -- ${clean(name, 100)}` }) });
      const id = created.body?.envelopeId;
      if (!created.ok || !/^[0-9a-f-]{36}$/i.test(id ?? '')) fail('docusign_draft_failed', created.body?.errorCode ?? `http_${created.status}`);
      const discard = async reason => {
        await call('/folders/recyclebin', { method: 'PUT', body: JSON.stringify({ envelopeIds: [id] }) }).catch(() => {});
        fail(reason);
      };
      const list = await call(`/envelopes/${id}/recipients`);
      if (!list.ok) await discard('docusign_recipients_unread');
      const signers = list.body.signers ?? [];
      const keepCompany = signers.find(r => r.roleName === 'Company'), keepSigner = signers.find(r => r.roleName === 'Signer');
      if (!keepCompany || !keepSigner) await discard('docusign_template_roles_missing');
      const extra = {};
      for (const [type, rows] of Object.entries(list.body)) {
        if (!Array.isArray(rows)) continue;
        const drop = rows.filter(r => r.recipientId && r !== keepCompany && r !== keepSigner).map(r => ({ recipientId: r.recipientId }));
        if (drop.length) extra[type] = drop;
      }
      if (Object.keys(extra).length) {
        const removed = await call(`/envelopes/${id}/recipients`, { method: 'DELETE', body: JSON.stringify(extra) });
        if (!removed.ok) await discard('docusign_extra_recipients_left');
      }
      const set = await call(`/envelopes/${id}/recipients`, { method: 'PUT', body: JSON.stringify({ signers: [
        // The candidate signs everything first, Company countersigns after (Project, 2026-10-16: "they should sign everything first").
        { recipientId: keepSigner.recipientId, name: clean(name, 120), email: who, routingOrder: '1' },
        { recipientId: keepCompany.recipientId, name: company.name, email: company.email, routingOrder: '2' }] }) });
      if (!set.ok) await discard('docusign_recipients_not_set');
      // The template's party names are sender prefill tabs, independent of the
      // recipient name. Set only the two pinned NDA party slots; never replace
      // arbitrary text, static wording, or another person's name globally.
      const inventory = await call(`/envelopes/${id}/documents`);
      const ndaDocs = (inventory.body?.envelopeDocuments ?? []).filter(d => d.type === 'content' && /^Company_NDA(?:\.pdf)?$/i.test(d.name));
      if (!inventory.ok || ndaDocs.length !== 1) await discard('docusign_packet_check_failed');
      const ndaId = String(ndaDocs[0].documentId);
      const ndaFields = await call(`/envelopes/${id}/documents/${ndaId}/tabs`);
      const partyFields = ndaFields.body?.prefillTabs?.textTabs ?? [];
      const required = fieldSchema.fields.filter(f => f.kind === 'nda' && f.role === 'prefill');
      if (!ndaFields.ok || partyFields.length !== 2 || required.some(f => partyFields.filter(t =>
        t.tabLabel === f.label && Number(t.pageNumber) === f.page && Number(t.xPosition) === f.x
        && Number(t.yPosition) === f.y && t.tabId).length !== 1)) {
        const blocked = new DocusignError('docusign_document_validation_failed', 'nda_party_field_schema_changed');
        blocked.envelopeId = id; throw blocked;
      }
      const filled = await call(`/envelopes/${id}/documents/${ndaId}/tabs`, { method: 'PUT', body: JSON.stringify({
        prefillTabs: { textTabs: partyFields.map(t => ({ ...t, value: name, originalValue: name, locked: 'true' })) } }) });
      if (!filled.ok) {
        const blocked = new DocusignError('docusign_document_validation_failed', 'nda_party_fields_not_populated');
        blocked.envelopeId = id; throw blocked;
      }
      // The 4th document: their compensation addendum (compensation-addendum.mjs), signing places found by its anchor words.
      if (addendum) {
        const added = await call(`/envelopes/${id}/documents`, { method: 'PUT', body: JSON.stringify({ documents: [{ documentId: '4', name: `Work Trial Compensation Addendum - ${clean(name, 80)}.pdf`, fileExtension: 'pdf', documentBase64: addendum.pdfBase64 }] }) });
        if (!added.ok) await discard('docusign_addendum_not_added');
        const at = a => ({ anchorString: a, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-4', anchorIgnoreIfNotPresent: 'false', anchorMatchWholeWord: 'true' });
        const forSigner = await call(`/envelopes/${id}/recipients/${keepSigner.recipientId}/tabs`, { method: 'POST', body: JSON.stringify({
          signHereTabs: [at(ANCHORS.candidateSign)], dateSignedTabs: [at(ANCHORS.candidateDate)] }) });
        const forCompany = await call(`/envelopes/${id}/recipients/${keepCompany.recipientId}/tabs`, { method: 'POST', body: JSON.stringify({
          signHereTabs: [at(ANCHORS.companySign)], dateSignedTabs: [at(ANCHORS.companyDate)], titleTabs: [{ ...at(ANCHORS.companyTitle), required: 'true' }] }) });
        if (!forSigner.ok || !forCompany.ok) await discard('docusign_addendum_tabs_failed');
      }
      // Uncle Sam sends the one reminder, timed to the trial start (paperwork-followup.mjs); DocuSign's own would double it.
      // Expiry is kept as the account has it. Not fatal: with DocuSign's reminders left on, Uncle Sam sends none of its own.
      const note = await call(`/envelopes/${id}/notification`).catch(() => null);
      if (note?.ok) await call(`/envelopes/${id}/notification`, { method: 'PUT', body: JSON.stringify({ useAccountDefaults: 'false',
        reminders: { reminderEnabled: 'false', reminderDelay: '0', reminderFrequency: '0' }, expirations: note.body?.expirations ?? { expireEnabled: 'true', expireAfter: '120', expireWarn: '0' } }) }).catch(() => null);
      const check = await call(`/envelopes/${id}/recipients?include_tabs=true`);
      const docs = await call(`/envelopes/${id}/documents`);
      const people = Object.entries(check.body ?? {}).filter(([, v]) => Array.isArray(v)).flatMap(([, v]) => v);
      const names = (docs.body?.envelopeDocuments ?? []).filter(d => d.type === 'content').map(d => String(d.name).toLowerCase());
      const ok = check.ok && people.length === 2
        && people.some(r => r.roleName === 'Company' && String(r.email).toLowerCase() === company.email && String(r.routingOrder) === '2' && (r.tabs?.signHereTabs ?? []).length)
        && people.some(r => r.roleName === 'Signer' && String(r.email).toLowerCase() === who && String(r.routingOrder) === '1' && (r.tabs?.signHereTabs ?? []).length)
        && names.length === (addendum ? 4 : 3) && ['nda', 'ciiaa', 'terms', ...(addendum ? ['compensation'] : [])].every(k => names.some(n => n.includes(k)))
        && (!addendum || ['Signer', 'Company'].every(role => people.some(r => r.roleName === role && (r.tabs?.signHereTabs ?? []).some(tab => String(tab.documentId) === '4'))));
      if (!ok) await discard('docusign_packet_check_failed');
      return sendValidated(id, { candidate: { name, email: who }, company, mode: 'packet', terms: addendum?.terms ?? null });
    },
    /**
     * The compensation addendum on its own (Project, 2026-10-16, for Arlen Archer: "he only needs 3 documents but add him the
     * 4th document with the $100 per day"): for someone whose NDA, CIIAA and Terms of Service already went out (Jamie's
     * envelope). One document, the candidate signs first, Company countersigns; built as a draft, checked, then sent.
     */
    async sendAddendum({ name, email, company, pdfBase64, terms }) {
      const who = String(email ?? '').toLowerCase();
      validateDocumentInputs({ ...(terms ?? {}), candidate: { name, email: who }, company });
      if (!terms) fail('docusign_document_validation_failed', 'trusted_terms_missing');
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(who) || !clean(name, 120) || typeof pdfBase64 !== 'string' || !pdfBase64) fail('docusign_recipient_invalid');
      const at = a => ({ anchorString: a, anchorUnits: 'pixels', anchorXOffset: '0', anchorYOffset: '-4', anchorIgnoreIfNotPresent: 'false', anchorMatchWholeWord: 'true' });
      const created = await call('/envelopes', { method: 'POST', body: JSON.stringify({ status: 'created', emailSubject: `Work Trial Compensation Addendum -- ${clean(name, 100)}`,
        documents: [{ documentId: '1', name: `Work Trial Compensation Addendum - ${clean(name, 80)}.pdf`, fileExtension: 'pdf', documentBase64: pdfBase64 }],
        recipients: { signers: [
          { recipientId: '1', roleName: 'Signer', name: clean(name, 120), email: who, routingOrder: '1', tabs: { signHereTabs: [at(ANCHORS.candidateSign)], dateSignedTabs: [at(ANCHORS.candidateDate)] } },
          { recipientId: '2', roleName: 'Company', name: company.name, email: company.email, routingOrder: '2',
            tabs: { signHereTabs: [at(ANCHORS.companySign)], dateSignedTabs: [at(ANCHORS.companyDate)], titleTabs: [{ ...at(ANCHORS.companyTitle), required: 'true' }] } }] } }) });
      const id = created.body?.envelopeId;
      if (!created.ok || !/^[0-9a-f-]{36}$/i.test(id ?? '')) fail('docusign_draft_failed', created.body?.errorCode ?? `http_${created.status}`);
      const discard = async reason => { await call('/folders/recyclebin', { method: 'PUT', body: JSON.stringify({ envelopeIds: [id] }) }).catch(() => {}); fail(reason); };
      const note = await call(`/envelopes/${id}/notification`).catch(() => null);
      if (note?.ok) await call(`/envelopes/${id}/notification`, { method: 'PUT', body: JSON.stringify({ useAccountDefaults: 'false',
        reminders: { reminderEnabled: 'false', reminderDelay: '0', reminderFrequency: '0' }, expirations: note.body?.expirations ?? { expireEnabled: 'true', expireAfter: '120', expireWarn: '0' } }) }).catch(() => null);
      const check = await call(`/envelopes/${id}/recipients?include_tabs=true`);
      const people = Object.entries(check.body ?? {}).filter(([, v]) => Array.isArray(v)).flatMap(([, v]) => v);
      const ok = check.ok && people.length === 2
        && people.some(r => String(r.email).toLowerCase() === who && String(r.routingOrder) === '1' && (r.tabs?.signHereTabs ?? []).length)
        && people.some(r => String(r.email).toLowerCase() === company.email && String(r.routingOrder) === '2' && (r.tabs?.signHereTabs ?? []).length);
      if (!ok) await discard('docusign_addendum_check_failed');
      return sendValidated(id, { candidate: { name, email: who }, company, mode: 'addendum', terms });
    },
  });
}

const RESEND = /\b(re-?send|resend|remind|nudge|send (?:it|that|this|the \w+) again)\b/i;
const DOCS = /\b(docu ?sign|docusign|sign(?:ed|ing)?|agreement|paperwork|docs?|documents?|contract|addendum|envelope)\b/i;
export const looksLikeResend = text => RESEND.test(String(text ?? '')) && DOCS.test(String(text ?? ''));

/**
 * Project's "resend …" in his DM. `findCandidate(text, event)` gives { pageId, fullName, email } or { ambiguous: [names] } or null.
 * `poster(threadTs)` replies in the DM. Returns an outcome, or null when the message is not this.
 */
export async function handleDocusignReply({ event, env, db, sender, findCandidate, poster, masonId, clock = Date.now, sideEffects = [], sendFresh = null }) {
  if (!db?.prepare || !event || event.authorId !== masonId || !looksLikeResend(event.text)) return null;
  const reply = async text => { try { await poster(event.threadTs ?? event.messageTs)(text); sideEffects.push('docusign_reply'); } catch { /* the outcome stands */ } };
  if (!sender || !(await docusignConnected({ db }))) {
    await reply("📋 I can't resend DocuSigns yet: DocuSign access for me isn't connected. I'll DM you the link to connect it.");
    return { kind: 'docusign_resend', reason: 'not_connected' };
  }
  const who = await findCandidate(event.text, event);
  if (who?.ambiguous) { await reply(`📋 Which one: ${who.ambiguous.slice(0, 4).join(' or ')}? Reply with the name, company or stage (\"the one on the work trial\") and I'll resend.`); return { kind: 'docusign_resend', reason: 'ambiguous' }; }
  if (!who?.email) { await reply("📋 Who should I resend it to? Reply with their full name."); return { kind: 'docusign_resend', reason: 'no_candidate' }; }
  let envelopes;
  try { envelopes = await sender.envelopesFor(who.email); }
  catch (error) { await reply(`🚨 DocuSign didn't answer (${error?.code ?? 'failed'}), so I resent nothing. Try again in a minute.`); return { kind: 'docusign_resend', reason: 'list_failed' }; }
  const open = envelopes.filter(e => ['sent', 'delivered'].includes(e.status));
  const waitingOnThem = open.filter(e => e.signers.some(s => s.email === who.email && ['sent', 'delivered'].includes(s.status)));
  const lines = [];
  const kv = noticeStore(db), now = clock();
  for (const e of waitingOnThem) {
    const others = e.signers.filter(s => s.email !== who.email && ['sent', 'delivered'].includes(s.status)).map(s => s.name || s.email);
    const also = others.length ? ` It's also waiting on ${others.join(' and ')}.` : '';
    const last = await kv.get(`docusign:resent:${e.id}`);
    if (last && now - last.at < RESEND_GAP_MS) { lines.push(`“${e.subject}” was already resent ${Math.round((now - last.at) / 60_000)} minutes ago; I left it.${also}`); continue; }
    // Sent or resent to them by anyone in the last few hours (Jamie resending by hand): another email now is only noise.
    const mine = e.signers.find(s => s.email === who.email);
    if (mine?.sentAt && now - mine.sentAt < FRESH_MS) { lines.push(`“${e.subject}” reached ${who.fullName} ${agoText(now - mine.sentAt)} ago, so I didn't send it again.${also}`); continue; }
    let done;
    try { done = await sender.resend(e.id); } catch (error) { done = { ok: false, code: error?.code ?? 'failed' }; }
    if (done.ok) { await kv.put(`docusign:resent:${e.id}`, { at: now, by: 'project' }, now); lines.push(`Resent “${e.subject}” to ${who.fullName}.${also}`); }
    else if (done.retryable) lines.push(`I couldn't check “${e.subject}” because DocuSign is temporarily unavailable. Nothing was resent; the approved check is preserved for retry.${also}`);
    else if (done.code === 'docusign_document_validation_failed') lines.push(`Blocked “${e.subject}”: its documents have not passed the content checker. Review and correct the packet before resending.${also}`);
    else lines.push(`DocuSign wouldn't let me resend “${e.subject}” (${done.code}). Check its status and sender in DocuSign.${also}`);
  }
  // Signed by them, waiting on someone at Company.
  for (const e of open.filter(x => !waitingOnThem.includes(x))) {
    const others = e.signers.filter(s => ['sent', 'delivered'].includes(s.status)).map(s => s.name || s.email);
    if (others.length) lines.push(`${who.fullName} already signed “${e.subject}”; it's waiting on ${others.join(' and ')}.`);
  }
  // Nothing out to resend (it expired, was voided or declined): a fresh packet at the rate of the first send (Project, 2026-10-17).
  // Never when they already signed one; sendFresh asks for the rate when none is on record and never sends twice.
  if (!lines.length && typeof sendFresh === 'function' && !envelopes.some(e => e.status === 'completed' && /work trial/i.test(e.subject))) {
    const fresh = await sendFresh(who).catch(error => ({ text: `🚨 I didn't send ${who.fullName} new documents: ${error?.code ?? 'failed'}. Nothing went out.` }));
    if (fresh?.text) { await reply(`${fresh.text.startsWith('📨') ? '📨 Nothing was waiting in DocuSign, so I sent a new set. ' + fresh.text.replace(/^📨 /, '') : fresh.text}`); return { kind: 'docusign_resend', reason: `fresh_${fresh.reason ?? 'sent'}` }; }
  }
  if (!lines.length) lines.push(`${who.fullName} has nothing waiting in DocuSign from the last 90 days.`);
  await reply(lines.length === 1 ? `📨 ${lines[0]}` : `📨 DocuSign for ${who.fullName}:\n${lines.map(l => `• ${l}`).join('\n')}`);
  return { kind: 'docusign_resend', reason: 'done', resent: lines.filter(l => l.startsWith('Resent')).length };
}

/** The connect link, to Project, once per link. */
export async function runDocusignConnect({ env, db, poster, clock = Date.now }) {
  if (!docusignSendConfigured(env) || !db?.prepare || typeof poster !== 'function') return { state: 'off' };
  if (await docusignConnected({ db })) return { state: 'connected' };
  const link = await prepareDocusignLink({ env, db, clock });
  if (link.status !== 'link') return { state: 'pending' };
  await poster(`🔗 DocuSign for Uncle Sam: open this signed in to DocuSign as project@company.example and tap Allow. Then "resend Morgan's DocuSign" in this DM resends whatever is waiting on them. The link works for 7 days.\n${link.url}`);
  return { state: 'linked' };
}

const NAME = /\b([A-Z][a-z'’-]+)(?:\s+([A-Z][a-z'’-]+))?(?:'s|’s)?\b/g;
const NOT_NAMES = new Set(['Uncle', 'Sam', 'DocuSign', 'Docusign', 'Resend', 'Please', 'Can', 'The', 'Send', 'His', 'Her', 'Their', 'Remind', 'Project', 'Jamie', 'Robin', 'Alexis', 'Interviewer', 'Work', 'Trial', 'Agreement']);
/**
 * Who a resend is about: a name in the message (one open record), else the record Uncle Sam's message just before it in
 * that DM (or the thread's first message) links to. `notion` needs findCandidatesByName and getCandidate; `history(event)`
 * gives the bot's recent messages there, newest first.
 */
const dateOnly = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : (typeof v?.start === 'string' ? v.start.slice(0, 10) : null));
export const factsOf = c => ({ pageId: c.pageId, fullName: c.fullName, email: String(c.email ?? '').toLowerCase() || null,
  dailyRate: c.payment?.dailyRate ?? null, trialStart: dateOnly(c.fields?.['Trial Start']), trialEnd: dateOnly(c.fields?.['Trial End']) });
/** Words in a send command that are never part of a name. */
const STOP = new Set(('a an and at for from the to of in on with him her his their them they he she it its this that these those set setup up send sending sent '
  + 'please can could would you uncle sam docusign docu sign docs doc documents document necessary needed need work trial trials packet paperwork nda ciiaa '
  + 'terms per day days daily usd dollars dollar rate pay standard normal usual regular hey hi ok okay also then now today tonight tomorrow get give make sure '
  + 'add adding addendum fourth compensation th nd rd st start starting resend remind nudge go out over to all of their our agreement contract envelope new same again first next week weekend thanks thank').split(' '));
/** "from Proximal" in a send command: the company that tells namesakes apart. */
export function companyOf(text) {
  const m = /\bfrom\s+([A-Za-z][\w&'’-]*(?:\s+[A-Z][\w&'’-]*)?)/.exec(String(text ?? '').replace(/<[^>]*>/g, ' '));
  if (!m) return null;
  const words = m[1].replace(/[,'’-]+$/, '').split(/\s+/);
  return (words.length > 1 && STOP.has(words[1].toLowerCase()) ? words.slice(0, 1) : words).join(' ');
}
/** Name guesses: capitalized pairs first, then the plain words left once command words, amounts and the company are taken out. */
export function nameGuesses(text) {
  const t = String(text ?? '').replace(/<[^>]*>/g, ' ');
  const company = new Set(String(companyOf(t) ?? '').toLowerCase().split(/\s+/).filter(Boolean));
  const caps = [...t.matchAll(NAME)].map(m => [m[1], m[2]].filter(Boolean).filter(w => !NOT_NAMES.has(w) && !STOP.has(w.toLowerCase()) && !company.has(w.toLowerCase())).join(' ')).filter(Boolean);
  const words = t.toLowerCase().replace(/\$\s*[\d,.]+/g, ' ').replace(/[^a-z\s'’-]/g, ' ').split(/\s+/).map(w => w.replace(/['’]s$/, '').replace(/^['’-]+|['’-]+$/g, ''))
    .filter(w => w.length >= 2 && !STOP.has(w) && !company.has(w) && !NOT_NAMES.has(w[0].toUpperCase() + w.slice(1)));
  const plain = [];
  for (let i = 0; i + 1 < words.length; i++) plain.push(`${words[i]} ${words[i + 1]}`);
  const out = [];
  const pairs = [...caps.filter(c => c.includes(' ')), ...plain];
  // A single word ("Morgan") only when no two-word name was said: "Jane" alone must never pick some other Jane.
  for (const g of pairs.length ? pairs : [...caps, ...words]) if (!out.includes(g.toLowerCase())) out.push(g.toLowerCase());
  return out.slice(0, 6);
}
/** American Soundex, for names heard through dictation ("reighan Jane" for Reagan Turner). */
export function soundex(word) {
  const w = String(word ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return '';
  const code = c => ('bfpv'.includes(c) ? '1' : 'cgjkqsxz'.includes(c) ? '2' : 'dt'.includes(c) ? '3' : c === 'l' ? '4' : 'mn'.includes(c) ? '5' : c === 'r' ? '6' : '');
  let out = w[0].toUpperCase(), last = code(w[0]);
  for (const c of w.slice(1)) { const d = code(c); if (d && d !== last) out += d; if (c !== 'h' && c !== 'w') last = d; if (out.length === 4) break; }
  return out.padEnd(4, '0');
}
/** A two-word guess that sounds like the person's first and last name (either order). */
export function soundsLike(guess, fullName) {
  const g = String(guess ?? '').split(/\s+/).filter(Boolean), n = String(fullName ?? '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  if (g.length !== 2 || n.length < 2) return false;
  const [a, b] = g.map(soundex), first = soundex(n[0]), last = soundex(n[n.length - 1]);
  return (a === first && b === last) || (a === last && b === first);
}
const fromOf = c => String(c?.profile?.from ?? c?.fields?.From ?? '').trim();
const sameCompany = (company, c) => { const a = company.toLowerCase(), b = fromOf(c).toLowerCase(); return !!b && (b.includes(a) || a.includes(b)); };
const labelOf = c => `${c.fullName}${fromOf(c) ? ` (${fromOf(c)})` : ''}`;
/** One namesake, kept for Project's "which one" reply (which-one.mjs). */
const optionOf = c => ({ ...factsOf(c), label: labelOf(c), from: fromOf(c) || null, stage: c.fields?.Stage ?? null, pipeline: c.fields?.Pipeline ?? null });
/**
 * Who a send or resend is about. A name in the message matching one open record; "from <company>" picks between namesakes.
 * A name heard wrong by dictation ("reighan, Jane from Proximal") is matched by sound against everyone open: { ..., matched:
 * 'sound', heard } so the caller can say how it read it. Else the record Uncle Sam's message just before it links to.
 */
export function candidateFinder({ notion, history }) {
  return async (text, event) => {
    const company = companyOf(text);
    const open = c => !c.archived && !['Not Selected', 'Withdrawn or Unavailable'].includes(c.fields?.Outcome);
    let ambiguous = null;
    for (const name of nameGuesses(text)) {
      let found = [];
      try { found = (await notion.findCandidatesByName(name)).filter(open); } catch { continue; }
      let fitting = company ? found.filter(c => sameCompany(company, c)) : found;
      // "Arlen Archer" also finds "Aarlen Archer": the one whose name is exactly what was said wins.
      const exact = fitting.filter(c => String(c.fullName ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase() === name.toLowerCase());
      if (fitting.length > 1 && exact.length === 1) fitting = exact;
      if (fitting.length === 1) return { ...factsOf(fitting[0]), matched: 'name' };
      if (found.length > 1 && !ambiguous) ambiguous = fitting.length > 1 ? fitting : found;
    }
    if (ambiguous) return { ambiguous: ambiguous.map(labelOf), options: ambiguous.map(optionOf) };
    if (typeof notion.listActiveCandidates === 'function') {
      let everyone = [];
      try { everyone = (await notion.listActiveCandidates({ includeProceeding: true })).filter(open); } catch { everyone = []; }
      for (const guess of nameGuesses(text).filter(g => g.includes(' '))) {
        const sounding = everyone.filter(c => soundsLike(guess, c.fullName));
        const fitting = company ? sounding.filter(c => sameCompany(company, c)) : sounding;
        if (fitting.length === 1) return { ...factsOf(fitting[0]), matched: 'sound', heard: guess, companyMatched: !!company, from: fromOf(fitting[0]) || null };
        if (fitting.length > 1) return { ambiguous: fitting.map(labelOf), options: fitting.map(optionOf) };
      }
    }
    let messages = [];
    try { messages = await history(event); } catch { messages = []; }
    for (const m of messages) {
      const ids = [...new Set([...String(m.text ?? '').matchAll(/notion\.(?:so|com)\/(?:[^\s|>]*?[-/])?([0-9a-f]{32})/gi)].map(x => x[1].toLowerCase()))];
      if (ids.length !== 1) continue;
      const id = ids[0].replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
      try { const c = await notion.getCandidate(id); if (c?.email) return factsOf(c); } catch { /* next */ }
    }
    return null;
  };
}

const SEND = /\bsend\b/i;
export const addendumOn = env => env.UNCLE_SAM_PACKET_ADDENDUM === 'on';
/** "$250/day", "250 per day", "250 a day", "$250 daily". */
export function rateOf(text) {
  const m = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:\/\s*day|per\s+day|a\s+day|\/\s*d\b|daily)/i.exec(String(text ?? ''))
    ?? /\b(\d{2,5}(?:\.\d{1,2})?)\s*(?:dollars|usd)?\s*(?:\/\s*day|per\s+day|a\s+day|daily)/i.exec(String(text ?? ''));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}
const PACKET = /\b(work ?trial (?:docs?|documents?|packet|paperwork)|docu ?sign|docusign|docs|documents|paperwork|packet|nda|ciiaa)\b/i;
const IP_DOC = /\b(ip|intellectual property|work ?trial agreement)\b/i;
export const looksLikePacketSend = text => SEND.test(String(text ?? '')) && PACKET.test(String(text ?? '')) && !looksLikeResend(text);

/**
 * Project's "send the work trial docs to Morgan" in his DM (Project, 2026-10-16: "If I say to send these documents to this person,
 * it will do it. Jamie won't be doing it anymore"): the three standard documents in one envelope, once per person. The IP /
 * work trial agreement is an edge case and never goes in this envelope.
 */
export const PACKET_ASK_MS = 24 * 3600_000;
const YES = /^\s*(?:<@[^>]+>\s*)?(?:yes|yep|yeah|yup|y|correct|right|that'?s (?:him|her|them|right|the one)|send(?: it| them)?|go(?: ahead)?)\b/i;
const usd = n => `US$${Number(n).toLocaleString('en-US')}`;
export async function handleDocusignSend({ event, env, db, sender, findCandidate, poster, masonId, clock = Date.now, sideEffects = [], afterSend = null, afterAddendum = null, threadRoot = null }) {
  if (!db?.prepare || !event || event.authorId !== masonId) return null;
  const kv = noticeStore(db), now = clock();
  const thread = event.threadTs ?? event.messageTs, inThread = !!event.threadTs && event.threadTs !== event.messageTs;
  // A reply under Uncle Sam's "Who should get them?" / "Did you mean …?" (Project, 2026-10-16: he named the person in the
  // thread and it went nowhere). Kept a day; a thread started by his own send command counts even without the kept question.
  let pending = null;
  if (inThread) {
    const kept = await kv.get(`packet-ask:${event.channelId}:${event.threadTs}`);
    pending = kept && !kept.done && now - kept.at <= PACKET_ASK_MS ? kept : null;
    if (!kept && !looksLikePacketSend(event.text) && typeof threadRoot === 'function') {
      const root = await Promise.resolve().then(() => threadRoot(event)).catch(() => null);
      if (root?.user === masonId && (looksLikePacketSend(root.text) || looksLikeAddendumSend(root.text)) && now - Number(root.ts) * 1000 < PACKET_ASK_MS) pending = { at: now, rate: rateOf(root.text), addendum: looksLikeAddendumSend(root.text) };
    }
  }
  const addendumOnly = looksLikeAddendumSend(event.text) || !!pending?.addendum;
  if (!pending && !looksLikePacketSend(event.text) && !looksLikeAddendumSend(event.text)) return null;
  // In such a thread, a reply that names nobody and isn't a yes ("thanks") is left to the other lanes.
  if (pending && !looksLikePacketSend(event.text) && !looksLikeAddendumSend(event.text) && !(pending.who && YES.test(event.text)) && !nameGuesses(event.text).length) return null;
  const reply = async text => { try { await poster(thread)(text); sideEffects.push('docusign_reply'); } catch { /* the outcome stands */ } };
  const ask = async (extra = {}) => kv.put(`packet-ask:${event.channelId}:${thread}`, { at: now, rate: rateOf(event.text) ?? pending?.rate ?? null, ...(addendumOnly ? { addendum: true } : {}), ...extra }, now);
  const onlyIp = IP_DOC.test(event.text) && !/\b(nda|ciiaa|terms|docs|documents|packet|paperwork)\b/i.test(event.text);
  if (onlyIp) { await reply("📋 The IP agreement isn't part of the standard envelope, so I don't send it. Send that one by hand for now."); return { kind: 'docusign_send', reason: 'ip_only' }; }
  if (!sender || !(await docusignConnected({ db }))) { await reply("📋 I can't send DocuSigns yet: DocuSign access for me isn't connected."); return { kind: 'docusign_send', reason: 'not_connected' }; }
  const rate = rateOf(event.text) ?? pending?.rate ?? null;
  const at = rate ? ` at ${usd(rate)} per day` : '';
  let who = null, lead = '';
  if (pending?.who && YES.test(event.text)) {
    who = await findCandidate(pending.who.fullName, event).catch(() => null);
    if (!who?.email || who.ambiguous || who.pageId !== pending.who.pageId) {
      await reply('🚨 I blocked the documents because I could not verify the current candidate record. Confirm the person on the tracker before trying again.');
      return { kind: 'docusign_send', reason: 'validation_blocked' };
    }
  }
  else who = await findCandidate(event.text, event);
  if (who?.ambiguous) {
    await ask();
    await reply(`📋 Which one: ${who.ambiguous.slice(0, 4).join(' or ')}? Reply here with the name (add "from <company>") and I'll send ${addendumOnly ? 'the compensation addendum' : 'the work trial documents'}${at}.`);
    return { kind: 'docusign_send', reason: 'ambiguous' };
  }
  if (!who?.email) {
    await ask();
    const heard = nameGuesses(event.text)[0];
    await reply(`📋 I couldn't find ${heard ? `“${heard}”` : 'who you meant'} on the tracker with an email. Reply here with their full name (add "from <company>" if two share it) and I'll send ${addendumOnly ? 'the compensation addendum' : 'the work trial documents'}${at}.`);
    return { kind: 'docusign_send', reason: 'no_candidate' };
  }
  if (who.matched === 'sound') {
    const label = `${who.fullName}${who.from ? ` (${who.from})` : ''}`;
    // Heard through dictation and confirmed by the company named: sent, with how it was read. Otherwise one "yes" first.
    if (!who.companyMatched) {
      const { matched, heard, companyMatched, from, ...facts } = who;
      await ask({ who: facts });
      await reply(`📋 Did you mean ${label}, ${who.email}? Reply yes here and I'll send ${addendumOnly ? 'the compensation addendum' : 'the work trial documents'}${at}.`);
      return { kind: 'docusign_send', reason: 'confirm_name' };
    }
    lead = `I read “${who.heard}” as ${label}. `;
  }
  const { matched, heard, companyMatched, from, ...facts } = who;
  let out;
  if (addendumOnly) {
    out = await sendAddendumOnly({ env, db, sender, who: facts, rate, clock });
    if (out.reason === 'sent' && typeof afterAddendum === 'function') { try { const after = await afterAddendum({ who: facts, rate: out.rate, envelopeId: out.envelopeId }); if (after) out = { ...out, text: `${out.text} ${after}` }; } catch { /* the send stands */ } }
  } else out = await sendWorkTrialPacket({ env, db, sender, who: facts, rate, clock, afterSend, afterAddendum });
  if (pending || inThread) await kv.put(`packet-ask:${event.channelId}:${thread}`, { at: now, done: true }, now);
  await reply(`${out.text.slice(0, 2)}${lead ? ` ${lead}` : ''}${out.text.slice(2)}`.replace(/\s{2,}/g, ' '));
  return { kind: 'docusign_send', reason: out.reason, ...(out.envelopeId ? { envelopeId: out.envelopeId } : {}) };
}

/** "add the 4th document", "send Arlen the addendum at $100/day", "the compensation addendum". */
export const looksLikeAddendumSend = text => /\b(addendum|(?:4th|fourth) (?:doc|document)|compensation (?:doc|document|agreement))s?\b/i.test(String(text ?? ''))
  && /\b(send|add|give|attach|include|get)\b/i.test(String(text ?? '')) && !looksLikeResend(text);
/**
 * The addendum alone for someone whose three documents already went out: once per person (claimed first), at the rate Project
 * gave or the record's. Returns { reason, text, envelopeId? }.
 */
/**
 * The pay per day for a send that names none: the rate Project gave the first time Uncle Sam sent this person documents (Project,
 * 2026-10-17: "the rate that i had him send the first time should be the standard rate"), else the tracker's; null means ask.
 */
export async function standardRate({ db, who, given = null }) {
  const ok = r => Number.isFinite(r) && r > 0;
  if (ok(given)) return given;
  if (db?.prepare && who?.email) {
    const kv = noticeStore(db);
    for (const key of [`docusign:rate:${who.email}`, `docusign:packet:${who.email}`, `docusign:addendum:${who.email}`]) { const r = Number((await kv.get(key))?.rate); if (ok(r)) return r; }
  }
  return ok(who?.dailyRate) ? who.dailyRate : null;
}
/** Kept for good the first time: later sends without a rate use it. */
const keepFirstRate = async (db, email, rate, now) => { if (email && Number.isFinite(rate) && rate > 0) await noticeStore(db).claim(`docusign:rate:${email}`, { rate, at: now }, now).catch(() => {}); };

/**
 * What already went out to this person in DocuSign, from anyone (Jamie included): the three-document packet, and the pay
 * terms, which are either a Work Trial Agreement or a compensation addendum (Project, 2026-10-19, on Rylan: "this was
 * already done"). Live = sent, delivered or signed.
 */
export function paperworkOut(list) {
  const live = (list ?? []).filter(e => ['sent', 'delivered', 'completed'].includes(e.status));
  const docs = live.find(e => /work trial(?: docs)?\b/i.test(e.subject) && !/agreement|addendum/i.test(e.subject)) ?? null;
  const pay = live.find(e => /work[\s_-]*trial[\s_-]*agreement/i.test(e.subject)) ?? live.find(e => /compensation[\s_-]*addendum/i.test(e.subject)) ?? null;
  return { docs, pay };
}

export async function sendAddendumOnly({ env, db, sender, who, rate: given = null, clock = Date.now, earlier = null }) {
  if (!sender || !(await docusignConnected({ db }))) return { reason: 'not_connected', text: "📋 I can't send DocuSigns yet: DocuSign access for me isn't connected." };
  if (!who?.email) return { reason: 'no_candidate', text: '📋 Who should get the compensation addendum? Reply with their full name; their email must be on the tracker.' };
  const first = who.fullName.split(' ')[0], now = clock();
  const rate = await standardRate({ db, who, given });
  if (!rate) return { reason: 'no_rate', text: `📋 I don't have ${first}'s pay per day on record. Say "send ${who.fullName} the addendum at $100/day".` };
  if (rate < 10 || rate > 5000) return { reason: 'rate_out_of_range', text: `📋 US$${rate} per day looks wrong, so I sent nothing. Say the rate again.` };
  let list = earlier;
  if (!list) { try { list = await sender.envelopesFor(who.email); } catch { return { reason: 'list_failed', text: "🚨 DocuSign didn't answer, so I sent nothing. Try again in a minute." }; } }
  // A Work Trial Agreement already carries the pay: no addendum on top of it (Project, 2026-10-19).
  const agreement = list.find(e => /work[\s_-]*trial[\s_-]*agreement/i.test(e.subject) && ['sent', 'delivered', 'completed'].includes(e.status));
  if (agreement) return { reason: 'already_has_agreement', text: `📋 ${who.fullName} already has a Work Trial Agreement (${agreement.status === 'completed' ? 'signed' : 'not signed yet'}), which carries the pay. I sent nothing.` };
  const live = list.find(e => /compensation addendum/i.test(e.subject) && ['sent', 'delivered', 'completed'].includes(e.status));
  if (live) return { reason: 'already_has_addendum', text: `📋 ${who.fullName} already has a compensation addendum (“${live.subject}”, ${live.status === 'completed' ? 'signed' : 'not signed yet'}). I sent nothing new.` };
  const key = `docusign:addendum:${who.email}`;
  const previous = await noticeStore(db).get(key);
  if (['send_pending', 'uncertain', 'validation_blocked'].includes(previous?.status)) return {
    reason: previous.status === 'send_pending' ? 'uncertain' : previous.status, envelopeId: previous.envelopeId,
    text: `🚨 ${who.fullName}'s addendum is held for ${previous.status === 'validation_blocked' ? 'document correction' : 'delivery reconciliation'}. Review the existing envelope before retrying.` };
  const claimed = await db.prepare(`INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE json_extract(uncle_sam_notices.value, '$.envelopeId') IS NULL AND uncle_sam_notices.updated_at <= ?
    RETURNING name`).bind(key, JSON.stringify({ at: now }), now, now - 3600_000).first();
  if (!claimed) return { reason: 'already_sent', text: `📋 ${who.fullName}'s compensation addendum already went out from me.` };
  const kv = noticeStore(db);
  let result;
  try {
    const terms = { dailyRate: rate, start: who.trialStart ?? null, end: who.trialEnd ?? null, date: new Date(now).toISOString().slice(0, 10) };
    validateDocumentInputs({ candidate: { name: who.fullName, email: who.email }, company: companySignerOf(env), ...terms });
    const bytes = await renderAddendum({ name: who.fullName, email: who.email, ...terms, company: companySignerOf(env) });
    result = await sender.sendAddendum({ name: who.fullName, email: who.email, company: companySignerOf(env), pdfBase64: Buffer.from(bytes).toString('base64'), terms });
  } catch (error) {
    if (error?.code === 'docusign_document_validation_failed') {
      await kv.put(key, { at: now, status: 'validation_blocked', envelopeId: error.envelopeId ?? null, detail: error.detail }, now);
      return { reason: 'validation_blocked', envelopeId: error.envelopeId, text: `🚨 Blocked ${who.fullName}'s compensation addendum: ${error.detail ?? 'document validation failed'}. No send was attempted; the packet needs correction.` };
    }
    await kv.del(key); return { reason: 'failed', text: `🚨 I didn't send ${who.fullName}'s compensation addendum: ${error?.code ?? 'failed'}. Nothing went out.` };
  }
  if (!result.ok) {
    if (!result.uncertain) await kv.del(key);
    else await kv.put(key, { at: now, status: 'uncertain', envelopeId: result.envelopeId, pageId: who.pageId ?? null, name: who.fullName, rate }, now);
    return { reason: result.uncertain ? 'uncertain' : 'refused', text: result.uncertain ? `🚨 DocuSign didn't confirm ${who.fullName}'s addendum went out. Check DocuSign before asking again.` : `🚨 DocuSign refused ${who.fullName}'s addendum (${result.code}). Nothing went out.` };
  }
  await kv.put(key, { at: now, envelopeId: result.envelopeId, pageId: who.pageId ?? null, name: who.fullName, rate }, now);
  await keepFirstRate(db, who.email, rate, now);
  return { reason: 'sent', envelopeId: result.envelopeId, rate, text: `📨 Sent ${who.fullName} the work trial compensation addendum at US$${rate.toLocaleString('en-US')} per day in its own DocuSign envelope, to ${who.email}.` }; // Project, 2026-10-18: no signing order or envelope explanation
}

/** The packet Uncle Sam sent this person and that is still live (not declined, voided or expired), or null. */
export async function packetOnRecord({ db, email }) {
  const who = String(email ?? '').toLowerCase();
  if (!db?.prepare || !who) return null;
  const mark = await noticeStore(db).get(`docusign:packet:${who}`);
  return mark && !mark.closed && !['send_pending', 'uncertain', 'validation_blocked'].includes(mark.status) ? mark : null;
}

/**
 * Every automatic packet waits 30 minutes in the email queue (email-queue.mjs `queue` = queuePacket, Project 2026-10-20), unless it's
 * already out. `force` only on a person's explicit word (a push-through, Project's tap, his rate reply or command): it re-queues a
 * send he cancelled; without it a cancelled one stays cancelled ({ reason: 'cancelled', text: null }: he cancelled it, nothing to
 * say). -> { reason: 'queued' | 'already_queued' | 'already_sent' | 'cancelled', at?, text }
 */
export async function queueWorkTrialPacket({ db, who, rate, force = false, clock = Date.now, queue, envelopesFor }) {
  const first = String(who?.fullName ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().split(/\s+/)[0] || 'their';
  const held = await noticeStore(db).get(`docusign:packet:${who?.email}`);
  if (['send_pending', 'uncertain', 'validation_blocked'].includes(held?.status)) return {
    reason: held.status === 'send_pending' ? 'uncertain' : held.status,
    text: `🚨 ${first}'s documents are held for ${held.status === 'validation_blocked' ? 'document correction' : 'delivery reconciliation'}. Review the existing envelope before retrying.` };
  if (await packetOnRecord({ db, email: who?.email }).catch(() => null)) return { reason: 'already_sent', text: `📋 ${first}'s work trial documents already went out from me.` };
  const out = paperworkOut(await envelopesFor(who?.email));
  if (out?.docs && out?.pay) return { reason: 'already_sent', text: `📋 ${first}'s work trial documents are already out in DocuSign.` };
  const q = await queue({ db, who, rate, clock, ...(force ? { force: true } : {}) });
  if (q?.reason === 'cancelled') return { ...q, text: null };
  if (['dispatch_started', 'held', 'queue_changed'].includes(q?.reason)) return { ...q,
    text: `📋 ${first}'s packet could not be changed because its delivery has started, is held, or changed concurrently. Check the existing packet before trying again.` };
  return { ...q, text: `Roger that 🫡 Sending ${first}'s work trial documents now.` };
}

/** The record read again at send time (email-queue.mjs sendNow): the trial dates as they are now, not as queued. */
export async function withFreshDates({ notion, who }) {
  const c = who?.pageId && typeof notion?.getCandidate === 'function' ? await notion.getCandidate(who.pageId).catch(() => null) : null;
  if (!c || c.archived) fail('docusign_document_validation_failed', 'candidate_record_unavailable');
  const now = factsOf(c);
  if (!now.fullName || !now.email) fail('docusign_document_validation_failed', 'candidate_identity_missing');
  if (String(now.email).toLowerCase() !== String(who.email ?? '').toLowerCase()
    || String(now.fullName).replace(/\s*\([^)]*\)/g, '').trim().toLowerCase() !== String(who.fullName).replace(/\s*\([^)]*\)/g, '').trim().toLowerCase()) fail('docusign_document_validation_failed', 'candidate_identity_changed');
  // The record's dates win when it has them; dates given on the push-through form stand when it doesn't.
  return { ...who, fullName: now.fullName, email: now.email,
    trialStart: now.trialStart ?? who.trialStart ?? null, trialEnd: now.trialEnd ?? who.trialEnd ?? null };
}

/**
 * The work-trial packet for one person (Project's typed "send the work trial docs to X", or his Send on a work-trial offer,
 * work-trial-offer.mjs): once per person, claimed before sending. `who` = { pageId, fullName, email, dailyRate, trialStart,
 * trialEnd }; `rate` overrides the record's pay per day. Returns { reason, text, envelopeId? }; `text` is Project's reply.
 */
export async function sendWorkTrialPacket({ env, db, sender, who, rate: given = null, clock = Date.now, afterSend = null, afterAddendum = null }) {
  if (!sender || !(await docusignConnected({ db }))) return { reason: 'not_connected', text: "📋 I can't send DocuSigns yet: DocuSign access for me isn't connected." };
  if (!who?.email) return { reason: 'no_candidate', text: '📋 Who should get the work trial documents? Reply with their full name; their email must be on the tracker.' };
  const kv = noticeStore(db), now = clock(), key = `docusign:packet:${who.email}`;
  const mark = await kv.get(key);
  if (['send_pending', 'uncertain', 'validation_blocked'].includes(mark?.status)) return {
    reason: mark.status === 'send_pending' ? 'uncertain' : mark.status, envelopeId: mark.envelopeId,
    text: `🚨 ${who.fullName}'s documents are held for ${mark.status === 'validation_blocked' ? 'document correction' : 'delivery reconciliation'}. Review the existing envelope before retrying.` };
  // A declined, voided or expired packet (paperwork-followup.mjs marks it closed) may be sent again.
  if ((mark?.envelopeId && !mark.closed) || (mark && !mark.envelopeId && now - mark.at < 3600_000)) return { reason: 'already_sent', text: `📋 ${who.fullName} already got the work trial documents from me${mark.at ? ` ${agoText(now - mark.at)} ago` : ''}. Say "resend ${who.fullName.split(' ')[0]}'s DocuSign" to send them again.` };
  let earlier = [];
  try { earlier = await sender.envelopesFor(who.email); } catch { earlier = null; }
  if (earlier === null) { return { reason: 'list_failed', text: "🚨 DocuSign didn't answer, so I sent nothing. Try again in a minute." }; }
  const packet = earlier.find(e => /work trial(?: docs)?\b/i.test(e.subject) && !/agreement/i.test(e.subject) && ['sent', 'delivered', 'completed'].includes(e.status));
  if (packet) {
    const state = packet.status === 'completed' ? 'signed it' : packet.status === 'delivered' ? 'opened it but not signed' : 'not opened it yet';
    const has = `${who.fullName} already has the work trial documents, sent by ${packet.sender.name || 'someone'}, and has ${state}.`;
    // Someone else's three-document packet: the 4th, their compensation addendum, goes on its own (Project, 2026-10-16).
    if (addendumOn(env)) {
      const add = await sendAddendumOnly({ env, db, sender, who, rate: given, clock, earlier });
      if (add.reason === 'sent') {
        let after = '';
        if (typeof afterAddendum === 'function') { try { after = await afterAddendum({ who, rate: add.rate, envelopeId: add.envelopeId }) ?? ''; } catch { after = ''; } }
        return { reason: 'addendum_sent', envelopeId: add.envelopeId, text: `📨 ${has} ${add.text.replace(/^📨 /, '')}${after ? ` ${after}` : ''}` };
      }
      return { reason: 'already_has_packet', text: `📋 ${has} ${add.text.replace(/^[📋🚨] /u, '')}` };
    }
    return { reason: 'already_has_packet', text: `📋 ${has} I sent nothing new.` };
  }
  // The 4th document, their pay per day (Project, 2026-10-16), once the wording is approved (UNCLE_SAM_PACKET_ADDENDUM=on).
  let addendum = null, rate = null;
  if (addendumOn(env)) {
    rate = await standardRate({ db, who, given });
    if (!rate) { return { reason: 'no_rate', text: `📋 I don't have ${who.fullName.split(' ')[0]}'s pay per day on record. Say "send the work trial docs to ${who.fullName} at $250/day" and I'll send all four documents.` }; }
    if (rate < 10 || rate > 5000) { return { reason: 'rate_out_of_range', text: `📋 US$${rate} per day looks wrong, so I sent nothing. Say the rate again.` }; }
    const terms = { dailyRate: rate, start: who.trialStart ?? null, end: who.trialEnd ?? null, date: new Date(now).toISOString().slice(0, 10) };
    try { validateDocumentInputs({ candidate: { name: who.fullName, email: who.email }, company: companySignerOf(env), ...terms }); }
    catch (error) { return { reason: 'validation_blocked', text: `🚨 Blocked ${who.fullName}'s documents: ${error.detail ?? 'invalid document inputs'}. No send was attempted.` }; }
    const bytes = await renderAddendum({ name: who.fullName, email: who.email, ...terms, company: companySignerOf(env) });
    addendum = { pdfBase64: Buffer.from(bytes).toString('base64'), terms };
  }
  // Claimed before sending, atomically: two "send" taps or messages at once never make two envelopes. Taken over only from a
  // closed packet (declined, voided, expired) or a claim an hour old that never got an envelope.
  const claimed = await db.prepare(`INSERT INTO uncle_sam_notices (name, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE json_extract(uncle_sam_notices.value, '$.closed') IS NOT NULL
      OR (json_extract(uncle_sam_notices.value, '$.envelopeId') IS NULL AND uncle_sam_notices.updated_at <= ?)
    RETURNING name`).bind(key, JSON.stringify({ at: now }), now, now - 3600_000).first();
  if (!claimed) return { reason: 'already_sent', text: `📋 ${who.fullName}'s work trial documents are already going out from me. Say "resend ${who.fullName.split(' ')[0]}'s DocuSign" to send them again.` };
  let result;
  try { result = await sender.sendPacket({ name: who.fullName, email: who.email, company: companySignerOf(env), addendum }); }
  catch (error) {
    if (error?.code === 'docusign_document_validation_failed') {
      await kv.put(key, { at: now, status: 'validation_blocked', envelopeId: error.envelopeId ?? null, pageId: who.pageId ?? null, name: who.fullName, detail: error.detail }, now);
      return { reason: 'validation_blocked', envelopeId: error.envelopeId, text: `🚨 Blocked ${who.fullName}'s work trial documents: ${error.detail ?? 'document validation failed'}. No send was attempted; the packet needs correction.` };
    }
    await kv.del(key); return { reason: 'failed', text: `🚨 I didn't send ${who.fullName}'s work trial documents: ${error?.code ?? 'failed'}. Nothing went out.` };
  }
  if (!result.ok) {
    if (!result.uncertain) await kv.del(key);
    else await kv.put(key, { at: now, status: 'uncertain', envelopeId: result.envelopeId, pageId: who.pageId ?? null, name: who.fullName, rate }, now);
    return { reason: result.uncertain ? 'uncertain' : 'refused', text: result.uncertain ? `🚨 DocuSign didn't confirm ${who.fullName}'s work trial documents went out. Check DocuSign before asking again.` : `🚨 DocuSign refused to send ${who.fullName}'s work trial documents (${result.code}). Nothing went out.` };
  }
  const sentRate = rate ?? await standardRate({ db, who, given: Number.isFinite(given) && given >= 10 && given <= 5000 ? given : null });
  await kv.put(key, { at: now, envelopeId: result.envelopeId, pageId: who.pageId ?? null, name: who.fullName, rate: sentRate ?? null }, now);
  await keepFirstRate(db, who.email, sentRate, now);
  const company = companySignerOf(env);
  // The confirmation email to them, on the same tap (work-trial-offer.mjs sendTrialConfirmation): its line ends the reply.
  let after = '';
  // The pay per day Project gave (or the record's) goes on the tracker even when the addendum is off.
  const payRate = sentRate ?? null;
  if (typeof afterSend === 'function') { try { after = await afterSend({ who, rate: payRate, addendum: !!addendum, envelopeId: result.envelopeId }) ?? ''; } catch { after = ''; } }
  return { reason: 'sent', envelopeId: result.envelopeId, text: `📨 Sent ${who.fullName} the work trial documents (NDA, CIIAA, Terms of Service${addendum ? `, and the compensation addendum at US$${rate.toLocaleString('en-US')} per day` : ''}) in one DocuSign envelope, to ${who.email}.${!addendum && payRate ? ` Pay per day: US$${payRate.toLocaleString('en-US')}.` : ''} ${who.fullName.split(' ')[0]} signs everything first; then ${company.name.split(' ')[0] === 'Project' ? 'you countersign (DocuSign emails you)' : `${company.name} countersigns`}. The IP agreement is not in it. ${followUpPromise({ sentAt: now, startDate: who.trialStart ?? null })}${after ? ` ${after}` : ''}` };
}

/**
 * A document fetch Claude asked for by writing uncle_sam_notices "docusign:fetch-request" = { envelopeId, documentId }: read
 * once, kept at "docusign:fetched:<envelopeId>:<documentId>", and the request cleared. Nothing in DocuSign changes.
 */
export async function runDocusignFetch({ env, db, sender, clock = Date.now }) {
  if (!sender || !db?.prepare) return null;
  const kv = noticeStore(db), now = clock();
  const ask = await kv.get('docusign:fetch-request');
  if (!ask?.envelopeId) return null;
  await kv.del('docusign:fetch-request');
  try {
    const b64 = await sender.documentBase64(ask.envelopeId, ask.documentId ?? '1');
    await kv.put(`docusign:fetched:${ask.envelopeId}:${ask.documentId ?? '1'}`, { at: now, b64 }, now);
    return { fetched: true };
  } catch (error) { await kv.put(`docusign:fetched:${ask.envelopeId}:${ask.documentId ?? '1'}`, { at: now, error: error?.code ?? 'failed' }, now); return { error: error?.code ?? 'failed' }; }
}
