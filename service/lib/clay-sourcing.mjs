/**
 * Clay as a second source for the daily ten (sourcing.mjs), so it runs before Juicebox is connected and alongside it after
 * (Project, 2026-10-18: "build out all of the code for this to the absolute max"). Clay has no open people search here, but
 * it has "Find People at Company": Project names target companies and the titles he wants, and each morning from 6:30 AM PT
 * Uncle Sam runs a few of those companies (rotating, SOURCING_CLAY_COMPANIES_PER_DAY, default 4, within CLAY_DAILY_MAX),
 * keeps the people whose title matches (and place, when given), and puts them in the pool the daily ten is picked from.
 *
 * Project's DM: "sourcing companies: zepto.com, swiggy.com, linkedin.com/company/razorpay", "sourcing titles: ML engineer,
 * data scientist", "sourcing places: India, Bangalore", "sourcing companies" (to see them). Nothing is sent to anyone here.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { FUNCTIONS } from './person-finder.mjs';
import { peopleIn } from './juicebox.mjs';
import { laDate, laWall } from './takehome-nudge.mjs';
import { PEOPLE } from './agent-runner.mjs';

const POOL_MAX = 300;
const clean = (v, n = 200) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const split = text => String(text ?? '').replace(/<([^|>]+)(?:\|[^>]+)?>/g, '$1').split(/[,;\n]|\band\b/i).map(s => clean(s, 200)).filter(Boolean);

/** "Zepto.com", "https://www.zepto.com/", "linkedin.com/company/razorpay" -> { key, input: { 'Company Domain' | 'Company Social Profile URL' } } */
export function companyOf(text) {
  const t = clean(text, 200).replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const li = /^(?:[a-z]{2,3}\.)?linkedin\.com\/company\/([A-Za-z0-9_%-]{2,100})/i.exec(t);
  if (li) return { key: `li:${li[1].toLowerCase()}`, label: li[1], input: { 'Company Social Profile URL': `https://www.linkedin.com/company/${li[1]}` } };
  const domain = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(t.split('/')[0]);
  if (domain && /\.[a-z]{2,}$/i.test(domain[1])) return { key: domain[1].toLowerCase(), label: domain[1].toLowerCase(), input: { 'Company Domain': domain[1].toLowerCase() } };
  return null;
}

