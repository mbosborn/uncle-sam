/**
 * Work-trial pay, read from Stripe (Project, 2026-10-16: "we use stripe to pay the work trialers ... lets do this for stripe and
 * build out all of the infrastructure"). Trialers get a Stripe Connect account and are paid by a transfer to it. Uncle Sam only
 * READS Stripe (a restricted key: Connect accounts and transfers, read). It never creates, changes or sends anything there:
 * paying stays Project's click. Every 30 minutes, for each record whose Payment Status is Actively in Trial, Awaiting Stripe
 * Setup, To Confirm or Ready to Pay (any outcome: people who were not selected are still paid):
 *
 *  - Their Stripe account: the connected account whose email is the record's email, or the one Project named in reply to a
 *    notice ("their Stripe email is x@y.com" or an acct_ id). Two accounts on one email: Project is asked, nothing is guessed.
 *  - Paid: transfers to that account since three days before Trial Start (or since the record was made), not reversed, not the
 *    contractor payouts another system sends (those carry a payout_id). Paid Amount and Payment Date are written; when it covers
 *    what is owed (or nothing was owed on the record), Payment Status Paid and Trial Amount Owed 0; a part payment lowers Trial
 *    Amount Owed and keeps the status. Project gets one line.
 *  - Not paid, trial over (Trial End before today, or no trial dates on the record): the amount owed is filled when empty from
 *    Planned Trial Payment, else Daily Trial Rate x Trial Days. Then Ready to Pay when the Stripe account can receive payouts
 *    and the paperwork is signed (or the record has none, as older ones), else Awaiting Stripe Setup. Project hears once when
 *    someone becomes ready (with the amount, how it was worked out, and a link to their account in Stripe), once more after two
 *    days unpaid, and once when there is no Stripe account under their email, or it is unfinished, or the paperwork is not
 *    signed, or the amount is unknown. To Confirm is a person's call: only a payment changes it.
 *  - STRIPE_API_KEY must be a restricted key (rk_live_ / rk_test_); a full secret key is refused. UNCLE_SAM_STRIPE=off stops it.
 *    Live only; never throws; a refused key is told once a day.
 */
import { noticeStore } from './stuck-rejections.mjs';

export const STRIPE_API = 'https://api.stripe.com/v1';
const EVERY_MS = 30 * 60_000;
const REMIND_MS = 2 * 86400_000;
const PREFIX = 'stripe:';
const OPEN = ['Actively in Trial', 'Awaiting Stripe Setup', 'To Confirm', 'Ready to Pay'];
export const stripeConfigured = env => env?.UNCLE_SAM_STRIPE !== 'off' && /^rk_(live|test)_[A-Za-z0-9]{20,}$/.test(String(env?.STRIPE_API_KEY ?? '').trim());
export const fullSecretKey = env => /^sk_(live|test)_/.test(String(env?.STRIPE_API_KEY ?? '').trim());
const ptDate = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const money = n => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const emailOf = text => (/[^\s@<>|]+@[^\s@<>|]+\.[A-Za-z]{2,}/.exec(String(text ?? '').replace(/<mailto:([^|>]+)\|[^>]*>/g, '$1'))?.[0] ?? '').toLowerCase() || null;
const acctOf = text => /\bacct_[A-Za-z0-9]{8,40}\b/.exec(String(text ?? ''))?.[0] ?? null;
export const dashboardLink = acct => `https://dashboard.stripe.com/connect/accounts/${acct}`;

