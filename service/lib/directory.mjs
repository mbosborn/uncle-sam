/**
 * Company's Google Workspace directory, read-only (Project, 2026-10-16): whether a work-trial hire's @company.example account
 * exists yet, so AA can be asked for Okta the moment Jamie has created it, without waiting for her reply or for the hire to
 * join Slack. Uses Project's Google grant with the directory.readonly scope (People API searchDirectoryPeople); it reads
 * names and email addresses only, never changes anything. Needs the People API enabled on the OAuth client's Google Cloud
 * project; when it is not, Project is told once with Google's own activation link.
 */
import { googleTokenProvider, directoryGranted } from './gmail.mjs';
import { noticeStore } from './stuck-rejections.mjs';
import { bannerName } from './work-trial.mjs';

const API = 'https://people.googleapis.com/v1/people:searchDirectoryPeople';
const norm = text => String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();

export class DirectoryError extends Error {
  constructor(code, extra = {}) { super(code); this.name = 'DirectoryError'; this.code = code; Object.assign(this, extra); }
}

/** The @company.example addresses of directory people whose name carries every part of `fullName`. */
export function matchingAccounts(people, fullName) {
  const want = norm(bannerName(fullName)).split(' ').filter(Boolean);
  if (want.length < 2) return [];
  const out = [];
  for (const person of people ?? []) {
    const names = (person.names ?? []).map(n => norm(`${n.displayName ?? ''} ${n.givenName ?? ''} ${n.familyName ?? ''}`)).join(' ');
    const words = new Set(names.split(' ').filter(Boolean));
    if (!want.every(w => words.has(w))) continue;
    for (const e of person.emailAddresses ?? []) {
      const address = String(e.value ?? '').toLowerCase();
      if (/^[a-z0-9._%+-]+@company\.example$/.test(address)) out.push(address);
    }
  }
  return [...new Set(out)];
}

/**
 * A finder for onboarding.mjs: fullName -> the candidate's Company addresses in the directory ([] when none yet), or null
 * when the directory cannot be read (not granted, API off); Uncle Sam then waits for Jamie's reply or Slack as before.
 */
export function createDirectoryFinder({ env, db, fetchImpl = globalThis.fetch, clock = Date.now, poster = null, log = () => {} }) {
  const token = googleTokenProvider({ env, db, fetchImpl, clock });
  return async fullName => {
    if (!(await directoryGranted({ db }).catch(() => false))) return null;
    const name = bannerName(fullName);
    if (!name) return [];
    const queries = [name, name.split(' ').slice(-1)[0]].filter((q, i, a) => q && a.indexOf(q) === i);
    const people = [];
    for (const query of queries) {
      const url = new URL(API);
      url.searchParams.set('query', query);
      url.searchParams.set('readMask', 'names,emailAddresses');
      url.searchParams.set('sources', 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE');
      url.searchParams.set('pageSize', '25');
      let response;
      try { response = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${await token()}`, accept: 'application/json' }, redirect: 'error' }); }
      catch (error) { log(`uncle_sam_directory error=${error?.code ?? 'network'}`); return null; }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const reason = body?.error?.details?.find?.(d => d?.reason)?.reason ?? body?.error?.status ?? `http_${response.status}`;
        log(`uncle_sam_directory error=${String(reason).slice(0, 60)}`);
        if (reason === 'SERVICE_DISABLED' && poster && db?.prepare) {
          const kv = noticeStore(db);
          if (await kv.claim('directory:disabled-notice', { at: clock() }, clock())) {
            const link = body?.error?.details?.find?.(d => d?.metadata?.activationUrl)?.metadata?.activationUrl ?? 'https://console.cloud.google.com/apis/library/people.googleapis.com';
            await poster(`📯 One switch left so I can see new Company accounts the moment Jamie creates them: turn on the People API for my Google project here: <${link}|Enable People API>. Nothing else changes.`).catch(() => {});
          }
        }
        return null;
      }
      people.push(...(body?.people ?? []));
    }
    const matched = matchingAccounts(people, fullName);
    log(`uncle_sam_directory people=${people.length} withEmail=${people.filter(p => (p.emailAddresses ?? []).length).length} matched=${matched.length}`);
    return matched;
  };
}

/**
 * Every 10 minutes until it works: a directory search proves the grant and the API (health shows the result). Never throws.
 */
export async function probeDirectory({ env, db, fetchImpl = globalThis.fetch, clock = Date.now, poster = null, log = () => {} }) {
  try {
    if (!db?.prepare) return { state: 'off' };
    const kv = noticeStore(db), now = clock();
    const last = await kv.get('directory:probe');
    if (last?.ok) return { state: 'ok' };
    const granted = await directoryGranted({ db }).catch(() => false);
    if (!granted) { if (last?.reason !== 'not_granted') await kv.put('directory:probe', { ok: false, reason: 'not_granted', at: now }, now); return { state: 'not_granted' }; }
    // Just granted: check at once; otherwise once an hour until it works.
    if (last?.reason !== 'not_granted' && last?.at && now - last.at < 10 * 60_000) return { state: 'not_due' };
    const found = await createDirectoryFinder({ env, db, fetchImpl, clock, poster, log })('Alexis Bailey');
    // A teammate's account must come back (Google leaves the signed-in person, Project, out of his own searches).
    const ok = Array.isArray(found) && found.some(a => a.endsWith('@company.example'));
    await kv.put('directory:probe', { ok, reason: ok ? null : Array.isArray(found) ? 'not_found' : 'unreadable', at: now }, now);
    log(`uncle_sam_directory probe=${ok ? 'ok' : 'failed'}`);
    return { state: ok ? 'ok' : 'failed' };
  } catch (error) { return { state: 'error', error: error?.code ?? 'probe_failed' }; }
}

/** Who in Company's directory has this exact address (a primary address or an alias it lists): [{ name }], or null when unreadable. */
export function createAddressOwners({ env, db, fetchImpl = globalThis.fetch, clock = Date.now }) {
  const token = googleTokenProvider({ env, db, fetchImpl, clock });
  return async address => {
    if (!(await directoryGranted({ db }).catch(() => false))) return null;
    const url = new URL(API);
    url.searchParams.set('query', address);
    url.searchParams.set('readMask', 'names,emailAddresses');
    url.searchParams.set('sources', 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE');
    url.searchParams.set('pageSize', '25');
    let response;
    try { response = await fetchImpl(url.toString(), { headers: { authorization: `Bearer ${await token()}`, accept: 'application/json' }, redirect: 'error' }); } catch { return null; }
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return (body?.people ?? []).filter(p => (p.emailAddresses ?? []).some(e => String(e.value ?? '').toLowerCase() === address))
      .map(p => ({ name: p.names?.[0]?.displayName ?? null }));
  };
}
