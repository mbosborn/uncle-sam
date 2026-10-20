/**
 * Which documents each person has signed (Project, 2026-10-16: "make sure that the tracker accurately reflects which documents have
 * been signed and which haven't, because I think the Notion has some stuff on documents wrong").
 *
 * Every 15 minutes, for everyone on a work trial (Stage Trial or Extended Offer) or with Paperwork set, Uncle Sam reads their DocuSign
 * envelopes (last 90 days, by email) and writes:
 *  - "Documents": one line per envelope that isn't voided: what it is, whether they signed it, and whether Company's countersignature
 *    is still out ("✅ Work Trial Docs (NDA, CIIAA, Terms of Service): signed · ⏳ Work Trial Agreement: sent Oct 16, not signed").
 *  - "Paperwork": Signed only when they have signed every one, Sent while any is unsigned, Declined, Voided. When DocuSign has
 *    nothing for that email, Paperwork is left as it is and Project is told once if it says Signed.
 * Project hears once per correction. UNCLE_SAM_DOCUMENTS=off stops it.
 */
import { noticeStore } from './stuck-rejections.mjs';

export const EVERY_MS = 15 * 60_000; // every 15 minutes (Project, 2026-10-20: a signature should be caught quickly)
export const NOTHING = 'Nothing in DocuSign for this email in the last 90 days.';
const day = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' }).format(ms);
const PACKET = /work trial docs?\b/i, ADDENDUM = /compensation[\s_-]*addendum/i, AGREEMENT = /work[\s_-]*trial[\s_-]*agreement/i;
export const docName = subject => {
  const s = String(subject ?? '').replace(/^Complete with Docusign:\s*/i, '').trim();
  if (ADDENDUM.test(s)) return 'Compensation addendum';
  if (AGREEMENT.test(s)) return 'Work Trial Agreement';
  if (PACKET.test(s) || /^work trial --/i.test(s)) return 'Work trial documents (NDA, CIIAA, Terms of Service)';
  return s.replace(/\.(pdf|docx?)$/i, '').slice(0, 80);
};

/** Their envelopes (as sender.envelopesFor gives them) -> { lines, paperwork: { value, signedAt } | null }. */
export function documentsOf(envelopes, email) {
  const who = String(email ?? '').toLowerCase();
  const mine = (envelopes ?? []).map(e => ({ e, s: (e.signers ?? []).find(x => x.email === who) })).filter(x => x.s);
  const live = mine.filter(x => x.e.status !== 'voided');
  if (!mine.length) return { lines: [], paperwork: null };
  if (!live.length) return { lines: [], paperwork: { value: 'Voided', signedAt: null } };
  // What has to be signed, not every envelope (Project, 2026-10-20, on Rylan: "i think he has signed now so its annoying if that
  // wasn't caught"): each document once. A signed Work Trial Agreement carries the pay terms, so it covers a compensation addendum
  // (as docusign-send.mjs already treats it); an addendum never covers the Agreement. An unsigned copy of something they signed in
  // another envelope is a leftover, shown as such, and never holds Paperwork at Sent.
  const signedBy = x => ['completed', 'signed'].includes(x.s.status) || x.e.status === 'completed';
  const need = name => name === 'Compensation addendum' ? 'pay' : name;
  const met = new Set(live.filter(signedBy).flatMap(x => { const n = docName(x.e.subject); return n === 'Work Trial Agreement' ? [n, 'pay'] : [need(n)]; }));
  const lines = live.sort((a, b) => (a.e.sentAt ?? '').localeCompare(b.e.sentAt ?? '')).map(x => {
    const { e, s } = x;
    const name = docName(e.subject);
    const others = (e.signers ?? []).filter(o => o.email !== who);
    const sent = Date.parse(e.sentAt ?? '') || s.sentAt || null;
    if (s.status === 'declined' || e.status === 'declined') return `❌ ${name}: declined`;
    if (signedBy(x)) {
      const waiting = others.filter(o => !['completed', 'signed'].includes(o.status)).map(o => o.name.split(' ')[0]);
      return `✅ ${name}: signed${waiting.length ? `, waiting on ${waiting.join(' and ')}'s countersignature` : ''}`;
    }
    if (met.has(need(name))) return `➖ ${name}: extra copy, not needed (${need(name) === 'pay' ? 'the signed Work Trial Agreement covers pay' : 'a later copy is signed'}${sent ? `; sent ${day(sent)}` : ''})`;
    return `⏳ ${name}: ${s.status === 'delivered' ? 'opened, not signed' : 'not signed'}${sent ? ` (sent ${day(sent)})` : ''}`;
  });
  const open = live.filter(x => !signedBy(x) && !met.has(need(docName(x.e.subject))));
  const signedAll = open.length === 0;
  const declined = open.some(x => x.s.status === 'declined' || x.e.status === 'declined');
  return { lines, paperwork: { value: declined ? 'Declined' : signedAll ? 'Signed' : 'Sent', signedAt: null } };
}

