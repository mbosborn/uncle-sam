/**
 * Okta, done by Uncle Sam itself (Project, 2026-10-18: "i don't have the api key for okta and i won't get it until monday but
 * build out everything for the okta set up and then monday i will get the api key").
 *
 * Switched on by two settings: OKTA_DOMAIN (example.okta.com) and OKTA_API_TOKEN (an Okta API token, "SSWS"; secret, never shown).
 * UNCLE_SAM_OKTA=off switches it off again; until both are set, AA is asked exactly as before.
 *
 *  - Check: on the first tick with a key, Uncle Sam reads who the token belongs to and the org's groups, and tells Project once:
 *    connected as whom, and which groups new hires will be put in. Project picks them in his DM: "okta groups: Engineering,
 *    Contractors" (names matched to the org's groups; OKTA_GROUP_IDS works too). Nothing is created before the check passes.
 *  - A work-trial hire, once their Company email exists (onboarding.mjs): their Okta user, login = email = the Company address,
 *    first and last name from the tracker, put in the chosen groups and activated (Okta emails the activation link to their
 *    Company inbox). Someone already in Okta with that login (imported from Google, made by AA) is never made twice: they are
 *    put in the groups if missing. A login that belongs to someone with another name stops it, and Project is told.
 *    Claimed before the call; an unclear answer is never retried, Project is told; a clear refusal falls back to asking AA.
 *  - Offboarding (offboarding.mjs): after the Google account is suspended, the Okta user is suspended too if it is still active.
 *  - "set up X's Okta" / "ask AA to set up X's Okta" in Project's DM: done by Uncle Sam when Okta is on, else AA is asked.
 */
import { noticeStore } from './stuck-rejections.mjs';

const DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.(?:okta|oktapreview|okta-emea|okta-gov)\.com$/i;
export const oktaConfigured = env => env?.UNCLE_SAM_OKTA !== 'off' && DOMAIN.test(String(env?.OKTA_DOMAIN ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''))
  && typeof env?.OKTA_API_TOKEN === 'string' && env.OKTA_API_TOKEN.trim().length >= 20;
const domainOf = env => String(env.OKTA_DOMAIN).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
const clean = (t, max = 120) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };

