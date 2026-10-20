/**
 * The payout setup email, mid-trial (Project, 2026-10-20: "i want this to be set up mid work trial. after their first check in has
 * been confirmed and complete, then send them this email ... just say so we can pay you out after your work trial").
 *
 *  - Every 15 minutes, Live only: everyone on the Work trial tier list (First check-in done ticked) with no Stripe account gets
 *    "Email · Payment Setup" from Project's Gmail, once, after 30 minutes' wait ("cancel <name>" stops it). Their Stripe account is
 *    looked for by account id first (the one their link made, payout:acct; the one Project named, stripe:map), then by email.
 *    Someone with an account, or already Paid, gets nothing. email-queue.mjs holdReason (closed, Stage Closed, On Hold, an
 *    unanswered pay concern) is checked when it is queued and again when it goes; Project hears once.
 *  - The reminder, 24 hours later in the same thread, waits its own 30 minutes (payout:remindq, cancellable) and goes only when
 *    they still have no payout details, are not paid and not held, once.
 *  - The onboarding key is tried once a day (an onboarding link for an account that doesn't exist, which creates nothing): if
 *    Stripe refuses it, Project hears once and no payout email goes, so no one gets a dead link.
 *  - The link in the email is Uncle Sam's own (/api/payout?t=…), because Stripe's onboarding links are single-use and expire in
 *    minutes, and Stripe says never to email them. On their click they pick the country of their bank account, Uncle Sam creates
 *    their Stripe payout account (an Express account, as Project's were made in the dashboard) and sends them straight on to
 *    Stripe's own form. Clicking again later continues the same account.
 *  - Stripe writes are limited by construction to creating an account and its onboarding link (Project, 2026-10-20: "i dont want
 *    uncle sam to have the ability to send payments"): createStripeOnboarder can call nothing else, and its key
 *    (STRIPE_ONBOARDING_KEY) is a restricted key with only Connect account write access. Paying stays Project's click.
 *  - UNCLE_SAM_PAYOUT_SETUP=off stops it.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { STRIPE_API, createStripeReader, stripeConfigured } from './stripe-payments.mjs';
import { HOLD_MS, holdReason, tellHold, readCandidate } from './email-queue.mjs';

export const PAYOUT_TEMPLATE_ID = '21e4cb6b-54c9-4ec5-9024-e6d3639decd4';
export const PAYOUT_REMINDER_TEMPLATE_ID = 'd41f8631-8bd5-456b-a7df-c24036d12eb1';
export const REMIND_AFTER_MS = 24 * 3600_000; // Project, 2026-10-20: "actually make it a 24 hour stripe reminder"
export const PAYOUT_PATH = '/api/payout';
const EVERY_MS = 15 * 60_000;
const PROBE_MS = 24 * 3600_000;
// Payment Status options that mean nothing is to be paid through Stripe: Paid, and Not Applicable (no payment owed, e.g. Avery
// James Carter, Project 2026-10-20: "we are not paying avery"). Have Not Started Yet, Actively in Trial, Awaiting Stripe Setup,
// To Confirm and Ready to Pay all still need a Stripe account.
export const PAID_STATUSES = ['Paid', 'Not Applicable'];
export const alreadyPaid = c => PAID_STATUSES.includes(c?.fields?.['Payment Status']);
// Pipelines Stripe can't pay yet: no payout setup email or reminder, Project told once (Stripe support, Oct 2026: Indian Connect
// recipient accounts need Global Payouts, still pending). Take 'India' out of this list to switch them on.
export const NO_STRIPE_PIPELINES = ['India'];
export const noStripePipeline = c => { const p = c?.fields?.Pipeline; return (Array.isArray(p) ? p : [p]).some(v => NO_STRIPE_PIPELINES.includes(v)); };
// The platform's own country: it pays out there and to Stripe's supported_transfer_countries for it.
export const PLATFORM_COUNTRY = 'US';
const DAY_MS = 24 * 3600_000;
const firstOf = full => String(full ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^\p{L}\s'.-]/gu, ' ').trim().split(/\s+/)[0] ?? '';

export const payoutConfigured = env => env?.UNCLE_SAM_PAYOUT_SETUP !== 'off' && stripeConfigured(env)
  && /^rk_(live|test)_[A-Za-z0-9]{20,}$/.test(String(env?.STRIPE_ONBOARDING_KEY ?? '').trim());
export const payoutUrlOf = (env, token) => `${String(env?.UNCLE_SAM_PUBLIC_URL || 'https://your-project.example.com').replace(/\/+$/, '')}${PAYOUT_PATH}?t=${token}`;

/**
 * The only Stripe writes Uncle Sam can make: create a payout account, and an onboarding link for it. No other path exists here,
 * and nothing here can move money.
 */
