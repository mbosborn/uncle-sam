/**
 * A fake Slack must not be more forgiving than the real one. Checked against the live API (2026-10-14): a method that does
 * not take JSON ignores the arguments of a JSON body (users.info answered user_not_found, bots.info an empty bot); only
 * chat.postMessage reads JSON. The list below is deliberately NOT imported from the service, so a wrong list there cannot
 * quietly change what the fakes accept.
 */
const TAKES_JSON = new Set(['chat.postMessage']);

/** What Slack would read from this body: a form for every method, JSON only where documented, anything else is ignored. */
export function parseSlackBody(method, contentType, raw) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const text = typeof raw === 'string' ? raw : '';
  if (type === 'application/x-www-form-urlencoded') return { type, args: Object.fromEntries(new URLSearchParams(text)) };
  if (type === 'application/json' && TAKES_JSON.has(method) && text) return { type, args: JSON.parse(text) };
  return { type, args: {} };
}

/** Same, for a fetch call: its URL and init. */
export function slackArguments(url, init = {}) {
  const method = new URL(String(url)).pathname.replace(/^.*\/api\//, '');
  const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, ...parseSlackBody(method, headers['content-type'], init.body) };
}
