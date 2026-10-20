/**
 * Group DMs for interviews taken together (Project, 2026-10-16: "it should be able to do this with everyone"): any two or
 * more of the interviewers (AA, Robin, Alexis, Interviewer) can be asked in one group DM with Uncle Sam. Each combination has a
 * fixed route key ("group_rishi_santosh"); its conversation is opened the first time it is needed (conversations.open with
 * exactly those people) and remembered. The dispatcher still checks, before every post, that the conversation is a private
 * group DM whose members are exactly those people and Uncle Sam.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { slackWire } from './slack-wire.mjs';

export const GROUPABLE = Object.freeze(['aa', 'robin', 'alexis', 'interviewer']);
export const groupRouteKey = names => `group_${[...new Set(names)].sort().join('_')}`;

function combinations(list) {
  const out = [];
  for (let mask = 1; mask < 1 << list.length; mask++) {
    const pick = list.filter((_, i) => mask & (1 << i));
    if (pick.length >= 2) out.push(pick);
  }
  return out;
}
/** Every group route key and its people, e.g. group_rishi_santosh: ['robin', 'interviewer']. */
export const GROUP_ROUTES = Object.freeze(Object.fromEntries(combinations(GROUPABLE).map(names => [groupRouteKey(names), Object.freeze([...names].sort())])));
export const isGroupRoute = key => Object.prototype.hasOwnProperty.call(GROUP_ROUTES, key);

const STORE_KEY = 'group-routes';
const channelPattern = /^[CG][A-Z0-9]{6,}$/;

/**
 * The group DMs Uncle Sam has opened: `routes` is shared (runner and dispatcher read it), `load()` fills it from the
 * database, `ensure(names, ids)` opens one when missing. Opening needs the bot's mpim:write scope; without it, it throws and
 * the caller asks each person on their own instead.
 */
export function createGroupRoutes({ db = null, env = {}, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const routes = {};
  const kv = db?.prepare ? noticeStore(db) : null;
  async function load() {
    if (!kv) return routes;
    const saved = await kv.get(STORE_KEY);
    for (const [key, route] of Object.entries(saved ?? {})) if (isGroupRoute(key) && channelPattern.test(route?.channelId ?? '')) routes[key] = { channelId: route.channelId, type: 'mpim' };
    return routes;
  }
  async function ensure(names, ids) {
    const key = groupRouteKey(names);
    if (!isGroupRoute(key)) { const e = new Error('not_a_group'); e.code = 'not_a_group'; throw e; }
    if (routes[key]) return key;
    await load();
    if (routes[key]) return key;
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(env.SLACK_BOT_TOKEN ?? '') || !kv) { const e = new Error('group_open_unavailable'); e.code = 'group_open_unavailable'; throw e; }
    const { headers, body } = slackWire('conversations.open', env.SLACK_BOT_TOKEN, { users: ids, return_im: false });
    const response = await fetchImpl('https://slack.com/api/conversations.open', { method: 'POST', headers, body, redirect: 'error' });
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    const channelId = json?.channel?.id;
    if (!json?.ok || !channelPattern.test(channelId ?? '')) { const e = new Error('group_open_failed'); e.code = `group_open_${String(json?.error ?? 'failed').slice(0, 40)}`; throw e; }
    const saved = (await kv.get(STORE_KEY)) ?? {};
    saved[key] = { channelId, openedAt: clock() };
    await kv.put(STORE_KEY, saved, clock());
    routes[key] = { channelId, type: 'mpim' };
    return key;
  }
  const keyOfChannel = channelId => Object.entries(routes).find(([, r]) => r.channelId === channelId)?.[0] ?? null;
  return Object.freeze({ routes, load, ensure, keyOfChannel });
}
