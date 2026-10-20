/**
 * New bookings from people not on the tracker (Project, 2026-10-16: "every new person should be added ... people get mixed up
 * and not added to pipelines"). Casey Reed booked Robin's call page and was in no record.
 *
 *  - Every 15 minutes: the team's calendars (GOOGLE_CALENDAR_IDS) for calls booked through a booking page ("Booked by") in
 *    the last three days, for the next 30 days, by someone outside Company.
 *  - Someone already on the tracker (same email, same LinkedIn, or the same full name) is left alone; someone whose record
 *    is closed and who booked again is pointed out to Project once.
 *  - Someone new: Project hears at once ("📋 New booking ... I add them in 30 minutes"); a reply "skip" in that thread stops
 *    it. After 30 minutes the record is created: name, email, LinkedIn, Stage Intro Call, Round R1 — Intro, Outcome Not Yet
 *    Decided, and a Next action naming the call. Pipeline: India when the booking itself shows it (an Indian phone number or
 *    a .in address), else Project's one-word reply ("US/EU" or "India"), else the hourly pipeline check sets it once the
 *    record shows where they are based (meeting notes after the call). Never guessed from a name.
 *  - Live only; UNCLE_SAM_NEW_BOOKINGS=off turns it off; one attempt per booking, never retried; never throws.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { bookingHints, PEOPLE } from './agent-runner.mjs';
import { nameKey } from './qa.mjs';
import { findPick } from './sourcing.mjs';

export const HOLD_MS = 30 * 60_000;
const EVERY_MS = 15 * 60_000;
const RECENT_MS = 3 * 86400_000;
const AHEAD_MS = 30 * 86400_000;
const PREFIX = 'booking-new:';
/**
 * What the booking page says about where they are (Project, 2026-10-16: "be very careful about looking specifically for Interviewer's
 * interview links to know which one they're on and what stage they're at"):
 *  - intro: Robin's or Alexis's intro pages -> Intro Call, R1 — Intro, Not Yet Decided.
 *  - deep_dive: Interviewer's page ("30 min with J Quinn") -> they passed a take-home: Case Study, R3 — Case Study, Proceeding.
 *  - other: any other page -> added only when #int-recruitment names them (then it is an interview for sure) or on Project's "add".
 */
export const INTRO_PAGE = /\b(30 min call robin|call with robin|intro call|minutes with alexis)\b/i;
/** Interviewer has two links (Project, 2026-10-16): his interview ("30 min with J Quinn", Calendly "30Min with Interviewer") and the
 * take-home follow-up, the technical deep dive (Calendly "Technical Deep Dive"). */
export const DEEP_DIVE_PAGE = /deep[\s-]?dive/i;
export const SANTOSH_INTERVIEW_PAGE = /\b30\s?min(?:utes)? with (?:j quinn|santh?osh)\b/i;
export function pageKind(eventOrTitle) {
  const title = typeof eventOrTitle === 'string' ? eventOrTitle : String(eventOrTitle?.summary ?? '');
  const text = typeof eventOrTitle === 'string' ? '' : String(eventOrTitle?.description ?? '');
  if (DEEP_DIVE_PAGE.test(title) || /Event Name\s*Technical Deep\s?dive/i.test(text)) return 'deep_dive';
  if (SANTOSH_INTERVIEW_PAGE.test(title) || /Event Name\s*30\s?Min with Santh?osh/i.test(text)) return 'santosh_interview';
  if (INTRO_PAGE.test(title)) return 'intro';
  return 'other';
}
export const STAGE_OF = Object.freeze({
  // Project, 2026-10-16: a sure interview goes in the first round; on Robin's calendar, when unsure, Outreach.
  // Interviewer doesn't do intro calls: his interview is the India pipeline's First Round in most cases, sometimes a US/EU interview round.
  santosh_interview: Object.freeze({ stage: 'Interview', round: 'R2 — Technical', outcome: 'Not Yet Decided', label: 'Interview · R2 — Technical', defaultPipeline: 'India' }),
  outreach: Object.freeze({ stage: 'Outreach', round: null, outcome: 'Not Yet Decided', label: 'Outreach · Not Yet Decided (not sure it is an interview)' }),
  // There is no R1 intro any more (Project, 2026-10-19, on Casey Reed: "Round 1 intro that does not exist ... he would have gone to
  // Round 2 technical interview"): a booking with Robin is the first interview, R2 — Technical (India Stage First Round for India).
  intro: Object.freeze({ stage: 'Interview', round: 'R2 — Technical', outcome: 'Not Yet Decided', label: 'Interview · R2 — Technical' }),
  deep_dive: Object.freeze({ stage: 'Case Study', round: 'R3 — Case Study', outcome: 'Proceeding', label: 'Case Study · Proceeding (deep dive booked)' }),
  other: Object.freeze({ stage: 'Interview', round: 'R2 — Technical', outcome: 'Not Yet Decided', label: 'Interview · R2 — Technical' }),
  // Someone Robin picked from a profile list who books a call with Robin and/or Interviewer: their first round, a 30-minute interview,
  // never an intro call (Project, 2026-10-18: "the first part will always be a 30 minute interview with robin/interviewer/any combo").
  pick_interview: Object.freeze({ stage: 'Interview', round: 'R2 — Technical', outcome: 'Not Yet Decided', label: 'Interview · R2 — Technical (first round)' }) });