export function createStripeOnboarder({ env, fetchImpl = globalThis.fetch }) {
  const post = async (path, form, idempotencyKey = null) => {
    if (!['/accounts', '/account_links'].includes(path)) throw Object.assign(new Error('stripe_write_refused'), { code: 'stripe_write_refused' });
    const body = new URLSearchParams(form).toString();
    let response;
    try {
      response = await fetchImpl(`${STRIPE_API}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000), body,
        headers: { authorization: `Bearer ${String(env.STRIPE_ONBOARDING_KEY).trim()}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) } });
    } catch { throw Object.assign(new Error('stripe_network'), { code: 'stripe_network', uncertain: true }); }
    const out = await response.json().catch(() => null);
    if (response.status >= 400) throw Object.assign(new Error('stripe_http'), { code: `stripe_http_${response.status}`, reason: String(out?.error?.message ?? '').slice(0, 200), type: out?.error?.type ?? null });
    return out;
  };
  let probeNote = null;
  return Object.freeze({
    /** What Stripe said to the last probe (key masked), for the record. */
    probeNote: () => probeNote,
    /** Countries payout accounts can be made in (read-only; the one GET this client makes). */
    async countrySpecs() {
      const out = [];
      let after = null;
      for (let page = 0; page < 3; page++) {
        let response;
        try {
          response = await fetchImpl(`${STRIPE_API}/country_specs?limit=100${after ? `&starting_after=${after}` : ''}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
            headers: { authorization: `Bearer ${String(env.STRIPE_ONBOARDING_KEY).trim()}`, accept: 'application/json' } });
        } catch { throw Object.assign(new Error('stripe_network'), { code: 'stripe_network' }); }
        const body = await response.json().catch(() => null);
        if (response.status >= 400) throw Object.assign(new Error('stripe_http'), { code: `stripe_http_${response.status}` });
        const data = Array.isArray(body?.data) ? body.data : [];
        out.push(...data.map(c => c.id).filter(id => /^[A-Z]{2}$/.test(id)));
        if (!body?.has_more || !data.length) break;
        after = data.at(-1).id;
      }
      return out;
    },
    /** Countries this platform can pay out to: its own, and Stripe's supported_transfer_countries for it (read-only GET). */
    async payableCountries() {
      let response;
      try {
        response = await fetchImpl(`${STRIPE_API}/country_specs/${PLATFORM_COUNTRY}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
          headers: { authorization: `Bearer ${String(env.STRIPE_ONBOARDING_KEY).trim()}`, accept: 'application/json' } });
      } catch { throw Object.assign(new Error('stripe_network'), { code: 'stripe_network' }); }
      const body = await response.json().catch(() => null);
      if (response.status >= 400) throw Object.assign(new Error('stripe_http'), { code: `stripe_http_${response.status}` });
      const list = (Array.isArray(body?.supported_transfer_countries) ? body.supported_transfer_countries : []).filter(id => /^[A-Z]{2}$/.test(id));
      return [...new Set([PLATFORM_COUNTRY, ...list])];
    },
    /** An Express payout account in their country: the full agreement first (as the dashboard makes them), else recipient. */
    async createAccount({ country, email, firstName, lastName, pageId }) {
      const base = { country, email, business_type: 'individual', 'controller[fees][payer]': 'application', 'controller[losses][payments]': 'application',
        'controller[stripe_dashboard][type]': 'express', 'controller[requirement_collection]': 'stripe', 'metadata[notion_page]': pageId,
        ...(firstName ? { 'individual[first_name]': firstName } : {}), ...(lastName ? { 'individual[last_name]': lastName } : {}) };
      // Idempotency keys: a retry after an unclear answer returns the same account instead of making a second one.
      try {
        const a = await post('/accounts', { ...base, 'capabilities[transfers][requested]': 'true', 'capabilities[card_payments][requested]': 'true' }, `payout-acct-${pageId}`);
        return a.id;
      } catch (error) {
        if (error?.uncertain || !/^stripe_http_4/.test(error?.code ?? '')) throw error;
        const a = await post('/accounts', { ...base, 'capabilities[transfers][requested]': 'true', 'tos_acceptance[service_agreement]': 'recipient' }, `payout-acct-${pageId}-recipient`);
        return a.id;
      }
    },
    async onboardingLink({ account, refreshUrl, returnUrl }) {
      const l = await post('/account_links', { account, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' });
      return l.url;
    },
    /**
     * Whether this key may make onboarding links: one asked for an account that doesn't exist, so nothing is made. 'ok' when
     * Stripe answers "no such account" (404, or 400 invalid request), 'refused' on 401/403, else 'unknown'.
     */
    async probe() {
      try {
        await post('/account_links', { account: 'acct_0000000000000000', refresh_url: payoutUrlOf(env, 'probe'), return_url: payoutUrlOf(env, 'probe'), type: 'account_onboarding' });
        return 'ok';
      } catch (error) {
        const code = error?.code ?? '', reason = String(error?.reason ?? '');
        probeNote = `${code} ${reason.replace(/\b[rs]k_(live|test)_[A-Za-z0-9*]+/g, '<key>')}`.slice(0, 200);
        // Stripe answers 403 for an account that doesn't exist too ("does not have access to account … or that account does not
        // exist"): only a missing permission or a bad key means the key can't do the job.
        if (code === 'stripe_http_401' || (code === 'stripe_http_403' && /required permissions|rak_/i.test(reason))) return 'refused';
        if (code === 'stripe_http_403' && /does not exist|does not have access to account/i.test(reason)) return 'ok';
        if (code === 'stripe_http_403') return 'unknown';
        if (code === 'stripe_http_404' || (code === 'stripe_http_400' && error?.type === 'invalid_request_error')) return 'ok';
        return 'unknown';
      }
    },
  });
}

/** The email from the Notion template ("Email · Payment Setup"), with {{first_name}} and {{payout_link}}. Null if it doesn't fit. */
export function fillPayoutEmail(template, { firstName, link }) {
  if (!template?.subject || !template?.body || !firstName || !link) return null;
  if (!template.body.includes('{{payout_link}}')) return null;
  const fill = t => t.replaceAll('{{first_name}}', firstName).replaceAll('{{payout_link}}', link);
  const subject = fill(template.subject), body = fill(template.body);
  if (/\{\{[^}]*\}\}|\[[A-Z][^\]]*\]/.test(subject + body) || body.length > 2500) return null;
  return { subject, body };
}

