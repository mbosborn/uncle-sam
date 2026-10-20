/**
 * Paperwork follow-through (Project, 2026-10-16: "48 hours yes but if there's a last second person that maybe agrees somehow 36
 * [hours before the trial] there needs to be a 24 hour warning ... essentially there needs to be edge cases for the docusign
 * reminder").
 *
 * For each work-trial packet Uncle Sam sent (kv docusign:packet:<email>), DocuSign is read every 10 minutes and:
 *  - The candidate hasn't signed: ONE DocuSign reminder (the same envelope sent again) 48 hours after sending, or sooner when
 *    the trial is close: 24 hours before Trial Start (9 am Pacific that day), never sooner than 4 hours after sending.
 *      sent a week ahead -> reminder at +48h;  sent 36h ahead -> at +12h (24h before);  sent 10h ahead -> at +4h.
 *    Skipped when anyone resent it to them in the last 24 hours (Project's "resend", Jamie by hand), when DocuSign's own
 *    reminders are on for that envelope, or when DocuSign could not deliver to their email.
 *  - Still unsigned 24 hours before Trial Start (or at the reminder, when that comes later): Project told once. On the trial day:
 *    told once more. With a far-off start, also told 4 days after sending. With no start date: told 4 days after sending.
 *  - Signed by the candidate, waiting on Company's countersignature: Project told 24 hours after they signed, or 24 hours before
 *    Trial Start when that is sooner (never sooner than 2 hours after they signed); once more on the trial day.
 *  - Declined, voided or expired, or the email bounced: Project told at once; reminders stop. A declined, voided or expired packet
 *    may be sent again ("send the work trial docs to <name>").
 *  - The candidate closed on the tracker (Not Selected, Withdrawn): reminders stop; Project told once that the envelope is open.
 *  - Signed by everyone: done. DocuSign Connect (docusign.mjs) has already set Paperwork, and the account requests follow.
 * Trial Start is read fresh each time, so a date added or moved later is honoured. Each message is claimed before it goes and
 * never repeated; a reminder DocuSign refuses is not retried (Project told). When several of Project's notices fall due together
 * (after downtime) only the latest goes. Project's DMs wait for 7 am-10 pm Pacific unless the trial starts within 12 hours.
 * Live only; never throws. UNCLE_SAM_PAPERWORK_FOLLOWUP=off stops it.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { pacificWall, startPhrase, laDate } from './onboarding.mjs';

const H = 3600_000;
export const REMIND_AFTER_MS = 48 * H;
export const REMIND_BEFORE_START_MS = 24 * H;
export const REMIND_MIN_MS = 4 * H;
export const STALE_WARN_MS = 96 * H;
export const RECENT_TOUCH_MS = 24 * H;
export const COUNTERSIGN_MS = 24 * H;
export const COUNTERSIGN_MIN_MS = 2 * H;
export const START_HOUR_PT = 9;
export const CHECK_EVERY_MS = 10 * 60_000;
const TZ = 'America/Los_Angeles';
const OPEN = ['created', 'sent', 'delivered'];
const CLOSED_OUTCOMES = ['Not Selected', 'Withdrawn or Unavailable'];
const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const dateOnly = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : (typeof v?.start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.start) ? v.start.slice(0, 10) : null));
const laHour = ms => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(ms));
export const whenPT = ms => `${new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms)} PT`;
export const ago = ms => (ms < H ? `${Math.max(1, Math.round(ms / 60_000))} minutes` : ms < 48 * H ? `${Math.round(ms / H)} hours` : `${Math.round(ms / (24 * H))} days`);

/** 9 am Pacific on the Trial Start date, or null. */
export const trialStartMs = date => (dateOnly(date) ? pacificWall(dateOnly(date), START_HOUR_PT) : null);

