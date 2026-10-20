import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createInsightfulClient, probeInsightful, setUpInsightful, offboardInsightful, insightfulSetup, projectName } from '../service/lib/insightful.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const ENV = { INSIGHTFUL_API_TOKEN: 'ins-token-fixture-only-1234567890' };
const NOW = Date.parse('2026-10-20T19:00:00Z');

/** A fake Insightful org; `dropTaskAssign` reproduces Rylan's "no projects assigned" (the task made without him). */
function fakeOrg({ dropTaskAssign = false, dropProjectAssign = false } = {}) {
  const org = { calls: [], teams: [{ id: 't-wt', name: 'Work Trialers', employees: ['e-morgan'] }, { id: 't-def', name: 'Default', default: true, employees: [] }],
    settings: [{ id: 's-def', name: 'Default', type: 'office', default: true }, { id: 's-pers', name: 'Personal tracking', type: 'personal' }],
    employees: [{ id: 'e-morgan', name: 'Morgan', email: 'morgan@company.example', teamId: 't-wt', sharedSettingsId: 's-pers', projects: [], deactivated: 0 }],
    projects: [], tasks: [], n: 0 };
  org.fetch = async (url, init = {}) => {
    const path = url.replace('https://app.insightful.io/api/v1', ''), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : null;
    org.calls.push(`${method} ${path}`);
    assert.equal(init.headers.authorization, `Bearer ${ENV.INSIGHTFUL_API_TOKEN}`);
    const ok = data => Response.json(data);
    if (path === '/team') return ok(org.teams);
    if (path === '/shared-settings/') return ok(org.settings);
    if (path === '/employee' && method === 'GET') return ok(org.employees);
    if (path === '/employee' && method === 'POST') { const e = { id: `e-${++org.n}`, ...body, projects: [], deactivated: 0 }; org.employees.push(e); return ok(e); }
    let m;
    if ((m = /^\/employee\/deactivate\/(.+)$/.exec(path))) { const e = org.employees.find(x => x.id === m[1]); if (e.deactivated) return Response.json({ message: 'Employee is already deactivated' }, { status: 409 }); e.deactivated = 1; return ok(e); }
    if ((m = /^\/employee\/(.+)$/.exec(path))) return ok(org.employees.find(x => x.id === m[1]));
    if (path === '/project' && method === 'GET') return ok(org.projects);
    if (path === '/project' && method === 'POST') { const p = { id: `p-${++org.n}`, statuses: ['To Do', 'In progress', 'Done'], archived: false, ...body, employees: dropProjectAssign ? [] : body.employees }; org.projects.push(p); return ok(p); }
    if ((m = /^\/project\/(.+)$/.exec(path))) { const p = org.projects.find(x => x.id === m[1]); if (method === 'PUT') Object.assign(p, body); return ok(p); }
    if (path === '/task' && method === 'GET') return ok(org.tasks);
    if (path === '/task' && method === 'POST') { const t = { id: `k-${++org.n}`, ...body, employees: dropTaskAssign ? [] : body.employees }; org.tasks.push(t); return ok(t); }
    if ((m = /^\/task\/(.+)$/.exec(path))) { const t = org.tasks.find(x => x.id === m[1]); if (method === 'PUT') Object.assign(t, body); return ok(t); }
    return Response.json({ message: 'nope' }, { status: 404 });
  };
  return org;
}

test('Insightful check: the Work Trialers team and the settings its people use; Project told once; nothing before it passes', async () => {
  const db = d1(), org = fakeOrg(), said = [];
  assert.equal(await insightfulSetup({ env: ENV, db }), null);
  const out = await probeInsightful({ env: ENV, db, fetchImpl: org.fetch, poster: async t => said.push(t), clock: () => NOW });
  assert.equal(out.state, 'ok');
  assert.deepEqual(await insightfulSetup({ env: ENV, db }), { team: { id: 't-wt', name: 'Work Trialers' }, settings: { id: 's-pers', name: 'Personal tracking' } });
  assert.equal(said[0], '⏱️ Insightful is connected. From now on work trialers go in Work Trialers (Personal tracking) with their own project and task, right when Okta is set up.');
  assert.equal((await probeInsightful({ env: ENV, db, fetchImpl: org.fetch, poster: async t => said.push(t), clock: () => NOW + 3600_000 })).state, 'ok');
  assert.equal(said.length, 1);
});

