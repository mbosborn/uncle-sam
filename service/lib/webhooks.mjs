/**
 * Inbound webhooks from Notion (signed with the subscription's verification token) and the
 * take-home portal (shared secret header). Both only persist a deduplicated event and schedule
 * the runner after the response; neither authorizes any action by itself.
 */
import { constantTimeSecretEqual } from './protocol.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const idPattern = /^[A-Za-z0-9_:.-]{1,120}$/;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

async function readBody(request) {
  if (request.method !== 'POST') return { error: json({ error: 'method_not_allowed' }, 405, { allow: 'POST' }) };
  const declared = request.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) return { error: json({ error: 'payload_too_large' }, 413) };
  let raw;
  try { raw = await request.text(); } catch { return { error: json({ error: 'invalid_body' }, 400) }; }
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { error: json({ error: 'payload_too_large' }, 413) };
  let payload;
  try { payload = JSON.parse(raw); } catch { return { error: json({ error: 'invalid_json' }, 400) }; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { error: json({ error: 'invalid_json' }, 400) };
  return { raw, payload };
}

async function hmacHex(secret, raw) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
}

function secretOk(secret) { return typeof secret === 'string' && secret.length >= 16 && !/\s/.test(secret); }

async function persistAndSchedule({ store, schedule, run, event }) {
  let recorded;
  try { recorded = await store.recordEvent(event); } catch { return json({ error: 'event_store_unavailable' }, 503); }
  if (recorded.created && typeof run === 'function') {
    const work = Promise.resolve().then(() => run({ eventId: event.eventId, attemptId: crypto.randomUUID() })).catch(() => undefined);
    if (typeof schedule === 'function') schedule(work);
  }
  return json({ ok: true, eventId: event.eventId, duplicate: !recorded.created });
}

/**
 * Notion sends {verification_token} once when a subscription URL is saved; the token must then be
 * stored as NOTION_WEBHOOK_SECRET. Every later delivery carries X-Notion-Signature = sha256=HMAC(token, body).
 */
export async function handleNotionWebhook(request, { secret, store, schedule, run, log = console.log } = {}) {
  const body = await readBody(request);
  if (body.error) return body.error;
  const { raw, payload } = body;
  if (typeof payload.verification_token === 'string') {
    // Logged on purpose: Notion's subscription flow requires the operator to copy this value into the secret store.
    log(`notion_webhook_verification_token=${payload.verification_token}`);
    return json({ ok: true, verification: 'logged' });
  }
  if (!secretOk(secret)) return json({ error: 'webhook_not_configured' }, 503);
  const header = request.headers.get('x-notion-signature') ?? '';
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return json({ error: 'signature_missing' }, 401);
  const expected = await hmacHex(secret, raw);
  if (!(await constantTimeSecretEqual(expected, match[1].toLowerCase()))) return json({ error: 'signature_invalid' }, 401);
  if (!idPattern.test(payload.id ?? '') || typeof payload.type !== 'string' || !payload.entity || typeof payload.entity.id !== 'string') {
    return json({ error: 'invalid_event' }, 400);
  }
  const occurredAt = typeof payload.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(payload.timestamp)
    ? payload.timestamp : new Date().toISOString();
  return persistAndSchedule({ store, schedule, run, event: { eventId: `notion:${payload.id}`, source: 'notion', occurredAt, isFixture: false,
    payload: { type: payload.type.slice(0, 80), entity: { id: payload.entity.id, type: payload.entity.type ?? null },
      data: payload.data ?? {}, authors: Array.isArray(payload.authors) ? payload.authors.slice(0, 10) : [], workspaceId: payload.workspace_id ?? null } } });
}

/**
 * Portal contract (Interviewer): POST JSON {event:'submission.uploaded', deliveryId, candidateEmail, submissionId,
 * submissionUrl, uploadedAt, attemptId?} with header x-uncle-sam-secret: <PORTAL_WEBHOOK_SECRET>.
 */
export async function handlePortalWebhook(request, { secret, store, schedule, run } = {}) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, { allow: 'POST' });
  if (!secretOk(secret)) return json({ error: 'webhook_not_configured' }, 503);
  const provided = request.headers.get('x-uncle-sam-secret') ?? '';
  if (!provided || !(await constantTimeSecretEqual(secret, provided))) return json({ error: 'unauthorized' }, 401);
  const body = await readBody(request);
  if (body.error) return body.error;
  const { payload } = body;
  if (typeof payload.event !== 'string' || !/^[a-z_.]{3,60}$/.test(payload.event)) return json({ error: 'invalid_event' }, 400);
  const deliveryId = typeof payload.deliveryId === 'string' && idPattern.test(payload.deliveryId) ? payload.deliveryId
    : typeof payload.submissionId === 'string' && idPattern.test(payload.submissionId) ? payload.submissionId : null;
  if (!deliveryId) return json({ error: 'delivery_id_required' }, 400);
  const occurredAt = typeof payload.uploadedAt === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(payload.uploadedAt)
    ? payload.uploadedAt : new Date().toISOString();
  const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : null;
  return persistAndSchedule({ store, schedule, run, event: { eventId: `portal:${payload.event}:${deliveryId}`, source: 'portal', occurredAt, isFixture: false,
    payload: { event: payload.event, deliveryId, candidateEmail: text(payload.candidateEmail, 254), candidateName: text(payload.candidateName, 160),
      submissionId: text(payload.submissionId, 120), submissionUrl: text(payload.submissionUrl, 2048), attemptId: text(payload.attemptId, 80), uploadedAt: occurredAt } } });
}
