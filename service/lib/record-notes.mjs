/**
 * The clerk's last jobs, done by Uncle Sam itself (Project, 2026-10-15: "if uncle sam can do it instead of the clerk have uncle
 * sam do it", "attempting to move over everything else to uncle sam as well"):
 *  - Wispr Flow: from each recruiting meeting it already reads for rejections, the recruiting facts about open candidates
 *    become Note rows (Action "wispr"), the same way Slack DMs do (slack-dm-watch.mjs).
 *  - Gmail: every new email in Project's mailbox to or from a candidate's exact address (his own and his teammates' emails
 *    with them too, but never the ones Uncle Sam sends) is read once; its recruiting facts become Note rows (Action "gmail").
 *  - Interviewer's deep-dive link: when Interviewer himself sends a new reusable scheduling link for his technical deep dive (email
 *    or Slack DM), it replaces the Booking link on the Interviewer links board and Project is told. Single-use Calendly links
 *    ("/d/") never count.
 * Every note keeps a word-for-word quote and never a pay figure. Nothing here emails or messages a candidate. Never throws.
 */
import { findNotes, NOTE_DIGEST } from './slack-dm-watch.mjs';
import { noticeStore } from './stuck-rejections.mjs';

const clean = (text, max) => String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const iso = ms => new Date(ms).toISOString();
const dayOf = ms => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(ms);
const httpsOrNull = url => { try { return new URL(url).protocol === 'https:' ? String(url) : null; } catch { return null; } };

const FIRST_SENTENCE = NOTE_DIGEST.slice(0, NOTE_DIGEST.indexOf('\n'));
const digestFor = what => NOTE_DIGEST.replace(FIRST_SENTENCE, `You read ${what} and keep only recruiting facts about the open candidates listed.`);
export const WISPR_NOTE_DIGEST = digestFor("the transcript of one Company AI recruiting meeting (in numbered parts; message_index is the part number) recorded in Project Owner's Wispr Flow. Final rejections are handled separately, so you may skip them");
export const GMAIL_NOTE_DIGEST = digestFor("new emails in Project Owner's (Company AI) mailbox between the recruiting team and candidates. Skip routine automated emails (take-home and deep-dive invitations, reminders, rejections, calendar notifications)");

/** A transcript cut into parts of about 1,500 characters on line breaks, so each quote can be checked against one part. */
export function transcriptParts(transcript, size = 1500, max = 140) {
  const parts = [];
  let current = '';
  for (const line of String(transcript ?? '').split(/\n+/)) {
    const text = line.trim();
    if (!text) continue;
    if (current && current.length + text.length + 1 > size) { parts.push(current); current = ''; }
    current = current ? `${current} ${text}` : text.slice(0, size * 2);
    if (parts.length >= max) break;
  }
  if (current && parts.length < max) parts.push(current);
  return parts;
}

/** One finished recruiting meeting's facts as Note rows (Action "wispr"); returns how many. Throws on a model/Notion failure. */
export async function wisprNotes({ claude, notion, meeting, transcript, candidates, policyVersion = 'uncle-sam', clock = Date.now }) {
  const start = Date.parse(meeting.start) || clock();
  const title = clean(meeting.title || 'Recruiting meeting', 120);
  const messages = transcriptParts(transcript).map((text, i) => ({ channelId: String(meeting.id).toLowerCase(), ts: String(i), kind: 'recruiting meeting', speaker: title, day: dayOf(start), text }));
  if (!messages.length || !candidates.length) return 0;
  const notes = await findNotes({ claude, messages, candidates, system: WISPR_NOTE_DIGEST });
  let written = 0;
  for (const n of notes) {
    const key = `wispr:${n.message.channelId}:${n.message.ts}:${n.candidate.pageId}`;
    await notion.upsertOperationsRecord({ policyVersion, recordKind: 'Note', requestKey: key, sourceEventKey: key, state: 'Complete', mode: 'Live', action: 'wispr',
      name: `Note · ${clean(n.candidate.fullName, 120)} · wispr`, candidatePageId: n.candidate.pageId, occurredAt: iso(start), observedAt: iso(clock()),
      sourceUrl: httpsOrNull(meeting.url) ?? undefined,
      resultEvidence: `${n.fact} In the Wispr meeting "${title}", ${dayOf(start)} PT: “${n.quote}”`.slice(0, 600) });
    written++;
  }
  return written;
}