export function createOktaClient({ env, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!oktaConfigured(env)) fail('okta_not_configured');
  const base = `https://${domainOf(env)}/api/v1`;
  const call = async (path, { method = 'GET', body = null, uncertainOnFailure = false } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `SSWS ${env.OKTA_API_TOKEN.trim()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { fail('okta_network', { uncertain: uncertainOnFailure }); }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.status === 404) return { status: 404, data: null };
    if (response.status === 429) fail('okta_rate_limited', { uncertain: uncertainOnFailure && method !== 'GET' });
    if (response.status >= 500) fail(`okta_http_${response.status}`, { uncertain: uncertainOnFailure });
    if (response.status >= 400) fail(`okta_http_${response.status}`, { reason: clean(data?.errorSummary ?? (data?.errorCauses ?? []).map(c => c?.errorSummary).join('; '), 200) });
    return { status: response.status, data };
  };
  const userOf = u => (u ? { id: u.id, status: u.status, login: String(u.profile?.login ?? '').toLowerCase(), email: String(u.profile?.email ?? '').toLowerCase(),
    firstName: u.profile?.firstName ?? '', lastName: u.profile?.lastName ?? '' } : null);
  return Object.freeze({
    domain: domainOf(env),
    /** Who the token belongs to: { login, name }. */
    async whoami() { const { data } = await call('/users/me'); return { login: String(data?.profile?.login ?? ''), name: clean(`${data?.profile?.firstName ?? ''} ${data?.profile?.lastName ?? ''}`) }; },
    async findUser(login) { const { status, data } = await call(`/users/${encodeURIComponent(login)}`); return status === 404 ? null : userOf(data); },
    async groups(q = '') { const { data } = await call(`/groups?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`); return (Array.isArray(data) ? data : []).map(g => ({ id: g.id, name: clean(g.profile?.name, 120), type: g.type ?? null })); },
    async userGroups(userId) { const { data } = await call(`/users/${encodeURIComponent(userId)}/groups`); return (Array.isArray(data) ? data : []).map(g => g.id); },
    /** Creates and activates one user (Okta emails the activation link to `email`). */
    async createUser({ firstName, lastName, login, email, secondEmail = null, groupIds = [] }) {
      const { data } = await call('/users?activate=true', { method: 'POST', uncertainOnFailure: true,
        body: { profile: { firstName, lastName, login, email, ...(secondEmail ? { secondEmail } : {}) }, ...(groupIds.length ? { groupIds } : {}) } });
      return userOf(data);
    },
    async addToGroup(userId, groupId) { await call(`/groups/${encodeURIComponent(groupId)}/users/${encodeURIComponent(userId)}`, { method: 'PUT' }); },
    async activate(userId) { await call(`/users/${encodeURIComponent(userId)}/lifecycle/activate?sendEmail=true`, { method: 'POST', uncertainOnFailure: true }); },
    async suspend(userId) { await call(`/users/${encodeURIComponent(userId)}/lifecycle/suspend`, { method: 'POST', uncertainOnFailure: true }); },
    async unsuspend(userId) { await call(`/users/${encodeURIComponent(userId)}/lifecycle/unsuspend`, { method: 'POST', uncertainOnFailure: true }); },
  });
}

/** The groups new hires go in: Project's pick (kv), else OKTA_GROUP_IDS. -> [{ id, name }] */
export async function hireGroups({ env = {}, db }) {
  const picked = db?.prepare ? (await noticeStore(db).get('okta:groups'))?.groups : null;
  if (Array.isArray(picked)) return picked;
  if (String(env.OKTA_GROUP_IDS ?? '').trim().toLowerCase() === 'none') return [];
  return String(env.OKTA_GROUP_IDS ?? '').split(',').map(s => s.trim()).filter(id => /^[A-Za-z0-9]{10,40}$/.test(id)).map(id => ({ id, name: id }));
}

/** Whether the connection check has passed. */
export async function oktaConnected({ env, db }) {
  if (!oktaConfigured(env) || !db?.prepare) return false;
  return !!(await noticeStore(db).get('okta:probe'))?.ok;
}

/** Connected and Project has said which groups hires go in (OKTA_GROUP_IDS=none means Everyone only). Nothing is created before. */
export async function oktaReady({ env, db }) {
  if (!(await oktaConnected({ env, db }))) return false;
  return String(env?.OKTA_GROUP_IDS ?? '').trim().toLowerCase() === 'none' || (await hireGroups({ env, db })).length > 0;
}

/**
 * The connection check, once per key: who the token is, the org's groups; Project is told once. Every 30 minutes until it passes.
 */
export async function probeOkta({ env, db, fetchImpl = globalThis.fetch, poster = null, clock = Date.now }) {
  if (!oktaConfigured(env) || !db?.prepare) return { state: 'not_configured' };
  const kv = noticeStore(db), now = clock(), last = await kv.get('okta:probe');
  const keyHint = `${domainOf(env)}:${env.OKTA_API_TOKEN.trim().length}:${env.OKTA_API_TOKEN.trim().slice(-4)}`;
  // An Okta API token expires after 30 days unused: one cheap call a day keeps it alive (and notices a revoked key).
  if (last?.ok && last.key === keyHint) {
    if (now - (last.aliveAt ?? last.at) < 20 * 3600_000) return { state: 'ok' };
    try { await createOktaClient({ env, fetchImpl }).whoami(); await kv.put('okta:probe', { ...last, aliveAt: now }, now); return { state: 'ok' }; }
    catch (error) {
      if (!['okta_http_401', 'okta_http_403'].includes(error?.code)) return { state: 'ok' };
      await kv.put('okta:probe', { ok: false, key: keyHint, error: error.code, at: now, failedTold: keyHint }, now);
      if (poster) await poster(`🚨 The Okta key stopped working (${error.code}). Make a new one and double-click "Save Okta key". AA gets the Okta asks meanwhile.`).catch(() => {});
      return { state: 'failed', error: error.code };
    }
  }
  if (last && last.key === keyHint && now - last.at < 30 * 60_000) return { state: 'not_due' };
  let who = null, groups = [];
  try {
    const okta = createOktaClient({ env, fetchImpl });
    who = await okta.whoami();
    groups = await okta.groups();
  } catch (error) {
    const told = last?.failedTold === keyHint;
    await kv.put('okta:probe', { ok: false, key: keyHint, error: error?.code ?? 'failed', at: now, failedTold: keyHint }, now);
    if (!told && poster) await poster(`🚨 The Okta key doesn't work yet (${error?.code ?? 'failed'}${error?.reason ? `: ${error.reason}` : ''}). Check that it's an API token from ${domainOf(env)} made by a user who can manage users and groups. AA keeps getting the Okta asks meanwhile.`).catch(() => {});
    return { state: 'failed', error: error?.code ?? 'failed' };
  }
  await kv.put('okta:probe', { ok: true, key: keyHint, who: who.login, at: now }, now);
  const chosen = await hireGroups({ env, db });
  const names = groups.filter(g => g.type !== 'BUILT_IN' || /everyone/i.test(g.name)).map(g => g.name).slice(0, 25);
  const noGroups = String(env.OKTA_GROUP_IDS ?? '').trim().toLowerCase() === 'none';
  if (poster) await poster(chosen.length || noGroups
    ? `🔐 Okta is connected (${domainOf(env)}, acting as ${who.login}). From now on I set up work-trial hires in Okta myself once their Company email exists; AA isn't asked anymore. New hires go in: ${noGroups ? 'Everyone only' : chosen.map(g => g.name).join(', ')}.`
    : `🔐 Okta is connected (${domainOf(env)}, acting as ${who.login}). Which groups should new hires go in? Reply here "okta groups: <names>". Groups: ${names.join(', ') || 'none found'}. Once you pick, I set hires up in Okta myself; until then AA keeps getting the asks.`).catch(() => {});
  return { state: 'ok', who: who.login, groups: groups.length };
}

