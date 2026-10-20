/**
 * A new hire's Company address is never one someone already has or had (Project, 2026-10-16: "always make sure, whenever new
 * emails are being created, that previous ones haven't been created. If so, make a workaround, like .lastname. That should be
 * a very strict thing").
 *
 * Before any @company.example address is proposed, created or passed to AA, every option is checked against:
 *  1. Google Workspace: a user or alias with that address (Admin SDK, when the grant has it) and Company's directory (People API);
 *  2. every address Uncle Sam has ever proposed, created or recorded for another person (kv `company-address:<address>`, kept
 *     forever, and every onboarding record);
 *  3. Slack, deleted members included: a member whose handle is that local part, or whose profile email is that address;
 *  4. Project's mail: any message to or from that address.
 * Options, in order: first@, first.last@, firstl@ (last initial), firstlast@, first.last2@. The first option with nothing
 * against it wins; if any source could not be read for an option, that option is not called free.
 * An address received from someone (Jamie, Project, a reply) that belongs to a different person is refused and Project is told.
 */
import { bannerName } from './work-trial.mjs';
import { noticeStore } from './stuck-rejections.mjs';

export const DOMAIN = 'company.example';
const ascii = text => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/['-]/g, '').replace(/\s+/g, ' ').trim();
const norm = text => ascii(text).split(' ').filter(Boolean);

/** Addresses to try, in order. */
export function addressOptions(fullName) {
  const parts = norm(bannerName(fullName));
  if (parts.length < 2) return [];
  const first = parts[0], last = parts[parts.length - 1];
  return [...new Set([`${first}@${DOMAIN}`, `${first}.${last}@${DOMAIN}`, `${first}${last[0]}@${DOMAIN}`, `${first}${last}@${DOMAIN}`, `${first}.${last}2@${DOMAIN}`])];
}

/** Whether a name ("Aarlen Archer") is this hire ("Arlen Archer"): every part of the hire's name, spelled the same. */
export const sameName = (a, b) => { const want = norm(bannerName(b)); const have = new Set(norm(a)); return want.length >= 2 && want.every(w => have.has(w)); };

/**
 * checks: { admin?: { exists(address) }, directoryOwners?: address -> [{ name }] | null, slackMembers?: () -> [{ id, name, realName, email, deleted }],
 *           mail?: address -> count | null }
 * -> { taken: true, by } | { taken: false } | { taken: null, why } (a source could not be read).
 */
export async function addressTaken({ address, pageId = null, db, checks = {}, forName = null }) {
  // forName: checking an address already made for this hire; Google or Slack entries in their own name are theirs.
  const theirs = n => !!forName && sameName(n, forName);
  const kv = db?.prepare ? noticeStore(db) : null;
  const local = address.split('@')[0];
  // 2. Uncle Sam's own history: reserved or recorded for someone else (namesakes included: the page decides, not the name).
  if (kv) {
    const held = await kv.get(`company-address:${address}`);
    if (held?.pageId && held.pageId !== pageId) return { taken: true, by: `${held.name ?? 'another hire'} (on record since ${new Date(held.at).toISOString().slice(0, 10)})` };
    for (const name of await kv.names('onboarding:')) {
      if (name.startsWith('onboarding:thread:') || name === `onboarding:${pageId}`) continue;
      const state = await kv.get(name).catch(() => null);
      if (state?.address === address) return { taken: true, by: `${state.name ?? 'another hire'} (an earlier work trial)` };
    }
  }
  let unknown = null;
  // 1. Google.
  if (checks.admin?.exists) {
    try { if (await checks.admin.exists(address)) return { taken: true, by: 'an existing Google Workspace user or alias' }; }
    catch { unknown = 'Google admin lookup failed'; }
  }
  if (checks.directoryOwners) {
    const owners = await checks.directoryOwners(address).catch(() => null);
    if (owners === null) unknown ??= "Company's directory could not be read";
    else if (owners.filter(o => !theirs(o.name)).length) return { taken: true, by: owners.filter(o => !theirs(o.name)).map(o => o.name).filter(Boolean).join(', ') || 'someone in the directory' };
  } else if (!checks.admin?.exists) unknown ??= 'no way to read Google Workspace';
  // 3. Slack, deleted members too.
  if (checks.slackMembers) {
    const members = await checks.slackMembers().catch(() => null);
    if (members === null) unknown ??= 'Slack members could not be read';
    else {
      // An address already made for this hire (forName): a Slack account signed up with that very address is their own (Rowan
      // Blake, Oct 18: his Slack shows as "rowanb", not his name).
      const own = m => !!forName && !!m.email && m.email.toLowerCase() === address;
      const hit = members.find(m => !theirs(`${m.realName ?? ''}`) && !own(m) && ((m.email && m.email.toLowerCase() === address) || (m.name && m.name.toLowerCase() === local)));
      if (hit) return { taken: true, by: `Slack member ${hit.realName || hit.name}${hit.deleted ? ' (deactivated)' : ''}` };
    }
  }
  // 4. Project's mail (not for an address already made for them: the welcome mail goes there).
  if (checks.mail && !forName) {
    const n = await checks.mail(address).catch(() => null);
    if (n === null) unknown ??= "your mail couldn't be searched";
    else if (n > 0) return { taken: true, by: `someone you've emailed (${n} sent message${n === 1 ? '' : 's'} to it)` };
  }
  return unknown ? { taken: null, why: unknown } : { taken: false };
}

/** The first free option. -> { address, skipped: [{ address, by }] } or { address: null, skipped, unknown } */
export async function pickCompanyAddress({ fullName, pageId, db, checks = {} }) {
  const skipped = [];
  if (checks.slackMembers) { const once = checks.slackMembers().catch(() => null); checks = { ...checks, slackMembers: () => once }; }
  for (const address of addressOptions(fullName)) {
    const r = await addressTaken({ address, pageId, db, checks });
    if (r.taken === false) return { address, skipped };
    if (r.taken === null) return { address: null, skipped, unknown: r.why, next: address };
    skipped.push({ address, by: r.by });
  }
  return { address: null, skipped };
}

/** Holds an address for this hire for good, so no one else is ever given it. False if it is someone else's. */
export async function reserveAddress({ db, address, pageId, name, clock = Date.now }) {
  const kv = noticeStore(db), now = clock(), key = `company-address:${address}`;
  if (await kv.claim(key, { pageId, name, at: now }, now)) return true;
  return (await kv.get(key))?.pageId === pageId;
}

/** "skipped arlen@ (Aarlen Archer)" for messages. */
export const skippedText = skipped => (skipped.length ? ` (${skipped.map(s => `${s.address} is taken: ${s.by}`).join('; ')})` : '');
