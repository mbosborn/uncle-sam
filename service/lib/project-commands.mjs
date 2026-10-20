/**
 * Project's own commands in his DM with Uncle Sam that act at once (Project, 2026-10-16: "this guy needs to be sent the take home
 * and cc interviewer ofc and update the tracker"; "if he has [Slack and a Company email] then message rory a to set up his okta
 * and get uncle sam to message him").
 *
 *   "send Logan Wells the take-home"     -> the take-home invite (template, portal link, Project's Gmail, Interviewer cc'd) on the
 *                                              next run, no 30-minute wait (he asked for it), with the usual Cancel notice; the
 *                                              tracker is updated when it goes out (agent-runner.mjs).
 *   "ask AA to set up Arlen Archer's Okta" -> AA's Okta request in the Project+AA group DM now, as onboarding.mjs would post it,
 *                                              without waiting for the paperwork (Project's call); once per person.
 * Names are read like the DocuSign commands (docusign-send.mjs candidateFinder: by sound, "from <company>" for namesakes). Nobody
 * found or two namesakes: Uncle Sam asks in the thread and a reply there naming the person does it. Uncle Sam's own question
 * about a stuck take-home (stage-gaps.mjs) takes a plain "send" / "yes" / "take-home" reply the same way.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { oktaReady, setUpOkta } from './okta.mjs';
import { googleName } from './accounts.mjs';
import { nameGuesses, looksLikeResend } from './docusign-send.mjs';
import { masonPoster } from './wispr.mjs';
import { laDate, startPhrase, slackMembersNamed } from './onboarding.mjs';

const ASK_MS = 24 * 3600_000;
const YES = /^\s*(?:<@[^>]+>\s*)?(?:yes|yep|yeah|y|send(?: it| them| the take[- ]?home)?|go(?: ahead)?|take[- ]?home|do it)\b/i;
export const looksLikeTakeHomeSend = text => /\b(take[- ]?homes?|case stud(?:y|ies)|assessment)\b/i.test(String(text ?? ''))
  && /\b(send|sent|give|get|start|email)\b/i.test(String(text ?? '')) && !looksLikeResend(text) && !/\b(remind|reminder|nudge)\b/i.test(String(text ?? ''))
  // A question about a take-home ("what score did he get on his take home?") is not an order to send one (Project, 2026-10-19).
  && !looksLikeQuestion(text);
const looksLikeQuestion = text => /\?\s*$/.test(String(text ?? '').replace(/\*Sent using\*[\s\S]*$/i, '').trim())
  || /^\s*(what|how|did|does|do|has|have|was|were|is|when|which|who|why)\b/i.test(String(text ?? ''))
  || /\b(score|scored|grade|graded|result|results|pass(?:ed)?|fail(?:ed)?|how did)\b/i.test(String(text ?? ''));
export const looksLikeOktaAsk = text => /\bokta\b/i.test(String(text ?? '')) && /\b(aa|rory|rowan|set ?up|ask|message|tell)\b/i.test(String(text ?? ''));

const first = who => String(who?.fullName ?? '').trim().split(/\s+/)[0] || 'them';
/**
 * "send X the take-home". `startTakeHome(who, text)` queues it (agent-runner takeHomeFromRecap, by Project, no hold) and returns
 * its result. Returns an outcome, or null when the message is not this.
 */