const token = () => [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
const keyPrint = async key => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(key ?? '').trim())))].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * Whether the onboarding key can make payout accounts, tried at most once a day per key (an unclear answer is tried again
 * after an hour). 'refused': Project hears once per key. -> 'ok' | 'refused' | 'unknown'
 */
export async function onboardingKeyWorks({ env, kv, onboarder, now, poster = null }) {
  const fp = await keyPrint(env?.STRIPE_ONBOARDING_KEY);
  const last = await kv.get('payout:keyprobe');
  if (last?.fp === fp && now - last.at < (last.result === 'ok' ? PROBE_MS : 3600_000)) return last.result; // a refused key is tried hourly: its permissions can be fixed in place
  let result;
  try { result = await onboarder.probe(); } catch { result = 'unknown'; }
  if (!['ok', 'refused'].includes(result)) result = 'unknown';
  await kv.put('payout:keyprobe', { result, fp, at: now, note: onboarder.probeNote?.() ?? null }, now);
  if (result === 'refused' && typeof poster === 'function' && await kv.claim(`payout:key-refused:${fp}`, { at: now }, now)) {
    await poster('🚨 Stripe refused the payout-setup key (STRIPE_ONBOARDING_KEY): it needs Connect account write access. No payout setup emails go until it works.').catch(() => {});
  }
  return result;
}