test('A hire: invited at the Company email into Work Trialers, on their own project and task, read back; never twice; offboarding deactivates and archives', async () => {
  const db = d1(), org = fakeOrg(), ins = createInsightfulClient({ env: ENV, fetchImpl: org.fetch });
  await probeInsightful({ env: ENV, db, fetchImpl: org.fetch, clock: () => NOW });
  const who = { pageId: 'p-rk', fullName: 'Rylan King', address: 'rylan@company.example' };
  const r = await setUpInsightful({ env: ENV, db, ins, who, clock: () => NOW });
  assert.equal(r.reason, 'created');
  const e = org.employees.find(x => x.email === 'rylan@company.example');
  assert.deepEqual([e.name, e.teamId, e.sharedSettingsId], ['Rylan King', 't-wt', 's-pers']);
  assert.equal(org.projects[0].name, 'Rylan King — Work Trial');
  assert.ok(org.projects[0].employees.includes(e.id) && org.tasks[0].employees.includes(e.id));
  assert.deepEqual([org.tasks[0].name, org.tasks[0].projectId, org.tasks[0].status], ['Work trial task', org.projects[0].id, 'To Do']);
  const again = await setUpInsightful({ env: ENV, db, ins, who, clock: () => NOW + 60_000 });
  assert.equal(again.reason, 'existing');
  assert.equal(org.employees.filter(x => x.email === 'rylan@company.example').length, 1, 'never invited twice');
  assert.equal(org.projects.length, 1); assert.equal(org.tasks.length, 1);
  const off = await offboardInsightful({ env: ENV, db, ins, address: 'rylan@company.example', pageId: 'p-rk' });
  assert.deepEqual(off, { deactivated: true, archived: true });
  assert.equal(e.deactivated, 1); assert.equal(org.projects[0].archived, true);
  assert.equal(projectName('Avery James Carter ⭐'), 'Avery James Carter — Work Trial');
});

test('Something not assigned (Rylan\'s "no projects assigned"): fixed and read back; still missing after the fix: told as unassigned', async () => {
  const db = d1(), org = fakeOrg({ dropTaskAssign: true }), ins = createInsightfulClient({ env: ENV, fetchImpl: org.fetch });
  await probeInsightful({ env: ENV, db, fetchImpl: org.fetch, clock: () => NOW });
  const r = await setUpInsightful({ env: ENV, db, ins, who: { pageId: 'p-a', fullName: 'Rowan Blake', address: 'rowand@company.example' }, clock: () => NOW });
  assert.equal(r.reason, 'created');
  assert.ok(org.calls.some(c => c.startsWith('PUT /task/')), 'the task is fixed');
  assert.ok(org.tasks[0].employees.includes(r.employeeId));
  // An org that refuses the fix too: reported, never claimed done.
  const db2 = d1(), org2 = fakeOrg({ dropTaskAssign: true }), ins2 = createInsightfulClient({ env: ENV, fetchImpl: org2.fetch });
  await probeInsightful({ env: ENV, db: db2, fetchImpl: org2.fetch, clock: () => NOW });
  const stuck = { ...ins2, updateTask: async () => null };
  const r2 = await setUpInsightful({ env: ENV, db: db2, ins: stuck, who: { pageId: 'p-a', fullName: 'Rowan Blake', address: 'rowand@company.example' }, clock: () => NOW });
  assert.deepEqual([r2.reason, r2.code], ['unassigned', 'not_on_task']);
  // No Company address: refused, nothing sent.
  const r3 = await setUpInsightful({ env: ENV, db, ins, who: { pageId: 'p-x', fullName: 'X Y', address: 'x@example.test' }, clock: () => NOW });
  assert.equal(r3.reason, 'refused');
});
