/**
 * When a work-trial check-in may be, and when it is best (Project, 2026-10-18: "We work 9 9 6 PST in sf. we are interviewing people
 * across the world. I want the check ins to align however best for the work trialers. however i'm not going to make our team have
 * meetings before their BOD sync. which in this scenario applies to robin and interviewer. And im willing to have meetings after
 * their EOD sync but no later than 9:30 start ... so uncle sam needs to check the time zone of the person work trialing").
 *
 * The team's side, each Pacific day:
 *  - never before Robin's and Interviewer's beginning-of-day sync has ended (their standup, "BOD sync"; 5 minutes after it), and
 *    never before 9:00 AM PT on a day without one;
 *  - never starting after 9:30 PM PT; after the EOD sync is allowed, but before it is preferred whenever the trialer's own
 *    working hours allow (Project, 2026-10-18: "ideally the check ins for our team are also before their EOD sync ... for an
 *    american def before the eod sync"; India usually can't be);
 *  - Robin and Interviewer free with 5 minutes either side (Taylor too when possible).
 * The trialer's side, in their own time zone: the morning check-in as near 9:30 AM their time as the team allows, the night one
 * as near 9:00 PM their time; first looked for in their waking hours (morning 6:00 AM–12:30 PM, night 5:00 PM–1:00 AM), then
 * anywhere within 12 hours of it.
 */
import { laWall, laDate } from './takehome-nudge.mjs';

// latestStart: the usual limit; extremeStart only when nothing else fits (Project, 2026-10-18: "in extreme circumstances, meetings
// can go up until 9:45 pm for check ins").
export const TEAM = Object.freeze({ dayStart: '09:00', latestStart: '21:30', extremeStart: '21:45' });
// comfort: the trialer's own hours where a check-in before the team's EOD sync is preferred to one nearer the target.
export const TRIALER = Object.freeze({ morning: { target: '09:30', band: ['06:00', '12:30'], comfort: ['09:00', '11:00'] }, night: { target: '21:00', band: ['17:00', '25:00'], comfort: ['18:00', '22:00'] } });
export const GAP_MS = 5 * 60_000;
export const SLOT_MS = 15 * 60_000;
const STEP_MS = 5 * 60_000;
const EOD = /\bEOD\b|\bend[- ]of[- ]day\b|\bevening sync\b/i;
const BOD = /\b(?:product\s+)?stand-?\s?ups?\b|\bBOD\b|\bbeginning[- ]of[- ]day\b|\bstart[- ]of[- ]day\b|\bmorning sync\b/i;
const hm = text => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '')); return m ? [Number(m[1]), Number(m[2])] : null; };

/** Milliseconds `tz` is ahead of UTC at `ms`. */
export function tzOffset(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000;
}
/** The instant of a wall time (hours may pass 24) on `date` (YYYY-MM-DD) in `tz`. */
export function zonedWall(date, tz, h, m = 0) {
  const [y, mo, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  let ms = guess - tzOffset(guess, tz);
  ms = guess - tzOffset(ms, tz);
  return ms;
}
export const zonedDate = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
export const zonedHM = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);

const clash = (spans, start, end) => (spans ?? []).find(b => b.start < end + GAP_MS && b.end > start - GAP_MS) ?? null;

/** [earliest, latest] start on the Pacific day of `ms`: after Robin's and Interviewer's BOD sync (else 9 AM), by 9:30 PM. */
export function teamBoundsOn(ms, busy, must, { extreme = false } = {}) {
  const day = laDate(ms);
  const [sh, sm] = hm(TEAM.dayStart), [lh, lm] = hm(extreme ? TEAM.extremeStart : TEAM.latestStart);
  let earliest = laWall(day, sh, sm);
  const morningFrom = laWall(day, 6, 0), morningTo = laWall(day, 12, 0);
  for (const email of must) {
    for (const b of busy[email] ?? []) if (BOD.test(b.summary ?? '') && b.start >= morningFrom && b.start <= morningTo) earliest = Math.max(earliest, b.end + GAP_MS);
  }
  return [earliest, laWall(day, lh, lm)];
}

/** When Robin's and Interviewer's EOD sync starts on the Pacific day of `ms` (4–11 PM PT), else 8:00 PM PT. */
export function eodStartOn(ms, busy, must) {
  const day = laDate(ms), from = laWall(day, 16, 0), to = laWall(day, 23, 0);
  let eod = null;
  for (const email of must) for (const b of busy[email] ?? []) if (EOD.test(b.summary ?? '') && b.start >= from && b.start <= to) eod = eod === null ? b.start : Math.min(eod, b.start);
  return eod ?? laWall(day, 20, 0);
}
/** Whether a check-in at `t` ends (with the 5-minute gap) before that day's EOD sync. */
export const beforeEod = (t, busy, must, length = SLOT_MS) => t + length + GAP_MS <= eodStartOn(t, busy, must);

