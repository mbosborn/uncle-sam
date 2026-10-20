/**
 * DocuSign paperwork on the tracker (Project, 2026-10-15: "can it get access to the docusign to tell when people have signed and
 * then auto update the tracker with that info?").
 *
 * The Company AI DocuSign account has Connect (account webhooks), so no API login is needed: DocuSign POSTs each envelope event
 * (sent, delivered, completed, declined, voided) to /api/docusign/connect, signed with HMAC-SHA256 (DOCUSIGN_CONNECT_HMAC_KEY).
 * Uncle Sam keeps the envelope's latest state, and for each signer whose email is exactly one Recruiting Pipeline record it sets
 * that record's "Paperwork" (Sent, Signed, Declined, Voided, by that person's own signature over all their envelopes) and "Paperwork signed" date,
 * writes a Note row (Action "docusign") and a dated line on the record, and tells Project when someone has signed everything.
 * Nothing is ever sent, voided or changed in DocuSign.
 */
import { timingSafeEqual } from 'node:crypto';
import { noticeStore } from './stuck-rejections.mjs';

export const PAPERWORK = Object.freeze(['Sent', 'Signed', 'Declined', 'Voided']);
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const iso = ms => new Date(ms).toISOString();

export const docusignConfigured = env => typeof env?.DOCUSIGN_CONNECT_HMAC_KEY === 'string' && env.DOCUSIGN_CONNECT_HMAC_KEY.trim().length >= 20;

/** DocuSign's X-DocuSign-Signature-<n> headers: base64 HMAC-SHA256 of the raw body under the account's Connect key. */
export async function connectSignatureOk({ body, headers, key }) {
  if (typeof key !== 'string' || key.trim().length < 20) return false;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key.trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Buffer.from(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)));
  for (let n = 1; n <= 10; n++) {
    const given = headers.get(`x-docusign-signature-${n}`);
    if (!given) continue;
    const g = Buffer.from(given, 'base64');
    if (g.length === mac.length && timingSafeEqual(g, mac)) return true;
  }
  return false;
}

/** The parts of a Connect (JSON) event Uncle Sam keeps: envelope id, status, subject, dates and each signer. */
export function envelopeOf(event) {
  const data = event?.data ?? {}, summary = data.envelopeSummary ?? {};
  const id = String(data.envelopeId ?? summary.envelopeId ?? '').toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const signers = (summary.recipients?.signers ?? []).filter(s => EMAIL.test(String(s?.email ?? '').trim())).map(s => ({
    email: String(s.email).trim().toLowerCase(), name: clean(s.name, 120), status: String(s.status ?? '').toLowerCase(), signedAt: s.signedDateTime ?? null }));
  return { id, event: clean(event.event, 60), status: String(summary.status ?? '').toLowerCase(), subject: clean(summary.emailSubject, 200),
    sentAt: summary.sentDateTime ?? null, completedAt: summary.completedDateTime ?? null, signers, at: event.generatedDateTime ?? null };
}

/**
 * One person's paperwork over all their envelopes, by their own signature (Project: "tell when people have signed"): Signed once
 * they have signed every envelope they are on that is not voided, even if a Company countersignature is still to come.
 */
export function paperworkOf(envelopes, email) {
  const mine = envelopes.map(e => ({ e, s: e.signers.find(x => x.email === email) })).filter(x => x.s);
  if (!mine.length) return null;
  const live = mine.filter(x => x.e.status !== 'voided');
  if (!live.length) return { value: 'Voided', signedAt: null };
  if (live.some(x => x.s.status === 'declined' || x.e.status === 'declined')) return { value: 'Declined', signedAt: null };
  if (live.every(x => x.s.status === 'completed' || x.e.status === 'completed')) {
    const at = live.map(x => Date.parse(x.s.signedAt ?? x.e.completedAt ?? '')).filter(Number.isFinite);
    return { value: 'Signed', signedAt: at.length ? iso(Math.max(...at)) : null };
  }
  return { value: 'Sent', signedAt: null };
}

const VERB = { sent: 'was sent', delivered: 'was opened', completed: 'was signed by everyone', declined: 'was declined', voided: 'was voided' };
const SIGNER_VERB = { sent: 'was sent to them', delivered: 'was opened by them', completed: 'was signed by them', declined: 'was declined by them' };

/**
 * One Connect event, after the signature check. Keeps the envelope, then updates each matched candidate. Returns a summary;
 * throws only on a storage failure (DocuSign then retries).
 */
