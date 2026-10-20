/**
 * Insightful (time tracking for work trialers), done by Uncle Sam with Okta (Project, 2026-10-20: "can you check to see if uncle sam
 * can make this a part of the same onboarding flow and do it at the same time as okta" / "it is all set up in insightful, it's
 * called work trialers" / "this stuff should end as soon as the okta stuff ends as well" / "don't make the same mistakes ... where
 * something didn't get assigned").
 *
 * INSIGHTFUL_API_TOKEN (an API token an Insightful admin makes on the API page; secret, never shown) switches it on;
 * UNCLE_SAM_INSIGHTFUL=off switches it off. API: https://app.insightful.io/api/v1 (Insightful's Postman collection):
 *   POST /employee {name, email, teamId, sharedSettingsId}  invite; GET /employee, /employee/:id, /employee/deactivate/:id
 *   GET /team, /shared-settings; POST /project, GET/PUT /project/:id; POST /task, GET /task, GET/PUT /task/:id
 *
 *  - Check (once per key, Project told once): the "Work Trialers" team (any team named like "work trial…"), and the shared
 *    settings its people already use (else settings named like it, else the default). Nothing is created before it passes.
 *  - A hire, once their Company email exists (onboarding.mjs, right with Okta): invited at the Company email into that team;
 *    a project "<Name> — Work Trial" with them on it, and a task "Work trial task" in it with them on it. Then everything is
 *    read back: they must be on the project and on the task (the "no projects assigned" Rylan hit), else it is fixed once
 *    and read back again, and Project is told if it still isn't. Someone already in Insightful at that email is never invited
 *    twice; their project and task are made or fixed the same way. Claimed before the invite; an unclear answer is never retried.
 *  - Offboarding, the moment Okta is suspended (offboarding.mjs, offboard-now.mjs): deactivated, and their project archived.
 */
import { noticeStore } from './stuck-rejections.mjs';

export const INSIGHTFUL_API = 'https://app.insightful.io/api/v1';
export const TASK_NAME = 'Work trial task';
export const projectName = fullName => `${String(fullName ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[⭐★]/gu, '').replace(/\s+/g, ' ').trim()} — Work Trial`;
export const insightfulConfigured = env => env?.UNCLE_SAM_INSIGHTFUL !== 'off' && /^\S{16,}$/.test(String(env?.INSIGHTFUL_API_TOKEN ?? '').trim());
const fail = (code, extra = {}) => { throw Object.assign(new Error(code), { code, ...extra }); };
const clean = (t, n = 160) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const listOf = data => (Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.items) ? data.items : []);
const idsOf = list => (Array.isArray(list) ? list : []).map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean);