/**
 * The start nearest `target` that the team allows and Robin and Interviewer have free (Taylor too when possible), first inside
 * [bandFrom, bandTo], then within 12 hours of the target. constraints: [{ from?, to? }] Pacific HH:MM bounds people asked for.
 * -> ms or null.
 */
export function nearestAllowed({ target, band, busy, must, optional = [], constraints = [], length = SLOT_MS, now = 0, comfort = null }) {
  let extreme = false, preEod = false;
  const allowed = (t, who) => {
    if (t <= now) return false;
    const [e, l] = teamBoundsOn(t, busy, must, { extreme });
    if (t < e || t > l) return false;
    if (preEod && !beforeEod(t, busy, must, length)) return false;
    for (const c of constraints) {
      const day = laDate(t), f = hm(c.from), to = hm(c.to);
      if (f && t < laWall(day, f[0], f[1])) return false;
      if (to && t > laWall(day, to[0], to[1])) return false;
    }
    return who.every(email => !clash(busy[email], t, t + length));
  };
  const search = (from, to) => {
    const times = [];
    for (let t = Math.ceil(from / STEP_MS) * STEP_MS; t <= to; t += STEP_MS) times.push(t);
    times.sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || a - b);
    for (const who of [[...must, ...optional], must]) for (const t of times) if (allowed(t, who)) return t;
    return null;
  };
  // Before the EOD sync, when that still falls in the trialer's own working hours (an American evening, never an Indian dawn).
  if (comfort) {
    preEod = true;
    const early = search(Math.max(comfort[0], band[0]), Math.min(comfort[1], band[1]));
    preEod = false;
    if (early !== null) return early;
  }
  const usual = search(band[0], band[1]) ?? search(target - 12 * 3600_000, target + 12 * 3600_000);
  if (usual !== null) return usual;
  // Nothing by 9:30 PM PT: up to 9:45 PM, only now.
  extreme = true;
  return search(band[0], band[1]) ?? search(target - 12 * 3600_000, target + 12 * 3600_000);
}
/** True when `ms` starts after the usual 9:30 PM PT limit (the 9:45 PM exception). */
export const isLate = ms => { const [lh, lm] = hm(TEAM.latestStart); return ms > laWall(laDate(ms), lh, lm); };

/** The trialer's target and waking band for one check-in on their date `date`, in `tz`. */
export function trialerSlot(kind, date, tz, targetHM = null) {
  const spec = TRIALER[kind];
  const [th, tm] = hm(targetHM ?? spec.target), [fh, fm] = hm(spec.band[0]), [bh, bm] = hm(spec.band[1]), [ch, cm] = hm(spec.comfort[0]), [dh, dm] = hm(spec.comfort[1]);
  return { target: zonedWall(date, tz, th, tm), band: [zonedWall(date, tz, fh, fm), zonedWall(date, tz, bh, bm)], comfort: [zonedWall(date, tz, ch, cm), zonedWall(date, tz, dh, dm)] };
}

