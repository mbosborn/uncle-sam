/**
 * Unsigned documents the day before a work trial (Project, 2026-10-17: "yup i like the #1 suggestion implement that" — Arlen's trial
 * started with nothing signed and Project only heard once it had).
 *
 * Project, 2026-10-19: the reminders go to the person on the trial, and Project gets one message. For each open trial whose
 * Paperwork isn't Signed: at noon Pacific the day before their start begins in Pacific terms and the day it begins, DocuSign
 * reminds them of whatever is waiting on them (once per round). Project gets no message from here: the onboarding heads-up 12
 * hours before is his one paper warning (Project, 2026-10-19). With UNCLE_SAM_PRESTART_MASON=on, 60–90 minutes before their
 * first check-in Project hears once what is still out and its state in DocuSign:
 *   - waiting on them: each envelope, when it reached them and whether they opened it; "resend" in the thread resends it;
 *   - nothing out: "send" in the thread sends the packet at the rate of the first send (else the tracker's), or asks for one;
 *   - DocuSign unreadable: the tracker's Paperwork, and "resend" resends whatever is waiting.
 * A packet DocuSign already shows signed (the tracker catching up) gets no message. Every 30 minutes, Live only.
 * These two replace the old alert at the trial's start (work-trial.mjs still moves the record). UNCLE_SAM_PRESTART=off stops it.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { trialTimeZone, zonedWall } from './checkin-times.mjs';

export const EVERY_MS = 30 * 60_000;
export const FROM_HOUR_PT = 12;
/** Project's one message comes this long before the trialer's first check-in (Project, 2026-10-19: "only want a reminder he hasn't
 * signed until the work trial is damn near about to start and then i will escalate to robin in person"). Runs every 30 minutes,
 * so it lands 60–90 minutes before. */
export const MASON_LEAD_MS = 90 * 60_000;
const ptTime = ms => pt(ms, { hour: 'numeric', minute: '2-digit' });
const pt = (ms, o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...o }).format(ms);
const laDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const dayOnly = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : (typeof v?.start === 'string' ? v.start.slice(0, 10) : null));
const dayLabel = date => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(Date.parse(`${date}T12:00:00Z`));
const shortDay = ms => pt(ms, { month: 'short', day: 'numeric' });
const nameOf = full => String(full ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[⭐★]/gu, '').replace(/\s+/g, ' ').trim();
const OUT = ['sent', 'delivered'];

/** What DocuSign shows for this person: { waiting: [{ subject, sentAt, opened }], signedPacket } or null when unreadable. */
export function paperworkState(envelopes, email) {
  if (!Array.isArray(envelopes)) return null;
  const mine = e => (e.signers ?? []).find(s => s.email === email);
  const waiting = envelopes.filter(e => OUT.includes(e.status) && OUT.includes(mine(e)?.status))
    .map(e => ({ id: e.id ?? null, subject: e.subject, sentAt: mine(e)?.sentAt ?? null, opened: mine(e)?.status === 'delivered' }));
  const signedPacket = envelopes.some(e => /work trial/i.test(e.subject ?? '') && (e.status === 'completed' || mine(e)?.status === 'completed'));
  return { waiting, signedPacket };
}

export function preStartText({ name, start, state, paperwork, rate, tz = null, sameDay = false, reminded = 0, firstAt = null }) {
  const theirs = tz && tz !== 'America/Los_Angeles';
  const when = firstAt ? `has their first check-in at ${ptTime(firstAt)} PT`
    : sameDay && !theirs ? `starts today (${dayLabel(start)})` : theirs ? `starts ${dayLabel(start)} their time` : `starts tomorrow (${dayLabel(start)})`;
  // DocuSign already reminded them (Project, 2026-10-19): said in a few words, the resend offer stays.
  if (state?.waiting?.length && reminded) {
    const items = state.waiting.map(w => `“${w.subject}” (${w.opened ? 'opened, not signed' : 'not opened yet'})`);
    return { mode: 'resend', text: `📋 ${name} ${when} and still hasn't signed ${items.length === 1 ? items[0] : items.join(' or ')}. DocuSign reminded them ${reminded === 1 ? 'once' : `${reminded} times`}. Reply resend for one more.` };
  }
  if (!state) return { mode: 'resend', text: `📋 ${name} ${when} and the tracker says their documents aren't signed (Paperwork: ${paperwork || 'blank'}). DocuSign didn't answer just now. Reply resend here and I'll resend whatever is waiting on them.` };
  if (state.waiting.length) {
    const items = state.waiting.map(w => `“${w.subject}” (${w.sentAt ? `sent ${shortDay(w.sentAt)}, ` : ''}${w.opened ? 'opened, not signed' : 'not opened yet'})`);
    return { mode: 'resend', text: `📋 ${name} ${when} and ${sameDay ? 'still hasn\'t' : 'hasn\'t'} signed ${items.length === 1 ? items[0] : items.join(' or ')}. Reply resend here and I'll send ${items.length === 1 ? 'it' : 'them'} again.` };
  }
  const at = Number.isFinite(rate) && rate > 0 ? ` at US$${rate.toLocaleString('en-US')} per day` : '';
  return { mode: 'send', text: `📋 ${name} ${when} and no work trial documents are out to them in DocuSign. Reply send here and I'll send them${at || ' (say the rate: "send at $100/day")'}.` };
}