export async function runDocumentsSync({ env = {}, db, notion, sender, poster = null, clock = Date.now, force = false, log = () => {} }) {
  const summary = { state: 'off', checked: 0, fixed: [], unbacked: [], error: null };
  try {
    if (env.UNCLE_SAM_DOCUMENTS === 'off' || !db?.prepare || !sender?.envelopesFor || typeof notion?.setDocuments !== 'function') return summary;
    const kv = noticeStore(db), now = clock();
    if (!force && now - ((await kv.get('documents:last'))?.at ?? 0) < EVERY_MS) return { ...summary, state: 'not_due' };
    await kv.put('documents:last', { at: now }, now);
    summary.state = 'ran';
    const people = (await notion.listActiveCandidates({ includeProceeding: true }))
      .filter(c => c.email && (c.fields?.Paperwork || ['Trial', 'Extended Offer'].includes(c.fields?.Stage)));
    for (const c of people.slice(0, 40)) {
      let envelopes;
      try { envelopes = await sender.envelopesFor(c.email); } catch { continue; }
      summary.checked++;
      const { lines, paperwork } = documentsOf(envelopes, c.email);
      const text = lines.length ? lines.join('\n') : NOTHING;
      const current = c.fields?.Paperwork || null;
      // Nothing in DocuSign: Paperwork is left alone (it may have been signed elsewhere or long ago), and Project is told once.
      const value = paperwork ? paperwork.value : current;
      const wrongPaperwork = current !== value;
      if (!paperwork && current === 'Signed') summary.unbacked.push(c);
      if (!wrongPaperwork && (c.fields?.Documents ?? '') === text) continue;
      try {
        await notion.setDocuments({ pageId: c.pageId, expectedEmail: c.email, documents: text, ...(wrongPaperwork ? { paperwork: value } : {}) });
      } catch { continue; }
      if (wrongPaperwork) {
        summary.fixed.push({ c, line: `${c.fullName}: Paperwork ${current ?? 'empty'} → ${value}`, value });
        await notion.appendCandidateNote?.({ pageId: c.pageId, text: `${new Date(now).toISOString().slice(0, 10)} · Paperwork corrected from DocuSign: ${current ?? 'empty'} → ${value}. ${lines.join(' · ')} (by Uncle Sam)` })?.catch?.(() => null);
      }
    }
    if (poster) {
      const tell = [];
      for (const f of summary.fixed) if (await kv.claim(`documents:told:${f.c.pageId}:${f.value}`, { at: now }, now)) tell.push(`🎖️ ${f.line}`);
      for (const c of summary.unbacked) if (await kv.claim(`documents:unbacked:${c.pageId}`, { at: now }, now)) tell.push(`🎖️ ${c.fullName}: Paperwork says Signed, but DocuSign has nothing for ${c.email}. Check where they signed, or clear it.`);
      if (tell.length) await poster(`📋 Paperwork on the tracker, checked against DocuSign:\n${tell.slice(0, 12).join('\n')}`).catch(() => {});
    }
    summary.fixed = summary.fixed.map(f => f.line);
    summary.unbacked = summary.unbacked.map(c => c.fullName);
    return summary;
  } catch (error) {
    summary.error = typeof error?.code === 'string' ? error.code : 'documents_sync_failed';
    log(`uncle_sam_documents ${JSON.stringify(summary)}`);
    return summary;
  }
}
