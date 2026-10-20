/**
 * Juicebox (PeopleGPT) for the daily sourcing loop (sourcing.mjs, Project 2026-10-18: "when robin says what profiles he likes
 * and doesn't like uncle sam iterates on that in his search and sends me 10 profiles to send robin per day").
 *
 * Juicebox has no API key; its MCP server (https://mcp.juicebox.ai/v1) takes each user's own OAuth sign-in and needs
 * re-approving every 30 days. So Project gets a "Connect Juicebox" link in his DM (on "connect juicebox", and again whenever
 * the connection lapses, at most once a day); the tokens are sealed in Turso. Its documented tools: get_schema, get_data,
 * resolve (analytics); search_shortlist, get_candidate_details, get_project (Business plan); get_agent_schema, create_agent
 * (creates or fine-tunes an Agent), start_sourcing, manage_agent. Their argument shapes are read from tools/list when it
 * connects, and the arguments for each call are filled from that schema (by name, else by the model), so nothing here
 * depends on guessing them. People in any result are read the same way: anything with a LinkedIn profile URL and a name.
 *
 * UNCLE_SAM_JUICEBOX=off stops it. Juicebox counts full profiles (with contact details) against its monthly export limit;
 * only the day's picks get get_candidate_details.
 */
import { mcpOAuth, mcpClient, McpOAuthError } from './mcp-oauth.mjs';
import { wisprConfigured, DEFAULT_PUBLIC_URL } from './wispr.mjs';
import { noticeStore } from './stuck-rejections.mjs';

export const JUICEBOX = Object.freeze({ mcpUrl: 'https://mcp.juicebox.ai/v1', callbackPath: '/api/juicebox/callback' });
export const juiceboxEnabled = env => env?.UNCLE_SAM_JUICEBOX !== 'off' && wisprConfigured(env);
const callbackOf = env => `${String(env.UNCLE_SAM_PUBLIC_URL || DEFAULT_PUBLIC_URL).replace(/\/+$/, '')}${JUICEBOX.callbackPath}`;
const clean = (v, n = 300) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

export function juiceboxAuth({ env, db, fetchImpl = globalThis.fetch, clock = Date.now }) {
  return mcpOAuth({ env, db, prefix: 'juicebox', mcpUrl: env.JUICEBOX_MCP_URL || JUICEBOX.mcpUrl, callbackUrl: callbackOf(env),
    clientName: 'Uncle Sam (Company AI recruiting)', fetchImpl, clock });
}

