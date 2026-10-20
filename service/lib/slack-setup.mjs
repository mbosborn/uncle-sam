/**
 * Pure helpers behind scripts/slack-bootstrap.mjs: the Slack scopes Uncle Sam needs, the conversations it needs, and whether a
 * Slack account really is the person we think it is. No network, no filesystem; everything here is unit-tested.
 */
import { PEOPLE, ROUTE_RECIPIENTS } from './agent-runner.mjs';
import { TEAM_ID } from './identity.mjs';
import { parseRouteMap } from './runtime.mjs';

/** Used by the running service: chat.postMessage, conversations.history/replies/info/members and bots.info (docs.slack.dev, checked 2026-10-14). */
export const RUNTIME_SCOPES = Object.freeze(['chat:write', 'im:history', 'im:read', 'mpim:history', 'mpim:read', 'users:read']);
/** Optional: ✅ on interview recaps Uncle Sam has put on the tracker (recap-intake.mjs). Without it the ✅ is skipped. */
export const OPTIONAL_SCOPES = Object.freeze(['reactions:write', 'files:read', 'groups:history', 'groups:read', 'channels:history', 'users:read.email']);
/** Used once, to open the direct and group conversations (conversations.open). */
export const OPEN_SCOPES = Object.freeze(['im:write', 'mpim:write']);

/** Slack reports a bot token's scopes in the x-oauth-scopes response header of auth.test, comma separated. */
export const parseScopes = header => String(header ?? '').split(',').map(scope => scope.trim()).filter(Boolean);

export function scopeReport(granted) {
  const have = new Set(granted);
  const needed = new Set([...RUNTIME_SCOPES, ...OPEN_SCOPES]);
  return {
    missingRuntime: RUNTIME_SCOPES.filter(scope => !have.has(scope)),
    missingOpen: OPEN_SCOPES.filter(scope => !have.has(scope)),
    unused: [...have].filter(scope => !needed.has(scope)).sort(),
  };
}

// Who each route must reach is decided in agent-runner.mjs (PEOPLE, ROUTE_RECIPIENTS). These patterns are a second opinion on the
// ids: they catch a wrong id (for example AA must be Rory Marshall, never Rowan Brooks) before any conversation is opened.
const NAME_PATTERNS = Object.freeze({ project: /project|mase/i, jamie: /jamie/i, aa: /rory/i, robin: /robin/i, alexis: /alexis/i, interviewer: /interviewer|quinn/i });
export const PEOPLE_KEYS = Object.freeze(Object.keys(PEOPLE));

export const namesOf = user => [user?.real_name, user?.name, user?.profile?.real_name, user?.profile?.display_name]
  .filter(value => typeof value === 'string' && value.trim());

/** Checks a Slack users.info `user` object against the person it should be. Never throws. */
export function checkPerson(person, user) {
  const id = PEOPLE[person];
  const names = namesOf(user);
  if (!id || !NAME_PATTERNS[person]) return { ok: false, reason: 'is not one of the people Uncle Sam knows', names };
  if (user?.id !== id) return { ok: false, reason: 'Slack returned a different user id', names };
  if (user.deleted) return { ok: false, reason: 'the account is deactivated', names };
  if (user.is_bot || user.is_app_user) return { ok: false, reason: 'the account is a bot', names };
  if (user.team_id && user.team_id !== TEAM_ID) return { ok: false, reason: 'the account belongs to another workspace', names };
  if (!NAME_PATTERNS[person].test(names.join(' '))) return { ok: false, reason: `the name (${names[0] ?? 'none'}) does not match who ${person} should be`, names };
  return { ok: true, names };
}

/** One entry per route key: the people, their Slack ids and the conversation type (two people means a group DM). */
export function routePlan() {
  // Group DMs for interviewers taking an interview together are opened by Uncle Sam as needed (group-routes.mjs), not here.
  return Object.entries(ROUTE_RECIPIENTS).filter(([key]) => !key.startsWith('group_')).map(([key, people]) => ({
    key, people: [...people], userIds: people.map(person => PEOPLE[person]), type: people.length === 2 ? 'mpim' : 'im',
  }));
}

/** The exact member set a route's conversation must have: its people plus the bot (the dispatcher verifies the same set). */
export const expectedMembers = (route, botUserId) => [...new Set([...route.userIds, botUserId])].sort();

/** SLACK_ROUTE_MAP_JSON from the opened conversations; throws if the result would not pass parseRouteMap. */
export function buildRouteMapJson(opened) {
  const map = {};
  for (const { key, channelId, type } of opened) map[key] = { channelId, type };
  parseRouteMap(map);
  return JSON.stringify(map);
}