export function createInsightfulClient({ env, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!insightfulConfigured(env)) fail('insightful_not_configured');
  const call = async (path, { method = 'GET', body = null, uncertainOnFailure = false } = {}) => {
    let response;
    try {
      response = await fetchImpl(`${INSIGHTFUL_API}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${env.INSIGHTFUL_API_TOKEN.trim()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { fail('insightful_network', { uncertain: uncertainOnFailure }); }
    const data = await response.json().catch(() => null);
    if (response.status === 404) return { status: 404, data: null };
    if (response.status === 409) return { status: 409, data };
    if (response.status === 429) fail('insightful_rate_limited', { uncertain: uncertainOnFailure && method !== 'GET' });
    if (response.status >= 500) fail(`insightful_http_${response.status}`, { uncertain: uncertainOnFailure });
    if (response.status >= 400) fail(`insightful_http_${response.status}`, { reason: clean(data?.message ?? data?.type ?? '', 200) });
    return { status: response.status, data };
  };
  const emp = e => (e ? { id: e.id, name: clean(e.name, 120), email: String(e.email ?? e.identifier ?? '').toLowerCase(), teamId: e.teamId ?? e.teamsId ?? null,
    sharedSettingsId: e.sharedSettingsId ?? null, projects: idsOf(e.projects), deactivated: Number(e.deactivated) || 0 } : null);
  const proj = p => (p ? { id: p.id, name: clean(p.name, 200), archived: !!p.archived, employees: idsOf(p.employees), statuses: Array.isArray(p.statuses) ? p.statuses : [] } : null);
  const task = t => (t ? { id: t.id, name: clean(t.name, 200), projectId: t.projectId ?? null, employees: idsOf(t.employees) } : null);
  return Object.freeze({
    async teams() { return listOf((await call('/team')).data).map(t => ({ id: t.id, name: clean(t.name, 120), employees: idsOf(t.employees), default: !!t.default })); },
    async sharedSettings() { return listOf((await call('/shared-settings/')).data).map(s => ({ id: s.id, name: clean(s.name, 120), type: s.type ?? null, default: !!s.default })); },
    async employees() { return listOf((await call('/employee')).data).map(emp); },
    async employee(id) { const { status, data } = await call(`/employee/${encodeURIComponent(id)}`); return status === 404 ? null : emp(data); },
    async invite({ name, email, teamId, sharedSettingsId }) {
      const { data } = await call('/employee', { method: 'POST', uncertainOnFailure: true, body: { name, email, teamId, sharedSettingsId } });
      return emp(data);
    },
    /** true when deactivated now or already (409). */
    async deactivate(id) { const { status } = await call(`/employee/deactivate/${encodeURIComponent(id)}`, { uncertainOnFailure: true }); return status === 200 || status === 409; },
    async projects() { return listOf((await call('/project')).data).map(proj); },
    async project(id) { const { status, data } = await call(`/project/${encodeURIComponent(id)}`); return status === 404 ? null : proj(data); },
    async createProject({ name, employees }) {
      const { data } = await call('/project', { method: 'POST', uncertainOnFailure: true, body: { name, description: 'Work trial (set up by Uncle Sam).', employees, billable: false } });
      return proj(data);
    },
    async updateProject(id, body) { const { data } = await call(`/project/${encodeURIComponent(id)}`, { method: 'PUT', body }); return proj(data); },
    async tasks() { return listOf((await call('/task')).data).map(task); },
    async task(id) { const { status, data } = await call(`/task/${encodeURIComponent(id)}`); return status === 404 ? null : task(data); },
    async createTask({ name, projectId, employees, status = null }) {
      const { data } = await call('/task', { method: 'POST', uncertainOnFailure: true, body: { name, projectId, employees, description: 'Pick this task in Insightful when you start working.', ...(status ? { status } : {}) } });
      return task(data);
    },
    async updateTask(id, body) { const { data } = await call(`/task/${encodeURIComponent(id)}`, { method: 'PUT', body }); return task(data); },
  });
}

const TEAM = /\bwork[\s-]*trial/i;

/** Ready once the check passed with this key: { team: { id, name }, settings: { id, name } } or null. */
export async function insightfulSetup({ env, db }) {
  if (!insightfulConfigured(env) || !db?.prepare) return null;
  const p = await noticeStore(db).get('insightful:probe');
  return p?.ok && p.key === keyHint(env) && p.team?.id && p.settings?.id ? { team: p.team, settings: p.settings } : null;
}
const keyHint = env => `${String(env.INSIGHTFUL_API_TOKEN).trim().length}:${String(env.INSIGHTFUL_API_TOKEN).trim().slice(-4)}`;

/** The connection check, once per key (every 30 minutes until it passes); Project told once. */
export async function probeInsightful({ env, db, fetchImpl = globalThis.fetch, poster = null, clock = Date.now }) {
  if (!insightfulConfigured(env) || !db?.prepare) return { state: 'not_configured' };
  const kv = noticeStore(db), now = clock(), last = await kv.get('insightful:probe'), key = keyHint(env);
  if (last?.ok && last.key === key) return { state: 'ok' };
  if (last && last.key === key && now - last.at < 30 * 60_000) return { state: 'not_due' };
  const told = last?.failedTold === key;
  const failed = async (code, text) => {
    await kv.put('insightful:probe', { ok: false, key, error: code, at: now, failedTold: key }, now);
    if (!told && poster) await poster(text).catch(() => {});
    return { state: 'failed', error: code };
  };
  let teams, settings, employees;
  try {
    const ins = createInsightfulClient({ env, fetchImpl });
    [teams, settings, employees] = [await ins.teams(), await ins.sharedSettings(), await ins.employees()];
  } catch (error) {
    return failed(error?.code ?? 'failed', `🚨 The Insightful key doesn't work yet (${error?.code ?? 'failed'}). Make a new API token in Insightful (admin → API) and double-click "Save Insightful key".`);
  }
  const matches = teams.filter(t => TEAM.test(t.name));
  if (matches.length !== 1) return failed(matches.length ? 'several_teams' : 'no_team', matches.length
    ? `📋 Insightful has more than one work-trial team (${matches.map(t => t.name).join(', ')}). Rename the others so only one says "work trial".`
    : `📋 Insightful is connected but I can't find the "Work Trialers" team. Teams: ${teams.map(t => t.name).join(', ') || 'none'}.`);
  const team = matches[0];
  // The settings the people already in that team use; else settings named like it; else the default.
  const counts = new Map();
  for (const e of employees) if (e.teamId === team.id && !e.deactivated && e.sharedSettingsId) counts.set(e.sharedSettingsId, (counts.get(e.sharedSettingsId) ?? 0) + 1);
  const usedId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const chosen = settings.find(s => s.id === usedId) ?? settings.find(s => TEAM.test(s.name)) ?? settings.find(s => s.default) ?? null;
  if (!chosen) return failed('no_settings', '📋 Insightful is connected but has no tracking settings I can use for work trialers.');
  await kv.put('insightful:probe', { ok: true, key, at: now, team: { id: team.id, name: team.name }, settings: { id: chosen.id, name: chosen.name } }, now);
  if (poster) await poster(`⏱️ Insightful is connected. From now on work trialers go in ${team.name} (${chosen.name}) with their own project and task, right when Okta is set up.`).catch(() => {});
  return { state: 'ok', team: team.name, settings: chosen.name };
}

/**
 * One hire in Insightful. who: { pageId, fullName, address (Company email) }.
 * -> { reason: 'created' | 'existing' | 'unassigned' | 'deactivated' | 'uncertain' | 'refused' | 'not_ready', employeeId?, projectId?, taskId?, code? }
 */
export async function setUpInsightful({ env, db, ins, who, clock = Date.now }) {
  const setup = await insightfulSetup({ env, db });
  if (!ins || !setup) return { reason: 'not_ready' };
  const email = String(who.address ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@company\.example$/.test(email)) return { reason: 'refused', code: 'no_company_address' };
  const kv = noticeStore(db), now = clock(), key = `insightful:employee:${email}`;
  const name = String(who.fullName ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[⭐★]/gu, '').replace(/\s+/g, ' ').trim();
  let person = (await ins.employees()).find(e => e.email === email) ?? null;
  let reason = 'existing';
  if (person?.deactivated) return { reason: 'deactivated', employeeId: person.id };
  if (!person) {
    const mark = await kv.get(key);
    if (mark?.uncertain || (mark && !mark.employeeId && now - (mark.claimedAt ?? 0) < 3600_000)) return { reason: 'uncertain', code: mark.uncertain ?? 'already_claimed' };
    if (!(await kv.claim(key, { pageId: who.pageId, claimedAt: now }, now))) return { reason: 'uncertain', code: 'already_claimed' };
    try { person = await ins.invite({ name, email, teamId: setup.team.id, sharedSettingsId: setup.settings.id }); }
    catch (error) {
      if (error?.uncertain) { await kv.put(key, { pageId: who.pageId, claimedAt: now, uncertain: error.code }, now); return { reason: 'uncertain', code: error.code }; }
      await kv.del(key);
      return { reason: 'refused', code: error?.code ?? 'failed', why: error?.reason ?? null };
    }
    if (!person?.id) { await kv.put(key, { pageId: who.pageId, claimedAt: now, uncertain: 'no_id' }, now); return { reason: 'uncertain', code: 'no_id' }; }
    reason = 'created';
  }
  await kv.put(key, { pageId: who.pageId, employeeId: person.id, at: now }, now);
  // Their project and task, each with them on it, read back after (Rylan: "no projects assigned").
  const wantName = projectName(who.fullName);
  let project = (await ins.projects()).find(p => !p.archived && p.name.toLowerCase() === wantName.toLowerCase()) ?? null;
  if (!project) project = await ins.createProject({ name: wantName, employees: [person.id] });
  if (!project?.id) return { reason: 'unassigned', employeeId: person.id, code: 'project_not_made' };
  let task = (await ins.tasks()).find(t => t.projectId === project.id && t.name.toLowerCase() === TASK_NAME.toLowerCase()) ?? null;
  if (!task) task = await ins.createTask({ name: TASK_NAME, projectId: project.id, employees: [person.id], status: project.statuses?.[0] ?? null });
  if (!task?.id) return { reason: 'unassigned', employeeId: person.id, projectId: project.id, code: 'task_not_made' };
  for (let pass = 0; pass < 2; pass++) {
    const p = await ins.project(project.id), t = await ins.task(task.id);
    const onProject = !!p?.employees.includes(person.id), onTask = !!t?.employees.includes(person.id);
    if (onProject && onTask) {
      await kv.put(`insightful:hire:${who.pageId}`, { email, employeeId: person.id, projectId: project.id, taskId: task.id, at: now }, now);
      return { reason, employeeId: person.id, projectId: project.id, taskId: task.id };
    }
    if (pass === 1) return { reason: 'unassigned', employeeId: person.id, projectId: project.id, taskId: task.id, code: !onProject ? 'not_on_project' : 'not_on_task' };
    if (!onProject) await ins.updateProject(project.id, { employees: [...new Set([...(p?.employees ?? []), person.id])] }).catch(() => null);
    if (!onTask) await ins.updateTask(task.id, { employees: [...new Set([...(t?.employees ?? []), person.id])] }).catch(() => null);
  }
  return { reason: 'unassigned', employeeId: person.id };
}

/** Offboarding, with Okta: deactivated and their project archived. -> { deactivated, archived } (never throws). */
export async function offboardInsightful({ env, db, ins, address, pageId = null }) {
  const out = { deactivated: false, archived: false };
  try {
    if (!ins || !(await insightfulSetup({ env, db }))) return out;
    const email = String(address ?? '').trim().toLowerCase();
    const hire = pageId ? await noticeStore(db).get(`insightful:hire:${pageId}`) : null;
    const person = hire?.employeeId ? await ins.employee(hire.employeeId) : (await ins.employees()).find(e => e.email === email);
    if (person && person.email === email) out.deactivated = person.deactivated ? true : await ins.deactivate(person.id);
    if (hire?.projectId) { await ins.updateProject(hire.projectId, { archived: true }); out.archived = true; }
  } catch { /* told by the caller's line; Insightful can be done by hand */ }
  return out;
}
