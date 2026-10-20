/**
 * Calendar questions to Uncle Sam (Project, 2026-10-16).
 *
 *  - "When is this scheduled for?" — when a person's call or interview is booked. Uncle Sam works out who is meant from the
 *    question, the earlier messages it points at ("answer the questions above") and their screenshots, and finds the booking
 *    on the team's calendars.
 *  - "What's on Robin's calendar tomorrow?", "what do I have Thursday?", "who's booked this week?" — a teammate's calendar,
 *    or the bookings across the team, for a day or a range (up to 14 days), today or later dates.
 *
 * Asked by tagging Uncle Sam in #int-recruitment (anyone there), by tagging it elsewhere (teammates), or in a teammate's own
 * DM with Uncle Sam. Calendars are those in GOOGLE_CALENDAR_IDS, read with Project's grant. Read-only: it never changes a
 * calendar, a record or a message. Anything that is not a calendar question goes on to the usual lanes. Screenshots need the
 * bot's files:read scope.
 */
import { slackWire } from './slack-wire.mjs';
import { bookingHints, PEOPLE, RECRUITING_TITLE } from './agent-runner.mjs';

export const LOOKAHEAD_DAYS = 30;
export const MAX_RANGE_DAYS = 14;
export const OPEN_CHANNEL = 'C01D1A69CE3'; // #int-recruitment: anyone there may ask
const LOOKBACK_MS = 2 * 86400_000;
const CONTEXT_WINDOW_S = 6 * 3600;
const MAX_IMAGES = 2;
const MAX_IMAGE_BYTES = 3_000_000;
const MAX_LINES = 40;
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/;