/**
 * Their Stripe payout account: by account id first (the one their link made, payout:acct; the one Project named, stripe:map),
 * then by email (Project's named one, and `emails`). -> { exists, ready (details submitted or payouts on), unknown (a lookup failed) }
 */
export async function stripeStatusOf({ kv, pageId, emails = [], accounts = [], reader = null }) {
  const made = await kv.get(`payout:acct:${pageId}`), map = await kv.get(`stripe:map:${pageId}`);
  const ids = [...new Set([made?.account, map?.acct].filter(Boolean))];
  const found = [];
  let unknown = false;
  for (const id of ids) {
    let a = accounts.find(x => x.id === id) ?? null;
    if (!a && typeof reader?.account === 'function') { try { a = await reader.account(id); } catch { unknown = true; } }
    if (a) found.push(a);
  }
  const wanted = [map?.email, ...emails].filter(Boolean).map(e => String(e).toLowerCase());
  for (const a of accounts) if (!found.includes(a) && wanted.some(e => (a.emails ?? []).includes(e))) found.push(a);
  return { exists: ids.length > 0 || found.length > 0, ready: found.some(a => a.detailsSubmitted || a.payoutsEnabled), unknown };
}

const live = q => !!q && !q.sentAt && !q.cancelled && !q.dropped && !q.failed;

