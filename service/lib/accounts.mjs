/**
 * Uncle Sam creating a work-trial hire's Company Google account itself (Project, 2026-10-16: "could uncle sam set up their email
 * account and their slack account like jamie does?"). Built but OFF until Project has the permissions and the email ready:
 *
 *  - UNCLE_SAM_ACCOUNT_CREATION=on turns it on. It then also needs: Project's Google grant with the Admin SDK user scope
 *    (admin.directory.user; his account must hold a Workspace admin role that can create users), UNCLE_SAM_SLACK_JOIN_URL
 *    (the Slack sign-up link for @company.example addresses, which needs Slack's approved-domain sign-up on), and the
 *    "Email · Work Trial · Company accounts" template with no DRAFT in its title or subject. Anything missing: Project is told
 *    once and Jamie is asked instead, as before.
 *  - Same timing as Jamie's request (onboarding.mjs). Project gets a heads-up in his DM; 30 minutes later, unless he replied
 *    "stop" in that thread, Uncle Sam creates first@company.example (or first.last@, or firstl@, whichever is free) with a
 *    one-time password Google makes them change, then emails the sign-in and the Slack join link from Project's Gmail to their
 *    personal address. The password is never stored, logged or noted. AA then gets the Okta request with the address.
 *  - One attempt each, never retried. An unclear create stops everything for that hire and Project is told.
 */
import { googleTokenProvider, adminUserGranted } from './gmail.mjs';
import { noticeStore } from './stuck-rejections.mjs';
import { parseTemplate } from './takehome-review.mjs';
import { bannerName } from './work-trial.mjs';

export const ACCOUNT_TEMPLATE_ID = '58e24a08-6b25-4376-9709-f1e992c33a09';
export const ACCOUNT_HOLD_MS = 30 * 60_000;
const DOMAIN = 'company.example';
const ADMIN_API = 'https://admin.googleapis.com/admin/directory/v1/users';
const PLACEHOLDERS = ['First name', 'Start day', 'Company email', 'Temporary password', 'Slack join link'];
const ascii = text => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').replace(/['-]/g, '').replace(/\s+/g, ' ').trim();

export class AccountError extends Error {
  constructor(code, { uncertain = false } = {}) { super(code); this.name = 'AccountError'; this.code = code; this.uncertain = uncertain; }
}
const fail = (code, opts) => { throw new AccountError(code, opts); };

export const accountCreationWanted = env => env?.UNCLE_SAM_ACCOUNT_CREATION === 'on';

/** Addresses to try, in order: first@, first.last@, firstl@ (letters only). */
export function addressCandidates(fullName) {
  const parts = ascii(bannerName(fullName)).split(' ').filter(Boolean);
  if (parts.length < 2) return [];
  const first = parts[0], last = parts[parts.length - 1];
  return [...new Set([`${first}@${DOMAIN}`, `${first}.${last}@${DOMAIN}`, `${first}${last[0]}@${DOMAIN}`])];
}

