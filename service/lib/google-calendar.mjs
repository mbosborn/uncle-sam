/**
 * Read-only Google Calendar access (no SDK). Two ways to get a token: Project's own Google grant to Uncle Sam (`tokenProvider`,
 * gmail.mjs; since 2026-10-15, it sees what Project's account sees) or a service account (JWT bearer grant signed with
 * WebCrypto RS256; optional `subject` for domain-wide delegation). Only events.list is exposed. Error codes never carry
 * response bodies.
 */
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export class CalendarError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const encodeJson = value => b64url(new TextEncoder().encode(JSON.stringify(value)));

function pemToPkcs8(pem) {
  const body = String(pem ?? '').replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  if (!body) throw new CalendarError('invalid_service_account_key');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function parseServiceAccount(json) {
  let account;
  try { account = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new CalendarError('invalid_service_account_json'); }
  if (account?.type !== 'service_account' || typeof account.client_email !== 'string' || typeof account.private_key !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.client_email)) throw new CalendarError('invalid_service_account_json');
  return { clientEmail: account.client_email, privateKey: account.private_key, tokenUri: account.token_uri ?? 'https://oauth2.googleapis.com/token' };
}

export function normalizeCalendarEvent(event, calendarId) {
  if (!event || typeof event !== 'object' || typeof event.id !== 'string') return null;
  const time = part => part?.dateTime ?? (part?.date ? `${part.date}T00:00:00Z` : null);
  return { id: event.id, iCalUID: event.iCalUID ?? null, calendarId, summary: typeof event.summary === 'string' ? event.summary.slice(0, 300) : '',
    status: event.status ?? 'confirmed', start: time(event.start), end: time(event.end), allDay: !!event.start?.date,
    updated: event.updated ?? null, created: event.created ?? null, htmlLink: typeof event.htmlLink === 'string' && event.htmlLink.startsWith('https://') ? event.htmlLink : null,
    attendees: (event.attendees ?? []).filter(a => typeof a?.email === 'string').map(a => ({
      email: a.email.toLowerCase(), responseStatus: a.responseStatus ?? null, organizer: a.organizer === true, self: a.self === true })),
    organizer: typeof event.organizer?.email === 'string' ? event.organizer.email.toLowerCase() : null,
    description: plainDescription(event.description), meetUrl: meetUrlOf(event),
    transparent: event.transparency === 'transparent', eventType: event.eventType ?? 'default', recurringEventId: event.recurringEventId ?? null,
    originalStart: time(event.originalStartTime) };
}

/** The video link (Google Meet, or the conference's video entry point), https only. */
export function meetUrlOf(event) {
  const candidates = [event?.hangoutLink, ...(event?.conferenceData?.entryPoints ?? []).filter(p => p?.entryPointType === 'video').map(p => p.uri)];
  for (const url of candidates) { try { if (typeof url === 'string' && new URL(url).protocol === 'https:') return url; } catch { /* next */ } }
  return null;
}

/** An event description as plain text (booking pages put the guest's name and LinkedIn there), at most 3,000 characters. */
export function plainDescription(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  return html.replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 3000);
}