export async function applyConnectEvent({ event, db, notion, poster = null, policyVersion = 'uncle-sam', clock = Date.now }) {
  const envelope = envelopeOf(event);
  if (!envelope || !VERB[envelope.status]) return { ignored: true };
  const kv = noticeStore(db), now = clock();
  const before = await kv.get(`docusign:env:${envelope.id}`);
  // Events can arrive out of order: never let an older one overwrite a later state.
  if (before?.at && envelope.at && Date.parse(before.at) > Date.parse(envelope.at)) return { stale: true };
  await kv.put(`docusign:env:${envelope.id}`, envelope, now);
  const results = [];
  for (const signer of envelope.signers) {
    const index = (await kv.get(`docusign:email:${signer.email}`)) ?? [];
    if (!index.includes(envelope.id)) { index.push(envelope.id); await kv.put(`docusign:email:${signer.email}`, index.slice(-25), now); }
    const found = await notion.findCandidatesByEmail(signer.email);
    if (found.length !== 1) { results.push({ email: signer.email, reason: found.length ? 'ambiguous' : 'not_a_candidate' }); continue; }
    const candidate = found[0];
    const envelopes = (await Promise.all(index.map(id => kv.get(`docusign:env:${id}`)))).filter(Boolean);
    const paperwork = paperworkOf(envelopes, signer.email);
    const was = before?.signers?.find(x => x.email === signer.email)?.status;
    const changed = before?.status !== envelope.status || was !== signer.status;
    const verb = envelope.status === 'voided' || envelope.status === 'completed' ? VERB[envelope.status] : SIGNER_VERB[signer.status] ?? VERB[envelope.status];
    if (changed) {
      const key = `docusign:${envelope.id}:${envelope.status}:${signer.status}:${candidate.pageId}`;
      const when = Date.parse(envelope.completedAt ?? envelope.at ?? '') || now;
      await notion.upsertOperationsRecord({ policyVersion, recordKind: 'Note', requestKey: key, sourceEventKey: key, state: 'Complete', mode: 'Live', action: 'docusign',
        name: `Note · ${clean(candidate.fullName, 120)} · docusign`, candidatePageId: candidate.pageId, occurredAt: iso(when), observedAt: iso(now),
        resultEvidence: `DocuSign: “${envelope.subject || 'envelope'}” ${verb} (${new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(when)} PT). Paperwork now: ${paperwork?.value ?? 'unknown'}.` });
    }
    let wrote = null;
    if (paperwork && (candidate.fields?.Paperwork !== paperwork.value || (paperwork.signedAt && !candidate.fields?.['Paperwork signed']))) {
      wrote = await notion.setPaperwork({ pageId: candidate.pageId, expectedEmail: candidate.email, value: paperwork.value, signedAt: paperwork.signedAt });
      try {
        await notion.appendCandidateNote({ pageId: candidate.pageId,
          text: `${iso(now).slice(0, 10)} · DocuSign “${envelope.subject || 'envelope'}” ${verb}; Paperwork set to ${paperwork.value} (by Uncle Sam).` });
      } catch { /* the field carries it */ }
      // DocuSign often sends two events for one signing at the same moment (recipient and envelope completed): only one tells Project.
      if (paperwork.value === 'Signed' && typeof poster === 'function' && await kv.claim(`docusign:told-signed:${candidate.pageId}`, { at: now, envelope: envelope.id }, now, { maxAgeMs: 7 * 86400_000 })) {
        // Who it still waits on, so the countersignature isn't forgotten (paperwork-followup.mjs nudges again later).
        const waiting = envelope.signers.filter(x => x.email !== signer.email && ['created', 'sent', 'delivered'].includes(x.status));
        const tail = !waiting.length ? '' : waiting.some(x => x.email === 'project@company.example') ? ' It\'s waiting on your countersignature; DocuSign emailed you the link.'
          : ` It's waiting on ${waiting.map(x => x.name || x.email).join(' and ')} to countersign.`;
        await poster(`📋 ${clean(candidate.fullName, 120)} signed all their DocuSign paperwork (“${envelope.subject || 'envelope'}”). Paperwork is set to Signed on the tracker.${tail}`).catch(() => {});
      }
    }
    results.push({ email: signer.email, candidate: candidate.pageId, paperwork: paperwork?.value ?? null, wrote: !!wrote });
  }
  return { envelope: envelope.id, status: envelope.status, results };
}