// Where people are -> their time zone. Countries, big cities, US states and the usual abbreviations; anything else is asked.
const ZONES = [
  [/\b(india|ist|bengaluru|bangalore|hyderabad|pune|mumbai|bombay|delhi|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|jaipur|kochi|indore|chandigarh|lucknow|kerala|karnataka|maharashtra|telangana|tamil nadu|gujarat|haryana|west bengal|rajasthan|andhra pradesh|madhya pradesh|odisha|uttar pradesh)\b/i, 'Asia/Kolkata'],
  [/\b(pakistan|karachi|lahore|islamabad|pkt)\b/i, 'Asia/Karachi'], [/\b(bangladesh|dhaka)\b/i, 'Asia/Dhaka'], [/\b(nepal|kathmandu)\b/i, 'Asia/Kathmandu'],
  [/\b(sri lanka|colombo)\b/i, 'Asia/Colombo'], [/\b(dubai|abu dhabi|uae|united arab emirates|gst)\b/i, 'Asia/Dubai'], [/\b(israel|tel aviv|jerusalem)\b/i, 'Asia/Jerusalem'],
  [/\b(singapore|sgt|malaysia|kuala lumpur)\b/i, 'Asia/Singapore'], [/\b(china|beijing|shanghai|shenzhen|hangzhou|guangzhou|hong kong|taiwan|taipei|hkt|cst china)\b/i, 'Asia/Shanghai'],
  [/\b(japan|tokyo|osaka|jst)\b/i, 'Asia/Tokyo'], [/\b(korea|seoul|kst)\b/i, 'Asia/Seoul'], [/\b(philippines|manila)\b/i, 'Asia/Manila'],
  [/\b(vietnam|ho chi minh|hanoi|thailand|bangkok)\b/i, 'Asia/Bangkok'], [/\b(indonesia|jakarta)\b/i, 'Asia/Jakarta'],
  [/\b(perth)\b/i, 'Australia/Perth'], [/\b(brisbane|queensland)\b/i, 'Australia/Brisbane'], [/\b(australia|sydney|melbourne|canberra|aest)\b/i, 'Australia/Sydney'],
  [/\b(new zealand|auckland|wellington|nzst)\b/i, 'Pacific/Auckland'],
  [/\b(uk|united kingdom|england|scotland|london|manchester|edinburgh|ireland|dublin|gmt|bst)\b/i, 'Europe/London'], [/\b(portugal|lisbon|porto)\b/i, 'Europe/Lisbon'],
  [/\b(ukraine|kyiv|kiev|romania|bucharest|greece|athens|finland|helsinki|bulgaria|sofia|estonia|latvia|lithuania|eet)\b/i, 'Europe/Bucharest'],
  [/\b(turkey|istanbul|ankara)\b/i, 'Europe/Istanbul'],
  [/\b(germany|berlin|munich|hamburg|france|paris|spain|madrid|barcelona|italy|rome|milan|netherlands|amsterdam|belgium|brussels|switzerland|zurich|geneva|austria|vienna|poland|warsaw|krakow|czech|prague|sweden|stockholm|norway|oslo|denmark|copenhagen|hungary|budapest|serbia|belgrade|croatia|cet|cest)\b/i, 'Europe/Berlin'],
  [/\b(nigeria|lagos|abuja)\b/i, 'Africa/Lagos'], [/\b(kenya|nairobi)\b/i, 'Africa/Nairobi'], [/\b(egypt|cairo)\b/i, 'Africa/Cairo'], [/\b(south africa|johannesburg|cape town)\b/i, 'Africa/Johannesburg'],
  [/\b(brazil|s[aã]o paulo|rio de janeiro|brt)\b/i, 'America/Sao_Paulo'], [/\b(argentina|buenos aires)\b/i, 'America/Argentina/Buenos_Aires'], [/\b(mexico city|guadalajara)\b/i, 'America/Mexico_City'],
  [/\b(colombia|bogot[aá]|peru|lima)\b/i, 'America/Bogota'],
  [/\b(vancouver|british columbia)\b/i, 'America/Vancouver'], [/\b(toronto|ontario|montreal|quebec|ottawa)\b/i, 'America/Toronto'],
  [/\b(pt|pst|pdt|pacific|california|san francisco|sf|bay area|los angeles|la|san diego|san jose|seattle|washington state|oregon|portland|nevada|las vegas)\b/i, 'America/Los_Angeles'],
  [/\b(arizona|phoenix)\b/i, 'America/Phoenix'], [/\b(mt|mst|mdt|mountain|colorado|denver|utah|salt lake)\b/i, 'America/Denver'],
  [/\b(ct|cst|cdt|central|texas|austin|dallas|houston|chicago|illinois|minnesota|minneapolis|missouri|wisconsin|tennessee|nashville)\b/i, 'America/Chicago'],
  [/\b(et|est|edt|eastern|new york|nyc|boston|massachusetts|new jersey|philadelphia|pennsylvania|florida|miami|atlanta|georgia|washington,? dc|dc|virginia|north carolina|ohio|michigan|detroit|maryland|connecticut)\b/i, 'America/New_York'],
];
/** An IANA time zone from a place or zone name ("Bangalore", "Berlin, Germany", "ET"), or null. */
export function zoneOfPlace(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  try { if (/^[A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?$/.test(t)) { new Intl.DateTimeFormat('en-US', { timeZone: t }); return t; } } catch { /* not a zone id */ }
  for (const [re, tz] of ZONES) if (re.test(t)) return tz;
  return null;
}

/** The trialer's time zone: what Project or the team said (kept), the India pipeline, else where the notes say they are based. */
export async function trialTimeZone({ candidate, kv = null, notes = [] }) {
  const kept = kv ? await kv.get(`trialtz:${candidate.pageId}`).catch(() => null) : null;
  if (kept?.tz) return { tz: kept.tz, from: kept.from ?? 'set' };
  const f = candidate.fields ?? {};
  if (/india/i.test(`${f.Pipeline ?? ''}`) || f['India Stage']) return { tz: 'Asia/Kolkata', from: 'India pipeline' };
  for (const n of notes) {
    const m = /\bbased in ([^.;()]{2,80})/i.exec(n?.text ?? '');
    const tz = m ? zoneOfPlace(m[1]) : null;
    if (tz) return { tz, from: m[1].trim() };
  }
  for (const key of ['Location', 'Based', 'City', 'Country']) { const tz = zoneOfPlace(f[key]); if (tz) return { tz, from: f[key] }; }
  return { tz: null, from: null };
}