const words = s => String(s ?? '').toLowerCase().split(/[^a-z0-9+#]+/).filter(w => w.length > 1);
/** A title matches when every word of one wanted title is in it ("ML engineer" matches "Senior ML Engineer II"). */
export const titleMatches = (title, wanted) => !wanted.length || wanted.some(w => { const have = new Set(words(title)); return words(w).every(x => have.has(x)); });
export const placeMatches = (place, wanted) => !wanted.length || !place || wanted.some(w => String(place).toLowerCase().includes(String(w).toLowerCase()));

export async function readPool(db) { return (await noticeStore(db).get('sourcing:pool'))?.people ?? []; }
export async function addToPool(kv, people, now) {
  const pool = (await kv.get('sourcing:pool'))?.people ?? [];
  const have = new Set(pool.map(p => p.slug));
  const next = [...pool, ...people.filter(p => !have.has(p.slug))].slice(-POOL_MAX);
  await kv.put('sourcing:pool', { people: next, at: now }, now);
  return next.length - pool.length;
}

/** The morning runs and the collection of finished ones. -> { started, collected, added } */
export async function runClayProspecting({ env = {}, db, clay, clock = Date.now, log = () => {} }) {
  const summary = { state: 'off', started: 0, collected: 0, added: 0, error: null };
  try {
    if (env.UNCLE_SAM_SOURCING === 'off' || env.UNCLE_SAM_CLAY_SOURCING === 'off' || !db?.prepare || !clay) return summary;
    const kv = noticeStore(db), now = clock(), today = laDate(now);
    const cfg = (await kv.get('sourcing:clay')) ?? {};
    if (!cfg.companies?.length) return { ...summary, state: 'no_companies' };
    summary.state = 'ran';
    // Collect what finished.
    const runs = (await kv.get('sourcing:clay:runs'))?.runs ?? [];
    const open = [];
    for (const r of runs) {
      if (now - r.at > 2 * 86400_000) continue;
      let results = null;
      try { results = await clay.results(r.runId); } catch { open.push(r); continue; }
      if (!results) { open.push(r); continue; }
      const found = peopleIn([...results.values()].map(x => x.result)).filter(p => titleMatches(p.title || p.headline, cfg.titles ?? []) && placeMatches(p.location, cfg.places ?? []))
        .map(p => ({ ...p, company: p.company || r.label, from: 'clay' }));
      summary.collected++;
      summary.added += await addToPool(kv, found, now);
    }
    // Start today's companies (rotating), once a day each, from 6:30 AM PT.
    const perDay = Math.min(Math.max(Number(env.SOURCING_CLAY_COMPANIES_PER_DAY) || 4, 1), 15);
    if (now >= laWall(today, 6, 30) && await kv.claim(`sourcing:clay:day:${today}`, { at: now }, now)) {
      let cursor = Number((await kv.get('sourcing:clay:cursor'))?.n ?? 0);
      for (let i = 0; i < Math.min(perDay, cfg.companies.length); i++) {
        const c = cfg.companies[cursor % cfg.companies.length];
        cursor++;
        const used = (await kv.get(`clay:day:${new Date(now).toISOString().slice(0, 10)}`))?.count ?? 0;
        if (used >= (Number(env.CLAY_DAILY_MAX) || 40)) break;
        try {
          const runId = await clay.startWith(FUNCTIONS['Find People at Company'].id, [{ id: 'c0', inputs: c.input }]);
          await kv.put(`clay:day:${new Date(now).toISOString().slice(0, 10)}`, { count: used + 1 }, now);
          open.push({ runId, key: c.key, label: c.label, at: now });
          summary.started++;
        } catch (error) { log(`uncle_sam_clay_sourcing start_failed ${c.key} ${error?.code ?? 'failed'}`); }
      }
      await kv.put('sourcing:clay:cursor', { n: cursor }, now);
    }
    await kv.put('sourcing:clay:runs', { runs: open.slice(-40) }, now);
    return summary;
  } catch (error) {
    summary.error = typeof error?.code === 'string' ? error.code : 'clay_sourcing_failed';
    log(`uncle_sam_clay_sourcing ${JSON.stringify(summary)}`);
    return summary;
  }
}

/** Project's "sourcing companies: ...", "sourcing titles: ...", "sourcing places: ...", "sourcing companies". Null when not one. */
export async function handleClaySourcingCommand({ event, env = {}, db, masonId = PEOPLE.project, poster, clock = Date.now, sideEffects = [] }) {
  if (env.UNCLE_SAM_SOURCING === 'off' || !db?.prepare || event?.authorId !== masonId) return null;
  const text = String(event.text ?? '').replace(/\*Sent using\*[\s\S]*$/i, '').trim();
  const m = /^\s*sourcing\s+(companies|company list|titles|roles|places|locations)\s*(?:[:=-]\s*([\s\S]*))?$/i.exec(text);
  if (!m) return null;
  const kv = noticeStore(db), now = clock();
  const cfg = (await kv.get('sourcing:clay')) ?? {};
  const reply = t => poster(event.threadTs ?? event.messageTs)(t).catch(() => {});
  const kind = /compan/i.test(m[1]) ? 'companies' : /title|role/i.test(m[1]) ? 'titles' : 'places';
  if (!m[2]?.trim()) {
    const list = kind === 'companies' ? (cfg.companies ?? []).map(c => c.label) : cfg[kind] ?? [];
    await reply(list.length ? `📋 Sourcing ${kind}: ${list.join(', ')}.` : `📋 No sourcing ${kind} yet. Send "sourcing ${kind}: a, b, c".`);
    return { kind: 'clay_sourcing', reason: 'shown' };
  }
  if (kind === 'companies') {
    const parsed = split(m[2]).map(companyOf);
    const good = parsed.filter(Boolean), bad = split(m[2]).filter((_, i) => !parsed[i]);
    const seen = new Set();
    const companies = good.filter(c => !seen.has(c.key) && seen.add(c.key)).slice(0, 100);
    if (!companies.length) { await reply('📋 Give me company websites or LinkedIn company links, e.g. "sourcing companies: zepto.com, linkedin.com/company/razorpay".'); return { kind: 'clay_sourcing', reason: 'none' }; }
    await kv.put('sourcing:clay', { ...cfg, companies, at: now }, now);
    sideEffects.push('clay_sourcing');
    await reply(`Roger that 🫡 ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}; I look through ${Math.min(Number(env.SOURCING_CLAY_COMPANIES_PER_DAY) || 4, companies.length)} a day in Clay${cfg.titles?.length ? ` for ${cfg.titles.join(', ')}` : '. Tell me which titles: "sourcing titles: ML engineer, data scientist"'}.${bad.length ? ` Not companies: ${bad.join(', ')}.` : ''}`);
    return { kind: 'clay_sourcing', reason: 'companies' };
  }
  const list = split(m[2]).slice(0, 30);
  await kv.put('sourcing:clay', { ...cfg, [kind]: list, at: now }, now);
  sideEffects.push('clay_sourcing');
  await reply(`Roger that 🫡 ${kind === 'titles' ? 'Titles' : 'Places'}: ${list.join(', ')}.`);
  return { kind: 'clay_sourcing', reason: kind };
}
