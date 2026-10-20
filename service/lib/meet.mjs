/**
 * Who was really on an interview's Google Meet, and when the interviewers left it (Project, 2026-10-16: "go into these interviews
 * ... see if Robin is there ... as soon as they both get off, boom, Uncle Sam knows to send them the message").
 *
 * Google Meet's REST API keeps a record of each call: when it started and ended, and when each person joined and last left.
 * That record belongs to the person whose Meet it is (usually whoever's booking link made the event), so each interviewer
 * grants it once, read-only (meetings.space.readonly), with Google sign-in from a link Uncle Sam gives Project. Interviewer first;
 * UNCLE_SAM_MEET_PEOPLE lists who is asked (comma names: interviewer, robin, alexis, project). Same OAuth client and redirect as
 * Project's Gmail grant (/api/google/callback); the one-use state says which grant a sign-in finishes. Tokens are sealed with
 * the bot's token key, like Gmail's. Nothing here changes a meeting or reads what was said: only times and who joined.
 *
 * Used by the interview follow-up (agent-runner planInterviewFollowUps):
 *   - the question goes out a minute after every interviewer who joined has left (even before the calendar end), and is held
 *     while they are still on the call (up to an hour past the calendar end);
 *   - the interviewers who actually joined are the ones asked (both together in one group DM when two of them joined);
 *   - a Meet that no guest joined is said in the question ("The Meet shows no guest joined").
 * Without a grant, or when Google says no, everything works as before from the calendar alone.
 */
import { seal, unseal, wisprStore } from './wispr.mjs';
import { gmailConfigured, gmailCallbackUrlOf } from './gmail.mjs';
import { noticeStore } from './stuck-rejections.mjs';
export { MEET_SETTLE_MS } from './workflow-policy.mjs';

export const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';
// Only how long the link waits to be clicked (Project, 2026-10-16: longer than 7 days). The grant itself does not expire.
/** At least this long on the call to count as having taken the interview. */
export const MIN_PRESENT_MS = 5 * 60_000;
export const MEET_LINK_TTL_MS = 30 * 86_400_000;
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MEET_API = 'https://meet.googleapis.com/v2';
const PEOPLE_API = 'https://people.googleapis.com/v1/people:listDirectoryPeople';
const CODE = /meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i;

export class MeetError extends Error {
  constructor(code) { super(code); this.name = 'MeetError'; this.code = code; }
}
const fail = code => { throw new MeetError(code); };
const b64u = bytes => Buffer.from(bytes).toString('base64url');
const random = n => crypto.getRandomValues(new Uint8Array(n));
const sameText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && x.equals(y); };
const tokens = db => {
  const kv = wisprStore(db);
  return { get: n => kv.get(`meet:${n}`), put: (n, v, now) => kv.put(`meet:${n}`, v, now), del: n => kv.del(`meet:${n}`) };
};

export const meetingCodeOf = url => CODE.exec(String(url ?? ''))?.[1]?.toLowerCase() ?? null;
export function meetConfigured(env = {}) { return gmailConfigured(env) && env.UNCLE_SAM_MEET !== 'off'; }

async function http(fetchImpl, url, init = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetchImpl(url, { redirect: 'error', ...init, signal: controller.signal }); }
  catch (error) { fail(error?.name === 'AbortError' ? 'meet_timeout' : 'meet_network_error'); }
  finally { clearTimeout(timer); }
}
async function jsonOf(response, code) {
  try { const text = await response.text(); if (text.length > 2_000_000) throw new Error('large'); return JSON.parse(text); } catch { fail(code); }
}
function claimsOf(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return null; }
}

/** connected | pending (an unexpired link is out; its URL again) | link (a new one). For one person's own Google account. */
export async function prepareMeetLink({ env, db, email, clock = Date.now }) {
  if (!meetConfigured(env)) fail('meet_not_configured');
  const who = String(email ?? '').toLowerCase();
  if (!/^[^\s@]+@company\.example$/.test(who)) fail('meet_email_invalid');
  const now = clock(), kv = tokens(db);
  if (await kv.get(`tokens:${who}`)) return { status: 'connected' };
  const out = await kv.get(`link:${who}`);
  if (out && out.expiresAt > now && out.url) return { status: 'pending', url: out.url, expiresAt: out.expiresAt };
  const state = `meet.${b64u(random(32))}`, verifier = b64u(random(48));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const expiresAt = now + MEET_LINK_TTL_MS;
  const url = new URL(AUTH_URL);
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: env.GMAIL_OAUTH_CLIENT_ID, redirect_uri: gmailCallbackUrlOf(env),
    scope: ['openid', 'email', MEET_SCOPE].join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
    login_hint: who, hd: 'company.example', state, code_challenge: challenge, code_challenge_method: 'S256' })) url.searchParams.set(k, v);
  await kv.put(`pending:${state}`, { email: who, verifier: await seal(env, verifier), expiresAt, createdAt: now }, now);
  await kv.put(`link:${who}`, { state, url: url.toString(), expiresAt, createdAt: now }, now);
  return { status: 'link', url: url.toString(), expiresAt };
}

