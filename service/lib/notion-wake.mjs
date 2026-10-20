// Creates operational wake records only. No candidate changes, hiring decisions, or sends.
export const NOTION_API_VERSION = '2025-09-03';
export const OPS_SOURCE_ID = '32b3ba1c-6963-40eb-9a96-30f18bba29fd';
export const CONTROL_PAGE_ID = 'c71e1782-2660-4a92-93fb-5977b1e4a8c9';
const SLACK_ORIGIN = 'https://example-workspace.slack.com';
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameId = (a, b) => typeof a === 'string' && a.replaceAll('-', '').toLowerCase() === b.replaceAll('-', '').toLowerCase();
const richText = text => ({ rich_text: [{ type: 'text', text: { content: text } }] });
const select = name => ({ select: { name } });
const date = ms => ({ date: { start: new Date(ms).toISOString() } });
const textOf = property => (property?.rich_text ?? []).map(part => part.plain_text ?? part.text?.content ?? '').join('');

class WakeError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

function explicitTime(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function controlOf(page) {
  const props = page?.properties;
  if (page?.object !== 'page' || !sameId(page.id, CONTROL_PAGE_ID) || page.archived || page.in_trash ||
      props?.['Record kind']?.select?.name !== 'Control' || textOf(props?.['Request key']) !== 'uncle-sam:control') {
    throw new WakeError('invalid_control');
  }
  const mode = props.Mode?.select?.name;
  if (!['Off', 'Test', 'Live'].includes(mode)) throw new WakeError('invalid_control_mode');
  return { mode, baselineComplete: props['Baseline complete']?.checkbox === true,
    activatedAt: explicitTime(props['Activated at']?.date?.start),
    policyVersion: textOf(props['Policy version']) };
}

function gate(control, event) {
  if (control.mode === 'Off') return 'mode_off';
  if (control.mode === 'Test') return event.isFixture === true ? null : 'fixture_required';
  if (event.isFixture === true) return 'fixture_not_live';
  if (!control.baselineComplete || control.activatedAt === null) return 'baseline_incomplete';
  if (event.occurredAt < control.activatedAt) return 'before_activation';
  return null;
}

function validEvent(event, eventId) {
  if (!event || event.eventId !== eventId || event.source !== 'slack' || event.status !== 'Observed' ||
      typeof event.isFixture !== 'boolean' || !/^[A-Z0-9]+$/.test(event.teamId ?? '') ||
      !/^[CDG][A-Z0-9]+$/.test(event.channelId ?? '') || !/^[UW][A-Z0-9]+$/.test(event.authorId ?? '') ||
      !/^\d{1,13}\.\d{1,6}$/.test(event.messageTs ?? '') ||
      (event.threadTs != null && !/^\d{1,13}\.\d{1,6}$/.test(event.threadTs))) return false;
  return explicitTime(event.occurredAt) !== null && explicitTime(event.observedAt) !== null;
}

function createBody(event, control, attemptId) {
  const sourceUrl = `${SLACK_ORIGIN}/archives/${event.channelId}/p${event.messageTs.replace('.', '').padEnd(event.messageTs.indexOf('.') + 6, '0')}`;
  const info = { event_id: event.eventId, source: 'slack', workspace: event.teamId,
    conversation: event.channelId, author: event.authorId, message_ts: event.messageTs,
    thread_ts: event.threadTs ?? null, is_fixture: event.isFixture };
  return { parent: { type: 'data_source_id', data_source_id: OPS_SOURCE_ID }, properties: {
    Name: { title: [{ type: 'text', text: { content: `${event.isFixture ? 'Test fixture' : 'Slack event'} · ${event.eventId}` } }] },
    'Record kind': select('Request'), Mode: select(control.mode), State: select('Ready'),
    Action: richText('process_slack_event'), 'Request key': richText(`slack:event:${event.eventId}`),
    'Source event key': richText(event.eventId), 'Delivery attempt ID': richText(attemptId),
    'Event occurred at': date(event.occurredAt), 'Observed at': date(event.observedAt),
    'Policy version': richText(control.policyVersion.slice(0, 2000)),
    'Slack conversation ID': richText(event.channelId), 'Slack message ts': richText(event.messageTs),
    'Slack thread ts': richText(event.threadTs ?? ''),
    'Slack message URL': { url: sourceUrl }, 'Source URL': { url: sourceUrl },
  }, children: [
    { object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: {
      content: 'A verified Slack event is available for policy evaluation. Read the complete source through get_event using the event_id below. This operational record is not a hiring decision or permission to send. Test fixtures permit dry-run output only.',
    } }] } },
    { object: 'block', type: 'code', code: { language: 'json', rich_text: [{ type: 'text',
      text: { content: JSON.stringify(info, null, 2) } }] } },
  ] };
}

async function boundedJson(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new WakeError('response_too_large');
  if (!response.body) throw new WakeError('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WakeError('response_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new WakeError('invalid_response'); }
}

/**
 * Invoke only after signature verification and durable event storage, outside Slack's ACK.
 * getEvent.isFixture must be canonical server metadata, never derived from Slack content.
 * Notion and D1 mode controls must both permit the effect. A pause after the final checks
 * cannot undo an in-flight create. Uncertain creates keep their claim for reconciliation;
 * this adapter never retries a write or resets an uncertain claim.
 */