/* ---------- Interviewer's deep-dive link ---------- */

export const INTERVIEWER = Object.freeze({ email: 'quinn@company.example', interviewer: 'Interviewer (Quinn)', useFor: 'Technical interview' });
const SCHEDULING_HOST = /^(?:www\.)?(?:calendly\.com|cal\.com|calendar\.app\.google|zcal\.co|savvycal\.com)$/i;
const DEEP_DIVE = /deep[\s-]?dive|technical/i;

/** The one reusable scheduling link for a deep dive in Interviewer's message, or null (none, several, single-use or unrelated). */
export function santoshDeepDiveLink(text) {
  const found = new Set();
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>|"')\]]+/gi)) {
    let url;
    try { url = new URL(m[0].replace(/[.,;:!?]+$/, '')); } catch { continue; }
    const appointments = url.hostname === 'calendar.google.com' && url.pathname.startsWith('/calendar/appointments/');
    if (!SCHEDULING_HOST.test(url.hostname) && !appointments) continue;
    if (/^calendly\.com$/i.test(url.hostname.replace(/^www\./, '')) && (url.pathname.startsWith('/d/') || url.pathname.split('/').filter(Boolean).length < 2)) continue;
    url.protocol = 'https:'; url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (/^utm_|^month$|^date$/i.test(k)) url.searchParams.delete(k);
    found.add(url.toString().replace(/\/$/, ''));
  }
  if (found.size !== 1) return null;
  const [link] = found;
  return DEEP_DIVE.test(text) || DEEP_DIVE.test(link) ? link : null;
}

/** Put Interviewer's newest deep-dive link on the board when it differs; tells Project once per link. */
export async function updateSantoshLink({ notion, db, poster = null, text, source, sourceUrl = null, clock = Date.now }) {
  const link = santoshDeepDiveLink(text);
  if (!link || typeof notion?.setBookingLink !== 'function') return { changed: false };
  const kv = noticeStore(db), marker = `interviewer-link:${link}`, now = clock();
  if (!(await kv.claim(marker, { at: now, pending: true }, now))) return { changed: false };
  const today = new Date(now).toISOString().slice(0, 10);
  let result;
  try {
    result = await notion.setBookingLink({ interviewer: INTERVIEWER.interviewer, useFor: INTERVIEWER.useFor, url: link,
      note: `${today} · Interviewer sent a new deep-dive link (${source}${sourceUrl ? `: ${sourceUrl}` : ''}); Uncle Sam put it in Booking link.` });
  } catch (error) { await kv.del(marker).catch(() => {}); throw error; } // not written: the next sighting tries again
  await kv.put(marker, { at: now, changed: result.changed }, now);
  if (result.changed && poster) await poster(`📅 Interviewer sent a new deep-dive scheduling link (${source}): <${link}>. I put it on the Interviewer links board, so the next deep-dive invites use it.${sourceUrl ? ` <${sourceUrl}|Where he sent it>` : ''}`).catch(() => {});
  return { changed: result.changed, link };
}

/* ---------- Gmail ---------- */

export const GMAIL_NOTES_QUERY = '-in:spam -in:trash -in:drafts -category:promotions -category:social -category:forums';
const MAX_EMAILS = 40;