export function createCalendarReader({ serviceAccountJson, subject = null, tokenProvider = null, fetchImpl = globalThis.fetch,
  clock = Date.now, timeoutMs = 15000, maxResponseBytes = 2 * 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl required');
  const account = typeof tokenProvider === 'function' ? { clientEmail: 'project@company.example' } : parseServiceAccount(serviceAccountJson);
  let cached = null;
  async function accessToken() {
    if (typeof tokenProvider === 'function') {
      let token;
      try { token = await tokenProvider(); } catch (error) { throw new CalendarError(typeof error?.code === 'string' ? error.code : 'token_unavailable'); }
      if (typeof token !== 'string' || !token) throw new CalendarError('token_unavailable');
      return token;
    }
    const now = Math.floor(clock() / 1000);
    if (cached && cached.expiresAt - 60 > now) return cached.token;
    const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(account.privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const claims = { iss: account.clientEmail, scope: SCOPE, aud: account.tokenUri, iat: now, exp: now + 3600, ...(subject ? { sub: subject } : {}) };
    const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson(claims)}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    const assertion = `${unsigned}.${b64url(new Uint8Array(signature))}`;
    let response;
    try {
      response = await fetchImpl(account.tokenUri, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
    } catch { throw new CalendarError('token_transport_failed'); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new CalendarError(`token_http_${response.status}`, response.status); }
    let body; try { body = await response.json(); } catch { throw new CalendarError('token_response_invalid'); }
    if (typeof body?.access_token !== 'string' || !Number.isFinite(body.expires_in)) throw new CalendarError('token_response_invalid');
    cached = { token: body.access_token, expiresAt: now + Math.min(body.expires_in, 3600) };
    return cached.token;
  }
  return Object.freeze({
    clientEmail: account.clientEmail,
    async listEvents({ calendarId, timeMin, timeMax, maxResults = 500, q = null } = {}) {
      if (typeof calendarId !== 'string' || !calendarId.trim() || calendarId.length > 254) throw new CalendarError('invalid_calendar_id');
      const min = new Date(timeMin), max = new Date(timeMax);
      if (Number.isNaN(min.getTime()) || Number.isNaN(max.getTime()) || max <= min) throw new CalendarError('invalid_time_window');
      const token = await accessToken();
      // A busy calendar (Robin's) can have more events in the window than one page: Google's next-page token is followed, up to
      // `maxResults` events in all (at most 1,000), so nothing past the first 100 is silently missed (2026-10-16).
      const want = Math.min(Math.max(maxResults, 1), 1000);
      const items = [];
      let pageToken = null;
      for (let page = 0; page < 10 && items.length < want; page++) {
        const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', timeMin: min.toISOString(), timeMax: max.toISOString(),
          maxResults: String(Math.min(want - items.length, 250)), showDeleted: 'false', ...(typeof q === 'string' && q.trim() && q.length <= 254 ? { q: q.trim() } : {}),
          ...(pageToken ? { pageToken } : {}) });
        let response;
        try {
          response = await fetchImpl(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`, {
            method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { authorization: `Bearer ${token}` } });
        } catch { throw new CalendarError('calendar_transport_failed'); }
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new CalendarError(`calendar_http_${response.status}`, response.status); }
        const declared = response.headers.get('content-length');
        if (declared && Number(declared) > maxResponseBytes) throw new CalendarError('response_too_large');
        let body; try { body = await response.json(); } catch { throw new CalendarError('calendar_response_invalid'); }
        if (!Array.isArray(body?.items)) throw new CalendarError('calendar_response_invalid');
        items.push(...body.items);
        pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null;
        if (!pageToken) break;
      }
      return items.map(e => normalizeCalendarEvent(e, calendarId)).filter(Boolean);
    },
    /**
     * Create (no eventId) or change (eventId) one event; needs the calendar.events grant. sendUpdates "all" emails the guests.
     * An unclear answer is marked uncertain so the caller never creates a second copy.
     */
    async writeEvent({ calendarId = 'primary', eventId = null, body, sendUpdates = 'all', conferenceDataVersion = null } = {}) {
      if (typeof calendarId !== 'string' || !calendarId.trim() || (eventId !== null && !/^[a-z0-9_-]{5,1024}$/i.test(eventId)) || !body || typeof body !== 'object') throw new CalendarError('invalid_event_write');
      const token = await accessToken();
      // conferenceDataVersion=1 is what makes Google create the Meet link a body asks for (it was dropped before 2026-10-19,
      // so the check-ins had none and Robin made his own).
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}?sendUpdates=${encodeURIComponent(sendUpdates)}${conferenceDataVersion === 1 ? '&conferenceDataVersion=1' : ''}`;
      let response;
      try {
        response = await fetchImpl(url, { method: eventId ? 'PATCH' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      } catch { const e = new CalendarError('calendar_write_transport_failed'); e.uncertain = true; throw e; }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); const e = new CalendarError(`calendar_write_http_${response.status}`, response.status); e.uncertain = response.status >= 500; throw e; }
      let saved; try { saved = await response.json(); } catch { const e = new CalendarError('calendar_write_response_invalid'); e.uncertain = true; throw e; }
      return normalizeCalendarEvent(saved, calendarId);
    },
  });
}

/**
 * The latest interview with this person that has ended, across the given calendars: { at, sourceUrl } or null. A confirmed,
 * timed event (not all-day) whose guests include the email exactly, ended at or before `now`, within the last `days`.
 */
export async function latestInterviewEnd({ reader, calendarIds = [], email, now, days = 21 }) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!reader || !address) return null;
  let best = null;
  for (const calendarId of calendarIds) {
    let events;
    try { events = await reader.listEvents({ calendarId, timeMin: now - days * 86400_000, timeMax: now, maxResults: 50, q: address }); } catch { continue; }
    for (const e of events) {
      const end = Date.parse(e.end ?? '');
      if (e.allDay || e.status === 'cancelled' || !Number.isFinite(end) || end > now || !e.htmlLink || !e.attendees.some(a => a.email === address)) continue;
      if (!best || end > best.ms) best = { ms: end, at: new Date(end).toISOString(), sourceUrl: e.htmlLink };
    }
  }
  return best ? { at: best.at, sourceUrl: best.sourceUrl } : null;
}