/** True when this sign-in's state is one of the Meet links (the Gmail callback is tried otherwise). */
export async function isMeetState({ db, state }) {
  return typeof state === 'string' && state.startsWith('meet.') && !!(await tokens(db).get(`pending:${state}`));
}

/** The /api/google/callback step for a Meet link: one use, 30 days, only the account the link was made for. */
export async function completeMeetConnection({ env, db, fetchImpl = globalThis.fetch, clock = Date.now, code, state }) {
  if (!meetConfigured(env)) fail('meet_not_configured');
  const now = clock(), kv = tokens(db);
  if (typeof code !== 'string' || !code || code.length > 2000 || typeof state !== 'string' || state.length > 200) fail('meet_callback_invalid');
  const pending = await kv.get(`pending:${state}`);
  if (!pending) fail('meet_link_invalid');
  await kv.del(`pending:${state}`);
  await kv.del(`link:${pending.email}`); // used up whatever happens next: the next run makes a fresh one
  if (pending.expiresAt <= now) fail('meet_link_expired');
  const response = await http(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: gmailCallbackUrlOf(env), client_id: env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: env.GMAIL_OAUTH_CLIENT_SECRET, code_verifier: await unseal(env, pending.verifier) }).toString() });
  if (!response.ok) fail(`meet_token_http_${response.status}`);
  const got = await jsonOf(response, 'meet_token_invalid');
  if (typeof got.access_token !== 'string' || typeof got.refresh_token !== 'string' || !got.refresh_token) fail('meet_no_refresh_token');
  const claims = claimsOf(got.id_token);
  if (String(claims?.email ?? '').toLowerCase() !== pending.email || claims?.email_verified !== true || claims?.aud !== env.GMAIL_OAUTH_CLIENT_ID) fail('meet_wrong_account');
  if (!String(got.scope ?? '').split(/\s+/).includes(MEET_SCOPE)) fail('meet_scope_missing');
  const saved = { access: got.access_token, refresh: got.refresh_token, expiresAt: now + 1000 * (Number(got.expires_in) > 0 ? Number(got.expires_in) : 3600) };
  await kv.put(`tokens:${pending.email}`, { sealed: await seal(env, JSON.stringify(saved)), sub: String(claims.sub ?? ''), connectedAt: now }, now);
  // Their Google id is how a Meet participant list names them.
  if (claims.sub) await kv.put(`sub:${claims.sub}`, { email: pending.email }, now);
  return { email: pending.email, connectedAt: now };
}

export async function meetConnected({ db, email }) { return !!(await tokens(db).get(`tokens:${String(email).toLowerCase()}`)); }

async function accessTokenOf({ env, db, fetchImpl, email, now }) {
  const kv = tokens(db);
  const record = await kv.get(`tokens:${email}`);
  if (!record) fail('meet_not_connected');
  const t = JSON.parse(await unseal(env, record.sealed));
  if (t.expiresAt - 120_000 > now) return t.access;
  const response = await http(fetchImpl, TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: env.GMAIL_OAUTH_CLIENT_ID, client_secret: env.GMAIL_OAUTH_CLIENT_SECRET }).toString() });
  if (response.status === 400 || response.status === 401) {
    const body = await jsonOf(response, 'meet_refresh_invalid').catch(() => ({}));
    if (body?.error === 'invalid_grant' || response.status === 401) { await kv.del(`tokens:${email}`); fail('meet_disconnected'); }
    fail(`meet_refresh_http_${response.status}`);
  }
  if (!response.ok) fail(`meet_refresh_http_${response.status}`);
  const fresh = await jsonOf(response, 'meet_refresh_invalid');
  if (typeof fresh.access_token !== 'string' || !fresh.access_token) fail('meet_refresh_invalid');
  const next = { ...t, access: fresh.access_token, expiresAt: now + 1000 * (Number(fresh.expires_in) > 0 ? Number(fresh.expires_in) : 3600) };
  await kv.put(`tokens:${email}`, { ...record, sealed: await seal(env, JSON.stringify(next)) }, now);
  return next.access;
}