export async function runPayoutSetup({ env, db, notion, gmail, parseTemplate, reader = null, onboarder = null, poster = null, clock = Date.now, force = false, log = () => {} }) {
  const summary = { state: 'off', sent: 0, error: null };
  try {
    if (env?.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !payoutConfigured(env) || !db?.prepare || !gmail || typeof notion?.listTierCandidates !== 'function') return summary;
    const kv = noticeStore(db), now = clock();
    if (!force && now - ((await kv.get('payout:last'))?.at ?? 0) < EVERY_MS) return { ...summary, state: 'not_due' };
    // Live only, like the rest of Uncle Sam's automatic work.
    if (typeof notion.readControl !== 'function' || (await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    await kv.put('payout:last', { at: now }, now);
    // A key Stripe refuses would mean emails with dead links: none go until it works.
    const key = await onboardingKeyWorks({ env, kv, onboarder: onboarder ?? createStripeOnboarder({ env }), now, poster });
    if (key !== 'ok') return { ...summary, state: key === 'refused' ? 'key_refused' : 'key_unknown' };
    summary.state = 'ran';
    const stripeReader = reader ?? createStripeReader({ env });
    let accountsCache = null;
    const stripeOf = async (pageId, emails) => stripeStatusOf({ kv, pageId, emails, accounts: (accountsCache ??= await stripeReader.accounts()), reader: stripeReader });
    const tell = (c, pageId, what, why) => tellHold({ kv, poster, pageId, name: c?.fullName ?? null, what, why, now,
      after: ['on_hold', 'pay_concern'].includes(why) ? 'It goes once that is cleared.' : '' });
    const drop = async (qKey, q, why) => { if (live(q)) await kv.put(qKey, { ...q, dropped: why, droppedAt: now }, now); };
    const tellNoStripe = async (c, pageId) => {
      if (typeof poster === 'function' && await kv.claim(`payout:nostripe:${pageId}`, { at: now }, now)) {
        await poster(`💳 I didn't send ${firstOf(c.fullName)} the payout setup email: Stripe can't make Indian payout accounts yet (Global Payouts is still pending). Pay them another way, or tell me when Stripe India works.`).catch(() => {});
      }
    };

    // 1. The reminder (Project, 2026-10-20: "set up a reminder for their stripe that sends a follow up in the same thread"; "actually
    //    make it a 24 hour stripe reminder"): queued 24 hours after the setup email, sent 30 minutes later unless cancelled, once.
    let reminderTpl, reminderTplRead = false;
    for (const key of await kv.names('payout:email:')) {
      const e = await kv.get(key);
      if (!e?.id || !e.token || !e.to || now - e.at < REMIND_AFTER_MS || e.remindedAt || e.reminderDone) continue;
      const pageId = key.slice('payout:email:'.length);
      if (await kv.get(`payout:reminded:${pageId}`)) continue; // once
      const qKey = `payout:remindq:${pageId}`, q = await kv.get(qKey);
      const finish = async (why, queueWhy = why) => { await drop(qKey, q, queueWhy); await kv.put(key, { ...e, reminderDone: why, reminderDoneAt: now }, now); };
      if (q?.cancelled) { await finish('cancelled_by_mason'); continue; }
      const read = await readCandidate(notion, pageId);
      if (read.transient) continue;
      const c = read.candidate;
      const why = await holdReason({ kv, candidate: c });
      if (why) { await drop(qKey, q, why); await tell(c ?? { fullName: q?.name }, pageId, 'payout reminder email', why); continue; }
      if (alreadyPaid(c)) { await finish('paid'); continue; }
      if (noStripePipeline(c)) { await drop(qKey, q, 'no_stripe_pipeline'); await tellNoStripe(c, pageId); continue; }
      const stripe = await stripeOf(pageId, [e.to, c.email]);
      if (stripe.unknown) continue;
      if (stripe.ready) { await finish('stripe_ready'); continue; }
      if (!q || q.dropped) { await kv.put(qKey, { pageId, name: c.fullName, email: e.to, at: now + HOLD_MS, queuedAt: now }, now); continue; }
      if (!live(q) || now < q.at) continue;
      if (!reminderTplRead) { reminderTplRead = true; try { reminderTpl = parseTemplate(await notion.getEmailTemplate(PAYOUT_REMINDER_TEMPLATE_ID)); } catch { reminderTpl = null; } }
      const first = firstOf(c.fullName);
      const msg = fillPayoutEmail(reminderTpl, { firstName: first, link: payoutUrlOf(env, e.token) });
      if (!msg) {
        log('uncle_sam_payout reminder_template');
        if (typeof poster === 'function' && await kv.claim('payout:reminder-template-broken', { at: now }, now)) await poster('📋 I can\'t send payout reminders: the "Email · Payment Setup reminder" template in Notion needs {{first_name}} and {{payout_link}}.').catch(() => {});
        continue;
      }
      if (!(await kv.claim(`payout:reminded:${pageId}`, { at: now }, now))) { await kv.put(qKey, { ...q, failed: 'already_claimed', failedAt: now }, now); continue; } // once, claimed before the send
      try {
        await gmail.send({ to: c.email ?? e.to, subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`, body: msg.body, replyTo: e.id });
        await kv.put(qKey, { ...q, sentAt: now }, now);
        await kv.put(key, { ...e, remindedAt: now }, now);
        summary.reminded = (summary.reminded ?? 0) + 1;
        await notion.appendCandidateNote?.({ pageId, text: `${new Date(now).toISOString().slice(0, 10)} · Stripe payout setup reminder sent (no payout details yet, 24 hours after the setup email; by Uncle Sam).` })?.catch?.(() => null);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'failed';
        await kv.put(qKey, { ...q, failed: code, failedAt: now }, now);
        await kv.put(key, { ...e, reminderDone: 'failed', reminderDoneAt: now }, now);
        log(`uncle_sam_payout reminder_failed ${code}`);
        if (typeof poster === 'function' && await kv.claim(`payout:remind-failed:${pageId}`, { at: now, code }, now)) {
          await poster(error?.uncertain ? `🚨 ${first}'s payout reminder may or may not have gone out (${code}). Check your Sent mail; I won't send it again.`
            : `📋 I couldn't send ${first} the payout reminder (${code}). I won't try again; send it by hand if they still need it.`).catch(() => {});
        }
      }
    }

    // 2. The setup email, after their first check-in.
    let template, templateRead = false;
    for (const c of await notion.listTierCandidates()) {
      const f = c.fields ?? {};
      if (f['First check-in done'] !== true || !c.email) continue;
      if (await kv.get(`payout:email:${c.pageId}`)) continue;
      const qKey = `payout:queued:${c.pageId}`, queued = await kv.get(qKey);
      const settle = async skipped => { await drop(qKey, queued, skipped); await kv.put(`payout:email:${c.pageId}`, { at: now, skipped }, now); };
      if (queued?.cancelled) { await kv.put(`payout:email:${c.pageId}`, { at: now, skipped: 'cancelled_by_mason' }, now); continue; }
      const why = await holdReason({ kv, candidate: c });
      if (why) { await drop(qKey, queued, why); await tell(c, c.pageId, 'payout setup email', why); continue; }
      if (alreadyPaid(c)) { await settle('paid'); continue; }
      if (noStripePipeline(c)) { await drop(qKey, queued, 'no_stripe_pipeline'); await tellNoStripe(c, c.pageId); continue; }
      const email = String(c.email).toLowerCase();
      const stripe = await stripeOf(c.pageId, [email]);
      if (stripe.unknown) continue;
      if (stripe.exists) { await settle('stripe_account_exists'); continue; }
      const first = firstOf(c.fullName);
      // 30 minutes' wait, said once as done, so Project can still cancel it (email-queue.mjs, Project 2026-10-20).
      if (!queued || queued.dropped) {
        await kv.put(qKey, { pageId: c.pageId, name: c.fullName, email, at: now + HOLD_MS, queuedAt: now }, now);
        if (typeof poster === 'function') await poster(`💳 Sending ${first} the payout setup email, so we can pay them after the trial.`).catch(() => {});
        continue;
      }
      if (!live(queued) || now < queued.at) continue;
      if (!templateRead) { templateRead = true; try { template = parseTemplate(await notion.getEmailTemplate(PAYOUT_TEMPLATE_ID)); } catch { template = null; } }
      const t = token();
      const message = fillPayoutEmail(template, { firstName: first, link: payoutUrlOf(env, t) });
      if (!message) {
        if (typeof poster === 'function' && await kv.claim('payout:template-broken', { at: now }, now)) await poster('📋 I can\'t send payout setup emails: the "Email · Payment Setup" template in Notion needs {{first_name}} and {{payout_link}}.').catch(() => {});
        return { ...summary, error: 'template' };
      }
      if (!(await kv.claim(`payout:email:${c.pageId}`, { at: now, to: email }, now))) { await kv.put(qKey, { ...queued, failed: 'already_claimed', failedAt: now }, now); continue; } // claimed before the send: never twice
      await kv.put(`payout:token:${t}`, { pageId: c.pageId, email, name: c.fullName, at: now }, now);
      try {
        const sent = await gmail.send({ to: c.email, subject: message.subject, body: message.body });
        await kv.put(`payout:email:${c.pageId}`, { at: now, to: email, id: sent?.id ?? null, token: t }, now);
        summary.sent++;
        await kv.put(qKey, { ...queued, sentAt: now }, now);
        await notion.appendCandidateNote?.({ pageId: c.pageId, sourceUrl: sent?.url, text: `${new Date(now).toISOString().slice(0, 10)} · Payout setup email sent from Project's Gmail after their first check-in, so they can be paid after the trial (by Uncle Sam).` })?.catch?.(() => null);
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'failed';
        await kv.put(qKey, { ...queued, failed: code, failedAt: now }, now);
        if (typeof poster === 'function') await poster(error?.uncertain ? `🚨 ${first}'s payout setup email may or may not have gone out (${code}). Check your Sent mail; I won't send it again.`
          : `📋 I couldn't send ${first} the payout setup email (${code}). I won't try again; send it by hand.`).catch(() => {});
        log(`uncle_sam_payout_email failed ${code}`);
      }
    }
    return summary;
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'payout_setup_failed' }; }
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function payoutPage(title, inner, status = 200) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1d1f22"><h1 style="font-size:1.4rem">${esc(title)}</h1>${inner}</body>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' } });
}

/**
 * GET /api/payout?t=… : the country picker (or, once their account exists, straight on to Stripe). POST with t and country: the
 * account is made once, then on to Stripe's form. ?done=1 is where Stripe sends them back.
 */
export async function handlePayoutRequest({ env, db, request, reader = null, onboarder = null, poster = null, clock = Date.now, log = () => {} }) {
  const url = new URL(request.url);
  let form = null;
  if (request.method === 'POST') { try { form = new URLSearchParams(await request.text()); } catch { form = new URLSearchParams(); } }
  const t = (form?.get('t') ?? url.searchParams.get('t') ?? '').trim();
  const sorry = 'Something went wrong on our side. Reply to the email you got from Project and he will sort it out.';
  if (!/^[0-9a-f]{48}$/.test(t) || !db?.prepare || !payoutConfigured(env)) return payoutPage('Link not valid', '<p>This link is not valid. Reply to the email you got from Project for a new one.</p>', 404);
  const kv = noticeStore(db), now = clock();
  const who = await kv.get(`payout:token:${t}`);
  if (!who?.pageId) return payoutPage('Link not valid', '<p>This link is not valid. Reply to the email you got from Project for a new one.</p>', 404);
  const first = firstOf(who.name);
  if (url.searchParams.get('done') === '1') return payoutPage('Thanks, you are all set', `<p>Thanks ${esc(first)}. Your payout details are with Stripe. We'll pay you there after your work trial.</p>`);
  const self = payoutUrlOf(env, t);
  const stripeW = onboarder ?? createStripeOnboarder({ env });
  const toStripe = async account => {
    try { return Response.redirect(await stripeW.onboardingLink({ account, refreshUrl: self, returnUrl: `${self}&done=1` }), 303); }
    catch (error) { log(`uncle_sam_payout link_failed ${error?.code ?? 'failed'}`); return payoutPage('Please try again', `<p>${sorry}</p>`, 502); }
  };
  const made = await kv.get(`payout:acct:${who.pageId}`);
  if (made?.account) return toStripe(made.account);
  const stripe = reader ?? createStripeReader({ env });
  let countries = (await kv.get('payout:countries'))?.list;
  if (!Array.isArray(countries) || !countries.length) {
    for (const source of [stripeW, stripe]) {
      try { countries = await source.countrySpecs?.(); } catch { countries = []; }
      if (Array.isArray(countries) && countries.length) { await kv.put('payout:countries', { list: countries, at: now }, now); break; }
    }
    if (!Array.isArray(countries) || !countries.length) countries = FALLBACK_COUNTRIES;
  }
  // Where the platform can pay out (its own country and Stripe's supported transfer countries), kept a day. Only those are
  // listed; when it can't be read, every country is listed and nothing is made until it can be checked.
  let payable = (await kv.get('payout:payable')) ?? null;
  if (!(Array.isArray(payable?.list) && payable.list.length && now - payable.at < DAY_MS)) {
    let list = null;
    for (const source of [stripeW, stripe]) {
      try { list = await source.payableCountries?.(PLATFORM_COUNTRY); } catch { list = null; }
      if (Array.isArray(list) && list.length) break;
    }
    if (Array.isArray(list) && list.length) { payable = { list, at: now }; await kv.put('payout:payable', payable, now); }
  }
  payable = Array.isArray(payable?.list) && payable.list.length ? payable.list : null;
  const listed = payable ?? countries;
  if (request.method === 'POST') {
    const country = String(form.get('country') ?? '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(country) || !(listed.includes(country) || countries.includes(country))) return payoutPage('Pick your country', `<p>Choose the country of the bank account you want to be paid in.</p>${picker(t, listed, first)}`, 400);
    if (!payable) return payoutPage('Please try again', `<p>${sorry}</p>`, 502); // can't check where Stripe pays: nothing is made
    if (!payable.includes(country)) {
      const place = NAMES?.of(country) ?? country;
      if (typeof poster === 'function' && await kv.claim(`payout:unpayable:${who.pageId}:${country}`, { at: now }, now)) {
        await poster(`💳 ${first || 'A trialer'} picked ${place} on the payout page; Stripe can't pay there, so set up their payment another way.`).catch(() => {});
      }
      log(`uncle_sam_payout unpayable ${who.pageId.slice(0, 8)} ${country}`);
      return payoutPage('Thanks', `<p>Thanks! Stripe can't pay out to ${esc(place)} yet, so Project will reach out with another way to get you paid.</p>`);
    }
    if (!(await kv.claim(`payout:creating:${who.pageId}`, { at: now, country }, now))) {
      const again = await kv.get(`payout:acct:${who.pageId}`);
      return again?.account ? toStripe(again.account) : payoutPage('One moment', `<p>Your account is being set up. Go back to the email and click the link again in a minute.</p>`, 409);
    }
    try {
      const parts = String(who.name ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/[^\p{L}\s'.-]/gu, ' ').trim().split(/\s+/);
      const account = await stripeW.createAccount({ country, email: who.email, firstName: parts[0] ?? null, lastName: parts.length > 1 ? parts.at(-1) : null, pageId: who.pageId });
      await kv.put(`payout:acct:${who.pageId}`, { account, country, at: now }, now);
      log(`uncle_sam_payout account_created ${who.pageId.slice(0, 8)} ${country}`);
      return toStripe(account);
    } catch (error) {
      log(`uncle_sam_payout create_failed ${error?.code ?? 'failed'} ${error?.reason ?? ''}`);
      // A clear refusal can be tried again; an unclear answer stays claimed so a second account is never made.
      if (!error?.uncertain) await kv.del(`payout:creating:${who.pageId}`).catch(() => {});
      return payoutPage('Please try again', `<p>${sorry}</p>`, 502);
    }
  }
  return payoutPage('Set up your payout', `<p>Hi ${esc(first)}, this sets up how Company pays you for your work trial, through Stripe. First, choose the country of the bank account you want to be paid in. Stripe's own form comes next.</p>${picker(t, listed, first)}`);
}

/** When Stripe's own list can't be read: the usual Express and cross-border payout countries. */
const FALLBACK_COUNTRIES = ['AE','AR','AT','AU','BE','BG','BR','CA','CH','CL','CO','CY','CZ','DE','DK','EE','ES','FI','FR','GB','GR','HK','HR','HU','ID','IE','IL','IN','IT','JP','KE','LT','LU','LV','MT','MX','MY','NG','NL','NO','NZ','PE','PH','PL','PT','RO','SE','SG','SI','SK','TH','TR','US','VN','ZA'];
const NAMES = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
function picker(t, countries) {
  const options = countries.map(c => [c, NAMES?.of(c) ?? c]).sort((a, b) => a[1].localeCompare(b[1]))
    .map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('');
  return `<form method="post" style="display:grid;gap:12px;margin-top:1.5rem"><input type="hidden" name="t" value="${esc(t)}">`
    + `<label for="country" style="font-weight:600">Country of your bank account</label><select id="country" name="country" required style="font:inherit;padding:8px"><option value="">Choose…</option>${options}</select>`
    + `<button type="submit" style="font:inherit;font-weight:600;padding:10px 14px;background:#7a2430;color:#fff;border:0;border-radius:6px;cursor:pointer">Continue to Stripe</button></form>`;
}