export async function handleTakeHomeCommand({ event, db, findCandidate, poster, masonId, startTakeHome, clock = Date.now, sideEffects = [] }) {
  if (!db?.prepare || !event || event.authorId !== masonId || typeof startTakeHome !== 'function') return null;
  const kv = noticeStore(db), now = clock();
  const thread = event.threadTs ?? event.messageTs, inThread = !!event.threadTs && event.threadTs !== event.messageTs;
  let pending = null;
  if (inThread) {
    const kept = await kv.get(`takehome-ask:${event.channelId}:${event.threadTs}`);
    pending = kept && !kept.done && now - kept.at <= ASK_MS ? kept : null;
  }
  if (!pending && !looksLikeTakeHomeSend(event.text)) return null;
  if (pending && !looksLikeTakeHomeSend(event.text) && !YES.test(event.text) && (pending.who || !nameGuesses(event.text).length)) return null;
  const reply = async text => { try { await poster(thread)(text); sideEffects.push('takehome_reply'); } catch { /* the outcome stands */ } };
  let who = null;
  if (pending?.who && (YES.test(event.text) || !nameGuesses(event.text).length)) who = pending.who;
  else who = await findCandidate(event.text, event);
  if (who?.ambiguous) {
    await kv.put(`takehome-ask:${event.channelId}:${thread}`, { at: now }, now);
    await reply(`📋 Which one: ${who.ambiguous.slice(0, 4).join(' or ')}? Reply here with the name (add "from <company>") and I'll send the take-home.`);
    return { kind: 'takehome_command', reason: 'ambiguous' };
  }
  if (!who?.pageId) {
    await kv.put(`takehome-ask:${event.channelId}:${thread}`, { at: now }, now);
    const heard = nameGuesses(event.text)[0];
    await reply(`📋 I couldn't find ${heard ? `“${heard}”` : 'who you meant'} on the tracker. Reply here with their full name (add "from <company>" if two share it) and I'll send the take-home.`);
    return { kind: 'takehome_command', reason: 'no_candidate' };
  }
  if (who.matched === 'sound' && !who.companyMatched && !pending?.who) {
    const { matched, heard, companyMatched, from, ...facts } = who;
    await kv.put(`takehome-ask:${event.channelId}:${thread}`, { at: now, who: facts }, now);
    await reply(`📋 Did you mean ${who.fullName}${who.from ? ` (${who.from})` : ''}, ${who.email ?? 'no email on record'}? Reply yes here and I'll send the take-home.`);
    return { kind: 'takehome_command', reason: 'confirm_name' };
  }
  if (!who.email) { await reply(`📋 ${who.fullName} has no email on the tracker, so I can't send the take-home. Add it to their record and say it again.`); return { kind: 'takehome_command', reason: 'no_email' }; }
  const out = await startTakeHome(who, event.text).catch(error => ({ error: error?.code ?? 'failed' }));
  await kv.put(`takehome-ask:${event.channelId}:${thread}`, { at: now, done: true }, now);
  const name = who.fullName;
  const line = out?.kind === 'takehome_invite_queued' ? (inThread ? `Roger that 🫡: ${first(who)}'s take-home goes out from your Gmail with Interviewer cc'd on my next run. Tap Cancel on the notice to stop it.` : '')
    : out?.kind === 'takehome_invite_already_queued' ? `📋 ${name}'s take-home invite is already with me (${out.state ?? 'queued'}). I didn't start another.`
    : out?.skipped === 'already_has_takehome' ? `📋 ${name} already has a take-home on record (a scorecard or an earlier invite). I didn't send another.`
    : out?.skipped === 'already_started' ? `📋 I already started ${first(who)}'s take-home earlier. I didn't send another.`
    : out?.skipped === 'candidate_closed' ? `📋 ${name} is closed on the tracker, so I sent nothing.`
    : out?.skipped === 'on_hold' ? `📋 ${name} is On Hold on the tracker. Take the hold off, then say it again.`
    : out?.skipped === 'not_live' ? '📋 I am not Live (Mode on the Notion control row), so I sent nothing.'
    : out?.error ? `🚨 I couldn't start ${first(who)}'s take-home (${out.error}). Nothing went out.`
    : out?.kind === 'takehome_invite' && out.dryRun ? '📋 I am not Live, so this was a dry run; nothing went out.' : '';
  if (line) await reply(line);
  return { kind: 'takehome_command', reason: out?.kind ?? out?.skipped ?? out?.error ?? 'unknown' };
}

/** A Company address written in the message (Project may paste it). */
const companyAddressIn = text => (String(text ?? '').match(/\b[a-z0-9._%+-]+@company\.example\b/i) ?? [])[0]?.toLowerCase() ?? null;
// Never the "Sent using @Claude" footer's mention (Oct 18: AA was told Rowan Blake was in Slack as @Claude).
const slackIdIn = text => /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/.exec(String(text ?? '').replace(/\*?Sent using\*?[\s\S]*$/i, '').replace(/<@U0C4899BFC9(?:\|[^>]*)?>/g, ''))?.[1] ?? null;

/**
 * "ask AA to set up X's Okta": AA's request now, in the Project+AA group DM. Returns an outcome, or null when not this.
 * `trialOf(who)` gives { start } from the record (optional).
 */