/** The one reminder to the candidate: 48h after sending, pulled in to 24h before the start, never before +4h. */
export function reminderAt({ sentAt, start = null }) {
  const normal = sentAt + REMIND_AFTER_MS;
  return start ? Math.min(normal, Math.max(sentAt + REMIND_MIN_MS, start - REMIND_BEFORE_START_MS)) : normal;
}

/** Project's notices while the candidate hasn't signed, in order. */
export function unsignedWarnings({ sentAt, start = null }) {
  const remind = reminderAt({ sentAt, start });
  if (!start) return [{ key: 'stale', at: sentAt + STALE_WARN_MS }];
  const out = [];
  const dayBefore = Math.max(start - 24 * H, remind);
  if (sentAt + STALE_WARN_MS < dayBefore - 12 * H) out.push({ key: 'stale', at: sentAt + STALE_WARN_MS });
  out.push({ key: 'day_before', at: dayBefore });
  if (start - dayBefore >= 6 * H) out.push({ key: 'trial_day', at: start });
  return out;
}

/** Project's notices while the packet waits on Company's countersignature. */
export function countersignWarnings({ signedAt, start = null }) {
  const first = start ? Math.min(signedAt + COUNTERSIGN_MS, Math.max(signedAt + COUNTERSIGN_MIN_MS, start - 24 * H)) : signedAt + COUNTERSIGN_MS;
  const out = [{ key: 'countersign', at: first }];
  if (start && start - first >= 6 * H) out.push({ key: 'countersign_trial_day', at: start });
  return out;
}

/** What the send reply promises, in Project's words. */
export function followUpPromise({ sentAt, startDate = null }) {
  const start = trialStartMs(startDate);
  const remind = reminderAt({ sentAt, start });
  const warn = unsignedWarnings({ sentAt, start }).find(w => w.key === 'day_before') ?? unsignedWarnings({ sentAt, start })[0];
  return `If they haven't signed by ${whenPT(remind)}, I'll send one DocuSign reminder${warn.at > remind + 30 * 60_000 ? `, and tell you ${whenPT(warn.at)} if it's still unsigned` : ' and tell you'}.`;
}

const startClause = (startDate, start, now) => (!start ? '' : start > now ? ` Their trial starts ${startPhrase(startDate, now)}.` : laDate(start) === laDate(now) ? ' Their trial starts today.' : ` Their trial started ${startPhrase(startDate, now)}.`);

export async function runPaperworkFollowUps({ env = {}, db, sender, notion, poster, clock = Date.now, log = () => {} }) {
  const summary = { checked: 0, reminded: 0, told: 0, done: 0, error: null };
  try {
    if (!db?.prepare || !sender || typeof poster !== 'function' || env.UNCLE_SAM_PAPERWORK_FOLLOWUP === 'off') return { ...summary, state: 'off' };
    const kv = noticeStore(db), now = clock();
    const last = await kv.get('docusign:followup:last');
    if (last?.at && now - last.at < CHECK_EVERY_MS) return { ...summary, state: 'not_due' };
    await kv.put('docusign:followup:last', { at: now }, now);
    for (const name of await kv.names('docusign:packet:')) {
      const packet = await kv.get(name);
      if (!packet?.envelopeId || packet.closed) continue;
      const email = name.slice('docusign:packet:'.length).toLowerCase();
      const fkey = `docusign:follow:${packet.envelopeId}`;
      const state = (await kv.get(fkey)) ?? { keys: [] };
      if (state.done) continue;
      summary.checked++;
      try { await followOne({ kv, name, packet, email, fkey, state, sender, notion, poster, now, summary, log }); }
      catch (error) { summary.error = typeof error?.code === 'string' ? error.code : 'paperwork_followup_failed'; log(`uncle_sam_paperwork error=${summary.error} env=${packet.envelopeId.slice(0, 8)}`); }
    }
    return summary;
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'paperwork_followup_failed' }; }
}

