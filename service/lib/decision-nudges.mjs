/**
 * Overdue decisions (Project, 2026-10-16: "uncle sam would probably dm and ask them what the decision [is] but uncle sam needs to
 * have protections ... so people arent spammed and it doesnt get annoying where uncle sam gets it wrong").
 *
 * Someone was interviewed (Uncle Sam's own interview log), and two business days later nothing has moved: Uncle Sam asks
 * whoever took the interview, in their DM with it (or their group DM when two or more took it), what the call is.
 *
 * Protections:
 *  - Only interviews that ended after this was switched on; never history.
 *  - The state of the record is noted when the interview is first seen. Anything that moves afterwards counts as decided and
 *    stops it for good: Stage, Round, Outcome, the take-home scorecard, any request Uncle Sam made for them after the
 *    interview (a take-home or deep-dive invite, a rejection), a later interview logged, or a next call booked on the
 *    team's calendars. Closed, hired, on-trial and On Hold candidates are never asked about.
 *  - While that interview's feedback request is still open (for up to 4 business days) it is the feedback request's turn.
 *  - Weekdays only, 10 AM–noon Pacific, at most one message per person a day, all their candidates in it (at most 6).
 *  - At most two asks per interview, two business days apart. Still nothing after the second: one line to Project, then never
 *    again. Every reply stops or pauses it: "done", "later" (two business days), "not mine" (to Project).
 *  - Replies can record the decision: "reject" (Robin, Alexis, Interviewer or Project) closes the record Not Selected and the usual
 *    rejection email follows (24 hours after the interview at the earliest, Rejection email hold respected); "hold" (Robin,
 *    Alexis or Project) sets On Hold; "advance" is noted and passed to Project for the next step. Anything else goes to Project.
 *  - Live only; UNCLE_SAM_DECISION_NUDGES=off turns it off; claim before every send, never retried; never throws.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { PEOPLE, NAMES, INTERVIEWER_ROUTES, REJECT_AUTHORITY, HOLD_AUTHORITY, CLOSED_OUTCOMES, permalink } from './agent-runner.mjs';
import { linkedinProfileUrl } from './name-links.mjs';

export const NUDGE_AFTER_BUSINESS_DAYS = 2;
export const MAX_ASKS = 2;
export const FEEDBACK_GRACE_BUSINESS_DAYS = 4;
export const MAX_PER_MESSAGE = 6;
export const WINDOW = Object.freeze({ fromHour: 10, toHour: 12 });
const LOOKBACK_MS = 21 * 86400_000;
const EVERY_MS = 10 * 60_000;
const OPEN_STAGES = Object.freeze(['Outreach', 'Intro Call', 'Interview', 'Case Study']);
const QUIET_ACTIONS = /^(interview\.feedback_(request|reminder)|decision\.)/;
const PREFIX = 'decision:';

const pt = (ms, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...opts }).format(ms);
export const ptDay = ms => pt(ms, { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
const weekday = ms => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(pt(ms, { weekday: 'short' }));
const hourPt = ms => Number(pt(ms, { hour: 'numeric', hourCycle: 'h23' })) % 24;
export const isBusinessDay = ms => { const d = weekday(ms); return d >= 1 && d <= 5; };
/** Business days (Mon–Fri, Pacific) after the day of `fromMs`, up to and including the day of `toMs`. */
export function businessDaysBetween(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  let n = 0;
  const start = ptDay(fromMs);
  for (let ms = fromMs + 12 * 3600_000, guard = 0; guard < 60; ms += 24 * 3600_000, guard++) {
    const day = ptDay(ms);
    if (day === start) continue;
    if (day > ptDay(toMs)) break;
    if (isBusinessDay(ms)) n++;
  }
  return n;
}
export const inWindow = ms => isBusinessDay(ms) && hourPt(ms) >= WINDOW.fromHour && hourPt(ms) < WINDOW.toHour;
const dayText = ms => pt(ms, { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
const plainName = full => String(full ?? '').replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{M}\s'.-]/gu, ' ').replace(/\s+/g, ' ').trim();
const capital = s => (s === 'aa' ? 'AA' : s.charAt(0).toUpperCase() + s.slice(1));
const nameOfId = id => capital(NAMES[id] ?? 'someone');
const kindOf = (summary, candidate) => (/deep[\s-]?dive/i.test(summary ?? '') ? 'Deep dive'
  : /intro/i.test(summary ?? '') || candidate?.fields?.Stage === 'Intro Call' || /intro/i.test(candidate?.fields?.Round ?? '') ? 'Intro call' : 'Interview');

/** What a decision would change on the record (Next action and notes are left out: feedback writes those). */
export function snapshotOf(candidate, card) {
  const f = candidate?.fields ?? {};
  return JSON.stringify({ stage: f.Stage ?? null, round: f.Round ?? null, outcome: f.Outcome ?? null,
    card: card ? [card.takeHomeReview ?? null, card.deepDive ?? null, card.takeHomeStatus ?? card.status ?? null] : null });
}
const closedOrParked = c => !c || c.archived || CLOSED_OUTCOMES.includes(c.fields?.Outcome) || c.fields?.Outcome === 'On Hold' || !OPEN_STAGES.includes(c.fields?.Stage);

/** The message to one person (or group) about their overdue decisions. */
export function askText(items, { group = false } = {}) {
  const lines = items.map(i => `• ${i.linkedin ? `<${i.linkedin}|${i.name}>` : i.name} · ${i.kind} ${dayText(i.end)}${i.asks ? ' (second ask)' : ''}`);
  const one = items.length === 1;
  const example = one ? '"advance", "reject" or "hold"' : `the name and the call, e.g. "${items[0].name.split(' ')[0]} advance"`;
  return `📋 ${one ? 'This one is' : 'These are'} waiting on a decision. Nothing has moved since the ${one ? items[0].kind.toLowerCase() : 'interviews'}${group ? ' you took together' : ''}:\n${lines.join('\n')}\nReply here with ${example}. Or "done" if it's handled, "later" to hear from me in two business days, "not mine" to pass it to Project.`;
}

export async function runDecisionNudges({ env, db, notion, store = null, calendar = null, calendarIds = [], routeMap = {}, groupRoutes = null,
  poster, masonPoster: tellMason = null, clock = Date.now, log = () => {} }) {
  const summary = { state: 'off', tracked: 0, stopped: 0, asked: 0, escalated: 0, error: null };
  try {
    if (env?.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || env?.UNCLE_SAM_DECISION_NUDGES === 'off' || !db?.prepare || typeof notion?.listInterviewRows !== 'function') return summary;
    const kv = noticeStore(db), now = clock();
    const last = await kv.get(`${PREFIX}last`);
    if (last?.at && now - last.at < EVERY_MS) return { ...summary, state: 'not_due' };
    if ((await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    await kv.put(`${PREFIX}last`, { at: now }, now);
    let baseline = (await kv.get(`${PREFIX}baseline`))?.at;
    if (!baseline) { baseline = now; await kv.put(`${PREFIX}baseline`, { at: now }, now); return { ...summary, state: 'baselined' }; }
    summary.state = 'ran';

    // 1. Every interview since the switch-on, newest per candidate (a later interview supersedes an earlier one).
    const rows = (await notion.listInterviewRows({ since: Math.max(baseline, now - LOOKBACK_MS) }))
      .filter(r => r.candidatePageId && r.end && Date.parse(r.end) >= baseline && Date.parse(r.end) <= now && r.status !== 'cancelled');
    const latest = new Map();
    for (const r of rows) { const prior = latest.get(r.candidatePageId); if (!prior || Date.parse(r.end) > Date.parse(prior.end)) latest.set(r.candidatePageId, r); }
    for (const r of rows) {
      if (latest.get(r.candidatePageId) === r) continue;
      const s = await kv.get(`${PREFIX}${r.id}`);
      if (s && !s.stopped) await kv.put(`${PREFIX}${r.id}`, { ...s, stopped: 'later_interview', stoppedAt: now }, now);
    }

    // 2. First sight: note the record as it stands. Later: has anything moved?
    const due = [], escalate = [];
    const open = inWindow(now);
    const cardOf = candidate => (candidate && typeof notion.findTakeHomeScorecard === 'function' ? notion.findTakeHomeScorecard(candidate.pageId).catch(() => null) : null);
    for (const r of latest.values()) {
      const key = `${PREFIX}${r.id}`;
      let s = await kv.get(key);
      if (!s) {
        const first = await notion.getCandidate(r.candidatePageId).catch(() => null);
        s = { candidateId: r.candidatePageId, end: Date.parse(r.end), kind: kindOf(r.summary, first), takers: r.interviewerIds.filter(id => id !== PEOPLE.project),
          snapshot: snapshotOf(first, await cardOf(first)), asks: [], at: now };
        await kv.put(key, s, now);
        summary.tracked++;
        continue;
      }
      // The record is compared with the first-sight note only when an ask would be due, inside the sending window.
      if (s.stopped || !open || (s.snoozedUntil && now < s.snoozedUntil)) continue;
      if (businessDaysBetween(s.asks.at(-1) ?? s.end, now) < NUDGE_AFTER_BUSINESS_DAYS) continue;
      const candidate = await notion.getCandidate(r.candidatePageId).catch(() => null);
      const card = await cardOf(candidate);
      const stop = async reason => { await kv.put(key, { ...s, stopped: reason, stoppedAt: now }, now); summary.stopped++; };
      if (closedOrParked(candidate)) { await stop('closed_or_parked'); continue; }
      if (snapshotOf(candidate, card) !== s.snapshot) { await stop('record_moved'); continue; }
      let requests = [];
      if (store?.listRequestsForCandidate) requests = await store.listRequestsForCandidate({ candidateId: candidate.pageId, limit: 30 }).catch(() => []);
      const madeAt = q => (typeof q.createdAt === 'number' ? q.createdAt : Date.parse(q.createdAt ?? ''));
      if (requests.some(q => madeAt(q) > s.end && !QUIET_ACTIONS.test(q.action ?? ''))) { await stop('next_step_requested'); continue; }
      if (await nextCallBooked(candidate, now)) { await stop('next_call_booked'); continue; }
      const feedbackOpen = requests.some(q => /^interview\.feedback_request$/.test(q.action ?? '') && !['Complete', 'Cancelled', 'Superseded', 'Baselined', 'Failed'].includes(q.state) && madeAt(q) >= s.end - 3600_000);
      if (feedbackOpen && businessDaysBetween(s.end, now) < FEEDBACK_GRACE_BUSINESS_DAYS) continue;
      const item = { key, s, name: plainName(candidate.fullName) || 'This candidate', linkedin: linkedinProfileUrl(candidate.profile?.linkedin), kind: s.kind, end: s.end, asks: s.asks.length, url: candidate.url };
      if (s.asks.length >= MAX_ASKS || !s.takers.length) escalate.push(item); else due.push(item);
    }

    // 3. Weekdays 10 AM–noon Pacific only; one message per person (or group) a day.
    if (!inWindow(now)) return { ...summary, state: 'outside_window', waiting: due.length + escalate.length };
    const today = ptDay(now);
    const byOwner = new Map();
    for (const item of due) { const k = [...item.s.takers].sort().join(','); if (!byOwner.has(k)) byOwner.set(k, []); byOwner.get(k).push(item); }
    for (const [ownerKey, items] of byOwner) {
      const sentKey = `${PREFIX}sent:${today}:${ownerKey}`;
      if (await kv.get(sentKey)) continue;
      const ids = ownerKey.split(',');
      let channelId = null;
      try {
        if (ids.length === 1) channelId = routeMap[INTERVIEWER_ROUTES[ids[0]]]?.channelId ?? null;
        else if (groupRoutes?.ensure) { const routeKey = await groupRoutes.ensure(ids.map(id => NAMES[id]), ids); channelId = groupRoutes.routes?.[routeKey]?.channelId ?? null; }
      } catch { channelId = null; }
      const batch = items.slice(0, MAX_PER_MESSAGE);
      if (!channelId) { escalate.push(...batch.map(i => ({ ...i, noRoute: true }))); continue; }
      // Claimed before the post: an unclear send is never repeated.
      if (!(await kv.claim(sentKey, { at: now, count: batch.length }, now))) continue;
      for (const i of batch) await kv.put(i.key, { ...i.s, asks: [...i.s.asks, now] }, now);
      try {
        const ts = await poster(channelId)(askText(batch, { group: ids.length > 1 }));
        await kv.put(`${PREFIX}thread:${channelId}:${ts}`, { keys: batch.map(i => i.key), ownerIds: ids, at: now }, now);
        summary.asked += batch.length;
      } catch (error) { log(`uncle_sam_decisions ask_failed owners=${ids.length} error=${error?.code ?? 'failed'}`); }
    }
    // 4. Still nothing after two asks (or nobody to ask): one line to Project, then never again.
    const masonKey = `${PREFIX}project:${today}`;
    if (escalate.length && tellMason && !(await kv.get(masonKey))) {
      await kv.put(masonKey, { at: now }, now);
      for (const i of escalate) await kv.put(i.key, { ...i.s, stopped: 'escalated', stoppedAt: now }, now);
      const lines = escalate.slice(0, 10).map(i => `• ${i.linkedin ? `<${i.linkedin}|${i.name}>` : i.name} · ${i.kind} ${dayText(i.end)}${i.s.takers.length ? ` (${i.s.takers.map(nameOfId).join(' and ')}${i.noRoute ? ", whom I can't reach" : `, asked ${i.asks}x`})` : ' (no interviewer on record)'}`);
      await tellMason(`📋 Still no decision on ${escalate.length === 1 ? 'this one' : 'these'}, and I've stopped asking:\n${lines.join('\n')}`).catch(() => {});
      summary.escalated = escalate.length;
    }
    return summary;
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'decision_nudges_failed' }; }

  /** A later call with them on the team's calendars (their email on the invite), in the next 30 days. */
  async function nextCallBooked(candidate, now) {
    if (!calendar || !calendarIds.length || !candidate.email) return false;
    for (const calendarId of calendarIds) {
      try {
        const events = await calendar.listEvents({ calendarId, timeMin: now, timeMax: now + 30 * 86400_000, maxResults: 10, q: candidate.email });
        if (events.some(e => e.status !== 'cancelled' && (e.attendees ?? []).some(a => a.email === candidate.email.toLowerCase()))) return true;
      } catch { /* the next calendar */ }
    }
    return false;
  }
}

const has = (re, text) => re.test(text);
export const INTENTS = Object.freeze([
  ['not_mine', /\b(not mine|not my call|not me|ask (?:robin|alexis|project|interviewer|aa))\b/i],
  ['later', /\b(later|snooze|tomorrow|next week|not yet|need (?:more )?time|give me)\b/i],
  ['done', /\b(done|handled|already|decided|taken care|sorted)\b/i],
  ['reject', /\b(reject|rejected|no hire|not a fit|pass on (?:him|her|them)|decline|not moving|don'?t move|do not move)\b/i],
  ['hold', /\b(hold|on hold|pause)\b/i],
  ['advance', /\b(advance|proceed|move (?:him|her|them) (?:forward|ahead|on)|move forward|take-?home|next round|work trial|send (?:the )?case)\b/i],
]);
/** The one intent a reply states, or null when it states none or several that conflict (those go to Project). */
export function intentOf(text) {
  const found = INTENTS.filter(([, re]) => has(re, text)).map(([k]) => k);
  if (!found.length) return null;
  const decisive = found.filter(k => ['reject', 'hold', 'advance'].includes(k));
  if (decisive.length > 1) return null;
  return found[0];
}

/**
 * A reply in the thread of a decision ask. Returns an outcome when it was one, else null (the usual lanes take it).
 */
export async function handleDecisionReply({ event, env, db, notion, poster, masonPoster: tellMason = null, clock = Date.now, sideEffects = [] }) {
  if (!db?.prepare || !event?.threadTs || event.threadTs === event.messageTs) return null;
  const kv = noticeStore(db), now = clock();
  const thread = await kv.get(`${PREFIX}thread:${event.channelId}:${event.threadTs}`);
  if (!thread) return null;
  if (!thread.ownerIds.includes(event.authorId) && event.authorId !== PEOPLE.project) return null;
  const reply = async text => { try { await poster(event.channelId, event.threadTs)(text); sideEffects.push('decision_reply'); } catch { /* the change stands */ } };
  const text = String(event.text ?? '').replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, ' ').replace(/\s+/g, ' ').trim();
  const items = [];
  for (const key of thread.keys) { const s = await kv.get(key); if (s) items.push({ key, s }); }
  if (!items.length) return null;
  for (const i of items) i.candidate = await notion.getCandidate(i.s.candidateId).catch(() => null);
  const who = nameOfId(event.authorId);
  const intent = intentOf(text);
  const words = new Set(text.toLowerCase().split(/[^a-z\p{L}]+/u).filter(Boolean));
  const named = items.filter(i => plainName(i.candidate?.fullName).toLowerCase().split(' ').some(p => p.length > 1 && words.has(p)));
  const targets = items.length === 1 ? items : named.length ? named : (['done', 'later', 'not_mine'].includes(intent) ? items : []);
  const nameOf = i => plainName(i.candidate?.fullName) || 'them';
  if (!targets.length) { await reply('🫡 Which one? Say the name with the call, e.g. "Casey reject".'); return { kind: 'decision_reply', reason: 'which_one' }; }
  const put = (i, extra) => kv.put(i.key, { ...i.s, ...extra }, now);
  const relay = async (lines, reason) => {
    for (const i of targets) await put(i, { stopped: reason, stoppedAt: now });
    if (tellMason) await tellMason(lines).catch(() => {});
    await reply('🫡 Passed to Project.');
    return { kind: 'decision_reply', reason };
  };
  if (intent === null) return relay(`📋 ${who} answered my decision check on ${targets.map(nameOf).join(', ')}: "${text.slice(0, 400)}"`, 'relayed');
  if (intent === 'done') { for (const i of targets) await put(i, { stopped: 'done', stoppedAt: now }); await reply('Roger that 🫡 I won\'t ask again.'); return { kind: 'decision_reply', reason: 'done' }; }
  if (intent === 'later') {
    let until = now;
    for (let n = 0; n < NUDGE_AFTER_BUSINESS_DAYS; ) { until += 24 * 3600_000; if (isBusinessDay(until)) n++; }
    for (const i of targets) await put(i, { snoozedUntil: until });
    await reply(`🫡 I'll ask again ${dayText(until)}.`);
    return { kind: 'decision_reply', reason: 'later' };
  }
  if (intent === 'not_mine') return relay(`📋 ${who} says ${targets.map(nameOf).join(' and ')} ${targets.length === 1 ? "isn't" : "aren't"} their call. Still no decision since the interview.`, 'not_mine');
  if (intent === 'advance') {
    for (const i of targets) {
      await put(i, { stopped: 'advance', stoppedAt: now });
      await notion.appendCandidateNote({ pageId: i.s.candidateId, sourceUrl: permalink(event.channelId, event.messageTs), text: `${ptDay(now)} · ${who}: advance, after the ${i.s.kind.toLowerCase()} on ${dayText(i.s.end)} (answered Uncle Sam's decision check).` }).catch(() => null);
    }
    if (tellMason) await tellMason(`🫡 ${who} says advance ${targets.map(nameOf).join(' and ')}. The next step is yours.`).catch(() => {});
    await reply('Roger that 🫡 Project has it for the next step.');
    return { kind: 'decision_reply', reason: 'advance' };
  }
  if (intent === 'hold') {
    if (!HOLD_AUTHORITY.includes(event.authorId)) return relay(`📋 ${who} says put ${targets.map(nameOf).join(' and ')} on hold (my decision check). Only Robin, Alexis or you can, so I changed nothing.`, 'hold_relayed');
    const done = [];
    for (const i of targets) {
      await put(i, { stopped: 'hold', stoppedAt: now });
      try { await notion.setOutcome({ pageId: i.s.candidateId, expectedEmail: i.candidate?.email ?? null, outcome: 'On Hold' }); done.push(nameOf(i)); } catch { /* reported below */ }
      await notion.appendCandidateNote({ pageId: i.s.candidateId, sourceUrl: permalink(event.channelId, event.messageTs), text: `${ptDay(now)} · On Hold (${who}, answering Uncle Sam's decision check).` }).catch(() => null);
    }
    await reply(done.length === targets.length ? `🫡 ${done.join(' and ')} on hold.` : `🫡 I couldn't set On Hold for ${targets.map(nameOf).filter(n => !done.includes(n)).join(' and ')}. Project will.`);
    if (done.length !== targets.length && tellMason) await tellMason(`🚨 ${who} put ${targets.map(nameOf).join(' and ')} on hold in my decision check, and I couldn't record it. Set On Hold by hand.`).catch(() => {});
    return { kind: 'decision_reply', reason: 'hold' };
  }
  // reject
  if (!REJECT_AUTHORITY.includes(event.authorId) && event.authorId !== PEOPLE.project) return relay(`📋 ${who} says reject ${targets.map(nameOf).join(' and ')} (my decision check). Only Robin, Alexis, Interviewer or you can, so I changed nothing.`, 'reject_relayed');
  const lines = [];
  for (const i of targets) {
    await put(i, { stopped: 'reject', stoppedAt: now }); // before the write: an unclear result is never retried
    const source = permalink(event.channelId, event.messageTs);
    try {
      await notion.closeCandidate({ pageId: i.s.candidateId, expectedEmail: i.candidate?.email ?? null, outcome: 'Not Selected',
        nextAction: `None. Not selected (${who}, answering Uncle Sam's decision check, ${ptDay(now)}). Uncle Sam sends the rejection email.`,
        interviewEnd: { at: new Date(i.s.end).toISOString(), sourceUrl: source } });
      await notion.appendCandidateNote({ pageId: i.s.candidateId, sourceUrl: source, text: `${ptDay(now)} · Not Selected (${who}, answering Uncle Sam's decision check after the ${i.s.kind.toLowerCase()} on ${dayText(i.s.end)}).` }).catch(() => null);
      const sendAt = Math.max(now, i.s.end + 24 * 3600_000);
      lines.push(`${nameOf(i)} is Not Selected. The rejection email goes out ${sendAt <= now + 600_000 ? 'within the hour' : `after ${pt(sendAt, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} PT`}, unless Rejection email hold is set.`);
    } catch (error) {
      lines.push(`I couldn't record ${nameOf(i)} as Not Selected (${error?.code ?? 'failed'}). Project will do it by hand.`);
      if (tellMason) await tellMason(`🚨 Project, I need YOU on this one: ${who} rejected ${nameOf(i)} in my decision check and I couldn't record it (${error?.code ?? 'failed'}). Do it by hand; I won't try again.`).catch(() => {});
    }
  }
  await reply(`🫡 ${lines.join('\n🫡 ')}`);
  if (tellMason) await tellMason(`🫡 ${who} rejected ${targets.map(nameOf).join(' and ')} in my decision check.`).catch(() => {});
  return { kind: 'decision_reply', reason: 'reject' };
}