export async function handleOktaCommand({ event, env, db, notion, findCandidate, poster, masonId, routeMap = {}, fetchImpl = globalThis.fetch, clock = Date.now, sideEffects = [], okta = null }) {
  if (!db?.prepare || !event || event.authorId !== masonId || !looksLikeOktaAsk(event.text)) return null;
  const reply = async text => { try { await poster(event.threadTs ?? event.messageTs)(text); sideEffects.push('okta_reply'); } catch { /* the outcome stands */ } };
  const aaChannel = routeMap?.interviewer_aa?.channelId ?? routeMap?.aa_group?.channelId; // AA alone (Project, 2026-10-16)
  if (!aaChannel) { await reply("📋 I don't have the group DM with you and AA set up, so I sent nothing. Ask AA by hand."); return { kind: 'okta_command', reason: 'no_route' }; }
  const who = await findCandidate(event.text, event);
  if (who?.ambiguous) { await reply(`📋 Which one: ${who.ambiguous.slice(0, 4).join(' or ')}? Say it again with the full name.`); return { kind: 'okta_command', reason: 'ambiguous' }; }
  if (!who?.pageId) { await reply('📋 Who is it for? Say "ask AA to set up <full name>\'s Okta".'); return { kind: 'okta_command', reason: 'no_candidate' }; }
  const kv = noticeStore(db), now = clock(), key = `onboarding:${who.pageId}`;
  const state = (await kv.get(key)) ?? {};
  const selfOkta = !!okta && await oktaReady({ env, db }).catch(() => false);
  if (state.aa?.sentAt && !(selfOkta && (companyAddressIn(event.text) ?? state.address))) { await reply(`📋 AA was already asked about ${who.fullName}'s Okta (${new Date(state.aa.sentAt).toISOString().slice(0, 10)}). I didn't ask again.`); return { kind: 'okta_command', reason: 'already_asked' }; }
  // The address and Slack account: what Project wrote, what onboarding already found, else a Slack member carrying their full name.
  let address = companyAddressIn(event.text) ?? state.address ?? null, slackUser = slackIdIn(event.text) ?? state.slackUser ?? null;
  // A Slack account named in a message or kept on record is used only when Slack confirms it is this person (their name or
  // their address); anything else is left out (Oct 18: AA was told Rowan Blake was in Slack as @Claude).
  if (slackUser) {
    try { const ok = await slackMembersNamed({ env, fetchImpl, fullName: who.fullName, emails: [address, who.email] }); if (!ok.includes(slackUser)) slackUser = null; }
    catch { slackUser = null; }
  }
  if (!slackUser) { try { const found = await slackMembersNamed({ env, fetchImpl, fullName: who.fullName }); if (found.length === 1) slackUser = found[0]; } catch { /* asked without it */ } }
  let start = who.trialStart ?? null;
  const name = who.fullName.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // Okta on (okta.mjs): Uncle Sam does it himself, AA isn't asked.
  if (okta && address && await oktaReady({ env, db }).catch(() => false)) {
    const r = await setUpOkta({ env, db, okta, who: { pageId: who.pageId, fullName: who.fullName, address, personalEmail: who.email ?? null }, names: googleName(who.fullName), clock })
      .catch(error => ({ reason: 'refused', code: error?.code ?? 'failed' }));
    if (r.reason === 'created' || r.reason === 'existing') {
      Object.assign(state, { address, aa: { skipped: 'okta_by_uncle_sam', at: now, byMason: true }, aaDone: { via: 'okta_api', at: now }, jamieDone: state.jamieDone ?? { via: 'project', at: now } });
      await kv.put(key, state, now);
      await notion?.appendCandidateNote?.({ pageId: who.pageId, text: `${laDate(now)} · Uncle Sam ${r.reason === 'created' ? 'created' : 'found'} the Okta account ${address} on Project's instruction.` }).catch(() => null);
      await reply('Roger that 🫡'); // Project, 2026-10-18: done is just Roger that
      return { kind: 'okta_command', reason: r.reason };
    }
    if (r.reason === 'mismatch') { await reply(`🚨 ${address} is already in Okta for ${r.user?.firstName ?? ''} ${r.user?.lastName ?? ''}, not ${name}. I didn't touch it.`); return { kind: 'okta_command', reason: 'mismatch' }; }
    if (r.reason === 'uncertain') { await reply(`🚨 Setting up ${name}'s Okta gave an unclear answer (${r.code}). Check Okta for ${address}; I won't try again.`); return { kind: 'okta_command', reason: 'uncertain' }; }
    await reply(`📋 Okta refused it (${r.code}${r.why ? `: ${r.why}` : ''}). Asking AA instead.`);
  }
  const when = start ? `reports for a work trial ${startPhrase(start, now)}` : 'starts a work trial soon';
  const text = `🔐 AA: ${name} ${when}. ${address ? `Their Company email is ${address}` : 'Their Company email is set up'}${slackUser ? ` and they're in Slack as <@${slackUser}>` : ''}. Set up Okta. Reply here when it's done.`;
  state.aa = { claimedAt: now, byMason: true };
  await kv.put(key, state, now);
  let ts;
  try { ts = await masonPoster({ env, fetchImpl, channelId: aaChannel })(text); }
  catch (error) { state.aa = { ...state.aa, failed: error?.code ?? 'failed' }; await kv.put(key, state, now); await reply(`🚨 I couldn't post to AA (${state.aa.failed}). Ask AA by hand.`); return { kind: 'okta_command', reason: 'post_failed' }; }
  Object.assign(state, { aa: { ...state.aa, ts, channelId: aaChannel, sentAt: now, withAddress: !!address }, ...(address ? { address } : {}), ...(slackUser ? { slackUser } : {}),
    jamieDone: state.jamieDone ?? { via: 'project', at: now } });
  await kv.put(key, state, now);
  await kv.put(`onboarding:thread:${aaChannel}:${ts}`, { pageId: who.pageId, who: 'aa' }, now);
  await notion?.appendCandidateNote?.({ pageId: who.pageId, text: `${laDate(now)} · Uncle Sam asked AA to set up Okta on Project's instruction${address ? ` (${address})` : ''}.` }).catch(() => null);
  await reply('Roger that 🫡'); // Project, 2026-10-18: done is just Roger that
  return { kind: 'okta_command', reason: 'asked', ts };
}

