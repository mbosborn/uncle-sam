/**
 * Offboarding after a work trial (Project, 2026-10-17: "24 hours after a work trial their email and slack should be suspended,
 * the okta gets suspended automatically as well").
 *
 *  - No heads-up (Project, 2026-10-18: "i don't need a heads up i know it deletes it noon the next day unless i say otherwise").
 *    "keep Elliot's account" in his DM holds it (restore-account.mjs); "keep" under an old heads-up still does too.
 *  - The next day from noon Pacific (24 hours after the trial's last day): the hire's Company Google account is DELETED (Project,
 *    2026-10-18: "delete right away"; Google can restore it for about 20 days; UNCLE_SAM_OFFBOARD_DELETE=off suspends instead).
 *    Okta follows Google on its own. Project gets one line, with the
 *    Slack deactivation link: Slack's Pro plan has no API to deactivate members, so that one tap is his.
 *  - Never for someone Hired, at Extended Offer, held by Project, or whose Trial End moved later. Only an account Uncle Sam can
 *    tie to that person for certain: the address Uncle Sam created or recorded for them, or the single Google user with exactly
 *    their name; never an admin or a staff address. Trials that ended more than 3 days ago are left alone (no backlog sweeps).
 * Google not answering (e.g. admin access refused) is retried every run; Project hears once if it still fails 6 hours after it
 * was due. The delete itself is one attempt, never retried; an unclear answer stops it and Project is told. Every 30 minutes, Live only.
 * UNCLE_SAM_OFFBOARDING=off stops it.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { bannerName } from './work-trial.mjs';
import { sameName } from './company-address.mjs';
import { oktaReady } from './okta.mjs';
import { offboardInsightful } from './insightful.mjs';

export const EVERY_MS = 30 * 60_000;
const STUCK_MS = 6 * 3600_000;
const STAFF_LOCAL = /^(?:project|jamie|robin|alexis|rory|aa|quinn|interviewer|manager|taylor|parker|shawn|andy|teo|reese|jules|phoenix|val|hr|admin|team|hello|info|recruiting|careers|ops|uncle-?sam)$/i;
const HOLD = /\b(keep|hold|stop|wait|don'?t|do not|cancel|no)\b/i;
const pt = (ms, o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...o }).format(ms);
const laDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const dayLabel = date => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(Date.parse(`${date}T12:00:00Z`));
const hourPt = ms => Number(pt(ms, { hour: 'numeric', hourCycle: 'h23' }));

/** The Company account that is certainly this person's, or { address: null, why }. */
export async function accountOf({ db, admin, candidate }) {
  const kv = noticeStore(db);
  const name = bannerName(candidate.fullName);
  let address = (await kv.get(`onboarding:${candidate.pageId}`))?.address ?? null;
  if (!address) {
    for (const key of await kv.names('company-address:')) {
      if ((await kv.get(key))?.pageId === candidate.pageId) { address = key.slice('company-address:'.length); break; }
    }
  }
  if (!address) {
    const found = (await admin.findByName(name)).filter(u => sameName(u.name, name) && !u.isAdmin);
    if (found.length !== 1) return { address: null, why: found.length ? `${found.length} Google accounts carry the name ${name}` : `no Google account carries the name ${name}` };
    address = found[0].primaryEmail;
  }
  if (!/@company\.example$/i.test(address) || STAFF_LOCAL.test(address.split('@')[0])) return { address: null, why: `${address} is not a work-trial address` };
  const user = await admin.get(address);
  if (!user) return { address: null, why: `${address} doesn't exist in Google` };
  if (user.isAdmin) return { address: null, why: `${address} is an admin account` };
  if (!sameName(user.name, name)) return { address: null, why: `${address} belongs to ${user.name}, not ${name}` };
  return { address: user.primaryEmail, suspended: user.suspended };
}

export const offboardDeletes = env => env?.UNCLE_SAM_OFFBOARD_DELETE !== 'off';