/** Read-only Stripe client: GET only, by construction. */
export function createStripeReader({ env, fetchImpl = globalThis.fetch }) {
  const get = async (path, query = {}) => {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
    let response;
    try {
      response = await fetchImpl(`${STRIPE_API}${path}${qs ? `?${qs}` : ''}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${env.STRIPE_API_KEY.trim()}`, accept: 'application/json' } });
    } catch { throw Object.assign(new Error('stripe_network'), { code: 'stripe_network' }); }
    const body = await response.json().catch(() => null);
    if (response.status >= 400) throw Object.assign(new Error('stripe_http'), { code: `stripe_http_${response.status}`, reason: String(body?.error?.message ?? '').slice(0, 160) });
    return body;
  };
  const list = async (path, query, maxPages) => {
    const out = [];
    let after;
    for (let page = 0; page < maxPages; page++) {
      const body = await get(path, { ...query, limit: 100, starting_after: after });
      const data = Array.isArray(body?.data) ? body.data : [];
      out.push(...data);
      if (!body?.has_more || !data.length) break;
      after = data.at(-1).id;
    }
    return out;
  };
  return Object.freeze({
    /** Connected accounts, slimmed to what Uncle Sam uses (no addresses, birthdays or bank details are kept). */
    async accounts() {
      return (await list('/accounts', {}, 10)).map(a => ({ id: a.id, emails: [a.email, a.individual?.email].filter(Boolean).map(e => String(e).toLowerCase()),
        payoutsEnabled: a.payouts_enabled === true, transfers: a.capabilities?.transfers === 'active', detailsSubmitted: a.details_submitted === true,
        due: (a.requirements?.currently_due ?? []).length + (a.requirements?.past_due ?? []).length, disabled: a.requirements?.disabled_reason ?? null }));
    },
    async account(id) { const a = (await get(`/accounts/${encodeURIComponent(id)}`)); return a?.id ? { id: a.id, emails: [a.email, a.individual?.email].filter(Boolean).map(e => String(e).toLowerCase()), payoutsEnabled: a.payouts_enabled === true, transfers: a.capabilities?.transfers === 'active', detailsSubmitted: a.details_submitted === true, due: (a.requirements?.currently_due ?? []).length + (a.requirements?.past_due ?? []).length, disabled: a.requirements?.disabled_reason ?? null } : null; },
    /** Countries Company can make payout accounts in (for the payout setup page). */
    async countrySpecs() { return (await list('/country_specs', {}, 3)).map(c => c.id).filter(id => /^[A-Z]{2}$/.test(id)); },
    /** The platform's own country plus where it can send transfers (country_specs/<platform>, read-only). */
    async payableCountries(platform = 'US') {
      const spec = await get(`/country_specs/${encodeURIComponent(platform)}`);
      const list = (Array.isArray(spec?.supported_transfer_countries) ? spec.supported_transfer_countries : []).filter(id => /^[A-Z]{2}$/.test(id));
      return [...new Set([platform, ...list])];
    },
    async transfersTo(destination) {
      return (await list('/transfers', { destination }, 3)).map(t => ({ id: t.id, amount: t.amount, reversed: t.amount_reversed ?? 0, currency: t.currency, created: t.created * 1000,
        contractorPayout: !!(t.metadata?.payout_id || /^payout_/.test(t.transfer_group ?? '')), description: t.description ?? null }));
    },
  });
}

/** What is owed, and how it was worked out: { amount, how } or null. */
export function owedOf(payment) {
  if (typeof payment?.owed === 'number' && payment.owed > 0) return { amount: payment.owed, how: 'Trial Amount Owed' };
  if (typeof payment?.planned === 'number' && payment.planned > 0) return { amount: payment.planned, how: 'planned trial payment' };
  if (payment?.dailyRate > 0 && payment?.days > 0) return { amount: payment.dailyRate * payment.days, how: `${payment.days} day${payment.days === 1 ? '' : 's'} × ${money(payment.dailyRate)}/day` };
  return null;
}

