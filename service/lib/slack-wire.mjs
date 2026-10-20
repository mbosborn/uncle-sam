/**
 * How requests to Slack's Web API are encoded. Slack documents which content types each method accepts, and a method that
 * does not accept JSON does not refuse it: it silently ignores the arguments in the body. Checked against the live API
 * (2026-10-14): `users.info` with a JSON body answered user_not_found and `bots.info` answered an empty bot, while the same
 * calls as a form returned the user and the bot. `chat.postMessage` is documented to take JSON. Every other method is sent
 * as a form, which every method accepts.
 */
export const JSON_METHODS = Object.freeze(['chat.postMessage']);

const formValue = value => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join(','); // e.g. the `users` of conversations.open
  return JSON.stringify(value);                                  // nested values travel as JSON text
};

/** The headers and body for one Web API call; the caller adds method, redirect and signal. */
export function slackWire(method, token, parameters = {}) {
  const authorization = `Bearer ${token}`;
  if (JSON_METHODS.includes(method)) return { headers: { authorization, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(parameters) };
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null) form.set(key, formValue(value));
  return { headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() };
}