/**
 * Corrects a request Uncle Sam already posted to AA (Project, 2026-10-18, after AA was told Rowan Blake was in Slack as @Claude:
 * "edit the message and correct it right now ... If you can't edit it, you can delete it and resend"). An onboarding record with
 * aa.repairText gets its AA message edited to that text, once; if the edit fails, the old one is deleted and the corrected one
 * posted in its place. Project isn't told unless both fail.
 */
export async function repairAaMessages({ env, db, fetchImpl = globalThis.fetch, clock = Date.now, update, remove, post, tell = null }) {
  if (!db?.prepare) return { repaired: 0 };
  const kv = noticeStore(db), now = clock();
  let repaired = 0;
  for (const key of await kv.names('onboarding:')) {
    if (key.startsWith('onboarding:thread:')) continue;
    const state = await kv.get(key).catch(() => null);
    const text = state?.aa?.repairText, ts = state?.aa?.ts, channel = state?.aa?.channelId;
    if (!text || !ts || !channel || state.aa.repairedAt) continue;
    if (!(await kv.claim(`aa-repair:${channel}:${ts}`, { at: now }, now))) continue;
    let newTs = ts, how = 'edited';
    try { await update({ channel, ts, text }); }
    catch {
      try { await remove({ channel, ts }).catch(() => null); newTs = await post({ channel, text }); how = 'reposted'; }
      catch (error) { how = `failed:${error?.code ?? 'failed'}`; }
    }
    const { repairText, ...aa } = state.aa;
    void repairText;
    await kv.put(key, { ...state, aa: { ...aa, ts: newTs, repairedAt: now, repairedHow: how } }, now);
    if (newTs !== ts) await kv.put(`onboarding:thread:${channel}:${newTs}`, { pageId: key.slice('onboarding:'.length), who: 'aa' }, now);
    if (how.startsWith('failed') && tell) await tell(`🚨 I couldn't correct my Okta request to AA (${how.slice(7)}). Tell AA by hand.`).catch(() => {});
    repaired++;
  }
  return { repaired };
}