export function createNotionWake({ env = {}, store, fetchImpl = globalThis.fetch,
  timeoutMs = 8000, maxResponseBytes = 512 * 1024 } = {}) {
  if (!store || ['getEvent', 'claimEventWake', 'authorizeEventWake', 'releaseEventWake',
    'markEventNotionWake', 'markWakeUncertain'].some(name => typeof store[name] !== 'function') ||
    typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
    !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new TypeError('Invalid wake dependencies');

  const request = async (path, method = 'GET', body) => {
    const controller = new AbortController();
    let timer;
    const operation = async () => {
      let response;
      try {
        response = await fetchImpl(`https://api.notion.com/v1${path}`, {
          method, redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, 'notion-version': NOTION_API_VERSION,
            'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch { throw new WakeError('network_error'); }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new WakeError(`notion_http_${response.status}`, response.status);
      }
      return boundedJson(response, maxResponseBytes);
    };
    try {
      return await Promise.race([operation(), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new WakeError('request_timeout')); }, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };

  return async function wakeEvent({ eventId, attemptId } = {}) {
    if (!idPattern.test(eventId ?? '') || !idPattern.test(attemptId ?? '')) return { status: 'blocked', reason: 'invalid_identifiers' };
    if (typeof env.NOTION_TOKEN !== 'string' || !env.NOTION_TOKEN || /\s/.test(env.NOTION_TOKEN)) {
      return { status: 'blocked', reason: 'notion_not_configured' };
    }
    let claimed = false;
    let createStarted = false;
    const release = async reason => {
      const result = await store.releaseEventWake({ eventId, attemptId, reason, preCreateFailure: true });
      return { status: 'blocked', reason, claimReleased: result?.updated === true };
    };
    const uncertain = async reason => {
      let recorded = false;
      try { recorded = (await store.markWakeUncertain({ eventId, attemptId, reason }))?.updated === true; } catch {}
      return { status: 'uncertain', reason, uncertaintyRecorded: recorded };
    };
    const complete = async (pageId, reused) => {
      const saved = await store.markEventNotionWake({ eventId, attemptId, pageId });
      if (saved?.recorded !== true) return uncertain('wake_receipt_not_recorded');
      return { status: 'complete', eventId, pageId, reused };
    };
    try {
      const event = await store.getEvent(eventId);
      if (event?.notionWakePageId) return { status: 'complete', eventId, pageId: event.notionWakePageId, reused: true };
      if (!validEvent(event, eventId)) return { status: 'blocked', reason: 'event_not_eligible' };
      event.occurredAt = explicitTime(event.occurredAt);
      event.observedAt = explicitTime(event.observedAt);
      const control = controlOf(await request(`/pages/${CONTROL_PAGE_ID}`));
      const denied = gate(control, event);
      if (denied) return { status: 'blocked', reason: denied };
      const claim = await store.claimEventWake({ eventId, attemptId });
      if (claim?.claimed !== true) return { status: 'blocked', reason: 'wake_not_claimable' };
      claimed = true;
      const found = await request(`/data_sources/${OPS_SOURCE_ID}/query`, 'POST', {
        filter: { property: 'Source event key', rich_text: { equals: eventId } }, page_size: 2,
      });
      if (found?.object !== 'list' || !Array.isArray(found.results) || typeof found.has_more !== 'boolean') {
        throw new WakeError('invalid_query_response');
      }
      if (found.has_more || found.results.length > 1) return uncertain('duplicate_or_incomplete_source_query');
      if (found.results.length === 1) {
        const page = found.results[0];
        if (page.object !== 'page' || !uuidPattern.test(page.id ?? '') || page.archived || page.in_trash ||
            !sameId(page.parent?.data_source_id, OPS_SOURCE_ID) || textOf(page.properties?.['Source event key']) !== eventId) {
          return uncertain('source_event_collision');
        }
        return await complete(page.id, true);
      }
      const finalControl = controlOf(await request(`/pages/${CONTROL_PAGE_ID}`));
      const finalDenied = gate(finalControl, event);
      if (finalDenied) return await release(finalDenied);
      if (!(await store.authorizeEventWake({ eventId, attemptId }))?.allowed) return await release('wake_authorization_stale');
      const body = createBody(event, finalControl, attemptId);
      createStarted = true;
      const created = await request('/pages', 'POST', body);
      if (created?.object !== 'page' || !uuidPattern.test(created.id ?? '') || created.archived || created.in_trash ||
          !sameId(created.parent?.data_source_id, OPS_SOURCE_ID) ||
          textOf(created.properties?.['Source event key']) !== eventId) return uncertain('invalid_create_receipt');
      return await complete(created.id, false);
    } catch (error) {
      const reason = error instanceof WakeError ? error.code : 'wake_dependency_failed';
      if (!claimed) return { status: 'blocked', reason };
      // Only definitive API refusal can release a started create. All ambiguous
      // responses, network errors, timeouts, or receipt failures retain the claim.
      if (createStarted && !(error instanceof WakeError && [400, 401, 403, 404, 422, 429].includes(error.status))) {
        return uncertain(reason);
      }
      try { return await release(reason); }
      catch { return uncertain('claim_release_failed'); }
    }
  };
}