export async function runStripePayments({ env, db, notion, stripe = null, poster = null, fetchImpl = globalThis.fetch, clock = Date.now, force = false, log = () => {} }) {
  const summary = { state: 'off', checked: 0, paid: 0, ready: 0, awaiting: 0, told: 0, error: null };
  const say = [];
  try {
    if (env?.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !db?.prepare || typeof notion?.listOpenPayments !== 'function') return summary;
    const kv = noticeStore(db), now = clock(), today = ptDate(now);
    if (fullSecretKey(env)) {
      if (await kv.claim(`${PREFIX}alert:full-key:${today}`, { at: now }, now)) { await tell(null, '🚨 The Stripe key I was given is a full secret key, so I am not using it. I only take a restricted, read-only key (it starts with rk_live_).'); }
      return { ...summary, state: 'refused_full_key' };
    }
    if (!stripeConfigured(env)) return summary;
    const last = await kv.get(`${PREFIX}last`);
    if (!force && last?.at && now - last.at < EVERY_MS) return { ...summary, state: 'not_due' };
    if ((await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    await kv.put(`${PREFIX}last`, { at: now }, now);
    summary.state = 'ran';
    const reader = stripe ?? createStripeReader({ env, fetchImpl });
    let accounts;
    try { accounts = await reader.accounts(); }
    catch (error) {
      summary.error = error?.code ?? 'stripe_failed';
      if (/^stripe_http_(401|403)$/.test(summary.error) && !(await kv.get(`${PREFIX}alert:${today}`))) {
        await kv.put(`${PREFIX}alert:${today}`, { at: now }, now);
        await tell(null, `🚨 Stripe refused my read (${summary.error}${error?.reason ? `: ${error.reason}` : ''}). Trial pay is not being checked until it's fixed; the key needs read access to Connect accounts and transfers.`);
      }
      return summary;
    }
    const byEmail = new Map();
    for (const a of accounts) for (const e of new Set(a.emails)) byEmail.set(e, [...(byEmail.get(e) ?? []), a]);

    for (const c of await notion.listOpenPayments()) {
      summary.checked++;
      try { await check(c); } catch (error) { log(`uncle_sam_stripe check_failed page=${c.pageId.slice(0, 8)} error=${error?.code ?? 'failed'}`); }
    }
    if (say.length) { await tell(null, say.slice(0, 20).join('\n')); summary.told = say.length; }
    return summary;

    async function once(key, line, threadable = false) {
      if (await kv.get(`${PREFIX}said:${key}`)) return;
      // Claimed before it is said, atomically: never twice.
      if (!(await kv.claim(`${PREFIX}said:${key}`, { at: now }, now))) return;
      if (threadable) {
        // A question Project can answer in its own thread: sent on its own.
        const ts = await tell(null, line);
        await kv.put(`${PREFIX}said:${key}`, { at: now, ts: ts ?? null }, now);
        if (ts) await kv.put(`${PREFIX}thread:${ts}`, { pageId: key.split(':').at(-1) }, now);
        return;
      }
      await kv.put(`${PREFIX}said:${key}`, { at: now }, now);
      say.push(line);
    }

    async function check(c) {
      const name = c.fullName.replace(/\s*⭐\s*$/u, '');
      const link = c.url ? `<${c.url}|${name}>` : name;
      const status = c.fields?.['Payment Status'];
      const map = await kv.get(`${PREFIX}map:${c.pageId}`);
      // Their Stripe account.
      let account = null;
      if (map?.acct) account = accounts.find(a => a.id === map.acct) ?? await reader.account(map.acct).catch(() => null);
      else {
        const email = (map?.email ?? c.email ?? '').toLowerCase();
        const found = email ? (byEmail.get(email) ?? []) : [];
        if (found.length > 1) {
          const usable = found.filter(a => a.payoutsEnabled);
          if (usable.length !== 1) { await once(`ambiguous:${c.pageId}`, `📋 ${link}: ${found.length} Stripe accounts use ${email}, so I can't tell which one is theirs. Reply in this thread with the acct_ id to use.`, true); return; }
          account = usable[0];
        } else account = found[0] ?? null;
      }
      // Paid?
      const startMs = Date.parse(c.fields?.['Trial Start'] ?? '') || Date.parse(c.createdTime ?? '') || 0;
      const since = startMs ? startMs - 3 * 86400_000 : 0;
      const transfers = account ? (await reader.transfersTo(account.id)).filter(t => !t.contractorPayout && t.created >= since && t.amount - t.reversed > 0) : [];
      const usd = transfers.filter(t => t.currency === 'usd');
      const paidCents = usd.reduce((n, t) => n + t.amount - t.reversed, 0);
      const owed = owedOf(c.payment);
      if (paidCents > 0) {
        const paid = Math.round(paidCents) / 100;
        if (c.payment?.paid === paid) return; // already recorded
        const date = ptDate(Math.max(...usd.map(t => t.created)));
        // What was due in all: after a part payment the record holds what is left, so add back what was already recorded.
        const before = typeof c.payment?.paid === 'number' && c.payment.paid > 0 ? c.payment.paid : 0;
        const recordedOwed = before && typeof c.payment?.owed === 'number' ? before + c.payment.owed : owed?.amount ?? null;
        const full = recordedOwed === null || paid >= recordedOwed;
        await notion.setPaymentFields({ pageId: c.pageId, expectedEmail: c.email ?? null, paid, date, ...(full ? { status: 'Paid', owed: 0 } : { owed: Math.round((recordedOwed - paid) * 100) / 100 }) });
        summary.paid++;
        await notion.appendCandidateNote?.({ pageId: c.pageId, text: `${today} · Trial pay: ${money(paid)} paid through Stripe (${usd.length} transfer${usd.length === 1 ? '' : 's'}, latest ${date}). Recorded by Uncle Sam.` }).catch(() => null);
        const extra = recordedOwed !== null && paid > recordedOwed ? ` That's more than the ${money(recordedOwed)} owed.` : !full ? ` ${money(recordedOwed - paid)} still owed.` : '';
        await once(`paid:${c.pageId}:${paid}`, `💵 Paid: ${link} · ${money(paid)} on ${date} (Stripe). Record updated.${extra}`);
        if (transfers.length > usd.length) await once(`currency:${c.pageId}`, `📋 ${link}: a transfer in another currency went to their Stripe account; I counted only the USD ones. Check the record.`);
        return;
      }
      // Not paid: only once the trial is over.
      // Trial End, else Trial Start + Trial Days; with neither, an Actively in Trial record is still running.
      const start = c.fields?.['Trial Start'] ?? null;
      const end = c.fields?.['Trial End'] ?? (start && c.payment?.days > 0 ? ptDate(Date.parse(`${start.slice(0, 10)}T12:00:00Z`) + (c.payment.days - 1) * 86400_000) : null);
      const over = end ? end.slice(0, 10) < today : status !== 'Actively in Trial';
      if (!over) return;
      if (!owed) { await once(`amount:${c.pageId}`, `📋 ${link}: trial is over but the record has no amount (Trial Amount Owed, Planned Trial Payment, or Daily Trial Rate and Trial Days). Add it and I'll take it from there.`); return; }
      if (status === 'To Confirm') return; // a person's call; only a payment changes it
      const paperwork = c.fields?.Paperwork ?? null;
      const ready = !!account && account.payoutsEnabled && account.transfers;
      const signed = paperwork === null || paperwork === 'Signed';
      // Ready but the paperwork isn't signed: the status is left as it is (it isn't a Stripe problem).
      const target = ready ? (signed ? 'Ready to Pay' : null) : 'Awaiting Stripe Setup';
      const fillOwed = !(c.payment?.owed > 0) ? { owed: owed.amount } : {};
      if ((target && status !== target) || fillOwed.owed !== undefined) await notion.setPaymentFields({ pageId: c.pageId, expectedEmail: c.email ?? null, ...(target && status !== target ? { status: target } : {}), ...fillOwed });
      if (target === 'Ready to Pay') {
        summary.ready++;
        const readyMark = await kv.get(`${PREFIX}ready:${c.pageId}`);
        if (!readyMark) {
          await kv.put(`${PREFIX}ready:${c.pageId}`, { at: now }, now);
          say.push(`💵 Ready to pay: ${link} · ${money(owed.amount)}${owed.how !== 'Trial Amount Owed' ? ` (${owed.how})` : ''} · Stripe account ready: <${dashboardLink(account.id)}|open in Stripe>. Paying stays your click; I record it when it lands.`);
        } else if (!readyMark.reminded && now - readyMark.at >= REMIND_MS) {
          await kv.put(`${PREFIX}ready:${c.pageId}`, { ...readyMark, reminded: now }, now);
          say.push(`💵 Still unpaid: ${link} · ${money(owed.amount)} · <${dashboardLink(account.id)}|open in Stripe>.`);
        }
        return;
      }
      if (target) summary.awaiting++;
      const payoutSent = await kv.get(`payout:email:${c.pageId}`);
      if (!account && payoutSent?.to) await once(`noaccount-sent:${c.pageId}`, `📋 ${link} is owed ${money(owed.amount)}; their payout setup email went out, but they haven't made their Stripe account yet.`, true);
      else if (!account) await once(`noaccount:${c.pageId}`, `📋 ${link} is owed ${money(owed.amount)}, but there's no Stripe account under ${(map?.email ?? c.email) || 'their email (none on the record)'}. Send them the Stripe setup link; if they used another email, reply in this thread with it.`, true);
      else if (!ready) await once(`unfinished:${c.pageId}`, `📋 ${link} is owed ${money(owed.amount)}; their Stripe account isn't ready for payouts yet${account.due ? ` (${account.due} item${account.due === 1 ? '' : 's'} still due in Stripe)` : ''}: <${dashboardLink(account.id)}|open in Stripe>. I'll say when it is.`);
      else if (!signed) await once(`paperwork:${c.pageId}`, `📋 ${link} is owed ${money(owed.amount)} and their Stripe account is ready, but the paperwork is ${paperwork}, not signed. I'll mark them Ready to Pay once it is.`);
    }
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'stripe_payments_failed' }; }

  async function tell(threadTs, text) {
    if (typeof poster !== 'function') return null;
    try { return await poster(threadTs)(text); } catch { return null; }
  }
}

/** Project's reply under a Stripe notice: an email or an acct_ id is used to find their account. Returns an outcome, else null. */
export async function handleStripeReply({ event, db, poster, masonId, clock = Date.now, sideEffects = [] }) {
  if (!db?.prepare || !event?.threadTs || event.threadTs === event.messageTs || (masonId && event.authorId !== masonId)) return null;
  const kv = noticeStore(db), now = clock();
  const pointer = await kv.get(`${PREFIX}thread:${event.threadTs}`);
  if (!pointer?.pageId) return null;
  const acct = acctOf(event.text), email = acct ? null : emailOf(event.text);
  const reply = async t => { try { await poster(event.threadTs)(t); sideEffects.push('stripe_reply'); } catch { /* noted anyway */ } };
  if (!acct && !email) { await reply('🫡 Send their Stripe email, or the acct_ id from Stripe, and I will use it.'); return { kind: 'stripe_reply', reason: 'unclear' }; }
  await kv.put(`${PREFIX}map:${pointer.pageId}`, acct ? { acct, at: now } : { email, at: now }, now);
  // A new answer clears the old questions so they can be asked again if it is still wrong.
  for (const k of ['noaccount', 'ambiguous', 'unfinished']) await kv.del(`${PREFIX}said:${k}:${pointer.pageId}`);
  await kv.put(`${PREFIX}last`, { at: 0 }, now); // checked on the next run
  await reply(`🫡 I'll look for their Stripe account under ${acct ?? email} within 5 minutes.`);
  return { kind: 'stripe_reply', reason: acct ? 'acct' : 'email' };
}