const CAL_WORDS = /\b(when|what time|schedul\w*|book\w*|meeting|meetings|calls?|calendar|interview\w*|today|tonight|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thurs|fri|sat|sun|week|weekend|free|busy|availab\w*)\b|\b(above|earlier|previous)\b/i;
const QUESTIONISH = /\?|^\s*(?:<@[^>]+>\s*)?(?:hey\s+|hi\s+)?(?:what|whats|what's|when|whens|when's|who|whos|who's|where|which|is|are|am|do|does|did|can|could|show|list|tell|give|answer|any|anything|check|pull)\b/i;
/** Worth a closer look: a question with a calendar word, or a pointer back to earlier messages. */
export const mightAskBooking = text => { const t = String(text ?? ''); return CAL_WORDS.test(t) && QUESTIONISH.test(t); };

const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9@.' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const nameParts = name => fold(name).split(' ').filter(w => w.length > 1 && !/[@.]/.test(w));

/** Does this calendar event belong to `name`? Every part of the name in the title, the booking text or a guest's address. */
export function eventMatches(event, name) {
  const parts = nameParts(name);
  if (parts.length < 1) return false;
  const hints = bookingHints(event);
  const hay = ` ${fold([event.summary, event.description, ...hints.names].join(' '))} `;
  const words = new Set(hay.split(' '));
  if (parts.every(p => words.has(p))) return true;
  // A guest address made of the name ("caseyjreed@example.test", "casey.reed@…").
  const locals = (event.attendees ?? []).map(a => String(a.email ?? '').split('@')[0].replace(/[^a-z]/g, ''));
  return parts.length >= 2 && locals.some(l => l.startsWith(parts[0]) && l.includes(parts[parts.length - 1]));
}

const capital = s => s === 'aa' ? 'AA' : s.charAt(0).toUpperCase() + s.slice(1);
const NAME_BY_ID = Object.fromEntries(Object.entries(PEOPLE).map(([name, id]) => [id, capital(name)]));
/** Address names a teammate's calendar may go by. */
const LOCAL_NAMES = Object.freeze({ project: ['project'], robin: ['robin'], alexis: ['alexis'], interviewer: ['interviewer', 'quinn'], jamie: ['jamie'], aa: ['aa', 'rory'] });
export const TEAM_NAMES = Object.freeze(Object.keys(PEOPLE).map(capital));

/** The calendar id of a teammate ("Robin", "Interviewer"), from INTERVIEWER_EMAILS_JSON or the address, or null. */
export function calendarOf(person, calendarIds = [], interviewerEmails = {}) {
  const key = String(person ?? '').toLowerCase();
  const id = PEOPLE[key];
  if (!id) return null;
  return calendarIds.find(c => interviewerEmails[c.toLowerCase()] === id)
    ?? calendarIds.find(c => (LOCAL_NAMES[key] ?? []).includes(c.toLowerCase().split('@')[0])) ?? null;
}

/** Who the call is with: the team members on it (not Project unless he is the only one), else whose calendar it is on. */
export function teammateOf(email, interviewerEmails = {}) {
  const address = String(email ?? '').toLowerCase();
  if (NAME_BY_ID[interviewerEmails[address]]) return NAME_BY_ID[interviewerEmails[address]];
  if (!address.endsWith('@company.example')) return null;
  const key = Object.keys(LOCAL_NAMES).find(k => LOCAL_NAMES[k].includes(address.split('@')[0]));
  return key ? capital(key) : null;
}
export function withWhom(event, interviewerEmails = {}) {
  const team = [...new Set((event.attendees ?? []).map(a => teammateOf(a.email, interviewerEmails)).filter(Boolean))];
  const shown = team.length > 1 ? team.filter(n => n !== 'Project') : team;
  if (shown.length) return shown.join(' and ');
  return teammateOf(event.calendarId, interviewerEmails) ?? String(event.calendarId ?? '').split('@')[0];
}

const pt = (ms, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...opts }).format(ms);
/** "2026-10-16" in Pacific time. */
export const ptDate = ms => pt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
/** The instant a Pacific date starts (handles PDT and PST). */
export function ptStart(date) {
  for (const off of ['-07:00', '-08:00']) {
    const ms = Date.parse(`${date}T00:00:00${off}`);
    if (Number.isFinite(ms) && ptDate(ms) === date && Number(pt(ms, { hour: 'numeric', hourCycle: 'h23' })) % 24 === 0) return ms;
  }
  return NaN;
}
const addDays = (date, n) => ptDate(ptStart(date) + n * 86400_000 + 12 * 3600_000);
/** "Mon Oct 19". */
export const dayLabel = date => pt(ptStart(date) + 12 * 3600_000, { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
/** "1:50–2:20 PM", "11:30 AM–12:30 PM". */
export function timeRange(startIso, endIso) {
  const s = Date.parse(startIso ?? ''), e = Date.parse(endIso ?? '');
  const t = ms => pt(ms, { hour: 'numeric', minute: '2-digit' });
  if (!Number.isFinite(s)) return '';
  if (!Number.isFinite(e)) return t(s);
  const [sh, sm] = t(s).split(' '), [eh, em] = t(e).split(' ');
  return `${sm === em ? sh : `${sh} ${sm}`}–${eh} ${em}`;
}
/** "Mon Oct 19, 1:50–2:20 PM PT". */
export function whenText(startIso, endIso) {
  const s = Date.parse(startIso ?? '');
  if (!Number.isFinite(s)) return '';
  return `${dayLabel(ptDate(s))}, ${timeRange(startIso, endIso)} PT`;
}
const bookedText = (createdIso, now) => {
  const c = Date.parse(createdIso ?? '');
  if (!Number.isFinite(c)) return '';
  return ` (booked ${ptDate(c) === ptDate(now) ? 'today' : pt(c, { weekday: 'short' })} at ${pt(c, { hour: 'numeric', minute: '2-digit' })})`;
};
const line = (name, event, interviewerEmails, now) => {
  const past = Date.parse(event.end ?? event.start) < now;
  return `${name} ${past ? 'had' : 'is booked for'} a call with ${withWhom(event, interviewerEmails)}: *${whenText(event.start, event.end)}*${bookedText(event.created, now)}`;
};

/** The reply for "when is X scheduled". */
export function bookingReply({ names, found, recent = [], interviewerEmails = {}, now, imagesUnread = false }) {
  if (names.length) {
    const lines = [];
    for (const name of names) {
      const mine = found.filter(f => f.name === name).map(f => f.event);
      const coming = mine.filter(e => Date.parse(e.end ?? e.start) >= now);
      const pick = coming.length ? coming : mine.slice(-1);
      if (pick.length) for (const e of pick.slice(0, 3)) lines.push(line(name, e, interviewerEmails, now));
      else lines.push(`I don't see a booking for ${name} on the team's calendars in the next ${LOOKAHEAD_DAYS} days.`);
    }
    return `🗓️ ${lines.join('\n🗓️ ')}`;
  }
  const lead = imagesUnread ? "I can't open screenshots yet, so I couldn't tell who you mean." : "I couldn't tell who you mean.";
  if (!recent.length) return `🗓️ ${lead} Give me their name and I'll check the calendars.`;
  const list = recent.slice(0, 4).map(r => `• ${line(r.name ?? r.event.summary, r.event, interviewerEmails, now)}`).join('\n');
  return `🗓️ ${lead} Bookings made in the last day:\n${list}`;
}

/** An outside booking (interview or booked call): a booking page wrote it, it names a guest, or it looks like an interview. */
export function isBooking(event) {
  const hints = bookingHints(event);
  const outside = (event.attendees ?? []).some(a => !/@company\.example$/.test(a.email));
  return hints.booked || hints.names.length > 0 || (outside && RECRUITING_TITLE.test(event.summary ?? ''));
}
const guestOf = event => {
  const hints = bookingHints(event);
  if (hints.names[0]) return hints.names[0];
  const outside = (event.attendees ?? []).find(a => !/@company\.example$/.test(a.email));
  return outside ? outside.email : (event.summary || 'Booking');
};
const titleOf = event => String(event.summary ?? '').trim() || 'Busy';

/** The reply for "what's on X's calendar" / "who's booked": one block per day. */
export function scheduleReply({ who, from, to, days, bookingsOnly, missing = [], interviewerEmails = {}, truncated = false }) {
  const span = from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`;
  const head = bookingsOnly ? `*Booked${who ? ` with ${who}` : ''} · ${span}*` : `*${who}'s calendar · ${span}*`;
  const out = [`🗓️ ${head}`];
  let count = 0;
  for (const { date, events } of days) {
    if (!events.length) continue;
    if (from !== to) out.push(`*${dayLabel(date)}*`);
    for (const e of events) {
      if (count >= MAX_LINES) break;
      const time = e.allDay ? 'All day' : timeRange(e.start, e.end);
      out.push(bookingsOnly ? `• ${time} — ${guestOf(e)}, with ${withWhom(e, interviewerEmails)}` : `• ${time} — ${titleOf(e)}`);
      count++;
    }
  }
  if (!count) out.push(bookingsOnly ? 'No bookings.' : 'Nothing on the calendar.');
  if (truncated || count >= MAX_LINES) out.push(`_Showing the first ${count}; ask for a shorter range for the rest._`);
  for (const m of missing) out.push(`_I can't see ${m}'s calendar._`);
  return out.join('\n');
}

export const CALENDAR_DIGEST = `You help Uncle Sam, Company AI's recruiting coordinator, answer calendar questions in Slack. You get the latest Slack message and, before it, the earlier messages in that conversation, with any screenshots, plus who asked and today's date.

Decide the kind:
- booking: the latest message (read with the earlier messages it points at, e.g. "answer the questions above", "when is he scheduled?") asks when a particular outside person's call, meeting or interview is, or whether they booked one. names: that person's full name(s), as written in the messages or screenshots. In a screenshot of a chat, it is usually the other person in the conversation (the name in the chat's header) who says they booked. Never a Company teammate. Empty when no name can be read.
- schedule: it asks what is on a teammate's calendar, what someone has on a day, who is booked or interviewing, or what is coming up, for a day or a range. people: whose calendar, from ${TEAM_NAMES.join(', ')} ("me", "my", "I" = the person who asked; empty = the whole team). bookings_only: true when they ask about bookings, interviews or who is booked rather than everything on the calendar. from/to: the dates meant, YYYY-MM-DD, inclusive ("today", "tomorrow", "Thursday" = the next one from the list, "this week" = today to Sunday, "next week" = next Monday to Sunday). No date said: today.
- none: anything else (a candidate's stage or status, a request to change something, feedback, chatter).

Call the calendar_question tool exactly once.`;

export const CALENDAR_TOOL = Object.freeze({ name: 'calendar_question', description: 'Terminal: what kind of calendar question this is, and its details.',
  input_schema: { type: 'object', additionalProperties: false, required: ['kind'], properties: {
    kind: { type: 'string', enum: ['booking', 'schedule', 'none'] },
    names: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 80 } },
    people: { type: 'array', maxItems: 6, items: { type: 'string', enum: [...TEAM_NAMES, 'me'] } },
    bookings_only: { type: 'boolean' },
    from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } } } });

const TEAM = /^(project|robin|alexis|interviewer|quinn|jamie|aa|rory|uncle sam)\b/i;

/** The model's reading, checked: dates within reach, the range at most 14 days, people resolved. */
export function checkReading(input, { today, asker }) {
  if (!input || !['booking', 'schedule', 'none'].includes(input.kind)) return null;
  const names = [...new Set((Array.isArray(input.names) ? input.names : []).map(n => String(n).replace(/\s+/g, ' ').trim()).filter(n => n && !TEAM.test(n) && nameParts(n).length))].slice(0, 3);
  const valid = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(ptStart(d));
  let from = valid(input.from) ? input.from : today;
  let to = valid(input.to) ? input.to : from;
  if (to < from) [from, to] = [to, from];
  if (from < addDays(today, -7)) from = addDays(today, -7);
  if (to > addDays(today, 90)) to = addDays(today, 90);
  if (to < from) to = from;
  let truncated = false;
  if (addDays(from, MAX_RANGE_DAYS - 1) < to) { to = addDays(from, MAX_RANGE_DAYS - 1); truncated = true; }
  const people = [...new Set((Array.isArray(input.people) ? input.people : []).map(p => (p === 'me' ? asker : p)).filter(p => TEAM_NAMES.includes(p)))];
  return { kind: input.kind, names, people, bookingsOnly: input.bookings_only === true, from, to, truncated };
}

