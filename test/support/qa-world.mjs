/**
 * One in-memory fake of everything an @-mention question touches: the Notion REST API (control row, the Recruiting Pipeline),
 * the Slack Web API (users.info and chat.postMessage; any other method throws) and the model. Every request is recorded, and a
 * request the real services would not accept as written is refused here too: Slack arguments are read through the independent
 * oracle in slack-wire.mjs (a form for users.info, JSON for chat.postMessage), and every call must use `redirect: 'error'`.
 */
import assert from 'node:assert/strict';
import { RECRUITING_SOURCE_ID } from '../../service/lib/notion-client.mjs';
import { CONTROL_PAGE_ID, OPS_SOURCE_ID } from '../../service/lib/notion-wake.mjs';
import { APP_ID, TEAM_ID } from '../../service/lib/identity.mjs';
import { slackArguments } from './slack-wire.mjs';

export { APP_ID, TEAM_ID, CONTROL_PAGE_ID, RECRUITING_SOURCE_ID };
export const NOW = Date.parse('2026-10-14T15:20:00Z'); // Wed 2026-10-14 08:20 PDT
export const ACTIVATED = '2026-10-12T07:00:00.000Z';
export const BOT_USER = 'UUNCLESAM', BOT_ID = 'BUNCLESAM';
export const SLACK_TOKEN = 'xoxb-fixture-only';
export const ASKER = 'U0CB213D6D6';
export const SENTINELS = Object.freeze({ brief: 'SENTINEL-BRIEF-4471', next: 'SENTINEL-NEXT-ACTION-4472', rejection: 'SENTINEL-REJECTION-4473',
  notes: 'SENTINEL-NOTES-4474', pay: 'SENTINEL-PAYMENT-4475' });

/** A Slack timestamp for a millisecond time (the seconds part is what the store reads as "when the question was asked"). */
export const tsAt = (ms, micro = '000100') => `${Math.floor(ms / 1000)}.${micro}`;

const rt = text => ({ type: 'rich_text', rich_text: text ? [{ type: 'text', plain_text: text, text: { content: text } }] : [] });
const sel = name => ({ type: 'select', select: name ? { name } : null });
export const uuid = n => `${String(n).padStart(8, '0')}-1111-4222-8333-444444444444`;
/** The address Notion gives a page: its title as a slug, then the page id without dashes. */
export const recordUrlFor = (n, name) => {
  const slug = String(name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `https://www.notion.so/${slug ? `${slug}-` : ''}${uuid(n).replaceAll('-', '')}`;
};

export function controlPage({ mode = 'Live', baseline = true, activatedAt = ACTIVATED, questions } = {}) {
  return { object: 'page', id: CONTROL_PAGE_ID, archived: false, in_trash: false, properties: {
    'Record kind': sel('Control'), 'Request key': rt('uncle-sam:control'), Mode: sel(mode), State: sel('Ready'),
    'Baseline complete': { type: 'checkbox', checkbox: baseline }, 'Activated at': { type: 'date', date: activatedAt ? { start: activatedAt } : null },
    'Policy version': rt('2026-10-14.test'), 'Result evidence': rt(''), ...(questions !== undefined ? { Questions: sel(questions) } : {}) } };
}

/**
 * A Recruiting Pipeline page. The brief, next action, rejection status, notes and payment fields always carry sentinel text,
 * so a test can prove that none of it can ever reach a reply.
 */
export function candidatePage({ n = 1, name = 'Alex Rivera', email = `candidate${n}@example.invalid`, stage = 'Interview', round = 'R2 — Technical',
  outcome = 'Proceeding', status = 'Awaiting Feedback', owner = [], followUp = null, role = '', pipeline = 'US/EU', from = null, linkedin = null,
  url, archived = false, parent = RECRUITING_SOURCE_ID, extra = {} } = {}) {
  return { object: 'page', id: uuid(n), url: url === undefined ? recordUrlFor(n, name) : url, archived, in_trash: false,
    last_edited_time: '2026-10-13T20:00:00.000Z', parent: { type: 'data_source_id', data_source_id: parent }, properties: {
      Candidate: { type: 'title', title: [{ plain_text: `${name} ⭐` }] }, Email: { type: 'email', email },
      Pipeline: sel(pipeline), Stage: sel(stage), Round: sel(round), Outcome: sel(outcome), 'Action Status': sel(status),
      Owner: { type: 'multi_select', multi_select: owner.map(label => ({ name: label })) },
      'Follow-up Date': { type: 'date', date: followUp ? { start: followUp } : null }, Role: rt(role),
      From: sel(from), LinkedIn: { type: 'url', url: linkedin },
      'Candidate brief': rt(SENTINELS.brief), 'Next action': rt(SENTINELS.next), 'Rejection email status': sel(SENTINELS.rejection),
      'Outcome Notes': rt(SENTINELS.notes), 'Amount Owed/Paid': rt(SENTINELS.pay), ...extra } };
}

/** What users.info returns for a normal full member; overrides turn them into a guest, a bot, and so on. */
export const member = (id, overrides = {}) => ({ id, team_id: TEAM_ID, deleted: false, is_bot: false, is_app_user: false,
  is_restricted: false, is_ultra_restricted: false, ...overrides });

const textOf = parts => (parts ?? []).map(part => part.plain_text ?? part.text?.content ?? '').join('');
const headersOf = init => (init.headers instanceof Headers ? Object.fromEntries(init.headers)
  : Object.fromEntries(Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])));

