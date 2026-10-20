/**
 * No-shows (Project, 2026-10-16, on Interviewer's "he did not attend the meeting" and his own "is he worth rescheduling? or
 * withdraw": "if this happens it gives them the option to close out their process (withdraw / not available) or send them an
 * auto email that sends them the link again saying that they didn't make it, here is another link ... a template reschedule
 * with the link auto adjusting per individual scenario and adjusting to the right link").
 *
 * When an interviewer reports a no-show (the "Didn't happen" form with No-show, a typed "he didn't show / didn't attend", or
 * "didn't happen" on a call whose Meet shows no guest joined), the interviewer gets one question on the same thread with two
 * buttons:
 *   Send a new link    -> the reschedule email (Notion template "Email · No-show · Reschedule") with the right booking link,
 *                         held 30 minutes for Project's Cancel, then sent from his Gmail
 *   Close them out     -> Outcome Withdrawn or Unavailable, Stage Closed; Project gets one line
 * The interviewer it was asked of, Robin, Alexis or Project may answer; the first tap counts. A second no-show says so on the
 * question. Rescheduled or cancelled (not a no-show) stays as before: Project is told to rebook or close the round.
 *
 * The right link: the Interviewer links board row for whoever took the call (not whose booking page it was: Project,
 * 2026-10-16, "whenever Interviewer picks one up for Robin and someone doesn't show up ... it should auto-switch to Interviewer's
 * regular interview link instead of resending Robin's"). Who took it: the interviewer who reported the no-show, else the
 * people the question went to (the Meet and stated assignments already decide that), Interviewer first when he is one of them.
 * Which link: a deep dive -> their Technical interview row (Interviewer's deep-dive link); any other call -> their regular
 * interview link (First call, the 30-minute call), then 2nd round (AA), then Other. None: no email, and Project is told.
 */
export const NOSHOW_CHOICE = 'noshow.choice';
export const RESCHEDULE_PENDING = 'email.reschedule_pending';
export const RESCHEDULE_ACTION = 'email.reschedule';
export const RESCHEDULE_TEMPLATE_ID = '04baad52-9aa1-4a49-acab-654a39fac66c';
export const RESCHEDULE_HOLD_MS = 30 * 60_000;
export const NOSHOW_BUTTONS = Object.freeze({ nsh_reschedule: 'reschedule', nsh_close: 'close', nsh_happened: 'happened' });

const pt = text => ({ type: 'plain_text', text: String(text).slice(0, 150), emoji: true });
const button = (actionId, text, value, style) => ({ type: 'button', action_id: actionId, text: pt(text), value, ...(style ? { style } : {}) });
export function noShowButtons(requestKey, { secondTime = false, detected = false } = {}) {
  return { type: 'actions', block_id: 'uncle_sam_noshow', elements: [
    button('nsh_reschedule', 'Send a new link', requestKey, secondTime ? undefined : 'primary'),
    button('nsh_close', 'Withdraw them', requestKey, secondTime ? 'primary' : undefined),
    // Seen from the Meet, not reported: they may have joined another way (a phone call, another link).
    ...(detected ? [button('nsh_happened', 'It happened', requestKey)] : [])] };
}

/**
 * A no-show the Meet shows by itself (Project, 2026-10-16: "our interviewer needed to pick up the meeting ... as soon as Interviewer
 * or Robin left, no one joined, so that would be classified as a no-show and send him the no-show options"): the interviewer
 * who took it was on the call and has left, the call has ended for them, and no one from outside Company ever joined (an
 * anonymous or dial-in participant counts as a guest, so the doubt goes to "they came"). Then the no-show question goes
 * instead of the feedback question, with a third button, It happened, for a call that went ahead some other way: that
 * answer lets the usual feedback question follow.
 */
/**
 * Earlier misses for this person (Project, 2026-10-16: "if somebody cancels a meeting, reschedules, and no-shows ... this is the
 * second time ... we recommend withdrawing them"): an earlier no-show question not answered It happened, or an earlier
 * interview reported as not having happened (cancelled or rescheduled). Returns { count, kinds }.
 */