export function createBookingAnswerer({ env = {}, claude, calendar, calendarIds = [], interviewerEmails = {}, fetchImpl = globalThis.fetch, clock = Date.now, log = () => {} }) {
  const token = env.SLACK_BOT_TOKEN;
  async function slack(method, params) {
    const response = await fetchImpl(`https://slack.com/api/${method}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), ...slackWire(method, token, params) });
    const body = await response.json().catch(() => null);
    if (body?.ok !== true) throw Object.assign(new Error('slack'), { code: `slack_${body?.error ?? response.status}` });
    return body;
  }

  /** The message and the human messages shortly before it (in its thread, or the conversation), oldest first. */
  async function conversation(event) {
    const latest = event.messageTs;
    const oldest = (Number(latest) - CONTEXT_WINDOW_S).toFixed(6);
    let messages = [];
    try {
      const body = event.threadTs && event.threadTs !== event.messageTs
        ? await slack('conversations.replies', { channel: event.channelId, ts: event.threadTs, latest, inclusive: true, limit: 30 })
        : await slack('conversations.history', { channel: event.channelId, latest, oldest, inclusive: true, limit: 8 });
      messages = (body.messages ?? []).filter(m => Number(m.ts) <= Number(latest));
    } catch (error) { log(`uncle_sam_booking context_unread error=${error?.code ?? 'failed'}`); }
    messages.sort((a, b) => Number(a.ts) - Number(b.ts));
    if (!messages.some(m => m.ts === latest)) messages.push({ ts: latest, user: event.authorId, text: event.text ?? '' });
    // Bot posts are left out; a thread keeps its root (the screenshot is usually there).
    return messages.filter(m => !m.bot_id && !m.subtype?.startsWith?.('bot')).slice(-6);
  }

  /** Up to two screenshots from those messages (newest first), as model image blocks. null entries mean "could not open". */
  async function images(messages) {
    const files = messages.slice().reverse().flatMap(m => m.files ?? []).filter(f => IMAGE_TYPES.test(f?.mimetype ?? '')).slice(0, MAX_IMAGES);
    const out = [];
    for (const f of files) {
      const url = Number(f.size) > 0 && Number(f.size) <= MAX_IMAGE_BYTES ? f.url_private : (f.thumb_1024 ?? f.thumb_720 ?? null);
      if (!/^https:\/\/files\.slack\.com\//.test(url ?? '')) { out.push(null); continue; }
      try {
        const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
        const type = (response.headers.get('content-type') ?? '').split(';')[0].trim();
        if (!response.ok || !IMAGE_TYPES.test(type)) { await response.body?.cancel?.().catch(() => {}); out.push(null); continue; }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES * 1.4) { out.push(null); continue; }
        out.push({ type: 'image', source: { type: 'base64', media_type: type === 'image/jpg' ? 'image/jpeg' : type, data: Buffer.from(bytes).toString('base64') } });
      } catch { out.push(null); }
    }
    return out;
  }

  async function read(messages, pictures, { asker, now }) {
    const who = id => NAME_BY_ID[id] ?? 'A colleague';
    const lines = messages.map((m, i) => `${i === messages.length - 1 ? 'LATEST — ' : ''}${who(m.user)}: ${String(m.text ?? '').replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${NAME_BY_ID[id] ?? (id === env.SLACK_BOT_USER_ID ? 'Uncle Sam' : 'someone')}`).slice(0, 1500)}${(m.files ?? []).length ? ' [screenshot attached]' : ''}`);
    const today = ptDate(now);
    const dates = Array.from({ length: 14 }, (_, i) => { const d = addDays(today, i); return `${pt(ptStart(d) + 12 * 3600_000, { weekday: 'long' })} ${d}${i === 0 ? ' (today)' : ''}`; }).join(', ');
    const header = `Asked by: ${asker ?? 'a colleague'}. Dates (Pacific): ${dates}.\n\n`;
    const content = [...pictures.filter(Boolean), { type: 'text', text: header + lines.join('\n') }];
    const result = await claude.complete({ system: CALENDAR_DIGEST, messages: [{ role: 'user', content }], tools: [CALENDAR_TOOL], toolChoice: { type: 'tool', name: CALENDAR_TOOL.name }, maxTokens: 400 });
    const call = (result.content ?? []).find(b => b.type === 'tool_use' && b.name === CALENDAR_TOOL.name);
    return checkReading(call?.input, { today, asker });
  }

  async function lookup(names, now) {
    const timeMin = now - LOOKBACK_MS, timeMax = now + LOOKAHEAD_DAYS * 86400_000;
    const found = [], seen = new Set();
    for (const name of names) {
      for (const calendarId of calendarIds) {
        let events = [];
        try { events = await calendar.listEvents({ calendarId, timeMin, timeMax, maxResults: 20, q: nameParts(name).join(' ') }); } catch { continue; }
        for (const e of events) {
          if (e.status === 'cancelled' || e.allDay || !eventMatches(e, name)) continue;
          const key = `${name}|${e.iCalUID ?? e.id}`;
          if (seen.has(key)) continue;
          seen.add(key); found.push({ name, event: e });
        }
      }
    }
    return found.sort((a, b) => Date.parse(a.event.start) - Date.parse(b.event.start));
  }

  /** Bookings made from a booking page in the last day (when no name could be found). */
  async function recentBookings(now) {
    const out = [], seen = new Set();
    for (const calendarId of calendarIds) {
      let events = [];
      try { events = await calendar.listEvents({ calendarId, timeMin: now, timeMax: now + LOOKAHEAD_DAYS * 86400_000, maxResults: 500 }); } catch { continue; }
      for (const e of events) {
        const hints = bookingHints(e);
        if (!hints.booked || !(now - Date.parse(e.created ?? '') <= 86400_000) || seen.has(e.iCalUID ?? e.id)) continue;
        seen.add(e.iCalUID ?? e.id);
        out.push({ name: hints.names[0] ?? null, event: e });
      }
    }
    return out.sort((a, b) => Date.parse(b.event.created) - Date.parse(a.event.created));
  }

  /** The events on these calendars between the dates, one copy each, grouped by Pacific day. */
  async function scheduleDays(ids, { from, to, bookingsOnly }) {
    const timeMin = ptStart(from), timeMax = ptStart(addDays(to, 1));
    const merged = new Map();
    for (const calendarId of ids) {
      let events = [];
      try { events = await calendar.listEvents({ calendarId, timeMin, timeMax, maxResults: 250 }); } catch { continue; }
      for (const e of events) {
        if (e.status === 'cancelled' || (e.attendees ?? []).some(a => a.self && a.responseStatus === 'declined')) continue;
        if (bookingsOnly && !isBooking(e)) continue;
        const key = e.iCalUID ?? e.id;
        const prior = merged.get(key);
        if (!prior) { merged.set(key, { ...e, attendees: [...(e.attendees ?? [])] }); continue; }
        const have = new Set(prior.attendees.map(a => a.email));
        for (const a of e.attendees ?? []) if (!have.has(a.email)) prior.attendees.push(a);
      }
    }
    const days = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const events = [...merged.values()].filter(e => (e.allDay ? String(e.start).slice(0, 10) === d : ptDate(Date.parse(e.start)) === d))
        .sort((a, b) => (a.allDay === b.allDay ? Date.parse(a.start) - Date.parse(b.start) : a.allDay ? -1 : 1));
      days.push({ date: d, events });
    }
    return days;
  }

  /** Returns { text, kind, ... } when this was a calendar question (the caller posts the text), or null. */
  return async function answer(event) {
    if (!claude || !calendar || !calendarIds.length || !/^xoxb-/.test(token ?? '')) return null;
    const teammate = Object.values(PEOPLE).includes(event.authorId);
    if (!teammate && !(event.channelId === OPEN_CHANNEL && /^[UW][A-Z0-9]+$/.test(event.authorId ?? ''))) return null;
    if (!mightAskBooking(event.text)) return null;
    const now = clock();
    const asker = NAME_BY_ID[event.authorId] ?? null;
    const messages = await conversation(event);
    const pictures = await images(messages);
    let reading;
    try { reading = await read(messages, pictures, { asker, now }); } catch (error) { log(`uncle_sam_booking model_failed error=${error?.code ?? 'failed'}`); return null; }
    if (!reading || reading.kind === 'none') return null;
    if (reading.kind === 'schedule') {
      const wanted = reading.people.length ? reading.people : reading.bookingsOnly ? [] : asker ? [asker] : [];
      const ids = [], missing = [];
      for (const p of wanted) { const id = calendarOf(p, calendarIds, interviewerEmails); if (id) ids.push(id); else missing.push(p); }
      const useIds = wanted.length ? ids : calendarIds;
      const who = wanted.length ? wanted.filter(p => !missing.includes(p)).join(' and ') : '';
      if (!useIds.length) return { kind: 'schedule', text: `🗓️ I can't see ${missing.join(' or ')}'s calendar. I can read ${calendarIds.map(c => withWhom({ calendarId: c, attendees: [] }, interviewerEmails)).join(', ')}.` };
      const days = await scheduleDays(useIds, reading);
      log(`uncle_sam_booking kind=schedule calendars=${useIds.length} days=${days.length} events=${days.reduce((n, d) => n + d.events.length, 0)}`);
      return { kind: 'schedule', text: scheduleReply({ who, from: reading.from, to: reading.to, days, bookingsOnly: reading.bookingsOnly || !wanted.length,
        missing, interviewerEmails, truncated: reading.truncated }) };
    }
    const imagesUnread = pictures.some(p => p === null) && !pictures.some(Boolean);
    const found = reading.names.length ? await lookup(reading.names, now) : [];
    const recent = reading.names.length ? [] : await recentBookings(now);
    log(`uncle_sam_booking kind=booking names=${reading.names.length} found=${found.length} recent=${recent.length} images=${pictures.filter(Boolean).length}/${pictures.length}`);
    return { kind: 'booking', text: bookingReply({ names: reading.names, found, recent, interviewerEmails, now, imagesUnread }), names: reading.names, found: found.length };
  };
}