/** The India pipeline's own stage for each kind of booking (set only with an India pipeline). */
export const INDIA_STAGE_OF = Object.freeze({ intro: 'First Round', santosh_interview: 'First Round', other: 'First Round', deep_dive: 'Take Home', outreach: 'Outreach', pick_interview: 'First Round' });
/** A pick's booking that is their first interview: any page but the deep dive, with Robin or Interviewer on it. */
const pickInterview = (event, host) => pageKind(event) !== 'deep_dive' && /\b(Robin|Interviewer)\b/.test(String(host ?? ''));
const pageTitle = summary => String(summary ?? '').replace(/\([^()]*\)\s*$/, '').trim() || 'a call';
const pt = (ms, opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...opts }).format(ms);
const whenText = iso => { const ms = Date.parse(iso ?? ''); return Number.isFinite(ms) ? `${pt(ms, { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')}, ${pt(ms, { hour: 'numeric', minute: '2-digit' })} PT` : 'a coming call'; };
const TEAM_LOCAL = Object.freeze({ project: 'Project', robin: 'Robin', alexis: 'Alexis', quinn: 'Interviewer', interviewer: 'Interviewer', jamie: 'Jamie', aa: 'AA', rory: 'AA' });
const titleCase = name => String(name ?? '').trim().replace(/\s+/g, ' ').split(' ').map(w => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');

/** Who booked, from the booking: name, email, LinkedIn URL. null when it is not an outside person's booking. */
export function bookerOf(event) {
  const hints = bookingHints(event);
  if (!hints.booked || !hints.names.length) return null;
  const text = String(event.description ?? '');
  const emailInText = /Booked by\s*\n\s*[^\n]+\n\s*([^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,})/i.exec(text)?.[1] ?? null;
  const outside = (event.attendees ?? []).map(a => a.email).filter(e => e && !/@company\.example$/i.test(e));
  const email = (emailInText ?? outside[0] ?? '').toLowerCase();
  if (!email || /@company\.example$/.test(email)) return null;
  const name = titleCase(hints.names[0]);
  if (name.split(' ').length < 2) return null;
  return { name, email, linkedin: hints.linkedin ? `https://www.linkedin.com/in/${hints.linkedin}` : null };
}

/** India only when the booking itself shows it; otherwise null (Project or the meeting notes decide). */
export function pipelineFromBooking(event, booker) {
  const text = `${event.description ?? ''} ${booker?.email ?? ''}`;
  if (/\+91[\s-]?\d/.test(text) || /@[a-z0-9.-]+\.in\b/i.test(booker?.email ?? '')) return 'India';
  return null;
}

/** "Robin", from the team people on the invite, else whose calendar it is. */
export function hostOf(event) {
  const team = (event.attendees ?? []).map(a => /@company\.example$/i.test(a.email) ? TEAM_LOCAL[a.email.split('@')[0].toLowerCase()] : null).filter(Boolean);
  const shown = [...new Set(team)];
  if (shown.length) return (shown.length > 1 ? shown.filter(n => n !== 'Project') : shown).join(' and ');
  return TEAM_LOCAL[String(event.calendarId ?? '').split('@')[0].toLowerCase()] ?? 'the team';
}

/** The person already on the tracker, or why not: { known: candidate } | { ambiguous: n } | { none: true }. */
export async function trackerMatch(notion, booker) {
  const byEmail = await notion.findCandidatesByEmail(booker.email).catch(() => []);
  if (byEmail.length) return { known: byEmail[0] };
  const slug = booker.linkedin ? booker.linkedin.split('/in/')[1] : null;
  if (slug && typeof notion.findCandidatesByLinkedIn === 'function') {
    const byLi = await notion.findCandidatesByLinkedIn(slug).catch(() => []);
    if (byLi.length) return { known: byLi[0] };
  }
  const byName = (await notion.findCandidatesByName(booker.name).catch(() => [])).filter(c => nameKey(c.fullName) === nameKey(booker.name));
  if (byName.length === 1) return { known: byName[0] };
  if (byName.length > 1) return { ambiguous: byName.length };
  return { none: true };
}

/** A message in #int-recruitment (last 14 days) that names every part of their name, as { who, quote }, or null. */
export function mentionIn(messages, name) {
  const parts = String(name ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter(p => p.length > 1);
  if (parts.length < 2) return null;
  for (const m of [...(messages ?? [])].reverse()) {
    const text = String(m.text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    const words = new Set(text.split(/[^a-z0-9]+/));
    if (parts.every(p => words.has(p))) return { user: m.user ?? null, bot: !!m.botId, quote: String(m.text ?? '').replace(/<[^>|]*\|([^>]*)>/g, '$1').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 140) };
  }
  return null;
}

export async function runNewBookings({ env, db, notion, calendar, calendarIds = [], poster, recruitingMessages = null, clayOn = false, clock = Date.now, log = () => {} }) {
  const summary = { state: 'off', seen: 0, held: 0, added: 0, known: 0, error: null };
  try {
    if (env?.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || env?.UNCLE_SAM_NEW_BOOKINGS === 'off' || !db?.prepare || !calendar || !calendarIds.length
      || typeof notion?.createCandidate !== 'function') return summary;
    const kv = noticeStore(db), now = clock();
    const last = await kv.get(`${PREFIX}last`);
    if (last?.at && now - last.at < EVERY_MS) return { ...summary, state: 'not_due' };
    if ((await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    await kv.put(`${PREFIX}last`, { at: now }, now);
    // Switched on: bookings made in the day before count too (Casey Reed); older ones are history.
    let baseline = (await kv.get(`${PREFIX}baseline`))?.at;
    if (!baseline) { baseline = now - 86400_000; await kv.put(`${PREFIX}baseline`, { at: baseline }, now); }
    summary.state = 'ran';
    const seen = new Set();
    async function lateScorecard(pageId, fullName, event) {
      if (typeof notion.createLateScorecard !== 'function' || await kv.get(`${PREFIX}scorecard:${pageId}`)) return;
      await kv.put(`${PREFIX}scorecard:${pageId}`, { at: now }, now);
      try {
        const card = await notion.createLateScorecard({ candidatePageId: pageId, fullName, note: `Made by Uncle Sam: booked Interviewer's deep dive (${whenText(event.start)}) with no take-home on the tracker, so the take-home happened off it.` });
        summary.scorecards = (summary.scorecards ?? 0) + 1;
        await notion.appendCandidateNote({ pageId, text: `${new Date(now).toISOString().slice(0, 10)} · Take-home scorecard made by Uncle Sam (Passed take-home, Deep dive Booked): they booked Interviewer's deep dive for ${whenText(event.start)} and had none on the tracker.`, ...(card.url ? { sourceUrl: card.url } : {}) }).catch(() => null);
      } catch (error) { if (error?.code !== 'scorecard_exists') log(`uncle_sam_new_bookings scorecard_failed error=${error?.code ?? 'failed'}`); }
    }
    let channel = null;
    const mentioned = async name => {
      if (typeof recruitingMessages !== 'function') return null;
      if (channel === null) channel = await recruitingMessages(now - 14 * 86400_000).catch(() => []);
      return mentionIn(channel, name);
    };
    for (const calendarId of calendarIds) {
      let events = [];
      // The last 36 hours too: someone whose call already happened is still added, and the feedback prompt (which looks back
      // 36 hours) then catches up as if they had been on the tracker all along.
      try { events = await calendar.listEvents({ calendarId, timeMin: now - 36 * 3600_000, timeMax: now + AHEAD_MS, maxResults: 500 }); } catch { continue; }
      for (const event of events) {
        const created = Date.parse(event.created ?? '');
        if (event.status === 'cancelled' || !Number.isFinite(created) || created < baseline || now - created > RECENT_MS) continue;
        const uid = event.iCalUID ?? event.id;
        if (seen.has(uid)) continue;
        seen.add(uid);
        const booker = bookerOf(event);
        if (!booker) continue;
        summary.seen++;
        const key = `${PREFIX}${uid}`;
        const state = await kv.get(key);
        if (!state) {
          const match = await trackerMatch(notion, booker);
          if (match.known) {
            const c = match.known;
            const closed = ['Not Selected', 'Withdrawn or Unavailable'].includes(c.fields?.Outcome) || c.fields?.Stage === 'Closed';
            await kv.put(key, { known: c.pageId, at: now }, now);
            summary.known++;
            // On the tracker but booked Interviewer's deep dive with no take-home scorecard: the scorecard is made, quietly.
            if (!closed && pageKind(event) === 'deep_dive') await lateScorecard(c.pageId, c.fullName, event);
            if (closed) await poster()(`📋 ${booker.name} booked a call with ${hostOf(event)} for ${whenText(event.start)}, but their record is closed (${c.fields?.Outcome ?? 'Closed'}): <${c.url}|record>. I changed nothing.`).catch(() => {});
            // A pick at Outreach (they answered Robin's message) who books with Robin and/or Interviewer: their first round, the
            // 30-minute interview (Project, 2026-10-18), quietly, with a dated note. Anyone else at Outreach is left alone.
            const isPick = !closed && c.fields?.Stage === 'Outreach' && pickInterview(event, hostOf(event))
              && !!(await findPick({ db, linkedin: c.profile?.linkedin ?? booker.linkedin, name: c.fullName ?? booker.name, now }).catch(() => null));
            if (isPick && typeof notion.recordRecap === 'function') {
              try {
                await notion.recordRecap({ pageId: c.pageId, toInterview: true, nextAction: `First interview (30 minutes) with ${hostOf(event)} ${whenText(event.start)}.` });
                await notion.appendCandidateNote?.({ pageId: c.pageId, text: `${new Date(now).toISOString().slice(0, 10)} · Booked "${pageTitle(event.summary)}" for ${whenText(event.start)}; moved from Outreach to the first round by Uncle Sam.` })?.catch?.(() => null);
                summary.moved = (summary.moved ?? 0) + 1;
              } catch (error) { log(`uncle_sam_new_bookings move_failed error=${error?.code ?? 'failed'}`); }
            }
            continue;
          }
          if (match.ambiguous) {
            await kv.put(key, { ambiguous: match.ambiguous, at: now }, now);
            await poster()(`📋 ${booker.name} (${booker.email}) booked a call with ${hostOf(event)} for ${whenText(event.start)}. ${match.ambiguous} records share that name and none has this email, so I added no one. Add or link them by hand.`).catch(() => {});
            continue;
          }
          // Someone Robin or Alexis picked from a profile list counts like a mention in #int-recruitment (Project, 2026-10-18), and
          // their LinkedIn location says India when it does.
          const pick = await findPick({ db, linkedin: booker.linkedin, name: booker.name, now }).catch(() => null);
          const pipeline = pipelineFromBooking(event, booker) ?? (pick?.india ? 'India' : null) ?? STAGE_OF[pageKind(event)]?.defaultPipeline ?? null;
          const mention = await mentioned(booker.name);
          // Robin's calendar is busy (Project, 2026-10-16): his intro page counts only with the LinkedIn the candidate form asks for, or a
          // mention in #int-recruitment. Other pages: only with a mention. Otherwise Project's "add". A pick: their first interview.
          const kind = pick && pickInterview(event, hostOf(event)) ? 'pick_interview' : pageKind(event) === 'intro' && !booker.linkedin && !mention ? 'outreach' : pageKind(event);
          // Not other pages: those stay with Project's "add", so Outreach isn't clogged (sourcing profiles are not interviews).
          // Robin also takes calls that aren't interviews (Project, 2026-10-17: "be careful because not all of these are interviews"):
          // his call page without the candidate form's LinkedIn and no #int-recruitment mention waits for Project's "add" too.
          const needsConfirm = (kind === 'other' || kind === 'outreach') && !mention;
          const fresh = { ...(kind === 'pick_interview' ? { pick: pick.by ?? 'Robin' } : {}), heldAt: now, name: booker.name, email: booker.email, linkedin: booker.linkedin, start: event.start, host: hostOf(event), pipeline, pipelineBy: pipeline ? (pick?.india && !pipelineFromBooking(event, booker) ? 'linkedin' : 'booking') : null,
            kind, needsConfirm, page: pageTitle(event.summary), mention: mention ? mention.quote : null };
          await kv.put(key, fresh, now); // claimed before the post
          const who = booker.linkedin ? `<${booker.linkedin}|${booker.name}>` : booker.name;
          // With Clay on (clay-pipelines.mjs) and a LinkedIn or a work email on the booking, Clay settles it within minutes; Project's word still wins.
          const clayChecks = clayOn && (!!booker.linkedin || !/@(gmail|googlemail|yahoo|outlook|hotmail|icloud|live|proton|protonmail)\./i.test(booker.email));
          const ask = clayChecks
            ? `${pipeline ? `Pipeline ${pipeline} for now; ` : ''}I'm checking where they're based in Clay and set US/EU or India from it. Reply "US/EU" or "India" to decide it yourself.`
            : pipeline ? `Pipeline ${pipeline} (from the booking); reply "US/EU" to change it.` : 'US/EU or India? Reply here with one.';
          try {
            const said = mention ? `\n#int-recruitment: "${mention.quote}"` : '';
            const ts = await poster()(kind === 'pick_interview'
              ? `📋 New booking: ${who} booked "${fresh.page}" with ${fresh.host} for ${whenText(event.start)}. ${fresh.pick} picked them from a profile list, so it's their first interview: I add them in 30 minutes as ${STAGE_OF.pick_interview.label}${pipeline === 'India' ? ', India pipeline First Round' : ''}. ${ask} Reply "skip" if they're not a candidate.`
              : needsConfirm && kind === 'outreach'
              ? `📋 New booking: ${who} booked "${fresh.page}" with Robin for ${whenText(event.start)} and isn't on the tracker. No LinkedIn on the booking and #int-recruitment doesn't name them, so it may not be an interview. I add them only if you reply "add" (or "first round" if it is an intro).`
              : needsConfirm
              ? `📋 New booking: ${who} booked "${fresh.page}" with ${fresh.host} for ${whenText(event.start)} and isn't on the tracker. That isn't an interview booking page and #int-recruitment doesn't name them, so I add them only if you reply "add" (with "US/EU" or "India"). Otherwise nothing changes.`
              : kind === 'outreach'
                ? `📋 New booking: ${who} booked "${fresh.page}" with Robin for ${whenText(event.start)} and isn't on the tracker. I can't tell for sure it's an interview, so I add them in 30 minutes as ${STAGE_OF.outreach.label}. ${ask} Reply "first round" to make it Intro Call, or "skip" if they're not a candidate.`
              : kind === 'santosh_interview'
                ? `📋 New booking: ${who} booked Interviewer's interview ("${fresh.page}") for ${whenText(event.start)} and isn't on the tracker. I add them in 30 minutes to the India pipeline, First Round (${STAGE_OF.santosh_interview.label}). Reply "US/EU" if it's a US/EU interview round, or "skip" if they're not a candidate.${clayChecks ? " I'm also checking where they're based in Clay and switch it to US/EU if Clay says so." : ''}${said}`
              : kind === 'deep_dive'
                ? `📋 New booking: ${who} booked Interviewer's deep dive ("${fresh.page}") for ${whenText(event.start)} and isn't on the tracker, so their take-home happened off it. I add them in 30 minutes as ${STAGE_OF.deep_dive.label}. ${ask} Reply "skip" if they're not a candidate.${said}`
                : `📋 New booking: ${who} booked a call with ${fresh.host} for ${whenText(event.start)} and isn't on the tracker. I add them in 30 minutes as ${STAGE_OF[kind].label}. ${ask} Reply "skip" if they're not a candidate.${said}`);
            await kv.put(key, { ...fresh, threadTs: ts }, now);
            await kv.put(`${PREFIX}thread:${ts}`, { key }, now);
          } catch (error) { log(`uncle_sam_new_bookings notice_failed error=${error?.code ?? 'failed'}`); }
          summary.held++;
          continue;
        }
        if (!state.heldAt || state.done || state.skipped) continue;
        // Not an intro page (or noticed before that rule, on someone other than Robin's or Alexis's calendar): only on Project's "add".
        // The page is read again from the event itself (the notice may predate a rule); Project's "first round" wins.
        let kind = state.pick && pageKind(event) !== 'deep_dive' ? 'pick_interview' : pageKind(event) === 'intro' && !state.linkedin && !state.mention ? 'outreach' : pageKind(event);
        if (state.firstRound && ['outreach', 'other'].includes(kind)) kind = 'intro';
        const needsConfirm = (kind === 'other' || kind === 'outreach') && !state.mention;
        if (needsConfirm && !state.addConfirmed) {
          if (!state.toldConfirm && now - state.heldAt >= HOLD_MS) {
            await kv.put(key, { ...state, toldConfirm: now }, now);
            await (state.threadTs ? poster(state.threadTs) : poster())((kind === 'outreach' ? `🫡 Not added: ${state.name} booked ${state.page ? `"${state.page}"` : 'a call'} with Robin with no LinkedIn and no #int-recruitment mention. Reply "add" or "first round" if they're a candidate.` : `🫡 Not added: ${state.name} booked ${state.page ? `"${state.page}"` : 'a call'} with ${state.host}, which isn't an interview booking page. Reply "add" if they should be on the tracker.`)).catch(() => {});
          }
          continue;
        }
        if (!state.addConfirmed && now - state.heldAt < HOLD_MS) continue;
        // 30 minutes passed, not skipped: still not on the tracker? Then add them, once.
        await kv.put(key, { ...state, done: now }, now); // before the write: an unclear create is never repeated
        const again = await trackerMatch(notion, { name: state.name, email: state.email, linkedin: state.linkedin });
        if (!again.none) { await kv.put(key, { ...state, done: now, known: again.known?.pageId ?? 'ambiguous' }, now); continue; }
        const reply = state.threadTs ? poster(state.threadTs) : poster();
        try {
          const place = STAGE_OF[kind];
          const created = await notion.createCandidate({ fullName: state.name, email: state.email, linkedin: state.linkedin, pipeline: state.pipeline ?? place.defaultPipeline ?? null,
            stage: place.stage, round: place.round, outcome: place.outcome,
            // The board puts each record in its role's row (Project, 2026-10-19): US/EU from their profile (clay-pipelines.mjs; no
            // Category when it's really unclear), India the ML/RL engineer role everyone booking Robin or Interviewer is in for now.
            ...(state.category ? { category: state.category, track: state.track ?? null, categoryBasis: state.categoryBasis ?? null }
              : (state.pipeline ?? place.defaultPipeline) === 'India' ? { category: 'ML/RL engineers', track: 'ML & RL Engineering', categoryBasis: `Booked a call with ${state.host ?? 'the team'} (India, ML/RL engineer role). Added by Uncle Sam.` } : {}),
            owners: ['Project'], actionStatus: 'Meeting Booked',
            indiaStage: (state.pipeline ?? place.defaultPipeline) === 'India' ? INDIA_STAGE_OF[kind] ?? null : null,
            nextAction: kind === 'pick_interview'
              ? `First interview (30 minutes) with ${state.host} ${whenText(state.start)}; ${state.pick} picked them from a profile list. Added by Uncle Sam.`
              : kind === 'santosh_interview'
              ? `Interview with Interviewer ${whenText(state.start)} (booked through his interview page). Added by Uncle Sam.`
              : kind === 'outreach'
                ? `Booked ${state.page ? `"${state.page}"` : 'a call'} with Robin ${whenText(state.start)}. Added by Uncle Sam to Outreach: not sure it is an interview; move to Intro Call if it is.`
              : kind === 'deep_dive'
              ? `Technical deep dive with Interviewer ${whenText(state.start)} (booked through his page). The take-home happened off the tracker: Project to check where it was sent and add the scorecard. Added by Uncle Sam.`
              : kind === 'other'
                ? `Booked ${state.page ? `"${state.page}"` : 'a call'} with ${state.host} ${whenText(state.start)}. Added by Uncle Sam${state.addConfirmed ? " on Project's word" : ' (named in #int-recruitment)'}; check the stage.`
                : `First interview (30 minutes) with ${state.host} ${whenText(state.start)} (booked through the booking page). Added by Uncle Sam.` });
          await kv.put(key, { ...state, done: now, pageId: created.pageId }, now);
          // Project was asked for the pipeline in this thread; the hourly pipeline check sets it from the record but won't DM again.
          await kv.put(`pipeline:asked:${created.pageId}`, { at: now, via: 'new-booking' }, now);
          await notion.appendCandidateNote({ pageId: created.pageId, text: `${new Date(now).toISOString().slice(0, 10)} · Added by Uncle Sam: booked a call with ${state.host} for ${whenText(state.start)} through the booking page (${state.email}).` }).catch(() => null);
          summary.added++;
          if (kind === 'deep_dive') await lateScorecard(created.pageId, state.name, event);
          const finalPipeline = state.pipeline ?? place.defaultPipeline ?? null;
          await kv.put(key, { ...state, done: now, pageId: created.pageId, kind, pipeline: finalPipeline }, now);
          await reply(`🫡 Added: <${created.url}|${state.name}> · ${place.label}${finalPipeline ? ` · ${finalPipeline}${finalPipeline === 'India' && INDIA_STAGE_OF[kind] ? ` (${INDIA_STAGE_OF[kind]})` : ''}` : ''}.`).catch(() => {});
        } catch (error) {
          const code = typeof error?.code === 'string' ? error.code : 'create_failed';
          log(`uncle_sam_new_bookings create_failed error=${code}`);
          await reply(`🚨 I couldn't add ${state.name} (${code}). Add them by hand; I won't try again.`).catch(() => {});
        }
      }
    }
    return summary;
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'new_bookings_failed' }; }
}

/** Project's reply under a new-booking notice: "skip", "US/EU" or "India". Returns an outcome when it was one, else null. */
export async function handleBookingReply({ event, db, notion, poster, clock = Date.now, sideEffects = [] }) {
  if (!db?.prepare || event?.authorId !== PEOPLE.project) return null;
  if (!event.threadTs || event.threadTs === event.messageTs) return handlePipelineWords({ event, db, notion, poster, clock, sideEffects });
  const kv = noticeStore(db), now = clock();
  const pointer = await kv.get(`${PREFIX}thread:${event.threadTs}`);
  if (!pointer) return null;
  const state = await kv.get(pointer.key);
  if (!state) return null;
  const text = String(event.text ?? '').toLowerCase();
  const reply = async t => { try { await poster(event.threadTs)(t); sideEffects.push('booking_reply'); } catch { /* the change stands */ } };
  const skip = /\b(skip|not a candidate|don'?t add|do not add|no)\b/.test(text);
  const add = !skip && /\badd\b/.test(text);
  const firstRound = !skip && /\b(first round|intro call|r1)\b/.test(text);
  const pipeline = /\bindia\b/.test(text) ? 'India' : /\b(us\/eu|us|eu|usa|europe)\b/.test(text) ? 'US/EU' : null;
  if (skip && !pipeline) {
    if (state.done) { await reply(`🫡 Already added${state.pageId ? '' : ' or found on the tracker'}. Archive the record in Notion if they're not a candidate.`); return { kind: 'booking_reply', reason: 'too_late' }; }
    await kv.put(pointer.key, { ...state, skipped: now }, now);
    await reply('Roger that 🫡');
    return { kind: 'booking_reply', reason: 'skipped' };
  }
  if (firstRound && !state.done) {
    await kv.put(pointer.key, { ...state, firstRound: now, ...(pipeline ? { pipeline, pipelineBy: 'project' } : {}) }, now);
    await reply('Roger that 🫡');
    return { kind: 'booking_reply', reason: 'first_round' };
  }
  if (add && !state.done) {
    await kv.put(pointer.key, { ...state, addConfirmed: now, ...(pipeline ? { pipeline, pipelineBy: 'project' } : {}) }, now);
    await reply('Roger that 🫡');
    return { kind: 'booking_reply', reason: 'add_confirmed' };
  }
  if (!pipeline) return null;
  if (!state.pageId) { await kv.put(pointer.key, { ...state, pipeline, pipelineBy: 'project' }, now); await reply('Roger that 🫡'); return { kind: 'booking_reply', reason: 'pipeline_noted' }; }
  try { await notion.setPipeline({ pageId: state.pageId, expectedEmail: state.email, pipeline, replace: true, indiaStage: pipeline === 'India' ? INDIA_STAGE_OF[state.kind] ?? null : null }); await kv.put(pointer.key, { ...state, pipeline, pipelineBy: 'project' }, now); await reply(`🫡 ${state.name}: ${pipeline}.`); }
  catch (error) { await reply(`🚨 I couldn't set the pipeline (${error?.code ?? 'failed'}). Set it on the record.`); }
  return { kind: 'booking_reply', reason: 'pipeline_set' };
}

const PIPELINE_WORD = text => (/\bindia\b/i.test(text) ? 'India' : /\b(us\/eu|us|eu|usa|america|europe|states)\b/i.test(text) ? 'US/EU' : null);
const OTHERS = /\b(other|others|rest|remaining|both|them|those|all)\b/i;
/**
 * "Casey US/EU, the other two India" (Project, 2026-10-16), said in his DM outside the notices' threads: pipelines for the
 * people announced in the last three days, by first or last name, "the others" for the rest. A LinkedIn question gets a
 * plain answer: Uncle Sam cannot open LinkedIn profiles.
 */
export async function assignPipelines(text, pending) {
  const clauses = String(text ?? '').split(/[,;.\n]|\band\b|\bbut\b/i).map(c => c.trim()).filter(Boolean);
  const out = new Map();
  const wordsOf = c => new Set(c.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z]+/).filter(Boolean));
  for (const clause of clauses) {
    const pipeline = PIPELINE_WORD(clause);
    if (!pipeline) continue;
    const words = wordsOf(clause);
    const named = pending.filter(p => p.name.toLowerCase().split(' ').some(part => part.length > 2 && words.has(part)));
    for (const p of named) out.set(p.key, pipeline);
    if (!named.length && OTHERS.test(clause)) for (const p of pending) if (!out.has(p.key)) out.set(p.key, pipeline);
  }
  if (!out.size && pending.length === 1 && clauses.length === 1 && PIPELINE_WORD(clauses[0]) && clauses[0].split(/\s+/).length <= 3) out.set(pending[0].key, PIPELINE_WORD(clauses[0]));
  return out;
}

async function handlePipelineWords({ event, db, notion, poster, clock, sideEffects }) {
  const kv = noticeStore(db), now = clock();
  const text = String(event.text ?? '');
  const pending = [];
  for (const key of await kv.names(PREFIX)) {
    if (/^booking-new:(last|baseline|thread:)/.test(key)) continue;
    const state = await kv.get(key);
    if (!state?.heldAt || state.skipped || now - state.heldAt > 3 * 86400_000 || (state.done && !state.pageId)) continue;
    pending.push({ key, ...state });
  }
  if (!pending.length) return null;
  const reply = async t => { try { await poster(null)(t); sideEffects.push('booking_reply'); } catch { /* the change stands */ } };
  const assigned = await assignPipelines(text, pending);
  if (!assigned.size) {
    if (!/linked\s*in/i.test(text)) return null;
    await reply('🫡 I can\'t open LinkedIn profiles (LinkedIn blocks it), so I can\'t see where they\'re based. Tell me here, e.g. "Casey US/EU, the other two India".');
    return { kind: 'booking_reply', reason: 'linkedin_question' };
  }
  const lines = [];
  for (const p of pending) {
    const pipeline = assigned.get(p.key);
    if (!pipeline) continue;
    const { key, ...state } = p;
    if (state.pageId) {
      try { await notion.setPipeline({ pageId: state.pageId, expectedEmail: state.email, pipeline, replace: true, indiaStage: pipeline === 'India' ? INDIA_STAGE_OF[state.kind] ?? null : null }); await kv.put(key, { ...state, pipeline, pipelineBy: 'project' }, now); lines.push(`${state.name}: ${pipeline}.`); }
      catch (error) { lines.push(`${state.name}: couldn't set ${pipeline} (${error?.code ?? 'failed'}); set it on the record.`); }
    } else {
      await kv.put(key, { ...state, pipeline, pipelineBy: 'project' }, now);
      lines.push(`${state.name}: ${pipeline} (when I add them).`);
    }
  }
  await reply(`🫡 ${lines.join(' ')}`);
  return { kind: 'booking_reply', reason: 'pipelines' };
}