export function earlierMisses(requests, currentNoShowOccurrence) {
  const seen = new Map();
  for (const r of requests ?? []) {
    if (r.action === NOSHOW_CHOICE && r.occurrenceId !== currentNoShowOccurrence && r.receipt?.reply?.choice !== 'happened') seen.set(r.occurrenceId.replace(/^noshow:/, ''), 'no-show');
  }
  for (const r of requests ?? []) {
    if (!/^interview\.feedback_/.test(r.action) || r.receipt?.reply?.kind !== 'did_not_happen' || `noshow:${r.occurrenceId}` === currentNoShowOccurrence) continue;
    if (!seen.has(r.occurrenceId)) seen.set(r.occurrenceId, /resched/i.test(r.receipt.reply.text ?? '') ? 'reschedule' : /cancel/i.test(r.receipt.reply.text ?? '') ? 'cancellation' : 'missed call');
  }
  return { count: seen.size, kinds: [...seen.values()] };
}
/** "a no-show", "a reschedule", "a cancellation and a no-show". */
export const missesText = kinds => { const a = kinds.map(k => `a ${k}`); return a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a.at(-1)}` : a[0] ?? ''; };

export const isMeetNoShow = seen => !!seen && Number.isFinite(seen.endedAt) && seen.guestJoined === false && seen.noInterviewer !== true && !seen.live;

/** A typed report that reads as a no-show (not a reschedule or a cancellation). */
const NO_SHOW = /\bno[\s-]?show(?:ed)?\b|\b(?:did ?n[o']?t|didnt|never|wasn'?t|was not)\s+(?:attend|show(?:\s+up)?|join|turn\s+up|make\s+it|come|there|on\b)|\b(?:ghosted|absent|missed\s+(?:the|our|his|her|their)\s+(?:call|meeting|interview))\b/i;
const NOT_NO_SHOW = /\b(?:resched|moved|postpon|cancel+ed|cancel+ation|asked to move|pushed)\w*/i;
export const looksLikeNoShow = text => NO_SHOW.test(String(text ?? '')) && !NOT_NO_SHOW.test(String(text ?? ''));

/** "intro call", "technical interview", "technical deep dive" or "interview". */
export function callKindOf({ deepDive = false, round = '', stage = '' } = {}) {
  if (deepDive) return 'technical deep dive';
  if (/^R1\b|intro/i.test(round) || (!round && /^intro/i.test(stage))) return 'intro call';
  if (/^R2\b|technical/i.test(round)) return 'technical interview';
  return 'interview';
}

/** Slack id -> the Interviewer option on the Interviewer links board, and the name the team writes. */
export const BOARD_INTERVIEWER = Object.freeze({ U0A4F08721B: 'Robin', U030A09DBFF: 'Interviewer (Quinn)', U0BF89D1279: 'AA (Rory)', U0F9EF97D89: 'Project' });
export const SHORT_NAME = Object.freeze({ U0A4F08721B: 'Robin', U030A09DBFF: 'Interviewer', U0BF89D1279: 'AA', U0F9EF97D89: 'Project', U0476A5BC82: 'Alexis' });

/** Which board rows to try, in order, for this call. */
export function linkCandidates({ interviewerId, deepDive = false, round = '' }) {
  const who = BOARD_INTERVIEWER[interviewerId];
  if (!who) return [];
  void round;
  const order = deepDive ? ['Technical interview', 'First call', '2nd round', 'Other'] : ['First call', '2nd round', 'Other', 'Technical interview'];
  return order.map(useFor => ({ interviewer: who, useFor }));
}

/** Who took the call, for the link: the reporting interviewer, else the people asked (Interviewer first), else the reporter. */
export function takerOf({ authorId, askedIds = [], interviewerIds = [] }) {
  if (interviewerIds.includes(authorId)) return authorId;
  const asked = askedIds.filter(id => interviewerIds.includes(id));
  return asked.includes('U030A09DBFF') ? 'U030A09DBFF' : asked[0] ?? authorId;
}
/** The first usable https link of those rows (never a single-use Calendly "/d/" link). */
export async function findRescheduleLink(notion, plan) {
  for (const row of plan) {
    let url = null;
    try { url = await notion.findBookingLink(row); } catch { url = null; }
    if (url && /^https:\/\//.test(url) && !/^https:\/\/(?:www\.)?calendly\.com\/d\//i.test(url)) return url;
  }
  return null;
}

/** The template filled for one person, or null when it changed shape. */
export function fillRescheduleEmail(template, { firstName, link, callKind, interviewerName }) {
  if (!template?.subject || !template?.body || !String(firstName ?? '').trim() || !/^https:\/\//.test(String(link ?? ''))) return null;
  if (!template.body.includes('{{first_name}}') || !template.body.includes('{{booking_link}}')) return null;
  const fill = text => text.replaceAll('{{first_name}}', firstName.trim()).replaceAll('{{booking_link}}', link)
    .replaceAll('{{call_kind}}', callKind).replaceAll('{{interviewer_name}}', interviewerName);
  const subject = fill(template.subject), body = fill(template.body);
  if (/\{\{[^}]*\}\}/.test(subject + body) || subject.length > 200 || body.length > 2000) return null;
  return { subject, body };
}