/**
 * Catch-up for DocuSign (Project, 2026-10-16: "fix this ... so everything can be accurate"). A Connect event is answered at once
 * and applied in the background; if Notion hiccups right then, the envelope is kept here but the record would keep its old
 * Paperwork. Every 10 minutes, each envelope seen in the last 14 days is compared with its signers' records and a record that
 * is behind is brought forward: empty -> Sent, Sent -> Signed / Declined / Voided, and a missing signed date filled. Never
 * moves a record backwards or overwrites a value someone set past it. Three failed tries for one change: Project is told once.
 */
export const CATCH_UP_MS = 10 * 60_000;
const BEHIND = Object.freeze({ Sent: ['', null, undefined], Signed: ['', null, undefined, 'Sent'], Declined: ['', null, undefined, 'Sent'], Voided: ['', null, undefined, 'Sent'] });
export async function reconcilePaperwork({ db, notion, poster = null, clock = Date.now, log = () => {} }) {
  const summary = { checked: 0, fixed: 0, failed: 0, error: null };
  try {
    if (!db?.prepare || typeof notion?.setPaperwork !== 'function') return summary;
    const kv = noticeStore(db), now = clock();
    const last = await kv.get('docusign:catchup:last');
    if (last?.at && now - last.at < CATCH_UP_MS) return { ...summary, state: 'not_due' };
    await kv.put('docusign:catchup:last', { at: now }, now);
    const done = new Set();
    for (const name of await kv.names('docusign:env:')) {
      const envelope = await kv.get(name);
      const seenAt = Date.parse(envelope?.at ?? envelope?.completedAt ?? envelope?.sentAt ?? '');
      // Five minutes' grace: the live update may still be on its way.
      if (!envelope?.signers?.length || !Number.isFinite(seenAt) || now - seenAt > 14 * 86400_000 || now - seenAt < 5 * 60_000) continue;
      for (const signer of envelope.signers) {
        if (done.has(signer.email)) continue;
        done.add(signer.email);
        const index = (await kv.get(`docusign:email:${signer.email}`)) ?? [envelope.id];
        const envelopes = (await Promise.all(index.map(id => kv.get(`docusign:env:${id}`)))).filter(Boolean);
        const paperwork = paperworkOf(envelopes, signer.email);
        if (!paperwork) continue;
        const found = await notion.findCandidatesByEmail(signer.email).catch(() => []);
        if (found.length !== 1) continue;
        const candidate = found[0];
        summary.checked++;
        const current = candidate.fields?.Paperwork;
        const behind = (BEHIND[paperwork.value] ?? []).includes(current);
        const dateMissing = paperwork.value === 'Signed' && current === 'Signed' && paperwork.signedAt && !candidate.fields?.['Paperwork signed'];
        if (!behind && !dateMissing) continue;
        const tries = `docusign:catchup:${candidate.pageId}:${paperwork.value}`;
        const state = (await kv.get(tries)) ?? { failures: 0 };
        if (state.told) continue;
        try {
          await notion.setPaperwork({ pageId: candidate.pageId, expectedEmail: candidate.email, value: paperwork.value, signedAt: paperwork.signedAt });
          summary.fixed++;
          await notion.appendCandidateNote({ pageId: candidate.pageId, text: `${iso(now).slice(0, 10)} · Paperwork set to ${paperwork.value} from DocuSign (caught up by Uncle Sam; the first update did not go through).` }).catch(() => null);
          log(`uncle_sam_docusign_catchup fixed=${candidate.pageId.slice(0, 8)} value=${paperwork.value}`);
          if (paperwork.value === 'Signed' && behind && poster && await kv.claim(`docusign:told-signed:${candidate.pageId}`, { at: now, catchUp: true }, now, { maxAgeMs: 7 * 86400_000 })) await poster(`📋 ${clean(candidate.fullName, 120)} signed all their DocuSign paperwork. Paperwork is set to Signed on the tracker.`).catch(() => {});
        } catch (error) {
          summary.failed++;
          const failures = state.failures + 1;
          const code = typeof error?.code === 'string' ? error.code : 'failed';
          await kv.put(tries, { failures, at: now, told: failures >= 3 }, now);
          if (failures >= 3 && poster) await poster(`🚨 Project, I need YOU on this one: DocuSign says ${clean(candidate.fullName, 120)}'s paperwork is ${paperwork.value}, and I couldn't put it on the tracker after 3 tries (${code}). Set Paperwork by hand.`).catch(() => {});
        }
      }
    }
    return summary;
  } catch (error) { return { ...summary, error: typeof error?.code === 'string' ? error.code : 'docusign_catchup_failed' }; }
}
