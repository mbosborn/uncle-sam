/** Explicit team recap decisions supersede older tracker holds; candidate mail remains in the normal sender queues. */
import { PEOPLE } from './agent-runner.mjs';
import { TAKEHOME_INVITE_ACTION } from './takehome-invite.mjs';
import { REJECTION_EXCLUDED, isNonSendingRejectionBaseline } from './rejection-sender.mjs';
const AUTHORS = new Map([[PEOPLE.robin, 'Robin'], [PEOPLE.alexis, 'Alexis'], [PEOPLE.interviewer, 'Interviewer'], [PEOPLE.project, 'Project']]);
const norm = s => String(s ?? '').toLowerCase().replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
const final = (next, quote) => !/\b(maybe|recommend|possibly|might|unsure|not sure|should we|hold|wait)\b|\b(?:do not|don't|not to)\s+(?:reject|send|advance)/i.test(quote)
  && (next === 'reject' ? /\b(not moving forward|not selected|reject(?:ed|ion)?)\b/i.test(quote) : /\b(?:send|share|moving|move|proceed|advance)\b.*\btake[ -]?home\b/i.test(quote));
export function isExplicitRecapDecision(next, quote) { return ['reject', 'take_home'].includes(next) && final(next, quote); }
const blocked = reason => ({ kind: 'recap_decision_blocked', reason });

export async function applyRecapDecision({ env, notion, slackRead, gmail, takeHome, findInterviewEnd = null, candidatePageId, authorId, channelId,
  messageTs, name, next, quote, singleCandidate = true, clock = Date.now }) {
  const who = AUTHORS.get(authorId), now = clock(), postedAt = Math.round(Number(messageTs) * 1000);
  if (env?.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || (await notion.readControl())?.mode !== 'Live') return blocked('not_live');
  if (!who || channelId !== 'C01D1A69CE3' || !singleCandidate || !Number.isFinite(postedAt) || postedAt > now || now - postedAt > 7 * 86400_000
    || !isExplicitRecapDecision(next, quote)) return blocked('instruction_not_explicit');
  const rows = await slackRead.readThread({ channelId, threadTs: messageTs, limit: 100, requireComplete: true });
  const post = rows.find(m => m.ts === messageTs);
  if (!post || post.user !== authorId || post.botId || post.subtype || !norm(post.text).includes(norm(quote)) || !norm(post.text).includes(norm(name))) return blocked('source_changed');
  // A later reply with a competing instruction is not silently ignored.
  if (rows.some(m => Number(m.ts) > Number(messageTs) && AUTHORS.has(m.user) && /\b(hold|wait|stop|cancel|reject|send|proceed|advance|instead)\b/i.test(m.text ?? ''))) return blocked('newer_thread_instruction');
  let { candidate: c, sender } = await notion.getRejectionState(candidatePageId);
  if (c.archived || c.inRecruitingSource === false || norm(c.fullName.replace(/\([^()]*\)/g, '')) !== norm(name) || !c.emailVerified || !c.email
    || REJECTION_EXCLUDED.includes(c.pageId) || /^\[(?:TEST|FIXTURE)\]/i.test(c.fullName)) return blocked('identity_unverified');
  const found = await notion.findCandidatesByName(name);
  if (!Array.isArray(found) || found.length >= 10) return blocked('identity_search_incomplete');
  const matches = found.filter(x => !x.archived && norm(x.fullName.replace(/\([^()]*\)/g, '')) === norm(name));
  if (matches.length !== 1 && !norm(post.text).includes(c.email.toLowerCase())) return blocked('identity_ambiguous');
  if (c.fields.Outcome === 'Hired' || c.fields.Stage === 'Hired' || c.fields.Outcome === 'Withdrawn or Unavailable') return blocked('candidate_unavailable');
  const newerEvidence = /\/p(\d{10})(\d{6})(?:[?#]|$)/.exec(c.profile?.latestEvidence ?? '');
  if (newerEvidence && Number(`${newerEvidence[1]}.${newerEvidence[2]}`) > Number(messageTs)) return blocked('newer_record_instruction');
  if ((sender.attempt && !isNonSendingRejectionBaseline(sender)) || sender.status === 'Sending' || sender.status === 'Needs attention') return blocked('earlier_send_unresolved');
  const sourceUrl = `https://example-workspace.slack.com/archives/${channelId}/p${messageTs.replace('.', '')}`;
  if (next === 'take_home') {
    const resume = existingStep => notion.applyExplicitRecapDecision({ pageId: c.pageId, expectedEmail: c.email, expectedLastEditedTime: c.lastEditedTime,
      outcome: 'Proceeding', who, quote, sourceUrl, existingStep, sourceText: post.text });
    // Read failures propagate. Absence of a duplicate is never inferred from an outage.
    const card = await notion.findTakeHomeScorecard(c.pageId);
    const operations = await notion.findOperationsForCandidate({ candidatePageId: c.pageId, action: TAKEHOME_INVITE_ACTION });
    if (card || operations.length) {
      if (operations.some(o => ['Sending', 'Needs attention', 'Cancelled'].includes(o.state))) return blocked('earlier_takehome_requires_reconciliation');
      await resume(card || operations.some(o => ['Complete', 'Sent'].includes(o.state)) ? 'sent' : 'queued');
      return { kind: 'recap_step_already_exists', reason: 'takehome_record_or_queue' };
    }
    if (typeof gmail?.searchSent !== 'function') return blocked('sent_mail_unavailable');
    const sent = await gmail.searchSent(`to:${c.email} ("Take-Home Assessment" OR "Research Take-Home" OR "company-takehome.vercel.app")`);
    if (!Array.isArray(sent)) return blocked('sent_mail_unavailable');
    if (sent.length) { await resume('sent'); return { kind: 'recap_step_already_exists', reason: 'takehome_already_sent' }; }
    if (typeof takeHome !== 'function') return blocked('takehome_queue_unavailable');
    await resume(null);
    const result = await takeHome({ candidatePageId: c.pageId, by: who, quote, at: postedAt });
    return result?.kind === 'takehome_invite_queued' ? result : result?.kind === 'takehome_invite_already_queued' || result?.skipped === 'already_has_takehome'
      ? { kind: 'recap_step_already_exists', reason: result.skipped ?? result.kind } : blocked(result?.error ?? result?.skipped ?? 'takehome_queue_unverified');
  }
  if (sender.status === 'Sent' || sender.sentAt) return { kind: 'recap_step_already_exists', reason: 'rejection_already_sent' };
  if (c.fields.Outcome === 'Not Selected' && sender.status === 'Scheduled') return { kind: 'recap_step_already_exists', reason: 'rejection_already_queued' };
  if (typeof gmail?.searchSent !== 'function') return blocked('sent_mail_unavailable');
  const sent = await gmail.searchSent(`to:${c.email} subject:"Update on Company Interview Process"`);
  if (!Array.isArray(sent)) return blocked('sent_mail_unavailable');
  if (sent.length) return { kind: 'recap_step_already_exists', reason: 'rejection_already_sent' };
  const interviews = await notion.listCandidateInterviews({ candidatePageId: c.pageId });
  const calendarEnd = typeof findInterviewEnd === 'function' ? await findInterviewEnd(c.email) : null;
  if (calendarEnd?.at && calendarEnd.sourceUrl) interviews.push({ end: calendarEnd.at, htmlLink: calendarEnd.sourceUrl });
  const logged = interviews.filter(e => e.status !== 'cancelled' && Number.isFinite(Date.parse(e.end)) && Date.parse(e.end) <= now && Date.parse(e.end) >= postedAt - 24 * 3600_000 && /^https:\/\//.test(e.htmlLink ?? ''))
    .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0];
  // Without a verified interview time, use the later recap time, never an earlier guessed time.
  const endMs = Math.max(logged ? Date.parse(logged.end) : postedAt, Date.parse(sender.lastInterviewEnd) || 0);
  const timing = { at: new Date(endMs).toISOString(), sourceUrl: endMs === Date.parse(sender.lastInterviewEnd) ? sender.timingSource || sourceUrl : logged?.htmlLink || sourceUrl };
  await notion.applyExplicitRecapDecision({ pageId: c.pageId, expectedEmail: c.email, expectedLastEditedTime: c.lastEditedTime,
    outcome: 'Not Selected', who, quote, sourceUrl, interviewEnd: timing, sourceText: post.text });
  ({ candidate: c, sender } = await notion.getRejectionState(c.pageId));
  if (c.fields.Outcome !== 'Not Selected' || sender.hold || sender.attempt || sender.status || !c.email) return blocked('queue_state_changed');
  const scheduledFor = new Date(Math.ceil(Math.max(clock(), endMs + 24 * 3600_000) / 60_000) * 60_000).toISOString();
  const decisionAt = new Date(clock()).toISOString(), decisionKey = `${c.pageId}|${messageTs}`;
  const after = await notion.writeRejection({ pageId: c.pageId, fields: { decisionAt, decisionKey, queuedTo: c.email, scheduledFor, status: 'Scheduled' } });
  if (after.sender.status !== 'Scheduled' || after.sender.queuedTo !== c.email || after.sender.decisionKey !== decisionKey
    || Date.parse(after.sender.scheduledFor) !== Date.parse(scheduledFor)) throw new Error('recap_queue_readback_mismatch');
  return { kind: 'recap_rejection_queued', scheduledFor, candidatePageId: c.pageId };
}