const nameWords = n => String(n ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter(w => w.length > 1);
const sameName = (a, b) => { const x = nameWords(a), y = new Set(nameWords(b)); return x.length > 0 && x.some(w => y.has(w)); };

/**
 * One hire's Okta account. who: { pageId, fullName, address (the Company email), personalEmail }. names: { givenName, familyName }.
 * -> { reason: 'created' | 'existing' | 'mismatch' | 'uncertain' | 'refused' | 'not_ready', user?, code? }
 */
export async function setUpOkta({ env, db, okta, who, names, clock = Date.now }) {
  if (!okta || !(await oktaReady({ env, db }))) return { reason: 'not_ready' };
  const login = String(who.address ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@company\.example$/.test(login)) return { reason: 'refused', code: 'no_company_address' };
  const kv = noticeStore(db), now = clock(), key = `okta:user:${login}`;
  const groups = (await hireGroups({ env, db })).map(g => g.id);
  const existing = await okta.findUser(login);
  if (existing) {
    if (!sameName(`${existing.firstName} ${existing.lastName}`, who.fullName)) return { reason: 'mismatch', user: existing };
    const have = new Set(await okta.userGroups(existing.id).catch(() => []));
    for (const g of groups.filter(id => !have.has(id))) await okta.addToGroup(existing.id, g).catch(() => {});
    if (existing.status === 'STAGED' || existing.status === 'PROVISIONED') await okta.activate(existing.id).catch(() => {});
    await kv.put(key, { pageId: who.pageId, userId: existing.id, at: now, existing: true }, now);
    return { reason: 'existing', user: existing };
  }
  if (!(await kv.claim(key, { pageId: who.pageId, claimedAt: now }, now))) return { reason: 'uncertain', code: 'already_claimed' };
  try {
    const user = await okta.createUser({ firstName: names.givenName, lastName: names.familyName, login, email: login, secondEmail: who.personalEmail ?? null, groupIds: groups });
    await kv.put(key, { pageId: who.pageId, userId: user?.id ?? null, at: now }, now);
    return { reason: 'created', user };
  } catch (error) {
    if (error?.uncertain) { await kv.put(key, { pageId: who.pageId, claimedAt: now, uncertain: error.code }, now); return { reason: 'uncertain', code: error.code }; }
    await kv.del(key);
    return { reason: 'refused', code: error?.code ?? 'failed', why: error?.reason ?? null };
  }
}

/** "okta groups: Engineering, Contractors" in Project's DM. Null when it isn't that. */
export async function handleOktaGroups({ event, env, db, masonId, okta, poster, clock = Date.now, sideEffects = [] }) {
  const m = /^\s*okta groups?\s*[:=-]\s*(.+)$/i.exec(String(event?.text ?? '').replace(/\*Sent using\*[\s\S]*$/i, '').trim());
  if (!m || event.authorId !== masonId || !db?.prepare) return null;
  const reply = t => poster(event.threadTs ?? event.messageTs)(t).catch(() => {});
  if (!okta || !(await oktaConnected({ env, db }))) { await reply('📋 Okta isn\'t connected yet, so I kept nothing. Send it again once the key is in.'); return { kind: 'okta_groups', reason: 'not_ready' }; }
  const wanted = m[1].split(/,|\band\b/i).map(s => s.trim()).filter(Boolean);
  const all = await okta.groups().catch(() => []);
  const picked = [], missing = [];
  for (const w of wanted) { const g = all.find(x => x.name.toLowerCase() === w.toLowerCase()) ?? all.filter(x => x.name.toLowerCase().includes(w.toLowerCase())).sort((a, b) => a.name.length - b.name.length)[0]; (g ? picked.push({ id: g.id, name: g.name }) : missing.push(w)); }
  if (!picked.length) { await reply(`📋 None of those are Okta groups. Groups here: ${all.map(g => g.name).slice(0, 25).join(', ')}.`); return { kind: 'okta_groups', reason: 'none_found' }; }
  await noticeStore(db).put('okta:groups', { groups: picked, by: 'Project', at: clock() }, clock());
  sideEffects.push('okta_groups');
  await reply(`Roger that 🫡 New hires go in: ${picked.map(g => g.name).join(', ')}. From now on I set them up in Okta myself.${missing.length ? ` Not found: ${missing.join(', ')}.` : ''}`);
  return { kind: 'okta_groups', reason: null };
}