export function qaWorld({ control = {}, candidates = [candidatePage()], members = {}, writable = false, interviews = [], threads = {}, history = {} } = {}) {
  const pages = new Map([[CONTROL_PAGE_ID, controlPage(control)], ...candidates.map(page => [page.id, page])]);
  const notionCalls = [], slackCalls = [], posts = [], otherCalls = [];
  const world = {
    pages, notionCalls, slackCalls, posts, otherCalls,
    members: { [ASKER]: member(ASKER), ...members },
    /** Flip these to make the fake misbehave: userInfo ok|error|http500|throw, post ok|refused|http429|http500|badjson|wrongchannel|throw, query ok|fail. */
    behavior: { userInfo: 'ok', post: 'ok', postError: 'not_in_channel', query: 'ok', members: 'ok' },
    /** Members of each conversation, for conversations.members (the asker room). */
    roomMembers: {},
    /** Handler for the model over HTTP (end-to-end tests only): (body, init) => Response. */
    claude: null,
    notionWrites: () => notionCalls.filter(call => call.method !== 'GET' && !/\/query$/.test(call.path)),
    slackMethods: () => slackCalls.map(call => call.method),
  };

  function notion(method, path, body) {
    notionCalls.push({ method, path, body });
    const page = path.match(/^\/pages\/([0-9a-f-]+)$/i);
    if (page && method === 'GET') {
      const found = pages.get(page[1].toLowerCase());
      return found ? [200, found] : [404, { object: 'error', code: 'object_not_found' }];
    }
    if (path === `/data_sources/${RECRUITING_SOURCE_ID}` && method === 'GET') return [200, { object: 'data_source', id: RECRUITING_SOURCE_ID, properties: { Candidate: { type: 'title' }, From: { type: 'select', select: { options: [{ name: 'Pareto' }] } }, Role: { type: 'rich_text' }, 'Candidate brief': { type: 'rich_text' }, 'Category Basis': { type: 'rich_text' } } }];
    const query = path.match(/^\/data_sources\/([0-9a-f-]+)\/query$/i);
    if (query && method === 'POST' && !(writable && query[1] === OPS_SOURCE_ID)) {
      if (world.behavior.query === 'fail') return [500, { object: 'error', code: 'internal_server_error' }];
      if (query[1] !== RECRUITING_SOURCE_ID) return [404, { object: 'error', code: 'object_not_found' }];
      const filter = body?.filter ?? {};
      const results = [...pages.values()].filter(candidate => candidate.parent?.data_source_id === RECRUITING_SOURCE_ID && !candidate.archived)
        .filter(candidate => (filter.or ? filter.or.some(f => { const p = candidate.properties[f.property]; return f.rich_text ? textOf(p?.rich_text).toLowerCase().includes(f.rich_text.contains.toLowerCase()) : f.title ? textOf(p?.title).toLowerCase().includes(f.title.contains.toLowerCase()) : f.select ? p?.select?.name === f.select.equals : false; }) : filter.property === 'Email' ? candidate.properties.Email?.email === filter.email?.equals
          : filter.property === 'Candidate' ? textOf(candidate.properties.Candidate.title).toLowerCase().includes(String(filter.title?.contains).toLowerCase()) : false))
        .slice(0, body?.page_size ?? 100);
      return [200, { object: 'list', results, has_more: false }];
    }
    // Record changes (an @-mention "mark X withdrawn" / "reject X"): only in a world built writable.
    if (writable && page && method === 'PATCH') {
      const found = pages.get(page[1].toLowerCase());
      if (!found) return [404, { object: 'error', code: 'object_not_found' }];
      for (const [name, value] of Object.entries(body.properties ?? {})) {
        if (value.rich_text) found.properties[name] = rt(value.rich_text.map(x => x.text.content).join(''));
        else if ('select' in value) found.properties[name] = sel(value.select?.name ?? null);
        else found.properties[name] = { type: Object.keys(value)[0], ...value };
      }
      return [200, found];
    }
    if (writable && /^\/blocks\/[0-9a-f-]+\/children$/i.test(path) && method === 'PATCH') return [200, { object: 'list', results: [{ object: 'block', id: 'bbbbbbbb-0000-4000-8000-000000000001' }] }];
    if (writable && query && method === 'POST' && query[1] === OPS_SOURCE_ID) {
      const id = body?.filter?.and?.find(f => f.relation)?.relation.contains;
      return [200, { object: 'list', results: interviews.filter(row => row.properties.Candidate.relation.some(r => r.id === id)), has_more: false }];
    }
    return [500, { object: 'error', code: 'unexpected_notion_call' }]; // a write lands here; it is recorded in notionCalls and notionWrites()
  }

  function slack(url, init) {
    const { method, type, args } = slackArguments(url, init);
    const headers = headersOf(init);
    slackCalls.push({ method, type, args, authorization: headers.authorization });
    if (method === 'users.info') {
      if (world.behavior.userInfo === 'throw') throw new TypeError('network down');
      if (world.behavior.userInfo === 'http500') return new Response('boom', { status: 500 });
      const user = world.members[args.user];
      if (world.behavior.userInfo === 'error' || !user) return Response.json({ ok: false, error: 'user_not_found' });
      return Response.json({ ok: true, user });
    }
    if (method === 'conversations.members') {
      if (world.behavior.members === 'error') return Response.json({ ok: false, error: 'channel_not_found' });
      const all = world.roomMembers[args.channel] ?? [];
      const start = args.cursor ? Number(args.cursor) : 0, end = start + 2; // two per page, so paging is exercised
      return Response.json({ ok: true, members: all.slice(start, end), response_metadata: { next_cursor: end < all.length ? String(end) : '' } });
    }
    if (method === 'conversations.replies' && args.ts in threads) return Response.json({ ok: true, messages: threads[args.ts] });
    // Top-level messages per conversation, oldest first here; Slack returns newest first within oldest/latest (inclusive).
    if (method === 'conversations.history' && args.channel in history) return Response.json({ ok: true, messages: history[args.channel]
      .filter(m => (args.oldest == null || Number(m.ts) >= Number(args.oldest)) && (args.latest == null || Number(m.ts) <= Number(args.latest))).slice().reverse() });
    if (method === 'chat.postMessage') {
      posts.push({ ...args, contentType: type });
      switch (world.behavior.post) {
        case 'throw': throw new TypeError('connection reset');
        case 'http500': return new Response('boom', { status: 500 });
        case 'http429': return new Response('slow down', { status: 429 });
        case 'badjson': return new Response('not json', { status: 200 });
        case 'refused': return Response.json({ ok: false, error: world.behavior.postError });
        case 'wrongchannel': return Response.json({ ok: true, channel: 'CWRONGCHAN1', ts: '1792000000.000900' });
        default: return Response.json({ ok: true, channel: args.channel, ts: `1792000001.${String(posts.length).padStart(6, '0')}` });
      }
    }
    throw new Error(`Unexpected Slack method ${method}`);
  }

  world.fetchImpl = async (url, init = {}) => {
    const target = new URL(String(url));
    assert.equal(init.redirect, 'error', `${target.origin}${target.pathname} must be fetched with redirect: 'error'`);
    if (target.origin === 'https://api.notion.com') {
      assert.equal(headersOf(init)['notion-version'], '2025-09-03');
      const [status, payload] = notion(init.method ?? 'GET', target.pathname.replace(/^\/v1/, ''), init.body ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    }
    if (target.origin === 'https://slack.com') return slack(url, init);
    if (target.origin === 'https://api.anthropic.com' && world.claude) { otherCalls.push({ url: String(url) }); return world.claude(JSON.parse(init.body), init); }
    throw new Error(`Unexpected origin ${target.origin}`);
  };
  return world;
}

/**
 * The model, scripted: each step is a list of tool calls ({name, input}) or {content: [...blocks]} for a reply of exactly those
 * blocks (for example text with no tool call). Every call is logged with a deep copy of what it was sent.
 */
export function scriptedClaude(script, log = []) {
  return { model: 'fake', async complete({ system, messages, tools, toolChoice }) {
    log.push({ system, tools: tools?.map(tool => tool.name), toolChoice, snapshot: JSON.parse(JSON.stringify(messages)) });
    const next = script.shift();
    if (!next) throw new Error('model script exhausted');
    if (!Array.isArray(next)) return { id: `msg_${log.length}`, model: 'fake', stopReason: 'end_turn', content: next.content, usage: { input: 100, output: 20 } };
    const content = next.map((call, i) => ({ type: 'tool_use', id: `tu_${log.length}_${i}`, name: call.name, input: call.input }));
    return { id: `msg_${log.length}`, model: 'fake', stopReason: 'tool_use', content, usage: { input: 100, output: 20 } };
  } };
}