/** A LinkedIn profile URL -> its slug (lowercase), or null. */
export function linkedinSlug(url) {
  const m = /linkedin\.com\/in\/([A-Za-z0-9_%-]{3,100})/i.exec(String(url ?? ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}
export const profileUrl = slug => `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;

const pick = (o, keys) => { for (const k of keys) { const v = o?.[k]; if (v != null && v !== '' && typeof v !== 'object') return v; } return null; };
const nested = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

/** Every person-looking object in a tool result (a name and a LinkedIn profile URL), de-duplicated by profile. */
export function peopleIn(result, max = 200) {
  const out = new Map();
  const walk = (node, depth) => {
    if (!node || depth > 8 || out.size >= max) return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return; }
    if (typeof node !== 'object') return;
    const urlField = pick(node, ['linkedin_url', 'linkedinUrl', 'linkedin', 'linkedIn', 'profile_url', 'profileUrl', 'li_url', 'url'])
      ?? Object.values(node).find(v => typeof v === 'string' && /linkedin\.com\/in\//i.test(v))
      // one level down too ({ profile: { url } }, { links: { linkedin } }), so the person keeps their name
      ?? Object.values(node).filter(v => v && typeof v === 'object' && !Array.isArray(v)).flatMap(v => Object.values(v)).find(v => typeof v === 'string' && /linkedin\.com\/in\//i.test(v));
    const slug = linkedinSlug(urlField);
    const first = pick(node, ['first_name', 'firstName']), last = pick(node, ['last_name', 'lastName']);
    const name = clean(pick(node, ['full_name', 'fullName', 'name', 'candidate_name']) ?? [first, last].filter(Boolean).join(' '), 120);
    if (slug && name && !out.has(slug)) {
      const exp = Array.isArray(node.experience) ? node.experience : Array.isArray(node.experiences) ? node.experiences : Array.isArray(node.positions) ? node.positions : Array.isArray(node.recentRoles) ? node.recentRoles : Array.isArray(node.roles) ? node.roles : [];
      const now = exp[0] ?? {};
      const emails = [pick(node, ['email', 'work_email', 'workEmail', 'personal_email', 'personalEmail']), ...(Array.isArray(node.emails) ? node.emails.map(e => (typeof e === 'string' ? e : e?.address ?? e?.email)) : [])]
        .filter(e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e)).map(e => e.toLowerCase());
      out.set(slug, {
        slug, linkedin: profileUrl(slug), name,
        title: clean(pick(node, ['title', 'job_title', 'jobTitle', 'current_title', 'currentTitle']) ?? pick(now, ['title', 'job_title']), 160),
        company: clean(pick(node, ['company', 'company_name', 'companyName', 'current_company', 'currentCompany', 'currentCompanyName']) ?? nested(node, 'company.name') ?? nested(node, 'currentCompany.name') ?? nested(node, 'current_company.name')
          ?? pick(now, ['company', 'company_name', 'companyName']) ?? nested(now, 'company.name'), 120),
        location: clean(pick(node, ['location', 'location_name', 'locationName', 'city', 'country']) ?? nested(node, 'location.name'), 120),
        headline: clean(pick(node, ['headline', 'summary', 'about']), 300),
        workEvidence: [...new Set([pick(node, ['summary', 'about', 'description']), ...exp.slice(0, 5).map(e => pick(e, ['description', 'summary', 'responsibilities']))].filter(v => typeof v === 'string').map(v => clean(v, 1500)).filter(Boolean))].slice(0, 6),
        years: Number(pick(node, ['total_years_of_experience', 'years_of_experience', 'yearsOfExperience', 'totalYearsOfExperience'])) || null,
        email: emails[0] ?? null,
        juiceboxId: pick(node, ['candidate_id', 'candidateId', 'profile_id', 'profileId', 'id']) ?? null,
        personId: pick(node, ['personId', 'person_id']) ?? null,
        score: Number(pick(node, ['score', 'matchScore', 'match_score'])) || null,
        education: (Array.isArray(node.education) ? node.education : Array.isArray(node.educations) ? node.educations : Array.isArray(node.schools) ? node.schools : []).slice(0, 2)
          .map(e => (typeof e === 'string' ? clean(e, 120) : clean([pick(e, ['school', 'schoolName', 'school_name', 'institution', 'name']) ?? nested(e, 'school.name'), pick(e, ['degree', 'degreeName', 'degree_name', 'field', 'fieldOfStudy'])].filter(Boolean).join(', '), 120))).filter(Boolean),
        past: exp.slice(1, 4).map(e => clean([pick(e, ['title', 'job_title']), pick(e, ['company', 'company_name', 'companyName']) ?? nested(e, 'company.name')].filter(Boolean).join(' at '), 120)).filter(Boolean),
      });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(result, 0);
  return [...out.values()];
}

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
/** The tool whose name is or contains `want` (Juicebox may prefix its tool names). */
export const toolNamed = (tools, want) => tools.find(t => t.name === want) ?? tools.find(t => norm(t.name).endsWith(norm(want))) ?? tools.find(t => norm(t.name).includes(norm(want))) ?? null;

/**
 * Arguments for a tool from its input schema: each property filled from `known` by name ("projectId" fills project_id),
 * defaults for limits; when a required one is still missing and a model is at hand, the model fills them from `intent`.
 * -> args, or null when a required argument can't be filled.
 */
export async function argsFor({ tool, known = {}, intent = '', claude = null }) {
  const props = tool?.inputSchema?.properties ?? {}, required = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
  const byNorm = Object.fromEntries(Object.entries(known).filter(([, v]) => v != null && v !== '').map(([k, v]) => [norm(k), v]));
  const args = {};
  for (const [key, spec] of Object.entries(props)) {
    const n = norm(key);
    if (n in byNorm) args[key] = byNorm[n];
    else if (/^(limit|pagesize|perpage|count|max|maxresults)$/.test(n) && ['integer', 'number'].includes(spec?.type)) args[key] = Math.min(Number(spec?.maximum) || 50, Number(known.limit) || 50);
  }
  const missing = required.filter(k => !(k in args));
  if (!missing.length) return args;
  if (!claude) return null;
  const reply = await claude.complete({ maxTokens: 800, toolChoice: { type: 'auto' },
    system: 'You fill the arguments for one call to a recruiting tool. Use only the values given or plainly implied by the task; never invent an id. Answer only by calling fill.',
    messages: [{ role: 'user', content: `Tool: ${tool.name}\nWhat it does: ${tool.description}\nInput schema: ${JSON.stringify(tool.inputSchema).slice(0, 4000)}\nTask: ${intent}\nKnown values: ${JSON.stringify(known).slice(0, 3000)}` }],
    tools: [{ name: 'fill', description: 'The arguments.', input_schema: { type: 'object', required: ['arguments'], properties: { arguments: { type: 'object' }, impossible: { type: 'boolean' } } } }] }).catch(() => null);
  const call = (reply?.content ?? []).find(b => b?.type === 'tool_use' && b.name === 'fill');
  if (!call?.input?.arguments || call.input.impossible) return null;
  const filled = { ...call.input.arguments, ...args };
  return required.every(k => k in filled) ? filled : null;
}

/** Connected session with its tool list (refreshed daily). -> { client, tools } or throws mcp_not_connected / mcp_disconnected. */
export async function juiceboxSession({ env, db, fetchImpl = globalThis.fetch, clock = Date.now }) {
  const auth = juiceboxAuth({ env, db, fetchImpl, clock });
  const token = await auth.accessToken();
  let client;
  try { client = await mcpClient({ mcpUrl: env.JUICEBOX_MCP_URL || JUICEBOX.mcpUrl, accessToken: token, fetchImpl }); }
  catch (error) { if (error?.code === 'mcp_unauthorized') await auth.disconnect(); throw error; }
  const kv = noticeStore(db), now = clock();
  let saved = await kv.get('juicebox:tools');
  if (!saved?.tools?.length || now - saved.at > 24 * 3600_000) { saved = { tools: await client.tools(), at: now }; await kv.put('juicebox:tools', saved, now); }
  return { client, tools: saved.tools };
}

async function callBy({ session, want, known, intent, claude }) {
  const tool = toolNamed(session.tools, want);
  if (!tool) throw new McpOAuthError('juicebox_tool_missing', { reason: want });
  const args = await argsFor({ tool, known, intent, claude });
  if (!args) throw new McpOAuthError('juicebox_args_unknown', { reason: want });
  return session.client.call(tool.name, args);
}

/** Leads for the day: the Agent's / project's shortlist, then the project summary; de-duplicated. */
export async function fetchLeads({ session, source = {}, claude = null, limit = 50 }) {
  const known = { projectId: source.projectId, project_id: source.projectId, agentId: source.agentId, agent_id: source.agentId, limit, status: 'new' };
  const found = new Map();
  for (const [want, intent] of [['search_shortlist', `List the newest shortlisted candidates${source.projectId ? ` in project ${source.projectId}` : ''}${source.agentId ? ` from agent ${source.agentId}` : ''}.`],
    ['get_project', `Summarize project ${source.projectId ?? ''} with its shortlisted candidates.`]]) {
    if (want === 'get_project' && !source.projectId) continue;
    try { for (const p of peopleIn(await callBy({ session, want, known, intent, claude }))) if (!found.has(p.slug)) found.set(p.slug, p); }
    catch (error) { if (want === 'search_shortlist' && !found.size && error?.code !== 'juicebox_tool_missing' && error?.code !== 'juicebox_args_unknown') throw error; }
    if (found.size >= limit) break;
  }
  return [...found.values()].slice(0, limit);
}

/** More about one person (years, past roles, contact details). Counts against Juicebox's export limit, so picks only. */
export async function detailsOf({ session, person, claude = null }) {
  try {
    const got = peopleIn(await callBy({ session, want: 'get_candidate_details', known: { candidateId: person.juiceboxId, candidate_id: person.juiceboxId, linkedinUrl: person.linkedin, linkedin_url: person.linkedin },
      intent: `Details for the candidate ${person.name} (${person.linkedin}).`, claude }));
    const same = got.find(p => p.slug === person.slug);
    return same ? { ...person, ...Object.fromEntries(Object.entries(same).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))) } : person;
  } catch { return person; }
}

const idIn = (result, keys = ['agent_id', 'agentId', 'id']) => {
  let found = null;
  const walk = (n, d) => { if (found || !n || typeof n !== 'object' || d > 5) return; for (const k of keys) if (typeof n[k] === 'string' && n[k].length < 120) { found = n[k]; return; } for (const v of Object.values(n)) walk(v, d + 1); };
  walk(result, 0);
  return found;
};

/** Creates the sourcing Agent from Project's brief and starts it. -> { agentId } */
export async function createAgent({ session, brief, dailyTarget = 15, claude = null }) {
  const made = await callBy({ session, want: 'create_agent', known: { description: brief, brief, prompt: brief, name: 'Uncle Sam · daily sourcing', dailyLeadTarget: dailyTarget, daily_lead_target: dailyTarget },
    intent: `Create a sourcing agent that finds candidates matching: ${brief}. Daily lead target ${dailyTarget}.`, claude });
  const agentId = idIn(made);
  if (agentId) {
    try { await callBy({ session, want: 'start_sourcing', known: { agentId, agent_id: agentId }, intent: `Start sourcing for agent ${agentId}.`, claude }); } catch { /* started on the next run */ }
  }
  return { agentId, raw: made };
}

/** Robin's verdicts back into the Agent ("fine-tunes an agent"), so tomorrow's batch moves. */
export async function sendFeedback({ session, agentId, feedback, claude = null }) {
  if (!agentId || !feedback) return { sent: false };
  await callBy({ session, want: 'create_agent', known: { agentId, agent_id: agentId, feedback, instructions: feedback, refinement: feedback },
    intent: `Fine-tune the existing agent ${agentId} (do not create a new one) with this reviewer feedback on its last batch: ${feedback}`, claude });
  return { sent: true };
}

/** "connect juicebox": the link (or that it's connected). Also re-sent by the tick once a day while it's lapsed and in use. */
export async function juiceboxConnectText({ env, db, fetchImpl = globalThis.fetch, clock = Date.now, force = false }) {
  const link = await juiceboxAuth({ env, db, fetchImpl, clock }).connectLink({ force });
  if (link.status === 'connected') return { status: 'connected', text: '🫡 Juicebox is already connected.' };
  return { status: link.status, text: `🔗 <${link.url}|Connect Juicebox> so I can pull your Agent's daily profiles and tune it on Robin's picks. Sign in with your Juicebox account and approve. The link works for 24 hours; Juicebox asks again every 30 days and I'll send a fresh one when it does.` };
}

/** Which of the tools the loop uses this account has (the shortlist and project ones need Juicebox's Business plan). */
export function toolCheckText(tools) {
  const need = [['search_shortlist', 'reading the shortlist'], ['get_project', 'reading a project'], ['get_candidate_details', 'profile details'], ['create_agent', 'making and tuning the Agent'], ['start_sourcing', 'starting the Agent']];
  const missing = need.filter(([n]) => !toolNamed(tools, n));
  return missing.length
    ? `Missing on this Juicebox account: ${missing.map(([, what]) => what).join(', ')} (some need the Business plan). ${toolNamed(tools, 'search_shortlist') || toolNamed(tools, 'get_project') ? 'I can still pull profiles.' : "Without the shortlist or a project I can't pull profiles; Clay's companies still work."}`
    : 'Every tool I use is there.';
}
