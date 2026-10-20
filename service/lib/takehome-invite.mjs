/**
 * Take-home invites (Project, 2026-10-15). When Robin, Alexis or Interviewer move a candidate on to the take-home, Uncle Sam:
 *   1. queues the "Email · Case Study · Take-Home (Vercel)" template for Project's Gmail on an Operations row (Action
 *      email.takehome_invite, State Held) and gives Project a heads-up with a Cancel button (every automatic email waits at
 *      least 30 minutes);
 *   2. when the 30 minutes are up and nobody cancelled, creates the candidate on Interviewer's take-home site
 *      (company-takehome.vercel.app, a create-only key), puts their link into the email and sets the row Ready;
 *   3. the clerk sends it from Project's Gmail on its next run, after checking his Sent mail for an earlier take-home.
 * Pure helpers and the portal client live here; the runner (agent-runner.mjs) does the steps.
 */
export const TAKEHOME_TEMPLATE_ID = '8b6b201d-3942-455f-9918-cccf59411ab4';
export const TAKEHOME_INVITE_ACTION = 'email.takehome_invite';
export const TAKEHOME_HOLD_MS = 30 * 60_000;
export const PORTAL_ORIGIN = 'https://company-takehome.vercel.app';
const LINK_SLOT = '[Unique candidate Vercel link]';
const PLACEHOLDER = /\{\{[^}]*\}\}|\[[A-Z][^\]]*\]/;

export class PortalError extends Error {
  constructor(code, status = 0, uncertain = false) { super(code); this.code = code; this.status = status; this.uncertain = uncertain; }
}

/**
 * The template with the first name filled in and the link slot kept for later. Markdown links become "text (url)" in
 * the plain-text body (the clerk renders the link text as a clickable link in the HTML part). Null when the template
 * changed shape (a placeholder other than the two it may carry), so nothing is queued.
 */
export function fillTakeHomeEmail(template, { firstName }) {
  if (!template || typeof firstName !== 'string' || !firstName.trim()) return null;
  if (!template.body.includes(LINK_SLOT)) return null;
  const body = template.body.replaceAll('[First name]', firstName.trim()).replace(/\[([^\]]+)\]\((\[Unique candidate Vercel link\]|https:\/\/[^)\s]+)\)/g, '$1 ($2)');
  const subject = template.subject.replaceAll('[First name]', firstName.trim());
  const rest = body.replaceAll(LINK_SLOT, '');
  if (PLACEHOLDER.test(subject) || PLACEHOLDER.test(rest) || subject.length > 200 || body.length > 1700) return null;
  return { subject, body };
}

/** The queued body with the candidate's own portal link in place of the slot. */
export function insertTakeHomeLink(body, url) {
  if (typeof body !== 'string' || !body.includes(LINK_SLOT) || !isPortalLink(url)) return null;
  const filled = body.replaceAll(LINK_SLOT, url);
  return PLACEHOLDER.test(filled.replaceAll(url, '')) ? null : filled;
}

export const isPortalLink = url => { try { const u = new URL(url); return u.origin === PORTAL_ORIGIN && u.pathname.length > 1; } catch { return false; } };

/**
 * Creates one candidate on the take-home site and returns their link. The key can only create (it cannot list, grade or
 * delete). A timeout or network failure is "uncertain": the candidate may exist, so it is never retried automatically.
 * Never logs or returns the key or the response body.
 */
export async function createPortalCandidate({ env, fetchImpl = fetch, name, email, track = 'research', timeoutMs = 10_000 }) {
  const key = env?.TAKEHOME_PORTAL_KEY;
  if (typeof key !== 'string' || key.length < 16) throw new PortalError('portal_key_missing');
  if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw new PortalError('invalid_candidate');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${PORTAL_ORIGIN}/api/admin/candidates`, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.trim().slice(0, 160), email: email.trim(), track, linkWindow: '7d' }) });
  } catch (error) {
    throw new PortalError(error?.name === 'AbortError' ? 'portal_timeout' : 'portal_network_error', 0, true);
  } finally { clearTimeout(timer); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new PortalError(`portal_http_${response.status}`, response.status, response.status >= 500);
  }
  let data;
  try { data = JSON.parse((await response.text()).slice(0, 20_000)); } catch { throw new PortalError('portal_bad_response', response.status, true); }
  const url = data?.url ?? data?.candidate?.url;
  if (!isPortalLink(url)) throw new PortalError('portal_no_link', response.status, true);
  return { url };
}