async function followOne({ kv, name, packet, email, fkey, state, sender, notion, poster, now, summary, log }) {
  const save = async () => kv.put(fkey, state, now);
  const claim = async key => { if (state.keys.includes(key)) return false; state.keys.push(key); await save(); return true; };
  const tell = async (key, text) => { if (!(await claim(key))) return; try { await poster(text); summary.told++; } catch { /* claimed: never twice */ } };
  const finish = async (closed = null) => {
    state.done = true; await save(); summary.done++;
    if (closed) await kv.put(name, { ...packet, closed, closedAt: now }, now);
  };

  const envelope = await sender.envelope(packet.envelopeId);
  let candidate = null;
  try {
    candidate = packet.pageId ? await notion.getCandidate(packet.pageId) : null;
    if (!candidate) { const found = await notion.findCandidatesByEmail(email); candidate = found.length === 1 ? found[0] : null; }
  } catch { candidate = null; }
  const fullName = clean(candidate?.fullName ?? packet.name ?? envelope.signers.find(s => s.email === email)?.name ?? email, 120);
  const first = fullName.split(' ')[0];
  const startDate = dateOnly(candidate?.fields?.['Trial Start']);
  const start = trialStartMs(startDate);
  const me = envelope.signers.find(s => s.email === email);
  const pending = envelope.signers.filter(s => s.email !== email && OPEN.includes(s.status));
  const resend = `say "resend ${first}'s DocuSign" to send it again`;

  if (envelope.status === 'completed') return finish();
  if (envelope.status === 'voided') {
    const expired = /expir/i.test(envelope.voidedReason ?? '');
    await tell('voided', expired
      ? `📋 ${fullName}'s work trial documents expired in DocuSign before they signed. Say "send the work trial docs to ${fullName}" and I'll send a fresh envelope.`
      : `📋 ${fullName}'s work trial envelope was voided${envelope.voidedReason ? ` (“${clean(envelope.voidedReason, 160)}”)` : ''}. I've stopped following it up. Say "send the work trial docs to ${fullName}" if they still need a packet.`);
    return finish(expired ? 'expired' : 'voided');
  }
  if (envelope.status === 'declined' || me?.status === 'declined') {
    await tell('declined', `🚨 ${fullName} declined the work trial documents in DocuSign${me?.declinedReason ? `: “${clean(me.declinedReason, 200)}”` : ''}. I've stopped the reminders. If it was a mistake, say "send the work trial docs to ${fullName}" and I'll send a fresh envelope.`);
    return finish('declined');
  }
  if (!me) { log(`uncle_sam_paperwork missing_signer env=${packet.envelopeId.slice(0, 8)}`); return finish(); }
  if (CLOSED_OUTCOMES.includes(candidate?.fields?.Outcome)) {
    await tell('closed', `📋 ${fullName} is closed on the tracker (${candidate.fields.Outcome}), but their work trial envelope is still open in DocuSign. I've stopped following it up; void it in DocuSign if it shouldn't be signed.`);
    return finish();
  }
  const urgent = start && start - now < 12 * H;
  const awake = urgent || (laHour(now) >= 7 && laHour(now) < 22);
  // Only the latest of the notices due now goes; the earlier ones are passed over.
  const latestDue = async (list, text) => {
    const due = list.filter(w => now >= w.at && !state.keys.includes(w.key));
    if (!due.length || !awake) return;
    for (const w of due.slice(0, -1)) await claim(w.key);
    const last = due.at(-1);
    await tell(last.key, text(last.key));
  };

  if (me.status === 'autoresponded') {
    await tell('bounced', `🚨 DocuSign couldn't deliver ${fullName}'s work trial documents to ${email}. Put the right email on the tracker, void this envelope in DocuSign, then say "send the work trial docs to ${fullName}".`);
    return;
  }

  if (OPEN.includes(me.status)) {
    const sentAt = packet.at;
    if (now >= reminderAt({ sentAt, start }) && !state.keys.includes('remind')) {
      const resentAt = (await kv.get(`docusign:resent:${packet.envelopeId}`))?.at ?? null;
      const touched = Math.max(resentAt ?? 0, me.sentAt && me.sentAt > sentAt + 10 * 60_000 ? me.sentAt : 0);
      let own = false;
      try { own = (await sender.reminders(packet.envelopeId))?.enabled === true; } catch { own = false; }
      if (touched && now - touched < RECENT_TOUCH_MS) { state.remindSkip = { why: 'recent', at: touched }; await claim('remind'); }
      else if (own) { state.remindSkip = { why: 'docusign' }; await claim('remind'); }
      else if (await claim('remind')) {
        let done;
        try { done = await sender.resend(packet.envelopeId); } catch (error) { done = { ok: false, code: error?.code ?? 'failed' }; }
        if (done.ok) {
          state.remindedAt = now; await save(); summary.reminded++;
          await kv.put(`docusign:resent:${packet.envelopeId}`, { at: now, by: 'uncle-sam' }, now);
          log(`uncle_sam_paperwork reminded=${packet.envelopeId.slice(0, 8)}`);
          if (candidate?.pageId) await notion.appendCandidateNote({ pageId: candidate.pageId, text: `${laDate(now)} · DocuSign reminder sent for the work trial documents (by Uncle Sam; still unsigned).` }).catch(() => null);
        } else await tell('remind_failed', done.code === 'docusign_document_validation_failed'
          ? `🚨 I blocked the DocuSign reminder to ${fullName}: the documents have not passed the checker. Review and correct the packet before resending.`
          : `🚨 DocuSign refused my reminder to ${fullName} (${clean(done.code, 60)}). Check the envelope before retrying.`);
      }
    }
    const reminded = state.remindedAt ? `; I reminded them ${now - state.remindedAt < 10 * 60_000 ? 'just now' : `${ago(now - state.remindedAt)} ago`}`
      : state.remindSkip?.why === 'recent' ? `; it was resent to them ${ago(now - state.remindSkip.at)} ago`
        : state.remindSkip?.why === 'docusign' ? '; DocuSign is sending its own reminders' : '';
    const opened = me.status === 'delivered' ? 'opened but not signed' : 'not opened';
    await latestDue(unsignedWarnings({ sentAt, start }), key => (key === 'trial_day'
      ? `🚨 ${fullName}'s trial starts today and they still haven't signed the work trial documents (${opened}). They shouldn't start work until they do. ${resend[0].toUpperCase()}${resend.slice(1)}, or move Trial Start on the tracker.`
      : key === 'day_before'
        ? `⏳ ${fullName} hasn't signed the work trial documents (${opened})${reminded}.${startClause(startDate, start, now)} Their accounts won't be requested until they sign. ${resend[0].toUpperCase()}${resend.slice(1)}, or move Trial Start on the tracker.`
        : `📋 ${fullName} still hasn't signed the work trial documents I sent ${ago(now - sentAt)} ago (${opened})${reminded}.${startClause(startDate, start, now)} ${resend[0].toUpperCase()}${resend.slice(1)}.`));
    return;
  }

  // They signed; the envelope waits on Company.
  if (pending.length) {
    if (!state.signedAt) { state.signedAt = me.signedAt ?? now; await save(); }
    const whose = pending.some(s => s.email === 'project@company.example') ? 'your countersignature' : `${pending.map(s => s.name || s.email).join(' and ')}'s countersignature`;
    await latestDue(countersignWarnings({ signedAt: state.signedAt, start }), key => (key === 'countersign_trial_day'
      ? `🚨 ${fullName}'s trial starts today and the work trial documents still need ${whose}. DocuSign emailed the link; it's under Action Required in DocuSign.`
      : `📋 ${fullName} signed the work trial documents ${ago(now - state.signedAt)} ago; they're waiting on ${whose}.${startClause(startDate, start, now)} DocuSign emailed the link; it's under Action Required in DocuSign.`));
  }
}