/** One tick's Gmail reading (every tick; a cursor keeps each email to one read). */
export async function runGmailNotes({ env, db, notion, gmail, claude, poster = null, policyVersion = 'uncle-sam', clock = Date.now, log = () => {} }) {
  const summary = { state: 'off', seen: 0, matched: 0, notes: 0, santoshLink: false, error: null };
  try {
    if (env?.UNCLE_SAM_AUTOMATIC_ACTIVITY !== 'enabled' || !gmail || !db?.prepare) return summary;
    if ((await notion.readControl())?.mode !== 'Live') return { ...summary, state: 'not_live' };
    if (!(await gmail.canSearch())) return { ...summary, state: 'waiting_for_gmail_read' };
    summary.state = 'on';
    const kv = noticeStore(db), now = clock();
    const since = (await kv.get('gmailnotes:since'))?.at;
    if (!since) { await kv.put('gmailnotes:since', { at: now }, now); return { ...summary, state: 'started' }; }
    // Hold a fixed interval until every page is processed; new arrivals belong to the next interval.
    const scan = (await kv.get('gmailnotes:scan')) ?? { since, until: Math.floor(now / 1000) * 1000, pageToken: null };
    await kv.put('gmailnotes:scan', scan, now);
    const page = await gmail.listInbox(`after:${Math.floor(scan.since / 1000) - 120} before:${Math.floor(scan.until / 1000)} ${GMAIL_NOTES_QUERY}`, MAX_EMAILS,
      { pageToken: scan.pageToken, paged: true });
    const fetched = Array.isArray(page) ? page : page.messages;
    const finishPage = async () => {
      if (page.nextPageToken) await kv.put('gmailnotes:scan', { ...scan, pageToken: page.nextPageToken }, now);
      else { await kv.put('gmailnotes:since', { at: scan.until }, now); await kv.del('gmailnotes:scan'); }
    };
    const fresh = [];
    for (const m of fetched.reverse()) { // oldest first
      const at = Date.parse(m.receivedAt ?? '');
      if (!(at >= scan.since - 120_000) || await kv.get(`gmailnote:${m.id}`)) continue;
      fresh.push({ ...m, at });
    }
    summary.seen = fresh.length;
    if (!fresh.length) { await finishPage(); return summary; }
    // Interviewer's own emails: his deep-dive link.
    for (const m of fresh) {
      if (m.from !== INTERVIEWER.email) continue;
      try { if ((await updateSantoshLink({ notion, db, poster, text: `${m.subject}\n${m.text}`, source: `email "${clean(m.subject, 80)}"`, sourceUrl: m.url, clock })).changed) summary.santoshLink = true; }
      catch (error) { log(`uncle_sam_gmail_notes santosh_link_failed error=${error?.code ?? 'failed'}`); }
    }
    const candidates = await notion.listActiveCandidates({ includeProceeding: true });
    const byEmail = new Map();
    for (const c of candidates) if (c.email && !/^\[(?:TEST|FIXTURE)\]/i.test(c.fullName)) {
      const e = c.email.toLowerCase();
      byEmail.set(e, byEmail.has(e) ? null : c); // two records on one address: neither is used
    }
    const batch = [], roster = new Map();
    for (const m of fresh.slice(0, MAX_EMAILS)) {
      if (m.byUncleSam) continue;
      const people = [...new Set([m.from, ...(m.to ?? []), ...(m.cc ?? [])].filter(Boolean))].map(e => byEmail.get(e)).filter(Boolean);
      if (!people.length) continue;
      summary.matched++;
      for (const c of people) roster.set(c.pageId, c);
      batch.push({ channelId: m.threadId, ts: m.id, kind: 'email', speaker: clean(m.fromName || m.from, 80), day: dayOf(m.at), url: m.url, at: m.at,
        text: clean(`Subject: ${m.subject} — ${m.text}`, 3000) });
    }
    if (batch.length) {
      const notes = await findNotes({ claude, messages: batch, candidates: [...roster.values()], system: GMAIL_NOTE_DIGEST });
      for (const n of notes) {
        const key = `gmail:${n.message.channelId}:${n.message.ts}:${n.candidate.pageId}`;
        await notion.upsertOperationsRecord({ policyVersion, recordKind: 'Note', requestKey: key, sourceEventKey: key, state: 'Complete', mode: 'Live', action: 'gmail',
          name: `Note · ${clean(n.candidate.fullName, 120)} · gmail`, candidatePageId: n.candidate.pageId, occurredAt: iso(n.message.at), observedAt: iso(clock()),
          sourceUrl: httpsOrNull(n.message.url) ?? undefined,
          resultEvidence: `${n.fact} ${n.message.speaker} by email, ${n.message.day} PT: “${n.quote}”`.slice(0, 600) });
        summary.notes++;
      }
    }
    // Only after the notes are written, so a failed tick reads the same emails again.
    for (const m of fresh.slice(0, MAX_EMAILS)) { await kv.put(`gmailnote:${m.id}`, { at: now }, now); }
    if (fresh.length <= MAX_EMAILS) await finishPage();
    return summary;
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'gmail_notes_failed';
    log(`uncle_sam_gmail_notes error=${code}`);
    return { ...summary, error: code, ...(error?.reason ? { reason: error.reason } : {}) };
  }
}