/**
 * Reads Meet records with the grant of whoever on the event has one. `directoryToken` (Project's grant, directory.readonly)
 * maps Google ids of people who never connected (Robin on Interviewer's call) to their Company email; without it, connected people
 * are still known by their own grant and the rest only by name.
 */
export function createMeetReader({ env, db, fetchImpl = globalThis.fetch, clock = Date.now, directoryToken = null, names = {} } = {}) {
  const kv = tokens(db), notes = noticeStore(db);
  async function directory() {
    const now = clock();
    const cached = await notes.get('meet:directory');
    if (cached && now - cached.at < 86_400_000) return cached.map ?? {};
    const map = {};
    if (typeof directoryToken === 'function') {
      try {
        const token = await directoryToken();
        let page = null;
        for (let i = 0; i < 5; i++) {
          const url = new URL(PEOPLE_API);
          url.searchParams.set('readMask', 'emailAddresses'); url.searchParams.set('sources', 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'); url.searchParams.set('pageSize', '500');
          if (page) url.searchParams.set('pageToken', page);
          const response = await http(fetchImpl, url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
          if (!response.ok) break;
          const body = await jsonOf(response, 'meet_directory_invalid');
          for (const p of body.people ?? []) {
            const id = /^people\/(\d+)$/.exec(p.resourceName ?? '')?.[1];
            const email = (p.emailAddresses ?? []).map(e => String(e.value ?? '').toLowerCase()).find(e => e.endsWith('@company.example'));
            if (id && email) map[id] = email;
          }
          page = body.nextPageToken; if (!page) break;
        }
      } catch { /* names only */ }
    }
    await notes.put('meet:directory', { at: now, map }, now);
    return map;
  }
  async function emailOfId(id, displayName) {
    if (!id) return null;
    const own = await kv.get(`sub:${id}`);
    if (own?.email) return own.email;
    const dir = await directory();
    if (dir[id]) return dir[id];
    // Last resort, a Company person's shown name ("J Quinn Foster" is Interviewer): only exact names from the verified list.
    const byName = Object.entries(names).find(([, shown]) => shown.some(n => n.toLowerCase() === String(displayName ?? '').trim().toLowerCase()));
    return byName ? byName[0] : null;
  }
  async function get(url, token) {
    const response = await http(fetchImpl, url, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
    if (response.status === 403 || response.status === 404) return { denied: response.status };
    if (!response.ok) fail(`meet_http_${response.status}`);
    return jsonOf(response, 'meet_invalid');
  }
  return Object.freeze({
    /** Whether anyone on this event has a Meet grant (no call is made otherwise). */
    async canRead(event) {
      if (!meetingCodeOf(event?.meetUrl)) return false;
      for (const email of hostsOf(event)) if (await kv.get(`tokens:${email}`)) return true;
      return false;
    },
    /**
     * The call behind a calendar event: { found, started, ended, people: [{ email|null, name, joined, left|null }] }, or
     * { found: false, reason }. Only the conference that started within the event's slot counts (a reused Meet link).
     */
    async read(event) {
      const code = meetingCodeOf(event?.meetUrl);
      if (!code) return { found: false, reason: 'no_meet_link' };
      const start = Date.parse(event.start), end = Date.parse(event.end), now = clock();
      if (!Number.isFinite(start) || !Number.isFinite(end)) return { found: false, reason: 'event_time_unknown' };
      let tried = 0;
      for (const host of hostsOf(event)) {
        if (!(await kv.get(`tokens:${host}`))) continue;
        tried++;
        let token;
        try { token = await accessTokenOf({ env, db, fetchImpl, email: host, now }); } catch { continue; }
        const filter = `space.meeting_code = "${code}" AND start_time >= "${new Date(start - 30 * 60_000).toISOString()}" AND start_time <= "${new Date(end).toISOString()}"`;
        const list = await get(`${MEET_API}/conferenceRecords?pageSize=10&filter=${encodeURIComponent(filter)}`, token);
        if (list.denied) continue;
        // Every call in the slot, oldest first: a call everyone left and rejoined is a second record of the same interview.
        const records = (list.conferenceRecords ?? []).filter(r => Number.isFinite(Date.parse(r.startTime)))
          .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime)).slice(-4);
        if (!records.length) continue;
        const byPerson = new Map();
        for (const record of records) {
          let page = null;
          for (let i = 0; i < 3; i++) {
            const body = await get(`${MEET_API}/${record.name}/participants?pageSize=100${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`, token);
            if (body.denied) break;
            for (const p of body.participants ?? []) {
              const id = /^users\/(\d+)$/.exec(p.signedinUser?.user ?? '')?.[1] ?? null;
              const name = String(p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName ?? '').slice(0, 80);
              const joined = Date.parse(p.earliestStartTime) || null, left = p.latestEndTime ? Date.parse(p.latestEndTime) || null : null;
              const key = id ? `u:${id}` : `n:${name}:${p.name ?? ''}`;
              const prior = byPerson.get(key);
              // Across calls: earliest join; still on if on in the latest call; present time added up.
              const present = Math.max(0, ((left ?? now) - (joined ?? now)));
              if (prior) byPerson.set(key, { ...prior, joined: Math.min(prior.joined ?? joined, joined ?? prior.joined), left, present: prior.present + present });
              else byPerson.set(key, { id, email: id ? await emailOfId(id, name) : null, name, joined, left, present });
            }
            page = body.nextPageToken; if (!page) break;
          }
        }
        const last = records.at(-1);
        const people = [...byPerson.values()].map(({ id, ...rest }) => ({ ...rest, signedIn: !!id }));
        return { found: true, host, calls: records.length, started: Date.parse(records[0].startTime), ended: last.endTime ? Date.parse(last.endTime) || null : null, people, readAt: now };
      }
      return { found: false, reason: tried ? 'no_record' : 'no_grant' };
    },
  });
}

/** The people on the event who might hold the Meet: its organizer first, then Company guests. */
function hostsOf(event) {
  const list = [event?.organizer, ...(event?.attendees ?? []).map(a => a.email)].map(e => String(e ?? '').toLowerCase()).filter(e => e.endsWith('@company.example'));
  return [...new Set(list)];
}

/**
 * What a Meet record means for the follow-up. `interviewerByEmail` maps Company emails to Slack ids of interviewers.
 *   joined: interviewers who were on it; live: one of them is still on it; endedAt: when the last of them left (null while
 *   live or when none joined); guestJoined: anyone not from Company joined.
 */
export function meetSummary(meet, interviewerByEmail = {}) {
  if (!meet?.found) return null;
  const isCompany = p => !!p.email && p.email.endsWith('@company.example');
  const interviewers = meet.people.filter(p => isCompany(p) && interviewerByEmail[p.email]);
  // Someone who popped in for a minute (to check the link, to say hi) did not take the interview: at least 5 minutes, or
  // half the call when the whole call was shorter than 10 minutes.
  const span = Math.max(1, ...meet.people.map(p => (Number.isFinite(p.present) ? p.present : 0)));
  const took = interviewers.filter(p => (p.present ?? Infinity) >= Math.min(MIN_PRESENT_MS, span / 2));
  const joined = [...new Set(took.map(p => interviewerByEmail[p.email]))];
  const live = !meet.ended && interviewers.some(p => !p.left);
  const lefts = took.map(p => p.left ?? meet.ended);
  const endedAt = took.length && !live && lefts.every(Number.isFinite) ? Math.max(...lefts) : null;
  const guestJoined = meet.people.some(p => !isCompany(p));
  // How long the interviewers who took it were on the call: how long they waited, when no guest ever came (no-show.mjs).
  const interviewerMs = took.length ? Math.max(...took.map(p => (Number.isFinite(p.present) ? p.present : 0))) : 0;
  return { joined, live, endedAt, guestJoined, interviewerMs, noInterviewer: !interviewers.length && (!!meet.ended || meet.people.every(p => p.left)), callEnded: !!meet.ended };
}

/**
 * The connect links, to Project (Project, 2026-10-16: "I'll work on this with Interviewer first, so I can see his links"): one DM per
 * link while someone on the list has not connected, a new link when the last one expires, and one line when they connect.
 */
export async function runMeetConnect({ env, db, poster, people = [], clock = Date.now }) {
  const summary = { connected: [], linked: [], error: null };
  if (!meetConfigured(env) || !db?.prepare || typeof poster !== 'function') return summary;
  const notes = noticeStore(db), now = clock();
  for (const { key, name, email } of people) {
    try {
      if (await meetConnected({ db, email })) {
        summary.connected.push(key);
        if (!(await notes.get(`meet:told-connected:${email}`))) {
          await notes.put(`meet:told-connected:${email}`, { at: now }, now);
          await poster(`🫡 ${name}'s Google Meet is connected. On ${name}'s calls I now see who actually joined and when they left, and ask for feedback within about a minute of the interviewers leaving.`);
        }
        continue;
      }
      const link = await prepareMeetLink({ env, db, email, clock });
      if (link.status !== 'link') continue;
      summary.linked.push(key);
      await poster(`🔗 Google Meet link for ${name}: have ${name} open it signed in as ${email} and tap Allow. Read-only: it shows me when each interview's call really ends and who was on it, nothing that was said. The link works for 30 days; once he taps Allow it stays connected.\n${link.url}`);
    } catch (error) { summary.error = error?.code ?? 'failed'; }
  }
  return summary;
}

const KNOWN = Object.freeze({ interviewer: { name: 'Interviewer', email: 'quinn@company.example' }, robin: { name: 'Robin', email: 'robin@company.example' },
  alexis: { name: 'Alexis', email: 'alexis@company.example' }, project: { name: 'Project', email: 'project@company.example' } });
/** Who is asked to connect: UNCLE_SAM_MEET_PEOPLE (default "interviewer"), with each one's address from INTERVIEWER_EMAILS_JSON when it lists them. */
export function meetPeopleOf(env = {}, interviewerEmails = {}, slackIds = {}) {
  const wanted = String(env.UNCLE_SAM_MEET_PEOPLE ?? 'interviewer').toLowerCase().split(',').map(x => x.trim()).filter(x => KNOWN[x]);
  return [...new Set(wanted)].map(key => {
    const listed = slackIds[key] ? Object.entries(interviewerEmails ?? {}).find(([, id]) => id === slackIds[key])?.[0] : null;
    return { key, name: KNOWN[key].name, email: String(listed ?? KNOWN[key].email).toLowerCase() };
  });
}

const TEAM_NAMES = /\b(robin|alexis|interviewer|quinn|project|jamie|rory)\b/i;
/**
 * Once a day after a grant (and once right after it), the last day's calls with a guest are read and kept, compact, in
 * uncle_sam_notices "meet:probe:last": whether Google returned a record, how many calls and people, which Company people were
 * recognised (by name before the @) and any signed-in name that looks like the team's but was not recognised. No guest names.
 */
export async function probeMeet({ reader, calendar, calendarIds = [], db, clock = Date.now, force = false }) {
  if (!reader || !calendar || !db?.prepare) return null;
  const notes = noticeStore(db), now = clock(), day = new Date(now).toISOString().slice(0, 10);
  if (!force && (await notes.get(`meet:probe:${day}`))) return null;
  await notes.put(`meet:probe:${day}`, { at: now }, now);
  const seen = new Set(), rows = [];
  for (const calendarId of calendarIds) {
    let events = [];
    try { events = await calendar.listEvents({ calendarId, timeMin: now - 24 * 3600_000, timeMax: now }); } catch { continue; }
    for (const event of events) {
      const key = event.iCalUID ?? event.id;
      if (seen.has(key) || !event.meetUrl || Date.parse(event.end) > now) continue;
      if (!(event.attendees ?? []).some(a => !String(a.email).endsWith('@company.example'))) continue;
      seen.add(key);
      if (!(await reader.canRead(event).catch(() => false))) continue;
      let read;
      try { read = await reader.read(event); } catch (error) { rows.push({ event: String(event.id).slice(0, 10), error: error?.code ?? 'failed' }); continue; }
      if (!read.found) { rows.push({ event: String(event.id).slice(0, 10), organizer: String(event.organizer ?? '').split('@')[0], found: false, reason: read.reason }); continue; }
      rows.push({ event: String(event.id).slice(0, 10), organizer: String(event.organizer ?? '').split('@')[0], found: true, calls: read.calls, people: read.people.length,
        company: read.people.filter(p => p.email).map(p => `${p.email.split('@')[0]}:${Math.round((p.present ?? 0) / 60_000)}m`),
        unrecognised: read.people.filter(p => !p.email && p.signedIn && TEAM_NAMES.test(p.name)).map(p => p.name),
        guests: read.people.filter(p => !p.email).length, endedAfterSlotMin: read.ended ? Math.round((read.ended - Date.parse(event.end)) / 60_000) : null });
      if (rows.length >= 12) break;
    }
  }
  await notes.put('meet:probe:last', { at: now, rows }, now);
  return rows;
}