/** 16 characters, no look-alikes (0/O, 1/l/I), at least one of each kind Google may require. */
export function temporaryPassword(random = n => crypto.getRandomValues(new Uint8Array(n))) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!#%*+=?'];
  const all = sets.join('');
  const bytes = random(32);
  const chars = sets.map((s, i) => s[bytes[i] % s.length]);
  for (let i = sets.length; chars.length < 16; i++) chars.push(all[bytes[i] % all.length]);
  for (let i = chars.length - 1; i > 0; i--) { const j = bytes[16 + (i % 16)] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

/** The template filled in, or null when it is a draft or carries a placeholder Uncle Sam does not fill. */
export function fillAccountEmail(fullEmail, { firstName, startDay, address, password, joinUrl }) {
  const template = parseTemplate(fullEmail);
  if (!template || /\bDRAFT\b/i.test(template.subject)) return null;
  if (![firstName, startDay, address, password].every(v => typeof v === 'string' && v.trim())) return null;
  // The Slack join link is optional: without one the paragraph carrying it is left out and Jamie adds them to Slack.
  if (!/^https:\/\//.test(joinUrl ?? '')) template.body = template.body.split(/\n\s*\n/).filter(p => !/\[Slack join link\\?\]/.test(p)).join('\n\n');
  const values = { 'First name': firstName, 'Start day': startDay, 'Company email': address, 'Temporary password': password, 'Slack join link': joinUrl };
  let { subject, body } = template;
  for (const name of PLACEHOLDERS) { const pattern = new RegExp(`\\\\?\\[${name}\\\\?\\]`, 'g'); subject = subject.replace(pattern, values[name]); body = body.replace(pattern, values[name]); }
  if (/\[[^\]\n]{1,40}\]/.test(`${subject}\n${body}`)) return null;
  return { subject, body };
}

/** What is still missing before Uncle Sam may create accounts ([] = ready). */
export async function accountCreationMissing({ env, db, notion }) {
  const missing = [];
  if (!(await adminUserGranted({ db }).catch(() => false))) missing.push('the Google admin box on your sign-in (your account needs a Workspace admin role that can create users)');
  let full = null;
  try { full = await notion.getEmailTemplate(ACCOUNT_TEMPLATE_ID); } catch { full = null; }
  if (!fillAccountEmail(full, { firstName: 'A', startDay: 'Mon Jan 1', address: `a@${DOMAIN}`, password: 'x', joinUrl: env?.UNCLE_SAM_SLACK_JOIN_URL || null })) missing.push('the "Email · Work Trial · Company accounts" template, with DRAFT taken out of its subject');
  return missing;
}

/** Google Workspace users through the Admin SDK, on Project's grant. */
export function createWorkspaceAdmin({ env, db, fetchImpl = globalThis.fetch, clock = Date.now }) {
  const token = googleTokenProvider({ env, db, fetchImpl, clock });
  const call = async (url, init = {}, timeoutMs = 20_000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { redirect: 'error', ...init, headers: { authorization: `Bearer ${await token()}`, accept: 'application/json', ...(init.headers ?? {}) }, signal: controller.signal });
      // Google's reason for a refusal (e.g. "Not Authorized to access this resource/api", or the Admin SDK API not enabled), kept for the health check.
      if (!response.ok && response.status !== 404 && db?.prepare && typeof response.clone === 'function') {
        const body = await response.clone().json().catch(() => null);
        const reason = String(body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '').slice(0, 60);
        const message = String(body?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 240);
        await noticeStore(db).put('google-admin:last-error', { status: response.status, reason, message, method: init.method ?? 'GET', at: clock() }, clock()).catch(() => {});
      }
      return response;
    }
    finally { clearTimeout(timer); }
  };
  return Object.freeze({
    /** true when the address is taken (a user or an alias), false when free. */
    async exists(address) {
      let response;
      try { response = await call(`${ADMIN_API}/${encodeURIComponent(address)}?projection=basic&viewType=admin_view`); } catch { fail('admin_lookup_network'); }
      if (response.status === 404) return false;
      if (response.ok) return true;
      fail(`admin_lookup_http_${response.status}`);
    },
    /** One user: { primaryEmail, name, suspended, isAdmin }, or null when there is none. (Offboarding, offboarding.mjs.) */
    async get(address) {
      let response;
      try { response = await call(`${ADMIN_API}/${encodeURIComponent(address)}?projection=basic&viewType=admin_view`); } catch { fail('admin_lookup_network'); }
      if (response.status === 404) return null;
      if (!response.ok) fail(`admin_lookup_http_${response.status}`);
      const u = await response.json().catch(() => null);
      if (!u?.primaryEmail) fail('admin_lookup_invalid');
      return { id: u.id ?? null, primaryEmail: String(u.primaryEmail).toLowerCase(), name: u.name?.fullName ?? `${u.name?.givenName ?? ''} ${u.name?.familyName ?? ''}`.trim(), suspended: !!u.suspended,
        isAdmin: !!(u.isAdmin || u.isDelegatedAdmin), aliases: [...(u.aliases ?? []), ...(u.nonEditableAliases ?? [])].map(a => String(a).toLowerCase()) };
    },
    /** Users whose name matches (Google's own name search, domain users only). */
    async findByName(fullName) {
      const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
      if (parts.length < 2) return [];
      const q = `givenName:'${parts[0].replace(/'/g, '')}' familyName:'${parts[parts.length - 1].replace(/'/g, '')}'`;
      let response;
      try { response = await call(`${ADMIN_API}?customer=my_customer&maxResults=10&projection=basic&viewType=admin_view&query=${encodeURIComponent(q)}`); } catch { fail('admin_search_network'); }
      if (!response.ok) fail(`admin_search_http_${response.status}`);
      const body = await response.json().catch(() => null);
      return (body?.users ?? []).map(u => ({ primaryEmail: String(u.primaryEmail).toLowerCase(), name: u.name?.fullName ?? '', suspended: !!u.suspended, isAdmin: !!(u.isAdmin || u.isDelegatedAdmin) }));
    },
    /** Suspends one user (reversible; never deletes). Reads back. Unclear answers are uncertain and never retried. */
    async suspend(address) {
      let response;
      try {
        response = await call(`${ADMIN_API}/${encodeURIComponent(address)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ suspended: true }) }, 30_000);
      } catch { fail('admin_suspend_network', { uncertain: true }); }
      if (response.status >= 400 && response.status < 500) fail(`admin_suspend_http_${response.status}`);
      if (!response.ok) fail(`admin_suspend_http_${response.status}`, { uncertain: true });
      const body = await response.json().catch(() => null);
      if (!body?.suspended) fail('admin_suspend_unverified', { uncertain: true });
      return { primaryEmail: address, suspended: true };
    },
    /**
     * Deletes one user (Project, 2026-10-18: delete right away after a work trial; Google keeps it restorable for about 20 days).
     * 404 = already gone. Read back: the user must be gone. Unclear answers are uncertain and never retried.
     */
    async remove(address) {
      // Google's id first: a deleted account can only be restored by its id (restore-account.mjs).
      let id = null;
      try { const before = await call(`${ADMIN_API}/${encodeURIComponent(address)}?projection=basic&viewType=admin_view`); if (before.ok) id = (await before.json().catch(() => null))?.id ?? null; } catch { /* the id is a convenience */ }
      let response;
      try { response = await call(`${ADMIN_API}/${encodeURIComponent(address)}`, { method: 'DELETE' }, 30_000); }
      catch { fail('admin_delete_network', { uncertain: true }); }
      if (response.status === 404) return { primaryEmail: address, deleted: true, already: true };
      if (response.status >= 400 && response.status < 500) fail(`admin_delete_http_${response.status}`);
      if (!response.ok) fail(`admin_delete_http_${response.status}`, { uncertain: true });
      let after;
      try { after = await call(`${ADMIN_API}/${encodeURIComponent(address)}`); } catch { fail('admin_delete_unverified', { uncertain: true }); }
      if (after.status !== 404) fail('admin_delete_unverified', { uncertain: true });
      return { primaryEmail: address, deleted: true, id };
    },
    /** Turns a suspended user back on. Reads back. Unclear answers are uncertain and never retried. */
    async unsuspend(address) {
      let response;
      try {
        response = await call(`${ADMIN_API}/${encodeURIComponent(address)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ suspended: false }) }, 30_000);
      } catch { fail('admin_unsuspend_network', { uncertain: true }); }
      if (response.status >= 400 && response.status < 500) fail(`admin_unsuspend_http_${response.status}`);
      if (!response.ok) fail(`admin_unsuspend_http_${response.status}`, { uncertain: true });
      const body = await response.json().catch(() => null);
      if (body?.suspended !== false) fail('admin_unsuspend_unverified', { uncertain: true });
      return { primaryEmail: address, suspended: false };
    },
    /** Recently deleted users Google can still restore (about 20 days): [{ id, primaryEmail, name, deletedAt }]. */
    async listDeleted() {
      const out = [];
      let pageToken = '';
      for (let page = 0; page < 5; page++) {
        let response;
        try { response = await call(`${ADMIN_API}?customer=my_customer&showDeleted=true&maxResults=500&projection=basic${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`); } catch { fail('admin_deleted_network'); }
        if (!response.ok) fail(`admin_deleted_http_${response.status}`);
        const body = await response.json().catch(() => null);
        for (const u of body?.users ?? []) if (u?.id && u?.primaryEmail) out.push({ id: String(u.id), primaryEmail: String(u.primaryEmail).toLowerCase(),
          name: u.name?.fullName ?? `${u.name?.givenName ?? ''} ${u.name?.familyName ?? ''}`.trim(), deletedAt: u.deletionTime ? Date.parse(u.deletionTime) || 0 : 0 });
        pageToken = body?.nextPageToken ?? '';
        if (!pageToken) break;
      }
      return out;
    },
    /** Restores one deleted user by Google's id, into the top org unit. Never retried; unclear answers are uncertain. */
    async undelete(id) {
      let response;
      try {
        response = await call(`${ADMIN_API}/${encodeURIComponent(id)}/undelete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orgUnitPath: '/' }) }, 30_000);
      } catch { fail('admin_undelete_network', { uncertain: true }); }
      if (response.status >= 400 && response.status < 500) fail(`admin_undelete_http_${response.status}`);
      if (!response.ok) fail(`admin_undelete_http_${response.status}`, { uncertain: true });
      return { id, restored: true };
    },
    /** Creates the user once. 4xx = certainly not created; anything unclear is uncertain and never retried. */
    /** A new one-time password that Google makes them change at sign-in (password-reset.mjs). Never logged. */
    async resetPassword(address, password) {
      let response;
      try {
        response = await call(`${ADMIN_API}/${encodeURIComponent(address)}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password, changePasswordAtNextLogin: true }) }, 30_000);
      } catch { fail('admin_reset_network', { uncertain: true }); }
      if (response.status >= 400 && response.status < 500) fail(`admin_reset_http_${response.status}`);
      if (!response.ok) fail(`admin_reset_http_${response.status}`, { uncertain: true });
      return true;
    },
    async create({ address, givenName, familyName, password, recoveryEmail }) {
      let response;
      try {
        response = await call(ADMIN_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          primaryEmail: address, name: { givenName, familyName }, password, changePasswordAtNextLogin: true,
          ...(recoveryEmail ? { recoveryEmail } : {}) }) }, 30_000);
      } catch { fail('admin_create_network', { uncertain: true }); }
      if (response.status >= 400 && response.status < 500) fail(`admin_create_http_${response.status}`);
      if (!response.ok) fail(`admin_create_http_${response.status}`, { uncertain: true });
      const body = await response.json().catch(() => null);
      if (String(body?.primaryEmail ?? '').toLowerCase() !== address) fail('admin_create_unverified', { uncertain: true });
      return { id: body.id ?? null, primaryEmail: address };
    },
  });
}

/** First and last name for Google, from the tracker name ("Avery James Carter ⭐" -> Avery / James Carter). */
export function googleName(fullName) {
  const parts = bannerName(fullName).split(' ').filter(Boolean);
  return { givenName: parts[0] ?? '', familyName: parts.slice(1).join(' ') || parts[0] || '' };
}
