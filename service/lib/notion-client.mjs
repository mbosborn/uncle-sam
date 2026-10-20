/**
 * Bounded Notion REST adapter for the Phase 2 runner. Reads the control row, the
 * Recruiting Pipeline and candidate pages, take-home scorecards and the Interviewer links board; writes only
 * (a) candidate brief/next action/Action Status patches that passed planConciseCandidateUpdate, (b) dated
 * append-only notes, (c) Uncle Sam Operations receipt rows and (d) Interviewer's recommendation on a take-home
 * scorecard (Interviewer review, its source, and his own score kept apart from the portal grade), and (e) closing a candidate on
 * an @-mention: Outcome Withdrawn or Unavailable / Not Selected, Stage Closed, Pipeline cleared, Next action, and for a
 * rejection the latest interview's end and its source, written first. Every write is read back.
 * Error codes never echo request or response bodies. No retries.
 */
import { NOTION_API_VERSION, OPS_SOURCE_ID, CONTROL_PAGE_ID } from './notion-wake.mjs';
import { isNonSendingRejectionBaseline } from './rejection-sender.mjs';

export const RECRUITING_SOURCE_ID = 'c4d27962-20e2-49ce-b694-f3b4cacddc05';
/** Recruiting Feedback (take-home and work-trial scorecards) and Recruiting Guides & Templates (the Interviewer links board). */
export const FEEDBACK_SOURCE_ID = 'c471e0af-fe68-4f21-ae7a-dc175bc73865';
export const GUIDES_SOURCE_ID = '5c014824-4335-4fd3-94aa-440d34b93739';
export const SANTOSH_REVIEWS = Object.freeze(['Advance recommended', 'Reject recommended']);
/**
 * The two stage fields on a take-home scorecard (Project, 2026-10-15): the take-home review, then the deep dive. Each has its
 * own three options; people can change them by hand and the Take-homes tab moves the row between sections.
 */