/**
 * sender: { envelopesFor(email) } (docusign-send.mjs) or null; rateOf(candidate) -> number|null (the standard rate).
 */
export async function runPreStartPaperwork({ env = {}, db, notion, sender = null, rateOf = async () => null, poster, masonChannel = null, clock = Date.now, force = false, log = () => {} }) {
  const summary = { state: 'off', told: 0, skipped: [], error: null };
  try {
    if (env.UNCLE_SAM_PRESTART === 'off' || !db?.prepare || typeof notion?.listTrialCandidates !== 'function' || typeof poster !== 'function') return summary;
    const kv = noticeStore(db), now = clock();
    if (!force && now - ((await kv.get('prestart:last'))?.at ?? 0) < EVERY_MS) return { ...summary, state: 'not_due' };
    if ((await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    await kv.put('prestart:last', { at: now }, now);
    summary.state = 'ran';
    const today = laDate(now);
    const afterNoon = Number(pt(now, { hour: 'numeric', hourCycle: 'h23' })) >= FROM_HOUR_PT;
    for (const c of await notion.listTrialCandidates()) {
      const f = c.fields ?? {}, start = dayOnly(f['Trial Start']);
      if (!start || f.Paperwork === 'Signed') continue;
      // The day before in Pacific terms of when their own start day begins (an India Saturday begins Friday morning PT, so the
      // heads-up comes Thursday). Project, 2026-10-18: "saturday start time always applies to them and not us".
      const tz = (await trialTimeZone({ candidate: c, kv }).catch(() => ({ tz: null }))).tz;
      const startDayPt = laDate(tz ? zonedWall(start, tz, 0, 0) : Date.parse(`${start}T12:00:00Z`));
      // Project, 2026-10-19: the reminders go to the person on the trial (DocuSign's own reminder of what is waiting on them), at
      // noon PT the day before their start begins in Pacific terms and the day it begins (Thu and Fri for an India Saturday);
      // Project hears once, shortly before their first check-in (MASON_LEAD_MS), if still unsigned.
      const remindDays = [addDays(startDayPt, -1), startDayPt];
      const remindNow = afterNoon && remindDays.includes(today);
      const reg = await kv.get(`checkins:${c.pageId}`).catch(() => null);
      const firstAt = Number(reg?.firstAt) || zonedWall(start, tz ?? 'America/Los_Angeles', 9, 30);
      // No second paper warning to Project (Project, 2026-10-19: "and then no other paper warning"): the onboarding heads-up 12
      // hours before already said they haven't signed. UNCLE_SAM_PRESTART_MASON=on brings this message back.
      const masonNow = env.UNCLE_SAM_PRESTART_MASON === 'on' && now >= firstAt - MASON_LEAD_MS && now < firstAt + 12 * 3600_000;
      if (!remindNow && !masonNow) continue;
      const name = nameOf(c.fullName), email = String(c.email ?? '').trim().toLowerCase();
      if (!email) { summary.skipped.push(`${name}: no email`); continue; }
      let state = null;
      if (sender?.envelopesFor) { try { state = paperworkState(await sender.envelopesFor(email), email); } catch { state = null; } }
      if (state?.signedPacket && !state.waiting.length) { summary.skipped.push(`${name}: signed in DocuSign`); continue; }
      // Their reminder, once per round.
      if (remindNow && state?.waiting?.length && typeof sender?.resend === 'function') {
        for (const w of state.waiting) {
          if (!w.id || !(await kv.claim(`prestart:reminded:${w.id}:${today}`, { at: now }, now))) continue;
          const r = await sender.resend(w.id).catch(() => ({ ok: false }));
          if (r?.ok) {
            summary.reminded = (summary.reminded ?? 0) + 1;
            await kv.put(`prestart:reminders:${c.pageId}:${start}`, { n: ((await kv.get(`prestart:reminders:${c.pageId}:${start}`))?.n ?? 0) + 1, at: now }, now);
            await notion.appendCandidateNote?.({ pageId: c.pageId, text: `${today} · DocuSign reminder sent to ${name} for “${w.subject}” (unsigned before the trial; by Uncle Sam).` })?.catch?.(() => null);
          } else if (r?.retryable === true) {
            // No resend request was made: retain the approved receipt and allow the next scheduled attempt.
            await kv.del(`prestart:reminded:${w.id}:${today}`);
            summary.skipped.push(`${name}: document check temporarily unavailable; retry pending`);
          } else if (r?.code === 'docusign_document_validation_failed') {
            summary.skipped.push(`${name}: document validation blocked`);
            if (await kv.claim(`docusign:validation-notified:${w.id}`, { at: now }, now)) {
              await poster(`🚨 I blocked the DocuSign reminder to ${name}: the documents have not passed the checker. Review and correct the packet before resending.`).catch(() => null);
            }
          }
        }
      }
      if (!masonNow) continue;
      const key = `prestart:told:${c.pageId}:${start}`;
      if (await kv.get(key)) continue;
      if (!(await kv.claim(key, { at: now }, now))) continue;
      const sameDay = today === startDayPt;
      const reminded = (await kv.get(`prestart:reminders:${c.pageId}:${start}`))?.n ?? 0;
      const rate = state && !state.waiting.length ? await rateOf(c).catch(() => null) : null;
      const { mode, text } = preStartText({ name, start, state, paperwork: f.Paperwork, rate, tz, sameDay, reminded, firstAt });
      // Where their accounts stand, in the same message (Project, 2026-10-19: one warning, not two).
      const onboarded = await kv.get(`onboarding:${c.pageId}`).catch(() => null);
      const accountsLine = onboarded?.address ? ` Their Company account (${onboarded.address}) is set up${onboarded.okta || onboarded.aaDone ? ', Okta too' : ''}.` : '';
      const ts = await poster(`${text}${accountsLine}`).catch(() => null);
      if (ts && masonChannel) await kv.put(`prestart-ask:${masonChannel}:${ts}`, { pageId: c.pageId, name, email, mode, start, at: now }, now);
      summary.told++;
      await notion.appendCandidateNote?.({ pageId: c.pageId, text: `${today} · Trial starts ${start} with documents unsigned; Project told (by Uncle Sam).` })?.catch?.(() => null);
    }
    return summary;
  } catch (error) {
    summary.error = typeof error?.code === 'string' ? error.code : 'prestart_failed';
    log(`uncle_sam_prestart ${JSON.stringify(summary)}`);
    return summary;
  }
}

const GO = /\b(re-?send|send|yes|yeah|yep|go|do it)\b/i;
const STOP = /\b(no|don'?t|do not|hold|wait|stop|cancel)\b/i;

/**
 * Project's "resend" / "send" under the day-before message. resend(ask, event) and send(ask, event) do the work and reply.
 * Null when it isn't a reply to one. Acts once per message thread.
 */
export async function handlePreStartReply({ event, db, masonId, resend, send, poster, clock = Date.now, sideEffects = [] }) {
  if (!db?.prepare || event?.authorId !== masonId || !event.threadTs || event.threadTs === event.messageTs) return null;
  const kv = noticeStore(db), ask = await kv.get(`prestart-ask:${event.channelId}:${event.threadTs}`);
  if (!ask?.pageId) return null;
  const text = String(event.text ?? '');
  if (STOP.test(text) && !/\bre-?send\b/i.test(text)) { await poster(event.threadTs)('Roger that 🫡 I left it.').catch(() => {}); return { kind: 'prestart_held', reason: null }; }
  if (!GO.test(text)) return null;
  if (!(await kv.claim(`prestart:acted:${event.channelId}:${event.threadTs}`, { at: clock() }, clock()))) {
    await poster(event.threadTs)('📋 Already done for this one.').catch(() => {});
    return { kind: 'prestart_done_before', reason: null };
  }
  sideEffects.push('prestart_reply');
  const mode = /\bre-?send\b/i.test(text) ? 'resend' : ask.mode;
  return mode === 'send' ? send(ask, event) : resend(ask, event);
}