export async function runOffboarding({ env = {}, db, notion, admin, poster, masonChannel = null, clock = Date.now, force = false, log = () => {}, okta = null, insightful = null }) {
  const summary = { state: 'off', told: 0, suspended: 0, skipped: [], error: null };
  const del = offboardDeletes(env) && typeof admin?.remove === 'function';
  const verb = del ? 'delete' : 'suspend';
  try {
    if (env.UNCLE_SAM_OFFBOARDING === 'off' || !db?.prepare || !admin?.suspend || typeof notion?.listTrialsEnded !== 'function' || typeof poster !== 'function') return summary;
    const kv = noticeStore(db), now = clock();
    if (!force && now - ((await kv.get('offboard:last'))?.at ?? 0) < EVERY_MS) return { ...summary, state: 'not_due' };
    if ((await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    await kv.put('offboard:last', { at: now }, now);
    summary.state = 'ran';
    const today = laDate(now), noon = hourPt(now) >= 12;
    const skip = (c, why) => summary.skipped.push(`${c.fullName}: ${why}`);
    for (const c of await notion.listTrialsEnded({ from: addDays(today, -3), to: today })) {
      const f = c.fields ?? {}, end = String(f['Trial End'] ?? '').slice(0, 10), name = bannerName(c.fullName);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) continue;
      if (f.Outcome === 'Hired' || f.Stage === 'Extended Offer') { skip(c, 'hired or offered'); continue; }
      const key = `offboard:${c.pageId}`;
      const state = (await kv.get(key)) ?? {};
      if (state.held || state.done) continue;
      // A Google error is not final: try again next run (an earlier version halted on it; Elliot, Oct 18).
      if (state.halted && !/^Google didn't answer/.test(state.halted)) continue;
      // No heads-up (Project, 2026-10-18: "i don't need a heads up i know it deletes it noon the next day unless i say otherwise").
      // 24 hours after the trial's last day, from noon Pacific the next day.
      const due = addDays(end, 1);
      if (today < due || (today === due && !noon)) continue;
      let acct;
      try { acct = await accountOf({ db, admin, candidate: c }); }
      catch (error) {
        const since = state.googleFailSince ?? now;
        await kv.put(key, { ...state, halted: undefined, googleFailSince: since, googleError: error?.code ?? 'error' }, now);
        summary.skipped.push(`${c.fullName}: Google didn't answer (${error?.code ?? 'error'})`);
        if (now - since >= STUCK_MS && await kv.claim(`offboard:stuck:${c.pageId}:${end}`, { at: now }, now)) {
          await poster(`🚨 I still can't ${verb} ${name}'s Company account: Google refuses my admin access (${error?.code ?? 'error'}). I keep trying every 30 minutes; ${del ? 'delete' : 'suspend'} it in the Google admin console if you want it done now.`).catch(() => {});
        }
        continue;
      }
      if (!acct.address) {
        if (await kv.claim(`offboard:noaccount:${c.pageId}:${end}`, { at: now }, now)) {
          await kv.put(key, { ...state, halted: acct.why }, now);
          await poster(`🪖 ${name}'s work trial ended ${dayLabel(end)}, but I can't ${verb} their Company account: ${acct.why}. ${del ? 'Delete' : 'Suspend'} it in the Google admin console and deactivate them in Slack.`).catch(() => {});
          await notion.appendCandidateNote?.({ pageId: c.pageId, text: `${today} · Work trial ended ${end}. Account not ${del ? 'deleted' : 'suspended'} by Uncle Sam: ${acct.why}.` })?.catch?.(() => null);
        }
        continue;
      }
      state.address = acct.address;
      if (!(await kv.claim(`offboard:suspend:${c.pageId}`, { at: now, address: state.address }, now))) continue;
      try {
        if (del) {
          const gone = await admin.remove(state.address);
          // Remembered so "restore <name>'s account" finds it by Google's id (restore-account.mjs).
          await kv.put(`deleted-account:${state.address.toLowerCase()}`, { id: gone?.id ?? null, pageId: c.pageId, name, at: now }, now);
        }
        else if (!acct.suspended) await admin.suspend(state.address);
        await kv.put(key, { ...state, done: now }, now);
        summary.suspended++;
        // Okta too, when Uncle Sam has the key (okta.mjs): only an active account with this exact login; anything odd is left to Okta's own sync.
        if (okta && await oktaReady({ env, db }).catch(() => false)) {
          try { const u = await okta.findUser(state.address); if (u?.status === 'ACTIVE' && String(u.login ?? '').toLowerCase() === state.address.toLowerCase()) { await okta.suspend(u.id); summary.oktaSuspended = (summary.oktaSuspended ?? 0) + 1; } }
          catch { /* Okta follows Google on its own */ }
        }
        // Insightful ends with Okta (insightful.mjs; Project, 2026-10-20).
        if (insightful) { const ins = await offboardInsightful({ env, db, ins: insightful, address: state.address, pageId: c.pageId }); if (ins.deactivated) summary.insightfulOff = (summary.insightfulOff ?? 0) + 1; }
        await notion.appendCandidateNote?.({ pageId: c.pageId, text: `${today} · Uncle Sam ${del ? 'deleted' : 'suspended'} the Company Google account ${state.address} (24 hours after the work trial ended ${end}; Okta follows). ${del ? 'Restorable in the Google admin console for about 20 days.' : 'Reversible in the Google admin console.'}` })?.catch?.(() => null);
        // Only what matters (Project, 2026-10-18): what was done and the one tap that is his.
        await poster(`🫡 ${del ? 'Deleted' : 'Suspended'} ${name}'s Company account. Deactivate them in Slack: <https://example-workspace.slack.com/admin|Manage members>.`).catch(() => {});
      } catch (error) {
        await kv.put(key, { ...state, halted: error?.code ?? 'failed' }, now);
        await poster(error?.uncertain
          ? `🚨 ${del ? 'Deleting' : 'Suspending'} ${state.address} for ${name} gave an unclear answer (${error.code}). Check it in the Google admin console; I won't try again.`
          : `🚨 I couldn't ${verb} ${state.address} for ${name} (${error?.code ?? 'failed'}). ${del ? 'Delete' : 'Suspend'} it in the Google admin console.`).catch(() => {});
      }
    }
    return summary;
  } catch (error) {
    summary.error = typeof error?.code === 'string' ? error.code : 'offboarding_failed';
    log(`uncle_sam_offboarding ${JSON.stringify(summary)}`);
    return summary;
  }
}

/** Project's "keep" under the heads-up holds the suspension. Null when it isn't a reply to one. */
export async function handleOffboardReply({ event, db, poster, masonId, clock = Date.now, sideEffects = [] }) {
  if (!db?.prepare || event.authorId !== masonId || !event.threadTs || event.threadTs === event.messageTs) return null;
  const kv = noticeStore(db), ask = await kv.get(`offboard-ask:${event.channelId}:${event.threadTs}`);
  if (!ask?.pageId) return null;
  if (!HOLD.test(String(event.text ?? ''))) return null;
  const key = `offboard:${ask.pageId}`, state = (await kv.get(key)) ?? {};
  if (state.done) { await poster(event.threadTs)(`📋 Already done. If they're staying, tell me "restore ${ask.name}'s account" and I'll bring it back (works for about 20 days after a delete).`).catch(() => {}); return { kind: 'offboard_too_late', reason: null }; }
  await kv.put(key, { ...state, held: { at: clock(), by: 'Project' } }, clock());
  sideEffects.push('offboard_held');
  await poster(event.threadTs)(`Roger that 🫡 ${ask.name}'s account stays on.`).catch(() => {});
  return { kind: 'offboard_held', reason: null };
}