export const STAGE_FIELDS = Object.freeze({ 'Take-home review': ['Awaiting review', 'Passed take-home', 'Reject'], 'Deep dive': ['Awaiting deep dive', 'Invite sent', 'Booked', 'Passed deep dive', 'Reject'] });
export const OPERATIONS_STATES = Object.freeze(['Baselined', 'Held', 'Ready', 'Sending', 'Awaiting reply', 'Complete', 'Cancelled', 'Needs attention']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANDIDATE_FIELDS = ['Pipeline', 'Stage', 'Round', 'Outcome', 'Action Status', 'Color mode', 'Dot color',
  'Candidate brief', 'Next action', 'Rejection email status', 'Rejection email hold', 'Owner', 'Follow-up Date',
  'Daily recap milestone', 'Category', 'Track', 'Role', 'Paperwork', 'Paperwork signed', 'India Stage', 'Research Stage',
  'Trial Start', 'Trial End', 'Meeting Format', 'Payment Status', 'Documents',
  'Gmail access', 'Slack access', 'Okta access', 'Insightful access', 'AWS access', 'First check-in done'];

export class NotionError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

export const sameId = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  a.replaceAll('-', '').toLowerCase() === b.replaceAll('-', '').toLowerCase();
export const dashed = value => {
  const compact = String(value ?? '').replaceAll('-', '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(compact) ? compact.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5') : null;
};
const plain = parts => (Array.isArray(parts) ? parts : []).map(p => p.plain_text ?? p.text?.content ?? '').join('');
export const richText = text => ({ rich_text: text ? [{ type: 'text', text: { content: String(text).slice(0, 2000) } }] : [] });
export const select = name => ({ select: name ? { name } : null });
export const dateProp = value => ({ date: value == null ? null : { start: typeof value === 'number' ? new Date(value).toISOString() : value } });

function explicitTime(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

/** Collapses a Notion property value to a plain JS value the policy modules and the model can use. */
export function propertyValue(property) {
  if (!property || typeof property !== 'object') return null;
  switch (property.type) {
    case 'title': return plain(property.title);
    case 'rich_text': return plain(property.rich_text);
    case 'select': return property.select?.name ?? null;
    case 'status': return property.status?.name ?? null;
    case 'multi_select': return (property.multi_select ?? []).map(o => o.name);
    case 'checkbox': return property.checkbox === true;
    case 'date': return property.date?.start ?? null;
    case 'email': return property.email ?? null;
    case 'url': return property.url ?? null;
    case 'number': return property.number ?? null;
    case 'relation': return (property.relation ?? []).map(r => r.id);
    case 'people': return (property.people ?? []).map(p => p.id);
    case 'formula': { const f = property.formula; return f ? (f[f.type] ?? null) : null; }
    case 'last_edited_time': return property.last_edited_time ?? null;
    case 'created_time': return property.created_time ?? null;
    default: return null;
  }
}

/** Schema shape expected by planConciseCandidateUpdate: {dataSourceId, properties:{Name:{type, options}}}. */
export function normalizeLayout(dataSource) {
  const properties = {};
  for (const [name, def] of Object.entries(dataSource?.properties ?? {})) {
    const type = def?.type === 'rich_text' ? 'text' : def?.type;
    const options = ['select', 'multi_select', 'status'].includes(def?.type)
      ? (def[def.type]?.options ?? []).map(o => o.name) : undefined;
    properties[name] = options ? { type, options } : { type };
  }
  return { dataSourceId: dashed(dataSource?.id) ?? dataSource?.id ?? null, properties, verifiedAt: Date.now() };
}

export function controlOf(page) {
  const props = page?.properties;
  if (page?.object !== 'page' || !sameId(page.id, CONTROL_PAGE_ID) || page.archived || page.in_trash ||
      propertyValue(props?.['Record kind']) !== 'Control' || propertyValue(props?.['Request key']) !== 'uncle-sam:control') {
    throw new NotionError('invalid_control');
  }
  const mode = propertyValue(props.Mode);
  if (!['Off', 'Test', 'Live'].includes(mode)) throw new NotionError('invalid_control_mode');
  return { mode, baselineComplete: propertyValue(props['Baseline complete']) === true,
    activatedAt: explicitTime(propertyValue(props['Activated at'])),
    policyVersion: propertyValue(props['Policy version']) ?? '', state: propertyValue(props.State),
    // Project's pause for questions (@-mentions and DMs) without a redeploy. Only an explicit "Off" pauses them.
    questions: propertyValue(props.Questions) === 'Off' ? 'Off' : 'On' };
}

/**
 * One interview the clerk recorded in Uncle Sam Operations (Record kind "Interview"), in the shape the calendar planner reads.
 * The clerk is the hourly Claude task that reads calendars with Project's own access. It names the candidate (relation) and the
 * interviewers (Slack IDs), so nothing is matched by email. State "Cancelled" means the meeting was cancelled.
 */
export function interviewRowOf(page) {
  const props = page?.properties ?? {};
  const v = name => propertyValue(props[name]);
  const key = String(v('Source event key') ?? '').trim().slice(0, 200);
  const end = v('Event occurred at');
  const candidate = (v('Candidate') ?? [])[0] ?? null;
  return { id: key || page.id, iCalUID: key || page.id, summary: String(v('Name') ?? '').slice(0, 200),
    end: typeof end === 'string' && /T\d{2}:\d{2}/.test(end) ? end : null, start: null,
    status: v('State') === 'Cancelled' ? 'cancelled' : 'confirmed', htmlLink: v('Source URL') || page.url || null,
    updated: page.last_edited_time ?? null, attendees: [], allDay: false, fromClerk: true,
    candidatePageId: candidate ? dashed(candidate) : null,
    interviewerIds: [...new Set(String(v('Recipient Slack user IDs') ?? '').split(/[\s,]+/).filter(id => /^[UW][A-Z0-9]+$/.test(id)))] };
}

/** Normalizes a Recruiting Feedback page (a take-home or work-trial scorecard). */
export function scorecardOf(page) {
  if (page?.object !== 'page' || !uuidPattern.test(page.id ?? '')) throw new NotionError('invalid_scorecard_page');
  const props = page.properties ?? {};
  const v = name => propertyValue(props[name]);
  const parent = page.parent?.data_source_id ?? page.parent?.database_id ?? null;
  const score = v('Score / 100');
  return { pageId: page.id.toLowerCase(), url: page.url ?? null, name: String(v('Log score') ?? '').slice(0, 160),
    inFeedbackSource: sameId(parent, FEEDBACK_SOURCE_ID), archived: page.archived === true || page.in_trash === true,
    takeHome: v('Type') === 'Take-home' && v('Assessment kind') === 'Scorecard', superseded: v('Status') === 'Superseded',
    status: v('Take-home status'), submittedAt: v('Submitted at'), score: Number.isFinite(score) ? score : null,
    sentOn: v('Sent') ?? null, startedOn: v('Started on') ?? null, link: v('Assignment / submission') ?? null, portalCheck: v('Portal check') ?? null, overall: v('Overall status') ?? null,
    sentEmail: v('Sent email') ?? null, checkedAt: v('Score checked at') ?? null, createdAt: page.created_time ?? null,
    santoshReview: v('Interviewer review'), takeHomeReview: v('Take-home review') ?? null, deepDive: v('Deep dive') ?? null, santoshNotes: v('Interviewer notes') ?? null, reviewerScore: v('Reviewer score / 100'),
    candidateIds: (v('Candidate') ?? []).map(dashed).filter(Boolean) };
}

/** The separate rejection sender's own fields on a candidate page, read raw (never written except by a reviewed re-arm). */
export function senderFieldsOf(page) {
  const props = page?.properties ?? {};
  const v = name => propertyValue(props[name]);
  const text = name => { const value = v(name); return typeof value === 'string' && value.trim() ? value.trim() : null; };
  return { status: text('Rejection email status'), hold: v('Rejection email hold') === true, attempt: text('Rejection email attempt'),
    decisionAt: text('Rejection decision at'), decisionKey: text('Rejection email decision key'), queuedTo: text('Rejection email queued to'),
    scheduledFor: text('Rejection email scheduled for'), sentAt: text('Rejection email sent at'), lastInterviewEnd: text('Last interview ended at'),
    messageUrl: text('Rejection email message URL'),
    timingSource: text('Interview timing source') };
}

/** Normalizes a Recruiting Pipeline page. The trailing ⭐ is decorative and stripped from the name. */
export function candidateOf(page) {
  if (page?.object !== 'page' || !uuidPattern.test(page.id ?? '')) throw new NotionError('invalid_candidate_page');
  const props = page.properties ?? {};
  const titleKey = Object.keys(props).find(k => props[k]?.type === 'title') ?? 'Candidate';
  const fullName = String(propertyValue(props[titleKey]) ?? '').replace(/\s*⭐\s*$/u, '').trim();
  const email = String(propertyValue(props.Email) ?? '').trim();
  const fields = {};
  for (const name of CANDIDATE_FIELDS) if (name in props) fields[name] = propertyValue(props[name]);
  // Who they are, for telling same-named people apart in an @-mention answer: the company (From) and the LinkedIn field.
  // Kept out of `fields`, which the workflow lane's model reads.
  const textOf = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const profile = { from: textOf(propertyValue(props.From)), linkedin: textOf(propertyValue(props.LinkedIn)),
    ...(textOf(propertyValue(props['Latest Evidence'])) ? { latestEvidence: textOf(propertyValue(props['Latest Evidence'])) } : {}),
    ...(textOf(propertyValue(props['Category Basis'])) ? { categoryBasis: textOf(propertyValue(props['Category Basis'])) } : {}),
    ...(textOf(propertyValue(props['Review Note'])) ? { reviewNote: textOf(propertyValue(props['Review Note'])) } : {}) };
  // Trial pay (stripe-payments.mjs), also kept out of `fields`: payment figures never reach the model or a channel.
  const num = name => (typeof propertyValue(props[name]) === 'number' ? propertyValue(props[name]) : null);
  const payment = { owed: num('Trial Amount Owed'), planned: num('Planned Trial Payment'), paid: num('Paid Amount'), dailyRate: num('Daily Trial Rate'),
    days: num('Trial Days'), date: propertyValue(props['Payment Date']) ?? null };
  const parent = page.parent?.data_source_id ?? page.parent?.database_id ?? null;
  const emailVerified = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && email.length <= 254;
  return { pageId: page.id.toLowerCase(), fullName, email: emailVerified ? email : null, emailVerified,
    url: page.url ?? `https://www.notion.so/${page.id.replaceAll('-', '')}`,
    archived: page.archived === true || page.in_trash === true, parentId: parent,
    inRecruitingSource: sameId(parent, RECRUITING_SOURCE_ID), fields, profile, payment,
    lastEditedTime: page.last_edited_time ?? null, lastEditedBy: page.last_edited_by?.id ?? null, createdTime: page.created_time ?? null };
}

async function boundedJson(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new NotionError('response_too_large');
  if (!response.body) throw new NotionError('invalid_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new NotionError('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new NotionError('invalid_response'); }
}

export function createNotionClient({ env = {}, fetchImpl = globalThis.fetch, timeoutMs = 10000,
  maxResponseBytes = 1024 * 1024, clock = Date.now } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError('Invalid Notion client configuration');
  }
  const configured = () => typeof env.NOTION_TOKEN === 'string' && env.NOTION_TOKEN && !/\s/.test(env.NOTION_TOKEN);
  async function request(path, method = 'GET', body) {
    if (!configured()) throw new NotionError('notion_not_configured', 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`https://api.notion.com/v1${path}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, 'notion-version': NOTION_API_VERSION, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      clearTimeout(timer);
      throw new NotionError(error?.name === 'AbortError' ? 'request_timeout' : 'network_error');
    }
    clearTimeout(timer);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new NotionError(`notion_http_${response.status}`, response.status);
    }
    return boundedJson(response, maxResponseBytes);
  }
  async function query(sourceId, filter, pageSize = 5) {
    const found = await request(`/data_sources/${sourceId}/query`, 'POST', { filter, page_size: pageSize });
    if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
    return found;
  }
  let layoutCache = null;
  let selfCache = null;

  const api = Object.freeze({
    configured,
    /** Dispatcher-shaped control readback: {verified:true, readAt, mode, baselineComplete, activatedAt, policyVersion}. */
    async readControl() {
      const control = controlOf(await request(`/pages/${CONTROL_PAGE_ID}`));
      return { verified: true, readAt: clock(), ...control };
    },
    async getSelf() {
      if (!selfCache) {
        const me = await request('/users/me');
        if (me?.object !== 'user' || typeof me.id !== 'string') throw new NotionError('invalid_self');
        selfCache = { id: me.id.toLowerCase(), name: me.name ?? null, type: me.type ?? null };
      }
      return selfCache;
    },
    async getRecruitingLayout({ maxAgeMs = 300000 } = {}) {
      if (!layoutCache || clock() - layoutCache.verifiedAt > maxAgeMs) {
        const source = await request(`/data_sources/${RECRUITING_SOURCE_ID}`);
        if (source?.object !== 'data_source' || !sameId(source.id, RECRUITING_SOURCE_ID)) throw new NotionError('invalid_layout');
        layoutCache = { ...normalizeLayout(source), dataSourceId: RECRUITING_SOURCE_ID, verifiedAt: clock() };
      }
      return layoutCache;
    },
    async getCandidate(pageId) {
      const id = dashed(pageId);
      if (!id) throw new NotionError('invalid_page_id');
      const candidate = candidateOf(await request(`/pages/${id}`));
      if (!candidate.inRecruitingSource) throw new NotionError('candidate_not_in_recruiting_source');
      return candidate;
    },
    async findCandidatesByEmail(email) {
      if (typeof email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return [];
      const found = await query(RECRUITING_SOURCE_ID, { property: 'Email', email: { equals: email.trim() } }, 5);
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(candidateOf)
        .filter(c => c.email && c.email.toLowerCase() === email.trim().toLowerCase());
    },
    /**
     * Every open candidate (Stage not Closed or Hired; Outcome empty or Not Yet Decided), for matching names heard in a
     * recruiting meeting. Paged, bounded to 500 rows; archived pages and [TEST]/[FIXTURE] rows are left out.
     */
    async listActiveCandidates({ maxPages = 5, includeProceeding = false } = {}) {
      // includeProceeding: everyone still in the process (Proceeding and On Hold too), not only the undecided.
      const outcome = includeProceeding
        ? [{ property: 'Outcome', select: { does_not_equal: 'Not Selected' } }, { property: 'Outcome', select: { does_not_equal: 'Withdrawn or Unavailable' } }, { property: 'Outcome', select: { does_not_equal: 'Hired' } }]
        : [{ or: [{ property: 'Outcome', select: { is_empty: true } }, { property: 'Outcome', select: { equals: 'Not Yet Decided' } }] }];
      const filter = { and: [
        { property: 'Stage', select: { does_not_equal: 'Closed' } }, { property: 'Stage', select: { does_not_equal: 'Hired' } }, ...outcome] };
      const out = [];
      let cursor;
      for (let page = 0; page < Math.min(Math.max(maxPages, 1), 5); page++) {
        const found = await request(`/data_sources/${RECRUITING_SOURCE_ID}/query`, 'POST', { filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
        out.push(...found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(candidateOf));
        cursor = found.has_more === true && typeof found.next_cursor === 'string' ? found.next_cursor : null;
        if (!cursor) break;
      }
      return out.filter(c => c.inRecruitingSource && c.fullName && !/^\[(?:TEST|FIXTURE)\]/i.test(c.fullName));
    },
    /**
     * Not Selected candidates whose rejection email the separate sender set to "Needs attention" (stuck until Project re-arms it),
     * with the sender's own fields read raw. Bounded to 50.
     */
    async listStuckRejections() {
      const found = await request(`/data_sources/${RECRUITING_SOURCE_ID}/query`, 'POST', { page_size: 50, filter: { and: [
        { property: 'Outcome', select: { equals: 'Not Selected' } }, { property: 'Rejection email status', select: { equals: 'Needs attention' } }] } });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(page => ({ candidate: candidateOf(page), sender: senderFieldsOf(page) }))
        .filter(row => row.candidate.inRecruitingSource && !/^\[(?:TEST|FIXTURE)\]/i.test(row.candidate.fullName));
    },
    /** Rejections whose send may or may not have gone out (rejection-sender.mjs confirmUnclearSends): Sending, or Needs attention with an attempt. */
    async listUnclearRejections() {
      const found = await request(`/data_sources/${RECRUITING_SOURCE_ID}/query`, 'POST', { page_size: 50, filter: { or: [
        { property: 'Rejection email status', select: { equals: 'Sending' } },
        { and: [{ property: 'Rejection email status', select: { equals: 'Needs attention' } }, { property: 'Rejection email attempt', rich_text: { is_not_empty: true } }] }] } });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(page => ({ candidate: candidateOf(page), sender: senderFieldsOf(page) }))
        .filter(row => row.candidate.inRecruitingSource && !/^\[(?:TEST|FIXTURE)\]/i.test(row.candidate.fullName));
    },
    /**
     * Uncle Sam's rejection queue (rejection-sender.mjs): Not Selected rows with no rejection status yet, and every Scheduled
     * row (whatever its Outcome now, so a changed decision can be cancelled). Bounded to 100 each.
     */
    async listRejectionQueue() {
      const rows = [];
      for (const filter of [{ and: [{ property: 'Outcome', select: { equals: 'Not Selected' } }, { property: 'Rejection email status', select: { is_empty: true } }] },
        { property: 'Rejection email status', select: { equals: 'Scheduled' } }]) {
        const found = await request(`/data_sources/${RECRUITING_SOURCE_ID}/query`, 'POST', { page_size: 100, filter });
        if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
        for (const page of found.results) if (page.object === 'page' && !page.archived && !page.in_trash) rows.push({ candidate: candidateOf(page), sender: senderFieldsOf(page) });
      }
      return rows.filter(row => row.candidate.inRecruitingSource);
    },
    /**
     * Uncle Sam writing its own rejection queue and delivery fields (Project, 2026-10-15: Uncle Sam took over sending rejections).
     * `fields`: status, attempt, decisionAt, decisionKey, queuedTo, scheduledFor, sentAt, messageUrl, interviewEnd {at, sourceUrl},
     * and `close` (Stage Closed, Action Status Complete, Self-DM Tracker off). Status is written last and read back.
     */
    async writeRejection({ pageId, fields = {} } = {}) {
      const id = dashed(pageId);
      if (!id) throw new NotionError('invalid_page_id');
      const f = fields, properties = {};
      if ('attempt' in f) properties['Rejection email attempt'] = richText(f.attempt ? String(f.attempt).slice(0, 500) : '');
      if ('decisionAt' in f) properties['Rejection decision at'] = dateProp(f.decisionAt);
      if ('decisionKey' in f) properties['Rejection email decision key'] = richText(f.decisionKey);
      if ('queuedTo' in f) properties['Rejection email queued to'] = { email: f.queuedTo || null };
      if ('scheduledFor' in f) properties['Rejection email scheduled for'] = dateProp(f.scheduledFor);
      if ('sentAt' in f) properties['Rejection email sent at'] = dateProp(f.sentAt);
      if ('messageUrl' in f) properties['Rejection email message URL'] = { url: f.messageUrl || null };
      if (f.interviewEnd) { properties['Last interview ended at'] = dateProp(f.interviewEnd.at); properties['Interview timing source'] = { url: f.interviewEnd.sourceUrl }; }
      if (f.close) { properties.Stage = select('Closed'); properties['Action Status'] = select('Complete'); properties['Self-DM Tracker'] = { checkbox: false }; }
      if (Object.keys(properties).length) await request(`/pages/${id}`, 'PATCH', { properties });
      if (f.status) await request(`/pages/${id}`, 'PATCH', { properties: { 'Rejection email status': select(f.status) } });
      const after = await api.getRejectionState(id);
      if (f.status && after.sender.status !== f.status) throw new NotionError('rejection_readback_mismatch');
      if ('attempt' in f && f.attempt && after.sender.attempt !== String(f.attempt).slice(0, 500)) throw new NotionError('rejection_readback_mismatch');
      return after;
    },
    /** The sender's fields of one candidate, read fresh. */
    async getRejectionState(pageId) {
      const id = dashed(pageId);
      if (!id) throw new NotionError('invalid_page_id');
      const page = await request(`/pages/${id}`);
      const candidate = candidateOf(page);
      if (!candidate.inRecruitingSource) throw new NotionError('candidate_not_in_recruiting_source');
      return { candidate, sender: senderFieldsOf(page) };
    },
    /**
     * Project's reviewed re-arm of a stuck rejection (his "go" in Slack): writes the queue the sender reads (interview end when
     * missing, decision time and key when missing, queued recipient, earliest send) and sets Scheduled, then reads it back.
     * Refuses unless the row is still Not Selected, Needs attention, not on hold and the email is the one Project saw.
     */
    async rearmRejection({ pageId, expectedEmail, interviewEnd = null, decisionAt, decisionKey, scheduledFor } = {}) {
      const before = await api.getRejectionState(pageId);
      const c = before.candidate, s = before.sender;
      if (c.archived || !c.email || c.email !== expectedEmail) throw new NotionError('candidate_identity_changed');
      if (c.fields.Outcome !== 'Not Selected' || s.status !== 'Needs attention' || s.hold) throw new NotionError('rejection_not_stuck');
      if (explicitTime(scheduledFor) === null || explicitTime(decisionAt) === null || typeof decisionKey !== 'string' || !decisionKey || decisionKey.length > 200) throw new NotionError('invalid_rearm');
      const properties = { 'Rejection decision at': dateProp(decisionAt), 'Rejection email decision key': richText(decisionKey),
        'Rejection email queued to': { email: c.email }, 'Rejection email scheduled for': dateProp(scheduledFor) };
      if (interviewEnd) {
        if (explicitTime(interviewEnd.at) === null) throw new NotionError('invalid_interview_end');
        try { if (new URL(interviewEnd.sourceUrl).protocol !== 'https:') throw new Error(); } catch { throw new NotionError('invalid_interview_source'); }
        properties['Last interview ended at'] = dateProp(interviewEnd.at);
        properties['Interview timing source'] = { url: interviewEnd.sourceUrl };
      }
      await request(`/pages/${c.pageId}`, 'PATCH', { properties });
      await request(`/pages/${c.pageId}`, 'PATCH', { properties: { 'Rejection email status': select('Scheduled') } });
      const after = await api.getRejectionState(c.pageId);
      if (after.sender.status !== 'Scheduled' || after.sender.queuedTo !== c.email || after.sender.decisionKey !== decisionKey || !after.sender.scheduledFor || !after.sender.lastInterviewEnd)
        throw new NotionError('rearm_readback_mismatch');
      return { verified: true, pageId: c.pageId, scheduledFor: after.sender.scheduledFor };
    },
    /** Candidates whose LinkedIn field holds this profile slug (linkedin.com/in/<slug>), at most 10. */
    async findCandidatesByLinkedIn(slug) {
      if (typeof slug !== 'string' || !/^[a-z0-9_%-]{3,100}$/i.test(slug)) return [];
      const found = await query(RECRUITING_SOURCE_ID, { property: 'LinkedIn', url: { contains: slug } }, 10);
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(candidateOf)
        .filter(c => new RegExp(`linkedin\\.com/in/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?(?:$|[?#])`, 'i').test(String(c.profile?.linkedin ?? '')));
    },
    async findCandidatesByName(name) {
      if (typeof name !== 'string' || name.trim().length < 2 || name.length > 120) return [];
      const found = await query(RECRUITING_SOURCE_ID, { property: 'Candidate', title: { contains: name.trim() } }, 10);
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(candidateOf);
    },
    /**
     * Identity lookup across current and historical recruiting evidence, independent of Stage/Outcome.
     * Query only schema-verified fields. Bounded pagination is explicit; an incomplete result cannot identify a unique person.
     */
    async searchCandidateEvidence({ terms = [], alternatives = [] } = {}) {
      if (!terms.length || terms.length > 12 || alternatives.length !== terms.length
          || alternatives.some(a => !Array.isArray(a) || !a.length || a.length > 3 || a.some(t => typeof t !== 'string' || !/^[\p{L}\p{N} ]{1,80}$/u.test(t)))) {
        throw new NotionError('invalid_discovery_terms');
      }
      const layout = await api.getRecruitingLayout();
      const searchable = ['Candidate', 'From', 'Role', 'Category', 'Track', 'Candidate brief', 'Next action', 'Category Basis', 'Review Note'];
      // Search the most identifying clue first, then verify ALL clues in trusted code. This avoids compound-filter limits
      // and permits evidence spread across fields (including a role stored as its full words rather than an abbreviation).
      const generic = new Set(['interview', 'reschedul', 'cancel', 'spl', 'spa', 'mle', 'engineer']);
      const anchor = Math.max(0, terms.findIndex(t => !generic.has(t)));
      const clauses = [];
      for (const property of searchable) {
        const field = layout.properties[property];
        if (!field) continue;
        for (const term of alternatives[anchor]) {
          if (field.type === 'title' || field.type === 'text') clauses.push({ property, [field.type === 'text' ? 'rich_text' : 'title']: { contains: term } });
          else if (['select', 'multi_select'].includes(field.type)) {
            for (const option of field.options ?? []) {
              if (option.toLowerCase().includes(term.toLowerCase())) clauses.push({ property, [field.type]: { [field.type === 'select' ? 'equals' : 'contains']: option } });
            }
          }
        }
      }
      if (!clauses.length) throw new NotionError('candidate_search_schema_unavailable');
      const candidates = [], seen = new Set();
      let cursor = null;
      for (let page = 0; page < 3; page++) {
        const found = await request(`/data_sources/${RECRUITING_SOURCE_ID}/query`, 'POST',
          { filter: { or: clauses }, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
        for (const raw of found.results) {
          if (raw.object !== 'page' || raw.archived || raw.in_trash || seen.has(raw.id)) continue;
          seen.add(raw.id);
          const c = candidateOf(raw);
          if (c.inRecruitingSource && !/^\[(?:TEST|FIXTURE)\]/i.test(c.fullName)) candidates.push(c);
        }
        if (!found.has_more) return { candidates, truncated: false };
        if (typeof found.next_cursor !== 'string' || !found.next_cursor) throw new NotionError('candidate_search_cursor_missing');
        cursor = found.next_cursor;
      }
      return { candidates, truncated: true };
    },
    /**
     * Applies a plan from planConciseCandidateUpdate. Only Candidate brief, Next action and
     * Action Status may be written; Color mode / Dot color are never touched. Reads back.
     */
    async applyCandidatePlan({ pageId, properties, expectedEmail } = {}) {
      const id = dashed(pageId);
      if (!id || !properties || typeof properties !== 'object') throw new NotionError('invalid_candidate_patch');
      const allowed = ['Candidate brief', 'Next action', 'Action Status'];
      const patch = {};
      for (const [name, value] of Object.entries(properties)) {
        if (!allowed.includes(name) || typeof value !== 'string') throw new NotionError('candidate_patch_not_allowed');
        patch[name] = name === 'Action Status' ? select(value) : richText(value);
      }
      const before = await api.getCandidate(id);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      const updated = candidateOf(await request(`/pages/${id}`, 'PATCH', { properties: patch }));
      const readback = await api.getCandidate(id);
      for (const [name, value] of Object.entries(properties)) {
        if (String(readback.fields[name] ?? '') !== value) throw new NotionError('candidate_readback_mismatch');
      }
      if (readback.fields['Color mode'] !== before.fields['Color mode'] ||
          (before.fields['Color mode'] === 'Manual override' && readback.fields['Dot color'] !== before.fields['Dot color'])) throw new NotionError('color_selection_changed');
      return { verified: true, pageId: id, lastEditedTime: updated.lastEditedTime, properties: { ...properties } };
    },
    /** Pipeline on a candidate who has none (pipeline-check.mjs): US/EU or India only, never Research (COLM). Reads back. */
    async setPipeline({ pageId, expectedEmail = null, pipeline, replace = false, indiaStage = undefined } = {}) {
      if (!['US/EU', 'India'].includes(pipeline)) throw new NotionError('invalid_pipeline');
      // indiaStage (new-bookings.mjs, on Project's word): India Stage set with an India pipeline, cleared (null) when moved to US/EU.
      if (indiaStage !== undefined && indiaStage !== null && !['First Round', 'Take Home', 'Outreach'].includes(indiaStage)) throw new NotionError('invalid_india_stage');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      // `replace` only on Project's word, or (clay-pipelines.mjs) to correct a pipeline Uncle Sam itself set from a booking page;
      // the hourly check never overwrites a pipeline someone set.
      const stageChange = indiaStage !== undefined && (before.fields['India Stage'] ?? null) !== indiaStage;
      if (before.fields.Pipeline && (!replace || before.fields.Pipeline === pipeline) && !stageChange) return { verified: true, pageId: before.pageId, pipeline: before.fields.Pipeline, unchanged: true };
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: { Pipeline: select(pipeline), ...(indiaStage !== undefined ? { 'India Stage': select(indiaStage) } : {}) } });
      const after = await api.getCandidate(before.pageId);
      if (after.fields.Pipeline !== pipeline) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId, pipeline };
    },
    /**
     * A new candidate from a booking (new-bookings.mjs): name, email, LinkedIn, a Next action, Pipeline only when known, and
     * either Intro Call / R1 — Intro / Not Yet Decided or (a deep dive booked) Case Study / R3 — Case Study / Proceeding.
     * Refuses an email already on the tracker. Reads back.
     */
    async createCandidate({ fullName, email, linkedin = null, pipeline = null, nextAction, stage = 'Interview', round = 'R2 — Technical', outcome = 'Not Yet Decided', indiaStage = null, source = null,
      category = null, categoryBasis = null, track = null, owners = [], actionStatus = null } = {}) {
      // The board groups each column by Category, so a new record without one lands outside the role's row (Project, 2026-10-19,
      // on Kai Sterling: "not seeing this guy in the right section").
      if (category !== null && !['ML/RL engineers', 'Junior engineers', 'Researchers', 'Ops people'].includes(category)) throw new NotionError('invalid_category');
      if (track !== null && !['ML & RL Engineering', 'Research', 'Engineering', 'Scope to Confirm'].includes(track)) throw new NotionError('invalid_track');
      if (actionStatus !== null && !['Meeting Booked', 'Waiting on Candidate', 'Needs Project'].includes(actionStatus)) throw new NotionError('invalid_action_status');
      if (!Array.isArray(owners) || owners.some(o => !['Project', 'Robin', 'Interviewer', 'Alexis'].includes(o))) throw new NotionError('invalid_owner');
      if (indiaStage !== null && (pipeline !== 'India' || !['First Round', 'Take Home', 'Outreach'].includes(indiaStage))) throw new NotionError('invalid_india_stage');
      const allowed = { 'Intro Call|R1 — Intro|Not Yet Decided': true, 'Interview|R2 — Technical|Not Yet Decided': true, 'Outreach|null|Not Yet Decided': true, 'Case Study|R3 — Case Study|Proceeding': true };
      if (!allowed[`${stage}|${round}|${outcome}`]) throw new NotionError('invalid_new_candidate_stage');
      const name = String(fullName ?? '').replace(/\s+/g, ' ').trim();
      // Someone who answered Robin's LinkedIn message may have no email yet (Outreach only, with their LinkedIn).
      const noEmail = !email && stage === 'Outreach' && !!linkedin;
      if (name.length < 3 || name.length > 120 || (!noEmail && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email ?? ''))) throw new NotionError('invalid_new_candidate');
      if (source !== null && !['LinkedIn outbound', 'Referral', 'Inbound'].includes(source)) throw new NotionError('invalid_source');
      if (pipeline !== null && !['US/EU', 'India'].includes(pipeline)) throw new NotionError('invalid_pipeline');
      if (linkedin !== null && !/^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]{3,100}\/?$/.test(linkedin)) throw new NotionError('invalid_linkedin');
      if (!noEmail && (await api.findCandidatesByEmail(email)).length) throw new NotionError('candidate_exists');
      if (linkedin && (await api.findCandidatesByLinkedIn(linkedin.replace(/\/$/, '').split('/in/')[1])).length) throw new NotionError('candidate_exists');
      const properties = { Candidate: { title: [{ type: 'text', text: { content: name } }] }, ...(noEmail ? {} : { Email: { email: email.trim().toLowerCase() } }), ...(source ? { Source: select(source) } : {}),
        Stage: select(stage), Round: select(round), Outcome: select(outcome), 'Next action': richText(nextAction),
        ...(linkedin ? { LinkedIn: { url: linkedin } } : {}), ...(pipeline ? { Pipeline: select(pipeline) } : {}), ...(indiaStage ? { 'India Stage': select(indiaStage) } : {}),
        ...(category ? { Category: select(category) } : {}), ...(categoryBasis ? { 'Category Basis': richText(categoryBasis) } : {}), ...(track ? { Track: select(track) } : {}),
        ...(owners.length ? { Owner: { multi_select: owners.map(name => ({ name })) } } : {}), ...(actionStatus ? { 'Action Status': select(actionStatus) } : {}) };
      const page = await request('/pages', 'POST', { parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID }, properties });
      if (typeof page?.id !== 'string') throw new NotionError('create_unverified');
      const after = await api.getCandidate(page.id);
      if (after.fullName !== name || (!noEmail && (after.email ?? '').toLowerCase() !== email.trim().toLowerCase()) || after.fields.Stage !== stage) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId, url: after.url };
    },
    /**
     * What an interview recap in #int-recruitment says (recap-intake.mjs), and only that: Stage from Outreach or Intro Call to
     * Interview / R2 — Technical (India Stage First Round for India) once the intro is behind them; Outcome On Hold (from an
     * open outcome) or Proceeding (from Not Yet Decided or blank); Next action; Follow-up Date. Never closes or reopens anyone.
     */
    async applyExplicitRecapDecision({ pageId, expectedEmail, expectedLastEditedTime, outcome, who, quote, sourceUrl, interviewEnd = null, existingStep = null, sourceText = '' } = {}) {
      if (!['Proceeding', 'Not Selected'].includes(outcome) || !['Robin', 'Alexis', 'Interviewer', 'Project'].includes(who)
        || typeof quote !== 'string' || quote.length < 6 || !/^https:\/\/example-workspace\.slack\.com\/archives\/C01D1A69CE3\/p\d{16}$/.test(sourceUrl ?? '')) throw new NotionError('invalid_recap_decision');
      const { candidate: before, sender } = await api.getRejectionState(pageId);
      if (before.archived || !expectedEmail || before.email !== expectedEmail || before.lastEditedTime !== expectedLastEditedTime) throw new NotionError('candidate_identity_changed');
      const nonSendingBaseline = isNonSendingRejectionBaseline(sender);
      if (['Hired', 'Withdrawn or Unavailable'].includes(before.fields.Outcome) || before.fields.Stage === 'Hired' || (sender.attempt && !nonSendingBaseline)
        || ['Sending', 'Needs attention'].includes(sender.status)) throw new NotionError('recap_decision_conflict');
      if (outcome === 'Not Selected' && (sender.sentAt || ['Sent', 'Scheduled'].includes(sender.status))) throw new NotionError('rejection_already_queued');
      if (outcome === 'Not Selected' && (!interviewEnd || explicitTime(interviewEnd.at) === null || !/^https:\/\//.test(interviewEnd.sourceUrl ?? ''))) throw new NotionError('invalid_interview_end');
      const nextAction = outcome === 'Proceeding' ? existingStep === 'sent' ? 'Take-home already delivered or recorded. Await submission/review; do not send another.' : existingStep === 'queued' ? 'Take-home already queued. Keep the existing cancel window; do not queue another.' : `${who}: ${quote}. Take-home delivery uses the normal queue and duplicate checks.`
        : `Not selected by ${who}. Rejection email uses the normal 24-hour window.`;
      // Preserve the old brief and hold in append-only history before replacing current-state prose.
      const history = `${new Date(clock()).toISOString()} · Explicit newer decision from ${who}: ${quote}. Supersedes earlier tracker instructions. Prior status: ${before.fields.Outcome ?? ''} / ${before.fields['Action Status'] ?? ''}. Prior brief: ${before.fields['Candidate brief'] ?? ''} Prior next action: ${before.fields['Next action'] ?? ''}${nonSendingBaseline ? ` Prior non-sending baseline: ${sender.attempt}` : ''}\nCurrent source post: ${String(sourceText).slice(0, 8000)}`;
      for (let i = 0; i < history.length; i += 1700) await api.appendCandidateNote({ pageId: before.pageId, sourceUrl, text: history.slice(i, i + 1700) });
      const properties = { Outcome: select(outcome), 'Action Status': select(null), 'Rejection email hold': { checkbox: false },
        'Next action': richText(nextAction), 'Latest Evidence': { url: sourceUrl },
        'Candidate brief': richText(`Status: ${outcome === 'Proceeding' ? existingStep ? 'Proceeding; take-home already delivered or queued' : 'Proceeding to take-home' : 'Not Selected'}.\nLatest: ${who}: ${quote}.\nNext: ${nextAction}\nHistory: Previous instructions are retained in the dated notes.`) };
      if (nonSendingBaseline) properties['Rejection email attempt'] = richText('');
      if (outcome === 'Not Selected') {
        properties.Stage = select('Closed'); properties.Pipeline = select(null);
        properties['Last interview ended at'] = dateProp(interviewEnd.at); properties['Interview timing source'] = { url: interviewEnd.sourceUrl };
        properties['Rejection email status'] = select(null);
      } else {
        if (['Closed', 'Intro Call'].includes(before.fields.Stage)) { properties.Stage = select('Interview'); properties.Round = select('R2 — Technical'); }
        if (existingStep === 'sent' && ['Closed', 'Intro Call', 'Outreach', 'Interview'].includes(before.fields.Stage)) {
          properties.Stage = select('Case Study'); properties.Round = select('R3 — Case Study');
          if (before.fields.Pipeline === 'India') properties['India Stage'] = select('Take Home');
        }
        if (sender.status && sender.status !== 'Sent') properties['Rejection email status'] = select('Cancelled');
      }
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getRejectionState(before.pageId);
      if (after.candidate.fields.Outcome !== outcome || after.sender.hold || after.candidate.fields['Next action'] !== nextAction
        || after.candidate.profile.latestEvidence !== sourceUrl || after.candidate.fields['Action Status'] != null) throw new NotionError('recap_decision_readback_mismatch');
      return { verified: true, candidate: after.candidate };
    },
    async recordRecap({ pageId, expectedEmail = null, toInterview = false, toIntro = false, outcome = null, nextAction = null, followUp = null } = {}) {
      if (outcome !== null && !['On Hold', 'Proceeding'].includes(outcome)) throw new NotionError('invalid_outcome');
      if (followUp !== null && !/^\d{4}-\d{2}-\d{2}$/.test(followUp)) throw new NotionError('invalid_follow_up');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      const f = before.fields;
      if (['Not Selected', 'Withdrawn or Unavailable', 'Hired'].includes(f.Outcome) || ['Closed', 'Hired'].includes(f.Stage)) throw new NotionError('candidate_already_closed');
      const properties = {};
      if (toInterview && [null, undefined, '', 'Outreach', 'Intro Call'].includes(f.Stage)) {
        properties.Stage = select('Interview'); properties.Round = select('R2 — Technical');
        if (f.Pipeline === 'India' && [null, undefined, '', 'Outreach', 'First Round'].includes(f['India Stage'])) properties['India Stage'] = select('First Round');
      } else if (toIntro && f.Stage === 'Outreach') {
        // A recap shows the call happened: it was an interview, not outreach (Project, 2026-10-16). There are no intro calls any more
        // (Project, 2026-10-19): the first call is the R2 — Technical interview.
        properties.Stage = select('Interview'); properties.Round = select('R2 — Technical');
        if (f.Pipeline === 'India' && [null, undefined, '', 'Outreach'].includes(f['India Stage'])) properties['India Stage'] = select('First Round');
      }
      if (outcome === 'On Hold' && [null, undefined, '', 'Not Yet Decided', 'Proceeding'].includes(f.Outcome)) properties.Outcome = select('On Hold');
      if (outcome === 'Proceeding' && [null, undefined, '', 'Not Yet Decided'].includes(f.Outcome)) properties.Outcome = select('Proceeding');
      if (nextAction) properties['Next action'] = richText(String(nextAction).slice(0, 1800));
      if (followUp) properties['Follow-up Date'] = { date: { start: followUp } };
      if (!Object.keys(properties).length) return { verified: true, pageId: before.pageId, unchanged: true };
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getCandidate(before.pageId);
      if (properties.Stage && after.fields.Stage !== 'Interview') throw new NotionError('candidate_readback_mismatch');
      if (properties.Outcome && after.fields.Outcome !== outcome) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId, changed: Object.keys(properties) };
    },
    /**
     * Who they are, from Clay (clay-pipelines.mjs): LinkedIn and From (current company), each only when the record has none.
     * From only to a company already in its list (a new option is never made). Reads back.
     */
    /** Category, Track and Category Basis on a record that has no Category yet (whatever someone set stands). */
    async setCategory({ pageId, expectedEmail = null, category, track = null, basis = null } = {}) {
      if (!['ML/RL engineers', 'Junior engineers', 'Researchers', 'Ops people'].includes(category)) throw new NotionError('invalid_category');
      if (track !== null && !['ML & RL Engineering', 'Research', 'Engineering', 'Scope to Confirm'].includes(track)) throw new NotionError('invalid_track');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      if (before.fields?.Category) return { verified: true, pageId: before.pageId, unchanged: true };
      const properties = { Category: select(category), ...(track && !before.fields?.Track ? { Track: select(track) } : {}), ...(basis ? { 'Category Basis': richText(String(basis).slice(0, 1800)) } : {}) };
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getCandidate(before.pageId);
      if (after.fields?.Category !== category) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId, changed: Object.keys(properties) };
    },
    async fillProfile({ pageId, expectedEmail = null, linkedin = null, from = null } = {}) {
      if (linkedin !== null && !/^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9_%-]{3,100}$/.test(linkedin)) throw new NotionError('invalid_linkedin');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      const properties = {};
      if (linkedin && !before.profile.linkedin) properties.LinkedIn = { url: linkedin };
      if (from && !before.profile.from) {
        const source = await request(`/data_sources/${RECRUITING_SOURCE_ID}`, 'GET');
        const options = source?.properties?.From?.select?.options ?? [];
        const match = options.find(o => String(o.name).trim().toLowerCase() === String(from).trim().toLowerCase());
        if (match) properties.From = select(match.name);
      }
      if (!Object.keys(properties).length) return { verified: true, pageId: before.pageId, unchanged: true };
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getCandidate(before.pageId);
      if (properties.LinkedIn && after.profile.linkedin !== linkedin) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId, changed: Object.keys(properties) };
    },
    /** On Hold or back to Proceeding, on Project's word in his DM. Never closes anyone (closeCandidate does that). Reads back. */
    async setOutcome({ pageId, expectedEmail = null, outcome } = {}) {
      if (!['On Hold', 'Proceeding'].includes(outcome)) throw new NotionError('invalid_outcome');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      if (['Not Selected', 'Withdrawn or Unavailable', 'Hired'].includes(before.fields.Outcome)) throw new NotionError('candidate_already_closed');
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: { Outcome: select(outcome) } });
      const after = await api.getCandidate(before.pageId);
      if (after.fields.Outcome !== outcome) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId, outcome };
    },
    /** Candidates in the work-trial stage (Stage = Trial) who are still open, at most 50 (work-trial.mjs). */
    /** Everyone whose Trial End falls between two dates (YYYY-MM-DD, inclusive), any outcome but Hired (offboarding.mjs). */
    async listTrialsEnded({ from, to }) {
      const found = await request(`/data_sources/${RECRUITING_SOURCE_ID}/query`, 'POST', { page_size: 50, filter: { and: [
        { property: 'Trial End', date: { on_or_after: from } }, { property: 'Trial End', date: { on_or_before: to } },
        { property: 'Outcome', select: { does_not_equal: 'Hired' } }] } });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(candidateOf)
        .filter(c => c.inRecruitingSource && c.fullName && !/^\[(?:TEST|FIXTURE)\]/i.test(c.fullName));
    },
    async listTrialCandidates() {
      const found = await request(`/data_sources/${RECRUITING_SOURCE_ID}/query`, 'POST', { page_size: 50, filter: { and: [
        { property: 'Stage', select: { equals: 'Trial' } },
        { property: 'Outcome', select: { does_not_equal: 'Not Selected' } }, { property: 'Outcome', select: { does_not_equal: 'Withdrawn or Unavailable' } },
        { property: 'Outcome', select: { does_not_equal: 'Hired' } }] } });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(candidateOf)
        .filter(c => c.inRecruitingSource && c.fullName && !/^\[(?:TEST|FIXTURE)\]/i.test(c.fullName));
    },
    /**
     * The work-trial setup fields (work-trial.mjs): India Stage, Payment Status and Action Status only, to the values the clerk's
     * Step 5 allowed. Never touches Dot color or Color mode. Reads back.
     */
    async setTrialTerms({ pageId, expectedEmail = null, start = null, end = null, days = null, rate = null, replaceDates = false } = {}) {
      // replaceDates: Project said these are the dates (project-trial-dates.mjs), so they replace whatever is there.
      // Work-trial terms agreed in writing (trial-terms.mjs): fills only empty fields; anything already there that differs is
      // returned as a conflict and left alone. Never touches Stage, Outcome, Dot color or Color mode. Reads back.
      const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
      if ((start || end) && !(isDay(start) && isDay(end) && end >= start)) throw new NotionError('invalid_trial_dates');
      if (rate !== null && !(typeof rate === 'number' && Number.isFinite(rate) && rate > 0 && rate < 100_000)) throw new NotionError('invalid_daily_rate');
      if (days !== null && !(Number.isInteger(days) && days > 0 && days <= 60)) throw new NotionError('invalid_trial_days');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      if (['Not Selected', 'Withdrawn or Unavailable', 'Hired'].includes(before.fields.Outcome) || ['Closed', 'Hired'].includes(before.fields.Stage)) throw new NotionError('candidate_already_closed');
      const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
      const properties = {}, set = [], conflicts = [];
      if (start) {
        const hs = day(before.fields['Trial Start']), he = day(before.fields['Trial End']);
        if ((!hs && !he) || (replaceDates && (hs !== start || he !== end))) {
          properties['Trial Start'] = { date: { start } }; properties['Trial End'] = { date: { start: end } };
          if (days && (replaceDates || !(before.payment?.days > 0))) properties['Trial Days'] = { number: days };
          set.push('dates');
        } else if ((hs === start && !he) || (!hs && he === end)) {
          // Half there and agreeing with what was written: the missing side is filled.
          if (!he) properties['Trial End'] = { date: { start: end } }; else properties['Trial Start'] = { date: { start } };
          if (days && !(before.payment?.days > 0)) properties['Trial Days'] = { number: days };
          set.push('dates');
        } else if (hs !== start || he !== end) conflicts.push({ field: 'trial dates', have: `${hs ?? '?'} – ${he ?? '?'}`, found: `${start} – ${end}` });
      }
      if (rate !== null) {
        const hr = before.payment?.dailyRate;
        if (!(hr > 0)) { properties['Daily Trial Rate'] = { number: rate }; set.push('rate'); }
        else if (hr !== rate) conflicts.push({ field: 'daily rate', have: `US$${hr}`, found: `US$${rate}` });
      }
      if (!set.length) return { verified: true, pageId: before.pageId, set, conflicts };
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getCandidate(before.pageId);
      if ((set.includes('dates') && (day(after.fields['Trial Start']) !== start || day(after.fields['Trial End']) !== end)) || (set.includes('rate') && after.payment?.dailyRate !== rate)) throw new NotionError('candidate_readback_mismatch');
      if (after.fields['Color mode'] !== before.fields['Color mode'] || (before.fields['Color mode'] === 'Manual override' && after.fields['Dot color'] !== before.fields['Dot color'])) throw new NotionError('color_selection_changed');
      return { verified: true, pageId: after.pageId, set, conflicts };
    },
    async setTrialFields({ pageId, expectedEmail = null, fields = {} } = {}) {
      const allowed = { 'India Stage': ['Active Work Trial'], 'Payment Status': ['Actively in Trial'], 'Action Status': ['Ready to Start', 'On Trial', 'Waiting on Candidate', null] };
      const entries = Object.entries(fields);
      if (!entries.length || entries.some(([name, value]) => !allowed[name]?.includes(value))) throw new NotionError('invalid_trial_field');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: Object.fromEntries(entries.map(([name, value]) => [name, select(value)])) });
      const after = await api.getCandidate(before.pageId);
      if (entries.some(([name, value]) => after.fields[name] !== value)) throw new NotionError('candidate_readback_mismatch');
      if (after.fields['Color mode'] !== before.fields['Color mode'] || (before.fields['Color mode'] === 'Manual override' && after.fields['Dot color'] !== before.fields['Dot color'])) throw new NotionError('color_selection_changed');
      return { verified: true, pageId: after.pageId, fields };
    },
    /**
     * Ticks the Work trial tier list's access boxes (Robin's board, Project 2026-10-20): Gmail, Slack, Okta and Insightful only,
     * and only ever to checked. AWS access is Robin's by hand and never touched. Reads back.
     */
    async setAccessChecks({ pageId, expectedEmail = null, checks = [] } = {}) {
      const allowed = ['Gmail access', 'Slack access', 'Okta access', 'Insightful access'];
      if (!Array.isArray(checks) || !checks.length || checks.some(n => !allowed.includes(n))) throw new NotionError('invalid_access_check');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: Object.fromEntries(checks.map(n => [n, { checkbox: true }])) });
      const after = await api.getCandidate(before.pageId);
      if (checks.some(n => after.fields[n] !== true)) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId, checks };
    },
    /** Everyone in a work trial or past one (Decision / Extended Offer with trial dates), until withdrawn, not selected or hired. */
    async listTierCandidates() {
      const out = []; let cursor;
      const sel = (property, names) => names.map(name => ({ property, select: { equals: name } }));
      for (let page = 0; page < 5; page++) {
        const found = await request(`/data_sources/${RECRUITING_SOURCE_ID}/query`, 'POST', { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}), filter: { and: [
          { or: [...sel('Stage', ['Trial', 'Decision', 'Extended Offer']), ...sel('India Stage', ['Pre Work Trial', 'Active Work Trial', 'Decision', 'Extended Offer']), ...sel('Research Stage', ['4. Work Trial', '5. Decision'])] },
          ...['Not Selected', 'Withdrawn or Unavailable', 'Hired'].map(name => ({ property: 'Outcome', select: { does_not_equal: name } }))] } });
        if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
        out.push(...found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(candidateOf));
        if (!found.has_more) break; cursor = found.next_cursor;
      }
      return out.filter(c => c.inRecruitingSource && c.fullName && !/^\[(?:TEST|FIXTURE)\]/i.test(c.fullName) && c.fields?.['Trial Start']);
    },
    /**
     * Stage Trial when someone is sent to the work trial (agent-runner.mjs offerPacket): only from an earlier stage (empty,
     * Outreach, Intro Call, Interview, Case Study), never for a closed record or another person's email. India Stage is left to
     * Notion's own automation (a record newly moved to Trial lands in Pre Work Trial). Reads back. -> { changed, reason }
     */
    async moveToTrial({ pageId, expectedEmail = null } = {}) {
      const before = await api.getCandidate(pageId);
      if (before.archived) return { changed: false, reason: 'archived' };
      if (expectedEmail && String(before.email ?? '').toLowerCase() !== String(expectedEmail).toLowerCase()) return { changed: false, reason: 'email_mismatch' };
      const f = before.fields ?? {};
      if (['Not Selected', 'Withdrawn or Unavailable', 'Hired'].includes(f.Outcome) || ['Closed', 'Hired'].includes(f.Stage)) return { changed: false, reason: 'closed' };
      if (f.Stage === 'Trial') return { changed: false, reason: 'already_trial' };
      if (![null, undefined, '', 'Outreach', 'Intro Call', 'Interview', 'Case Study'].includes(f.Stage)) return { changed: false, reason: 'later_stage' };
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: { Stage: select('Trial') } });
      const after = await api.getCandidate(before.pageId);
      if (after.fields?.Stage !== 'Trial') throw new NotionError('candidate_readback_mismatch');
      return { changed: true, reason: 'moved' };
    },
    /** Ticks First check-in done (puts them on the Work trial tier list). Nothing else. Reads back. */
    async setFirstCheckinDone({ pageId, expectedEmail = null } = {}) {
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: { 'First check-in done': { checkbox: true } } });
      const after = await api.getCandidate(before.pageId);
      if (after.fields['First check-in done'] !== true) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId };
    },
    /** Everyone whose trial pay is still open (stripe-payments.mjs): Payment Status Actively in Trial, Awaiting Stripe Setup, To Confirm or Ready to Pay, any outcome. */
    async listOpenPayments() {
      const found = await request(`/data_sources/${RECRUITING_SOURCE_ID}/query`, 'POST', { page_size: 100, filter: { or: ['Actively in Trial', 'Awaiting Stripe Setup', 'To Confirm', 'Ready to Pay']
        .map(name => ({ property: 'Payment Status', select: { equals: name } })) } });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(candidateOf)
        .filter(c => c.inRecruitingSource && c.fullName && !/^\[(?:TEST|FIXTURE)\]/i.test(c.fullName));
    },
    /**
     * Trial pay on a candidate, from Stripe (stripe-payments.mjs): Payment Status (Ready to Pay, Awaiting Stripe Setup or Paid),
     * Paid Amount, Payment Date and Trial Amount Owed. Nothing else. Reads back.
     */
    async setPaymentFields({ pageId, expectedEmail = null, status = undefined, paid = undefined, date = undefined, owed = undefined } = {}) {
      if (status !== undefined && !['Ready to Pay', 'Awaiting Stripe Setup', 'Paid'].includes(status)) throw new NotionError('invalid_payment_status');
      for (const n of [paid, owed]) if (n !== undefined && !(typeof n === 'number' && Number.isFinite(n) && n >= 0 && n < 1_000_000)) throw new NotionError('invalid_payment_amount');
      if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new NotionError('invalid_payment_date');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      const properties = {};
      if (status !== undefined) properties['Payment Status'] = select(status);
      if (paid !== undefined) properties['Paid Amount'] = { number: paid };
      if (owed !== undefined) properties['Trial Amount Owed'] = { number: owed };
      if (date !== undefined) properties['Payment Date'] = { date: { start: date } };
      if (!Object.keys(properties).length) throw new NotionError('invalid_payment_fields');
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getCandidate(before.pageId);
      if ((status !== undefined && after.fields['Payment Status'] !== status) || (paid !== undefined && after.payment.paid !== paid) || (owed !== undefined && after.payment.owed !== owed)) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId };
    },
    /** DocuSign paperwork on a candidate (docusign.mjs): "Paperwork" and, once signed, "Paperwork signed". Touches nothing else. Reads back. */
    async setPaperwork({ pageId, expectedEmail = null, value, signedAt = null } = {}) {
      if (!['Sent', 'Signed', 'Declined', 'Voided'].includes(value) || (signedAt !== null && explicitTime(signedAt) === null)) throw new NotionError('invalid_paperwork');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: { Paperwork: select(value), ...(signedAt ? { 'Paperwork signed': dateProp(signedAt) } : {}) } });
      const after = await api.getCandidate(before.pageId);
      if (after.fields.Paperwork !== value) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId, value };
    },
    /** Which DocuSign documents are signed (docusign-documents.mjs): "Documents", and "Paperwork" when DocuSign says otherwise. Reads back. */
    async setDocuments({ pageId, expectedEmail = null, documents, paperwork } = {}) {
      if (typeof documents !== 'string' || (paperwork !== undefined && paperwork !== null && !['Sent', 'Signed', 'Declined', 'Voided'].includes(paperwork))) throw new NotionError('invalid_documents');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: { Documents: richText(documents), ...(paperwork !== undefined ? { Paperwork: select(paperwork) } : {}) } });
      const after = await api.getCandidate(before.pageId);
      if ((paperwork !== undefined && (after.fields.Paperwork || null) !== paperwork) || (after.fields.Documents ?? '') !== documents.slice(0, 2000)) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId };
    },
    /**
     * The tracker the moment Uncle Sam sends the work-trial documents (Project, 2026-10-16: "the tracker should be updated ...
     * pretty much instantaneously once this goes out"), the way the team already marks someone whose packet went out:
     * Paperwork Sent, Stage Trial (unless already past it), Take Home / Trial gains Work Trial, Payment Status Have Not Started Yet
     * (only when empty or Not Applicable), Action Status Waiting on Candidate, Next action, and Daily Trial Rate when given.
     * Never touches Outcome, Dot color or Color mode. Reads back.
     */
    async recordPacketSent({ pageId, expectedEmail = null, dailyRate = null, nextAction = null } = {}) {
      if (dailyRate !== null && !(typeof dailyRate === 'number' && Number.isFinite(dailyRate) && dailyRate > 0 && dailyRate < 100_000)) throw new NotionError('invalid_daily_rate');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      const raw = await request(`/pages/${before.pageId}`, 'GET');
      const tracks = (raw?.properties?.['Take Home / Trial']?.multi_select ?? []).map(o => o.name);
      const properties = { Paperwork: select('Sent'), 'Action Status': select('Waiting on Candidate') };
      if (!['Trial', 'Extended Offer', 'Hired', 'Closed'].includes(before.fields.Stage)) properties.Stage = select('Trial');
      if (!tracks.includes('Work Trial')) properties['Take Home / Trial'] = { multi_select: [...tracks, 'Work Trial'].map(name => ({ name })) };
      if (!before.fields['Payment Status'] || before.fields['Payment Status'] === 'Not Applicable') properties['Payment Status'] = select('Have Not Started Yet');
      // Delivery records are not new pay instructions. Never roll a later rate back after an older send finishes.
      if (dailyRate !== null && before.payment.dailyRate != null && before.payment.dailyRate !== dailyRate) throw new NotionError('candidate_rate_changed');
      if (dailyRate !== null && before.payment.dailyRate == null) properties['Daily Trial Rate'] = { number: dailyRate };
      if (typeof nextAction === 'string' && nextAction.trim()) properties['Next action'] = richText(nextAction.trim());
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getCandidate(before.pageId);
      if (after.fields.Paperwork !== 'Sent' || (properties.Stage && after.fields.Stage !== 'Trial') || (dailyRate !== null && after.payment.dailyRate !== dailyRate)) throw new NotionError('candidate_readback_mismatch');
      if (after.fields['Color mode'] !== before.fields['Color mode'] || (before.fields['Color mode'] === 'Manual override' && after.fields['Dot color'] !== before.fields['Dot color'])) throw new NotionError('color_selection_changed');
      return { verified: true, pageId: after.pageId, changed: Object.keys(properties) };
    },
    /**
     * The tracker when the take-home goes out (Project, 2026-10-16: "send the take home and cc interviewer ofc and update the
     * tracker"): Stage Case Study and Round R3 (only forward, never back), Take Home / Trial gains Take Home, Action Status
     * Waiting on Candidate, Follow-up Date on the reminder day (3 days on), Next action, and the brief's first lines brought up
     * to date (the old "Latest" kept as "Prior"). Never touches Outcome, Dot color or Color mode. Reads back.
     */
    /** The brief and Next action once a take-home is submitted (planTakeHomeReviews). Reads back. */
    async noteTakeHomeSubmitted({ pageId, expectedEmail = null, submittedAt, score = null } = {}) {
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      const day = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }).format(ms);
      const first = String(before.fullName ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().split(/\s+/)[0] || 'They';
      const scoreText = Number.isFinite(score) ? `, portal score ${score}/100 (not a human review)` : '';
      const old = String(before.fields['Candidate brief'] ?? '').split('\n').map(l => l.trim()).filter(Boolean);
      const keep = old.filter(l => !/^(Status|Latest|Prior|Open items)\b/i.test(l)).slice(0, 2);
      const latestBefore = old.find(l => /^Latest\b/i.test(l));
      const brief = [`Status: Case Study / ${before.fields.Outcome ?? 'Proceeding'}; take-home submitted ${day(submittedAt)}${scoreText}, waiting on Interviewer's review.`,
        ...keep, `Latest · ${day(submittedAt)}: ${first} submitted the take-home${scoreText}.`,
        ...(latestBefore ? [latestBefore.replace(/^Latest\b/i, 'Prior')] : []),
        `Open items: Interviewer reviews the take-home; his Advance sends the deep-dive invite.`].join('\n');
      const properties = { 'Candidate brief': richText(brief), 'Next action': richText(`Interviewer: review ${first}'s take-home (submitted ${day(submittedAt)}). Advance sends the deep-dive invite; Reject goes to Robin or Alexis.`) };
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getCandidate(before.pageId);
      if (!String(after.fields['Candidate brief'] ?? '').startsWith('Status: Case Study')) throw new NotionError('candidate_readback_mismatch');
      return { verified: true };
    },
    async recordTakeHomeSent({ pageId, expectedEmail = null, sentAt = Date.now() } = {}) {
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      const raw = await request(`/pages/${before.pageId}`, 'GET');
      const tracks = (raw?.properties?.['Take Home / Trial']?.multi_select ?? []).map(o => o.name);
      const day = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }).format(ms);
      const laDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
      const first = String(before.fullName ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').trim().split(/\s+/)[0] || 'They';
      const early = ['Outreach', 'Intro Call', 'Interview', null, undefined, ''].includes(before.fields.Stage);
      const earlyRound = [null, undefined, '', 'R1 — Intro', 'R2 — Technical'].includes(before.fields.Round);
      const old = String(before.fields['Candidate brief'] ?? '').split('\n').map(l => l.trim()).filter(Boolean);
      const latestBefore = old.find(l => /^Latest\b/i.test(l));
      const brief = [`Status: Case Study / ${before.fields.Outcome ?? 'Proceeding'}; take-home sent ${day(sentAt)}, waiting on ${first}.`,
        `Latest · ${day(sentAt)}: take-home emailed from Project's Gmail with Interviewer cc'd (by Uncle Sam); the link stays open 7 days.`,
        ...(latestBefore ? [latestBefore.replace(/^Latest\b/i, 'Prior')] : []),
        `Open items: ${first} submits the take-home (reminder ${day(sentAt + 3 * 86400_000)} if not started); Interviewer grades it when it comes in.`].join('\n');
      const properties = { 'Action Status': select('Waiting on Candidate'), 'Candidate brief': richText(brief),
        'Next action': richText(`${first}: complete the take-home (sent ${day(sentAt)}, open 7 days). Uncle Sam reminds once if not started; Interviewer grades it when submitted.`),
        'Follow-up Date': { date: { start: laDay(sentAt + 3 * 86400_000) } } };
      if (early) properties.Stage = select('Case Study');
      if (earlyRound) properties.Round = select('R3 — Case Study');
      if (!tracks.includes('Take Home')) properties['Take Home / Trial'] = { multi_select: [...tracks, 'Take Home'].map(name => ({ name })) };
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getCandidate(before.pageId);
      if (after.fields['Action Status'] !== 'Waiting on Candidate' || (properties.Stage && after.fields.Stage !== 'Case Study')) throw new NotionError('candidate_readback_mismatch');
      if (after.fields['Color mode'] !== before.fields['Color mode'] || (before.fields['Color mode'] === 'Manual override' && after.fields['Dot color'] !== before.fields['Dot color'])) throw new NotionError('color_selection_changed');
      return { verified: true, pageId: after.pageId, changed: Object.keys(properties) };
    },
    /** Append-only dated note at the end of the candidate page body. Never edits existing blocks. */
    async appendCandidateNote({ pageId, text, sourceUrl } = {}) {
      const id = dashed(pageId);
      if (!id || typeof text !== 'string' || !text.trim() || text.length > 1800) throw new NotionError('invalid_note');
      const parts = [{ type: 'text', text: { content: text.trim() } }];
      if (sourceUrl) {
        try { if (new URL(sourceUrl).protocol !== 'https:') throw new Error(); } catch { throw new NotionError('invalid_note_link'); }
        parts.push({ type: 'text', text: { content: ' Source' , link: { url: sourceUrl } } });
      }
      const result = await request(`/blocks/${id}/children`, 'PATCH', { children: [
        { object: 'block', type: 'paragraph', paragraph: { rich_text: parts } }] });
      const block = result?.results?.[0];
      if (result?.object !== 'list' || block?.object !== 'block' || !uuidPattern.test(block.id ?? '')) throw new NotionError('note_receipt_unverified');
      return { verified: true, blockId: block.id };
    },
    async findOperationsByRequestKey(requestKey) {
      if (typeof requestKey !== 'string' || !requestKey.trim()) return [];
      const found = await query(OPS_SOURCE_ID, { property: 'Request key', rich_text: { equals: requestKey.trim() } }, 5);
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(p => ({
        pageId: p.id.toLowerCase(), url: p.url, state: propertyValue(p.properties?.State),
        requestKey: propertyValue(p.properties?.['Request key']), action: propertyValue(p.properties?.Action) }));
    },
    /** Creates or updates one Operations receipt row keyed by Request key. Returns the page id. */
    /** Interviews the clerk logged that ended at or after `since` (newest 50), as calendar-shaped events. */
    async listInterviewRows({ since } = {}) {
      const found = await request(`/data_sources/${OPS_SOURCE_ID}/query`, 'POST', { filter: { and: [
        { property: 'Record kind', select: { equals: 'Interview' } },
        { property: 'Event occurred at', date: { on_or_after: new Date(since).toISOString() } }] },
      sorts: [{ property: 'Event occurred at', direction: 'descending' }], page_size: 50 });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(interviewRowOf);
    },
    /**
     * What the clerk noted about a candidate from sources the bot cannot read itself (Wispr meeting notes, email, Project's DMs):
     * Operations rows with Record kind "Note" for this candidate since a time, newest first, as { at, source, text }.
     */
    async listCandidateNotes({ candidatePageId, since, max = 12 } = {}) {
      const id = dashed(candidatePageId);
      if (!id) throw new NotionError('invalid_page_id');
      const found = await request(`/data_sources/${OPS_SOURCE_ID}/query`, 'POST', { filter: { and: [
        { property: 'Record kind', select: { equals: 'Note' } }, { property: 'Candidate', relation: { contains: id } },
        { property: 'Event occurred at', date: { on_or_after: new Date(since).toISOString() } }] },
      sorts: [{ property: 'Event occurred at', direction: 'descending' }], page_size: Math.min(max, 25) });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(p => ({
        at: propertyValue(p.properties?.['Event occurred at']) ?? null, source: String(propertyValue(p.properties?.Action) ?? '').slice(0, 60),
        text: String(propertyValue(p.properties?.['Result evidence']) ?? '').slice(0, 800) }));
    },
    /**
     * Take-home scorecards the portal sync marked Complete with a submission on or after `since`, newest 50. The sync,
     * not the bot, decides Complete; the bot never opens the portal or a submission.
     */
    async listTakeHomeSubmissions({ since } = {}) {
      const found = await request(`/data_sources/${FEEDBACK_SOURCE_ID}/query`, 'POST', { filter: { and: [
        { property: 'Type', select: { equals: 'Take-home' } }, { property: 'Assessment kind', select: { equals: 'Scorecard' } },
        { property: 'Take-home status', select: { equals: 'Complete' } },
        { property: 'Submitted at', date: { on_or_after: new Date(since).toISOString() } }] },
      sorts: [{ property: 'Submitted at', direction: 'descending' }], page_size: 50 });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(scorecardOf)
        .filter(s => s.inFeedbackSource && s.takeHome && !s.superseded);
    },
    async getScorecard(pageId) {
      const id = dashed(pageId);
      if (!id) throw new NotionError('invalid_page_id');
      const scorecard = scorecardOf(await request(`/pages/${id}`));
      if (!scorecard.inFeedbackSource) throw new NotionError('scorecard_not_in_feedback_source');
      return scorecard;
    },
    /**
     * Interviewer's recommendation from his Slack review, on the candidate's current take-home scorecard: Interviewer review and
     * its source, his one-sentence note (Interviewer notes), plus his own score when he gave one (Reviewer score / 100, kept
     * apart from the portal's Score / 100, which stays the auto-populated portal grade).
     * Never touches the portal grade, Outcome, Stage or anything on the candidate. Reads back.
     */
    async recordTakeHomeReview({ scorecardPageId, candidatePageId, recommendation, sourceUrl, reviewerScore = null, notes = '' } = {}) {
      const note = String(notes ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!SANTOSH_REVIEWS.includes(recommendation)) throw new NotionError('invalid_recommendation');
      try { if (new URL(sourceUrl).protocol !== 'https:') throw new Error(); } catch { throw new NotionError('invalid_review_link'); }
      if (reviewerScore != null && !(Number.isInteger(reviewerScore) && reviewerScore >= 0 && reviewerScore <= 100)) throw new NotionError('invalid_reviewer_score');
      const before = await api.getScorecard(scorecardPageId);
      if (before.archived || !before.takeHome || before.superseded || !before.candidateIds.some(id => sameId(id, candidatePageId))) throw new NotionError('scorecard_mismatch');
      const properties = { 'Interviewer review': select(recommendation), 'Interviewer review source': { url: sourceUrl } };
      if (note) properties['Interviewer notes'] = richText(note);
      if (reviewerScore != null) Object.assign(properties, { 'Reviewer score / 100': { number: reviewerScore }, 'Reviewer score source': { url: sourceUrl } });
      await request(`/pages/${before.pageId}`, 'PATCH', { properties });
      const after = await api.getScorecard(before.pageId);
      if (after.santoshReview !== recommendation || (note && after.santoshNotes !== note) || (reviewerScore != null && after.reviewerScore !== reviewerScore) || after.score !== before.score) throw new NotionError('scorecard_readback_mismatch');
      return { verified: true, pageId: after.pageId, santoshReview: after.santoshReview, santoshNotes: after.santoshNotes, reviewerScore: after.reviewerScore };
    },
    /**
     * The stage fields on the candidate's take-home scorecard ("Take-home review", "Deep dive"), as people move between
     * stages. `onlyIfEmpty` never overwrites a value someone set; `onlyFrom` changes a field only while it holds one of those
     * values (null for empty), so an automatic step never moves a candidate backwards. Touches nothing else. Reads back.
     */
    async setStageFields({ scorecardPageId, candidatePageId, fields = {}, onlyIfEmpty = false, onlyFrom = null } = {}) {
      const keyOf = { 'Take-home review': 'takeHomeReview', 'Deep dive': 'deepDive' };
      const entries = Object.entries(fields);
      if (!entries.length || entries.some(([name, value]) => !STAGE_FIELDS[name]?.includes(value))) throw new NotionError('invalid_stage_field');
      const before = await api.getScorecard(scorecardPageId);
      if (before.archived || !before.takeHome || before.superseded || !before.candidateIds.some(id => sameId(id, candidatePageId))) throw new NotionError('scorecard_mismatch');
      const todo = entries.filter(([name, value]) => before[keyOf[name]] !== value && !(onlyIfEmpty && before[keyOf[name]])
        && !(Array.isArray(onlyFrom) && !onlyFrom.includes(before[keyOf[name]] ?? null)));
      if (!todo.length) return { verified: true, changed: false };
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: Object.fromEntries(todo.map(([name, value]) => [name, select(value)])) });
      const after = await api.getScorecard(before.pageId);
      if (todo.some(([name, value]) => after[keyOf[name]] !== value)) throw new NotionError('scorecard_readback_mismatch');
      return { verified: true, changed: true, takeHomeReview: after.takeHomeReview, deepDive: after.deepDive };
    },
    /** Operations rows with this Action in this State (oldest Due at first), with what a queued email needs. */
    async listOperationsByState({ action, state } = {}) {
      if (typeof action !== 'string' || !action || !OPERATIONS_STATES.includes(state)) throw new NotionError('invalid_operations_query');
      const found = await request(`/data_sources/${OPS_SOURCE_ID}/query`, 'POST', { filter: { and: [{ property: 'Action', rich_text: { equals: action } },
        { property: 'State', select: { equals: state } }] }, page_size: 25 });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(p => {
        const v = name => propertyValue(p.properties?.[name]);
        return { pageId: p.id.toLowerCase(), url: p.url ?? null, state: v('State'), requestKey: v('Request key'), name: v('Name'),
          dueAt: v('Due at'), emailTo: v('Email to'), emailSubject: v('Email subject'), emailBody: v('Email body'),
          candidateIds: (v('Candidate') ?? []).map(dashed).filter(Boolean), sourceUrl: v('Source URL'), resultEvidence: v('Result evidence') ?? null };
      }).sort((a, b) => String(a.dueAt ?? '').localeCompare(String(b.dueAt ?? '')));
    },
    /** Take-home invite rows that were sent (Complete with a Sent at) on or after `since`, newest first, at most 50. */
    async listSentTakeHomeInvites({ since } = {}) { return api.listSentEmails({ action: 'email.takehome_invite', since }); },
    /** Queued-email rows with this Action that were sent (Complete with a Sent at) on or after `since`, newest first, at most 50. */
    async listSentEmails({ action, since } = {}) {
      if (typeof action !== 'string' || !action) throw new NotionError('invalid_operations_query');
      const found = await request(`/data_sources/${OPS_SOURCE_ID}/query`, 'POST', { filter: { and: [{ property: 'Action', rich_text: { equals: action } },
        { property: 'State', select: { equals: 'Complete' } }, { property: 'Sent at', date: { on_or_after: new Date(since).toISOString() } }] },
      sorts: [{ property: 'Sent at', direction: 'descending' }], page_size: 50 });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(p => {
        const v = name => propertyValue(p.properties?.[name]);
        return { pageId: p.id.toLowerCase(), requestKey: v('Request key'), sentAt: v('Sent at'), emailTo: v('Email to'), emailSubject: v('Email subject'),
          emailBody: v('Email body'), resultEvidence: String(v('Result evidence') ?? ''), candidateIds: (v('Candidate') ?? []).map(dashed).filter(Boolean) };
      });
    },
    /** Take-home scorecards whose "Deep dive" is this value (for example "Invite sent"), at most 50. */
    async listScorecardsByDeepDive(value) {
      if (!STAGE_FIELDS['Deep dive'].includes(value)) throw new NotionError('invalid_stage_field');
      const found = await request(`/data_sources/${FEEDBACK_SOURCE_ID}/query`, 'POST', { filter: { and: [
        { property: 'Type', select: { equals: 'Take-home' } }, { property: 'Assessment kind', select: { equals: 'Scorecard' } },
        { property: 'Deep dive', select: { equals: value } }] }, page_size: 50 });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(scorecardOf)
        .filter(s => s.inFeedbackSource && s.takeHome && !s.superseded);
    },
    /** Take-home scorecards with Take-home review or Deep dive = Reject (manual-reject.mjs), at most 50. */
    async listStageRejects() {
      const found = await request(`/data_sources/${FEEDBACK_SOURCE_ID}/query`, 'POST', { filter: { and: [
        { property: 'Type', select: { equals: 'Take-home' } }, { property: 'Assessment kind', select: { equals: 'Scorecard' } },
        { or: [{ property: 'Take-home review', select: { equals: 'Reject' } }, { property: 'Deep dive', select: { equals: 'Reject' } }] }] }, page_size: 50 });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(scorecardOf)
        .filter(s => s.inFeedbackSource && s.takeHome && !s.superseded);
    },
    /** Take-home scorecards marked "Passed take-home" (by Uncle Sam or by hand), newest edit first. */
    async listPassedTakeHomes() {
      const found = await request(`/data_sources/${FEEDBACK_SOURCE_ID}/query`, 'POST', { filter: { and: [
        { property: 'Type', select: { equals: 'Take-home' } }, { property: 'Assessment kind', select: { equals: 'Scorecard' } },
        { property: 'Take-home review', select: { equals: 'Passed take-home' } }] }, page_size: 50 });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(scorecardOf)
        .filter(s => s.inFeedbackSource && s.takeHome && !s.superseded);
    },
    /** Every Operations row for this candidate with this Action, in any state (queued, sent, cancelled). */
    async findOperationsForCandidate({ candidatePageId, action } = {}) {
      const id = dashed(candidatePageId);
      if (!id || typeof action !== 'string' || !action) throw new NotionError('invalid_operations_query');
      const found = await query(OPS_SOURCE_ID, { and: [{ property: 'Action', rich_text: { equals: action } },
        { property: 'Candidate', relation: { contains: id } }] }, 10);
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(p => ({
        pageId: p.id.toLowerCase(), state: propertyValue(p.properties?.State), requestKey: propertyValue(p.properties?.['Request key']) }));
    },
    /** The candidate's one current take-home scorecard (not superseded), or null when there is none or more than one. */
    async findTakeHomeScorecard(candidatePageId) {
      const id = dashed(candidatePageId);
      if (!id) throw new NotionError('invalid_page_id');
      const found = await query(FEEDBACK_SOURCE_ID, { and: [{ property: 'Type', select: { equals: 'Take-home' } },
        { property: 'Assessment kind', select: { equals: 'Scorecard' } }, { property: 'Candidate', relation: { contains: id } }] }, 10);
      const cards = found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(scorecardOf)
        .filter(s => s.inFeedbackSource && s.takeHome && !s.superseded);
      return cards.length === 1 ? cards[0] : null;
    },
    /**
     * The scorecard for a take-home Uncle Sam just sent (Project, 2026-10-19: reminders never went out because nothing on the
     * tracker showed the take-home): Not started, the Sent date (Pacific), the portal link and the sent email, so the portal
     * monitor fills in progress and the reminder rule can read it. Refuses when the candidate already has any current take-home
     * scorecard (a superseded one does not count). Reads back.
     */
    async createSentScorecard({ candidatePageId, fullName, sentAt, link, sentUrl = null } = {}) {
      const id = dashed(candidatePageId);
      const name = String(fullName ?? '').replace(/\s+/g, ' ').trim();
      const sentMs = typeof sentAt === 'number' ? sentAt : Date.parse(sentAt ?? '');
      if (!id || name.length < 3 || !Number.isFinite(sentMs) || !/^https:\/\/company-takehome\.vercel\.app\/\S+$/.test(link ?? '')) throw new NotionError('invalid_sent_scorecard');
      if (sentUrl !== null && !/^https:\/\/mail\.google\.com\//.test(sentUrl)) throw new NotionError('invalid_sent_scorecard');
      const existing = await query(FEEDBACK_SOURCE_ID, { and: [{ property: 'Type', select: { equals: 'Take-home' } }, { property: 'Candidate', relation: { contains: id } }] }, 10);
      if (existing.results.some(p => p.object === 'page' && !p.archived && !p.in_trash && propertyValue(p.properties?.Status) !== 'Superseded')) throw new NotionError('scorecard_exists');
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(sentMs);
      const page = await request('/pages', 'POST', { parent: { type: 'data_source_id', data_source_id: FEEDBACK_SOURCE_ID }, properties: {
        'Log score': { title: [{ type: 'text', text: { content: name.slice(0, 200) } }] }, Type: select('Take-home'), 'Assessment kind': select('Scorecard'),
        Status: select('Draft'), Candidate: { relation: [{ id }] }, Attempt: { number: 1 }, 'Review key': richText(`queue:${id.replaceAll('-', '')}:take-home:1`),
        'Take-home status': select('Not started'), Sent: { date: { start: day } }, 'Assignment / submission': { url: link },
        ...(sentUrl ? { 'Sent email': { url: sentUrl }, 'Delivery source': { url: sentUrl } } : {}), 'On take-home website': { checkbox: true } } });
      if (typeof page?.id !== 'string') throw new NotionError('create_unverified');
      const after = scorecardOf(await request(`/pages/${page.id}`));
      if (after.status !== 'Not started' || after.link !== link || !after.candidateIds?.includes(id)) throw new NotionError('scorecard_readback_mismatch');
      return { verified: true, pageId: after.pageId, url: page.url ?? null };
    },
    /** Take-home scorecards still Not started whose Sent date is on or after `since` (hand-sent ones included), at most 50. */
    async listUnstartedTakeHomes({ since } = {}) {
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(since);
      const found = await request(`/data_sources/${FEEDBACK_SOURCE_ID}/query`, 'POST', { filter: { and: [
        { property: 'Type', select: { equals: 'Take-home' } }, { property: 'Assessment kind', select: { equals: 'Scorecard' } },
        { property: 'Take-home status', select: { equals: 'Not started' } }, { property: 'Sent', date: { on_or_after: day } }] }, page_size: 50 });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(scorecardOf)
        .filter(s => s.inFeedbackSource && s.takeHome && !s.superseded);
    },
    /**
     * A take-home scorecard for someone whose take-home happened off the tracker and who has booked Interviewer's deep dive
     * (new-bookings.mjs, Project 2026-10-16: "as if the mistake didn't happen"): Take-home review Passed take-home, Deep dive
     * Booked, so they sit on the Take-homes tab where they belong. Refuses when any take-home scorecard exists. Reads back.
     */
    async createLateScorecard({ candidatePageId, fullName } = {}) {
      const id = dashed(candidatePageId);
      const name = String(fullName ?? '').replace(/\s+/g, ' ').trim();
      if (!id || name.length < 3) throw new NotionError('invalid_late_scorecard');
      const existing = await query(FEEDBACK_SOURCE_ID, { and: [{ property: 'Type', select: { equals: 'Take-home' } }, { property: 'Candidate', relation: { contains: id } }] }, 5);
      if (existing.results.some(p => p.object === 'page' && !p.archived && !p.in_trash)) throw new NotionError('scorecard_exists');
      const page = await request('/pages', 'POST', { parent: { type: 'data_source_id', data_source_id: FEEDBACK_SOURCE_ID }, properties: {
        'Log score': { title: [{ type: 'text', text: { content: name.slice(0, 200) } }] }, Type: select('Take-home'), 'Assessment kind': select('Scorecard'),
        Candidate: { relation: [{ id }] }, Attempt: { number: 1 }, 'Review key': richText(`queue:${id.replaceAll('-', '')}:take-home:1`),
        'Take-home review': select('Passed take-home'), 'Deep dive': select('Booked') } });
      if (typeof page?.id !== 'string') throw new NotionError('create_unverified');
      const after = scorecardOf(await request(`/pages/${page.id}`));
      if (after.takeHomeReview !== 'Passed take-home' || after.deepDive !== 'Booked' || !after.candidateIds?.includes(id)) throw new NotionError('scorecard_readback_mismatch');
      return { verified: true, pageId: page.id.toLowerCase(), url: page.url ?? null };
    },
    /** The clerk's logged interviews for one candidate, newest first, as calendar-shaped events. */
    async listCandidateInterviews({ candidatePageId, max = 10 } = {}) {
      const id = dashed(candidatePageId);
      if (!id) throw new NotionError('invalid_page_id');
      const found = await request(`/data_sources/${OPS_SOURCE_ID}/query`, 'POST', { filter: { and: [
        { property: 'Record kind', select: { equals: 'Interview' } }, { property: 'Candidate', relation: { contains: id } }] },
      sorts: [{ property: 'Event occurred at', direction: 'descending' }], page_size: Math.min(max, 25) });
      if (found?.object !== 'list' || !Array.isArray(found.results)) throw new NotionError('invalid_query_response');
      return found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash).map(interviewRowOf);
    },
    /**
     * Closes an open candidate on an @-mention: Outcome, Stage Closed, Pipeline cleared and Next action. For Not Selected the
     * latest interview's end and source (when known) are written first, so the rejection sender sees them with the decision.
     * Refuses a candidate already closed. Never touches the sender's own Rejection email fields. Reads back.
     */
    async closeCandidate({ pageId, expectedEmail = null, outcome, nextAction, interviewEnd = null } = {}) {
      if (!['Withdrawn or Unavailable', 'Not Selected'].includes(outcome)) throw new NotionError('invalid_outcome');
      if (typeof nextAction !== 'string' || !nextAction.trim() || nextAction.length > 400) throw new NotionError('invalid_next_action');
      const before = await api.getCandidate(pageId);
      if (before.archived || (expectedEmail && before.email !== expectedEmail)) throw new NotionError('candidate_identity_changed');
      if (['Not Selected', 'Withdrawn or Unavailable', 'Hired'].includes(before.fields.Outcome) || ['Closed', 'Hired'].includes(before.fields.Stage)) throw new NotionError('candidate_already_closed');
      if (interviewEnd) {
        if (outcome !== 'Not Selected' || typeof interviewEnd.at !== 'string' || explicitTime(interviewEnd.at) === null) throw new NotionError('invalid_interview_end');
        try { if (new URL(interviewEnd.sourceUrl).protocol !== 'https:') throw new Error(); } catch { throw new NotionError('invalid_interview_source'); }
        await request(`/pages/${before.pageId}`, 'PATCH', { properties: { 'Last interview ended at': dateProp(interviewEnd.at), 'Interview timing source': { url: interviewEnd.sourceUrl } } });
      }
      await request(`/pages/${before.pageId}`, 'PATCH', { properties: { Outcome: select(outcome), Stage: select('Closed'), Pipeline: select(null), 'Next action': richText(nextAction) } });
      const after = await api.getCandidate(before.pageId);
      if (after.fields.Outcome !== outcome || after.fields.Stage !== 'Closed' || String(after.fields['Next action'] ?? '') !== nextAction) throw new NotionError('candidate_readback_mismatch');
      return { verified: true, pageId: after.pageId, outcome, timingWritten: !!interviewEnd };
    },
    /** The "Full email" text of a Template Emails row (Recruiting Guides & Templates), or null when it is empty. */
    async getEmailTemplate(pageId) {
      const id = dashed(pageId);
      if (!id) throw new NotionError('invalid_page_id');
      const page = await request(`/pages/${id}`);
      if (page?.object !== 'page' || page.archived || page.in_trash || !sameId(page.parent?.data_source_id ?? page.parent?.database_id, GUIDES_SOURCE_ID)) throw new NotionError('template_unavailable');
      // A slot written as a Notion link ("your take-home assessment link" pointing at "[Unique candidate Vercel link]" or
      // "{{takehome_link}}", edited in on Oct 16) is kept as Markdown so the filler finds the slot; real links stay plain text as before.
      const parts = page.properties?.['Full email']?.rich_text;
      const text = (Array.isArray(parts) ? parts.map(part => {
        const shown = part.plain_text ?? part.text?.content ?? '';
        let href = part.href ?? part.text?.link?.url ?? null;
        try { href = href ? decodeURIComponent(href) : null; } catch { /* as is */ }
        return href && /^(?:\[[^\]]+\]|\{\{[a-z_]+\}\})$/.test(href) ? `[${shown}](${href})` : shown;
      }).join('') : String(propertyValue(page.properties?.['Full email']) ?? '')).trim();
      return text || null;
    },
    /**
     * Calls off a queued candidate email (an Operations row the clerk sends from Project's Gmail) while it is still Ready.
     * Returns { cancelled: true } or { cancelled: false, state } when it is already Sending, sent or gone. Reads back.
     */
    async cancelQueuedEmail({ requestKey, reason } = {}) {
      const rows = await api.findOperationsByRequestKey(requestKey);
      if (rows.length !== 1) return { cancelled: false, state: rows.length ? 'duplicate_rows' : 'missing' };
      if (!['Ready', 'Held'].includes(rows[0].state)) return { cancelled: false, state: rows[0].state };
      await request(`/pages/${rows[0].pageId}`, 'PATCH', { properties: { State: select('Cancelled'), 'Hold reason': richText(String(reason ?? 'Cancelled').slice(0, 400)) } });
      const [after] = await api.findOperationsByRequestKey(requestKey);
      if (after?.state !== 'Cancelled') throw new NotionError('cancel_readback_mismatch');
      return { cancelled: true, pageId: rows[0].pageId };
    },
    /**
     * Replace one Interviewer links row's Booking link (exactly one row for this interviewer and use, https only), keep Link
     * verified ticked, and add a dated line with the source. { changed: false } when it already holds this link.
     */
    async setBookingLink({ interviewer, useFor, url, note } = {}) {
      if (typeof interviewer !== 'string' || typeof useFor !== 'string' || typeof note !== 'string' || !note.trim()) throw new NotionError('invalid_booking_link');
      try { if (new URL(url).protocol !== 'https:') throw new Error(); } catch { throw new NotionError('invalid_booking_link'); }
      const found = await query(GUIDES_SOURCE_ID, { and: [{ property: 'Interviewer', select: { equals: interviewer } }, { property: 'Use for', select: { equals: useFor } }] }, 5);
      const rows = found.results.filter(p => p.object === 'page' && !p.archived && !p.in_trash);
      if (rows.length !== 1) throw new NotionError(rows.length ? 'booking_link_ambiguous' : 'booking_link_row_missing');
      if (propertyValue(rows[0].properties?.['Booking link']) === url) return { changed: false, pageId: rows[0].id };
      await request(`/pages/${rows[0].id}`, 'PATCH', { properties: { 'Booking link': { url }, 'Link verified': { checkbox: true } } });
      const after = await request(`/pages/${rows[0].id}`);
      if (propertyValue(after?.properties?.['Booking link']) !== url) throw new NotionError('booking_link_readback_mismatch');
      await request(`/blocks/${rows[0].id}/children`, 'PATCH', { children: [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: note.trim().slice(0, 1800) } }] } }] });
      return { changed: true, pageId: rows[0].id };
    },
    /** A booking link from the Interviewer links board (Recruiting Guides & Templates), or null. */
    async findBookingLink({ interviewer, useFor } = {}) {
      if (typeof interviewer !== 'string' || typeof useFor !== 'string') return null;
      const found = await query(GUIDES_SOURCE_ID, { and: [{ property: 'Interviewer', select: { equals: interviewer } },
        { property: 'Use for', select: { equals: useFor } }, { property: 'Booking link', url: { is_not_empty: true } }] }, 5);
      for (const page of found.results) {
        if (page.object !== 'page' || page.archived || page.in_trash) continue;
        const url = propertyValue(page.properties?.['Booking link']);
        try { if (new URL(url).protocol === 'https:') return url; } catch { /* skip */ }
      }
      return null;
    },
    async upsertOperationsRecord(record = {}) {
      const r = record;
      if (typeof r.requestKey !== 'string' || !r.requestKey.trim() || !OPERATIONS_STATES.includes(r.state) ||
          !['Off', 'Test', 'Live'].includes(r.mode) || typeof r.name !== 'string' || !r.name.trim() ||
          (r.recordKind != null && !['Request', 'Interview', 'Note'].includes(r.recordKind))) throw new NotionError('invalid_operations_record');
      const properties = {
        Name: { title: [{ type: 'text', text: { content: r.name.slice(0, 200) } }] },
        'Record kind': select(r.recordKind ?? 'Request'), Mode: select(r.mode), State: select(r.state),
        'Request key': richText(r.requestKey), Action: richText(r.action ?? ''),
        'Policy version': richText(r.policyVersion ?? ''),
      };
      const optionalText = { 'Source event key': r.sourceEventKey, 'Round instance key': r.occurrenceId,
        'Recipient Slack user IDs': Array.isArray(r.recipientIds) ? r.recipientIds.join(', ') : r.recipientIds,
        'Slack conversation ID': r.channelId, 'Slack message ts': r.messageTs, 'Slack thread ts': r.threadTs,
        'Hold reason': r.holdReason, 'Last error': r.lastError, 'Result evidence': r.resultEvidence,
        'Delivery attempt ID': r.attemptId, 'Source cursors': r.sourceCursors, 'Email subject': r.emailSubject, 'Email body': r.emailBody };
      for (const [name, value] of Object.entries(optionalText)) if (value != null) properties[name] = richText(String(value));
      const optionalDate = { 'Due at': r.dueAt, 'Sent at': r.sentAt, 'Completed at': r.completedAt,
        'Observed at': r.observedAt, 'Event occurred at': r.occurredAt };
      for (const [name, value] of Object.entries(optionalDate)) if (value != null) properties[name] = dateProp(value);
      for (const [name, value] of Object.entries({ 'Slack message URL': r.messageUrl, 'Source URL': r.sourceUrl })) {
        if (value != null) { try { if (new URL(value).protocol !== 'https:') throw new Error(); } catch { throw new NotionError('invalid_record_link'); } properties[name] = { url: value }; }
      }
      if (r.emailTo != null) {
        if (typeof r.emailTo !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(r.emailTo)) throw new NotionError('invalid_email_to');
        properties['Email to'] = { email: r.emailTo };
      }
      if (r.candidatePageId) {
        const id = dashed(r.candidatePageId);
        if (!id) throw new NotionError('invalid_candidate_relation');
        properties.Candidate = { relation: [{ id }] };
      }
      const existing = await api.findOperationsByRequestKey(r.requestKey);
      if (existing.length > 1) throw new NotionError('duplicate_operations_records');
      const page = existing.length === 1
        ? await request(`/pages/${existing[0].pageId}`, 'PATCH', { properties })
        : await request('/pages', 'POST', { parent: { type: 'data_source_id', data_source_id: OPS_SOURCE_ID }, properties });
      if (page?.object !== 'page' || !uuidPattern.test(page.id ?? '') || propertyValue(page.properties?.['Request key']) !== r.requestKey.trim() ||
          propertyValue(page.properties?.State) !== r.state) throw new NotionError('operations_receipt_unverified');
      return { verified: true, pageId: page.id.toLowerCase(), url: page.url ?? null, created: existing.length === 0 };
    },
    /**
     * Liveness line on the control row, kept in "Source cursors" so the human-written
     * "Result evidence" log is never overwritten. Never changes Mode, Baseline complete or Activated at.
     */
    async writeHeartbeat(text) {
      if (typeof text !== 'string' || !text.trim()) throw new NotionError('invalid_heartbeat');
      const page = await request(`/pages/${CONTROL_PAGE_ID}`, 'PATCH', { properties: { 'Source cursors': richText(text.slice(0, 1900)) } });
      controlOf(page);
      return { verified: true };
    },
  });
  return api;
}
