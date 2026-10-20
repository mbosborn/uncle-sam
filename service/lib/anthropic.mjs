/**
 * Minimal Messages API client for the runtime. No SDK, no retries, bounded responses, and error codes that never echo
 * request or response bodies. The runner owns the tool loop; this module only performs one HTTP round trip.
 *
 * Two routes speak the same Messages shape. "anthropic" is Anthropic's own API (the default). "openrouter" is OpenRouter's
 * Anthropic-compatible endpoint; its requests are pinned to Anthropic's own endpoint with no fallback, so the vendor that
 * sees the text is the same as on the direct route and a model's thinking blocks are never replayed to a different host.
 */
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MODEL = 'claude-sonnet-4-5';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/messages';
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';
export const OPENROUTER_PROVIDER = Object.freeze({ only: Object.freeze(['anthropic']), allow_fallbacks: false });
/**
 * The current Claude models think by default and thinking counts against max_tokens, so a small limit can end a turn
 * inside the thinking, with no tool call. The limit is a ceiling, not a spend: only generated tokens are billed.
 */
export const DEFAULT_MAX_TOKENS = 8192;

const ROUTES = Object.freeze({
  anthropic: Object.freeze({
    url: ANTHROPIC_URL, model: DEFAULT_MODEL, pattern: /^[a-z0-9.-]{3,80}$/i,
    notConfigured: 'anthropic_not_configured', httpError: 'anthropic_http_',
    headers: key => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' }),
    extra: () => ({}),
  }),
  openrouter: Object.freeze({
    url: OPENROUTER_URL, model: DEFAULT_OPENROUTER_MODEL, pattern: /^~?[a-z0-9][a-z0-9._-]{0,39}\/[a-z0-9][a-z0-9._:-]{1,79}$/i,
    notConfigured: 'openrouter_not_configured', httpError: 'openrouter_http_',
    headers: key => ({ authorization: `Bearer ${key}`, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' }),
    extra: () => ({ provider: OPENROUTER_PROVIDER }),
  }),
});

/** True when `name` is an acceptable model id for the route; the client and the setup checks share this one rule. */
export const isModelName = (route, name) => Object.hasOwn(ROUTES, route) && typeof name === 'string' && ROUTES[route].pattern.test(name);

export class ClaudeError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

async function boundedJson(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new ClaudeError('response_too_large');
  if (!response.body) throw new ClaudeError('invalid_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new ClaudeError('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ClaudeError('invalid_response'); }
}

export function createClaudeClient({ apiKey, route = 'anthropic', model, fetchImpl = globalThis.fetch,
  timeoutMs = 60000, maxTokens = DEFAULT_MAX_TOKENS, maxResponseBytes = 1024 * 1024 } = {}) {
  if (typeof route !== 'string' || !Object.hasOwn(ROUTES, route)) throw new ClaudeError('invalid_route', 503);
  const target = ROUTES[route];
  if (typeof apiKey !== 'string' || !apiKey || /\s/.test(apiKey)) throw new ClaudeError(target.notConfigured, 503);
  const name = model === undefined ? target.model : model;
  if (!isModelName(route, name)) throw new ClaudeError('invalid_model', 503);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) {
    throw new ClaudeError('invalid_client_configuration', 503);
  }
  return Object.freeze({
    model: name,
    route,
    /** One Messages API call. Content blocks are returned as-is; callers validate tool_use inputs. */
    async complete({ system, messages, tools, toolChoice, maxTokens: perCall } = {}) {
      if (!Array.isArray(messages) || !messages.length) throw new ClaudeError('messages_required');
      // A string cut in the middle of an emoji leaves half a surrogate pair, which the API refuses (400): make every string whole.
      const whole = v => typeof v === 'string' ? v.toWellFormed() : Array.isArray(v) ? v.map(whole) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, whole(x)])) : v;
      const body = { model: name, max_tokens: Number.isSafeInteger(perCall) ? perCall : maxTokens, messages: whole(messages), ...target.extra() };
      if (typeof system === 'string' && system) body.system = whole(system);
      if (Array.isArray(tools) && tools.length) body.tools = tools;
      // The configured model refuses a forced tool ("tool_choice: type tool and any are not supported for this model", seen
      // Oct 16): ask for auto; every caller's system prompt already says to call its one tool exactly once and checks the result.
      if (toolChoice) body.tool_choice = toolChoice.type === 'none' ? toolChoice : { type: 'auto' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(target.url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: target.headers(apiKey),
          body: JSON.stringify(body),
        });
      } catch (error) {
        clearTimeout(timer);
        throw new ClaudeError(error?.name === 'AbortError' ? 'request_timeout' : 'network_error');
      }
      clearTimeout(timer);
      if (!response.ok) {
        // The API's own one-line reason (never the request, never a key), for the logs.
        let reason = '';
        try { reason = String(JSON.parse((await response.text()).slice(0, 4000))?.error?.message ?? '').replace(/[^\w .,:;'()-]/g, ' ').slice(0, 160); } catch { reason = ''; }
        const error = new ClaudeError(`${target.httpError}${response.status}`, response.status);
        error.reason = reason;
        throw error;
      }
      const data = await boundedJson(response, maxResponseBytes);
      if (data?.type !== 'message' || !Array.isArray(data.content)) throw new ClaudeError('invalid_response');
      return { id: data.id, model: data.model, stopReason: data.stop_reason, content: data.content,
        usage: { input: data.usage?.input_tokens ?? null, output: data.usage?.output_tokens ?? null },
        // OpenRouter names the provider that served the call; a short string or nothing, never an object we would have to trust.
        servedBy: typeof data.provider === 'string' && data.provider.length > 0 && data.provider.length <= 60 ? data.provider : null };
    },
  });
}
