import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';
import { queuePacket, runEmailQueue, HOLD_MS } from '../service/lib/email-queue.mjs';
import { runGmailNotes } from '../service/lib/record-notes.mjs';
import { runReplyWatch, classifyReply } from '../service/lib/reply-watch.mjs';
import { markFirstCheckins } from '../service/lib/work-trial.mjs';
import { createNotionClient, RECRUITING_SOURCE_ID } from '../service/lib/notion-client.mjs';
const NOW = Date.parse('2026-10-20T18:00:00Z');
const ENV = { UNCLE_SAM_AUTOMATIC_ACTIVITY: 'enabled' };
function d1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE uncle_sam_notices(name TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)');
  return { prepare: s => ({ bind: (...a) => ({ first: async () => sql.prepare(s).get(...a) ?? null,
    all: async () => ({ results: sql.prepare(s).all(...a) }), run: async () => sql.prepare(s).run(...a) }) }) };
}
const who = { pageId: '3f26ba36-8537-8000-8000-0000000000a1', fullName: 'Fixture Person', email: 'person@example.test', trialStart: '2026-10-24', trialEnd: '2026-10-25' };
const candidate = rate => ({ ...who, payment: { dailyRate: rate }, fields: { Stage: 'Trial', Outcome: 'Proceeding' } });

test('explicit rate correction supersedes pending terms, restarts delay, and resists automatic stale rediscovery', async () => {
  const db = d1(), kv = noticeStore(db), sent = [];
  await queuePacket({ db, who, rate: 100, clock: () => NOW });
  assert.equal((await queuePacket({ db, who, rate: 150, force: true, clock: () => NOW + 1000 })).reason, 'queued');
  assert.equal((await queuePacket({ db, who, rate: 100, clock: () => NOW + 2000 })).reason, 'already_queued');
  const run = time => runEmailQueue({ db, notion: { getCandidate: async () => candidate(150) }, packets: { sendNow: async p => { sent.push(p); return { reason: 'sent' }; } }, clock: () => time });
  await run(NOW + HOLD_MS); assert.equal(sent.length, 0);
  await run(NOW + HOLD_MS + 1000); await run(NOW + HOLD_MS + 2000);
  assert.equal(sent.length, 1); assert.equal(sent[0].rate, 150);
  assert.equal((await kv.get(`emailq:packet:${who.pageId}`)).rate, 150);
});

test('a rate correction racing the candidate read prevents stale dispatch', async () => {
  const db = d1(), sent = []; let release, entered;
  const waiting = new Promise(r => release = r), started = new Promise(r => entered = r);
  await queuePacket({ db, who, rate: 100, clock: () => NOW });
  const run = runEmailQueue({ db, notion: { getCandidate: async () => { entered(); await waiting; return candidate(100); } },
    packets: { sendNow: async p => { sent.push(p); return { reason: 'sent' }; } }, clock: () => NOW + HOLD_MS });
  await started;
  await queuePacket({ db, who, rate: 150, force: true, clock: () => NOW + HOLD_MS });
  release(); await run;
  assert.equal(sent.length, 0);
  assert.equal((await noticeStore(db).get(`emailq:packet:${who.pageId}`)).rate, 150);
});

test('tracker conflict holds stale legacy packets; a new instruction cannot rewrite an in-flight packet', async () => {
  const db = d1(), kv = noticeStore(db), sent = [];
  await queuePacket({ db, who, rate: 100, clock: () => NOW });
  await runEmailQueue({ db, notion: { getCandidate: async () => candidate(150) }, packets: { sendNow: async p => sent.push(p) }, clock: () => NOW + HOLD_MS });
  assert.equal(sent.length, 0);
  const q = await kv.get(`emailq:packet:${who.pageId}`);
  await kv.put(`emailq:packet:${who.pageId}`, { ...q, dispatchingAt: NOW + HOLD_MS }, NOW + HOLD_MS);
  assert.equal((await queuePacket({ db, who, rate: 150, force: true, clock: () => NOW + HOLD_MS + 1 })).reason, 'dispatch_started');
});

test('delivery completion refuses to overwrite a newer tracker rate', async () => {
  const writes = [];
  const page = { object: 'page', id: who.pageId, parent: { data_source_id: RECRUITING_SOURCE_ID }, properties: {
    Name: { type: 'title', title: [{ plain_text: who.fullName }] }, Email: { type: 'email', email: who.email },
    'Daily Trial Rate': { type: 'number', number: 150 } } };
  const notion = createNotionClient({ env: { NOTION_TOKEN: 'fixture' }, fetchImpl: async (url, init) => {
    if (init.method === 'PATCH') writes.push(JSON.parse(init.body)); return Response.json(page);
  } });
  await assert.rejects(notion.recordPacketSent({ pageId: who.pageId, expectedEmail: who.email, dailyRate: 100 }), { code: 'candidate_rate_changed' });
  assert.equal(writes.length, 0);
});

function pagedMailbox(rows) {
  const queries = [];
  return { queries, canSearch: async () => true, searchSent: async () => [], listInbox: async (query, limit, options = {}) => {
    queries.push({ query, ...options });
    const after = Number(/after:(\d+)/.exec(query)?.[1] ?? 0) * 1000;
    const before = Number(/before:(\d+)/.exec(query)?.[1] ?? Infinity) * 1000;
    const eligible = rows.filter(m => Date.parse(m.receivedAt) > after && Date.parse(m.receivedAt) < before).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    const offset = Number(options.pageToken ?? 0), messages = eligible.slice(offset, offset + limit);
    return { messages, nextPageToken: offset + limit < eligible.length ? String(offset + limit) : null };
  } };
}
const email = (id, at, from = 'stranger@example.test') => ({ id, threadId: id, from, receivedAt: new Date(at).toISOString(), text: 'I can do the assessment tomorrow.', subject: 'Trial', url: `https://mail.google.com/mail/u/0/#all/${id}` });

test('Gmail notes drains 100-message backlog across restarts before advancing watermark', async () => {
  const db = d1(), kv = noticeStore(db), since = NOW - 200 * 60000;
  await kv.put('gmailnotes:since', { at: since }, since);
  const rows = Array.from({ length: 100 }, (_, i) => email(`fixture${i}`, since + (i + 1) * 60000));
  const gmail = pagedMailbox(rows);
  const notion = { readControl: async () => ({ mode: 'Live' }), listActiveCandidates: async () => [] };
  for (let i = 0; i < 3; i++) {
    await runGmailNotes({ env: ENV, db, notion, gmail, clock: () => NOW + i * 300000 });
    if (i < 2) assert.equal((await kv.get('gmailnotes:since')).at, since);
  }
  for (const m of rows) assert.ok(await kv.get(`gmailnote:${m.id}`), m.id);
  assert.equal(await kv.get('gmailnotes:scan'), null);
  assert.equal((await kv.get('gmailnotes:since')).at, NOW, 'fixed original high-water mark');
  assert.deepEqual(gmail.queries.map(q => q.pageToken), [null, '40', '80']);
});

test('an inbox page failure does not advance its continuation cursor', async () => {
  const db = d1(), kv = noticeStore(db), since = NOW - 10000;
  await kv.put('gmailnotes:since', { at: since }, since);
  const result = await runGmailNotes({ env: ENV, db, notion: { readControl: async () => ({ mode: 'Live' }) },
    gmail: { canSearch: async () => true, listInbox: async () => { throw Error('outage'); } }, clock: () => NOW });
  assert.ok(result.error); assert.equal((await kv.get('gmailnotes:since')).at, since);
  assert.equal((await kv.get('gmailnotes:scan')).pageToken, null);
});

test('failed or truncated reply interpretation stays pending and later succeeds exactly once', async () => {
  for (const failure of ['provider', 'truncated', 'missing', 'malformed']) {
    const db = d1(), kv = noticeStore(db), notes = [];
    await kv.put('replies:since', { at: NOW - 60000 }, NOW);
    const m = email('abc123', NOW - 1000, who.email), gmail = pagedMailbox([m]);
    const notion = { readControl: async () => ({ mode: 'Live' }), findCandidatesByEmail: async () => [candidate(100)], appendCandidateNote: async n => notes.push(n) };
    const complete = async () => {
      if (failure === 'provider') throw Object.assign(Error('down'), { code: 'provider_429' });
      if (failure === 'truncated') return { stopReason: 'max_tokens', content: [] };
      if (failure === 'malformed') return { content: [{ type: 'tool_use', name: 'classify', input: { kind: 'invented' } }] };
      return { content: [] };
    };
    const run = claude => runReplyWatch({ env: ENV, db, notion, gmail, claude, post: async () => {}, clock: () => NOW });
    assert.ok((await run({ complete })).error);
    assert.equal(await kv.get('reply:abc123'), null); assert.equal(notes.length, 0);
    assert.ok(await kv.get('replies:scan'));
    await run({ complete: async () => ({ content: [{ type: 'tool_use', name: 'classify', input: { kind: 'thanks' } }] }) });
    assert.equal((await kv.get('reply:abc123')).kind, 'thanks'); assert.equal(notes.length, 1);
    assert.equal(await kv.get('reply-retry:abc123'), null);
  }
  assert.ok((await classifyReply({ claude: null, text: 'I withdraw.' })).error);
});

test('reply watcher drains more than 25 messages instead of repeatedly processing only the newest page', async () => {
  const db = d1(), kv = noticeStore(db), since = NOW - 100000;
  await kv.put('replies:since', { at: since }, since);
  const rows = Array.from({ length: 70 }, (_, i) => email(`reply${i}`, since + 1000 + i * 1000));
  const gmail = pagedMailbox(rows), notion = { readControl: async () => ({ mode: 'Live' }), findCandidatesByEmail: async () => [] };
  for (let i = 0; i < 3; i++) await runReplyWatch({ env: ENV, db, notion, gmail, post: async () => {}, clock: () => NOW + i * 300000 });
  for (const m of rows) assert.ok(await kv.get(`reply:${m.id}`), m.id);
});

test('elapsed trial dates and unavailable calendar never mark a check-in done', async () => {
  for (const unavailable of [true, false]) {
    const writes = [], c = { ...candidate(100), fields: { 'Trial Start': '2026-10-01', 'Trial End': '2026-10-03' } };
    const out = await markFirstCheckins({ db: d1(), notion: { listTierCandidates: async () => [c], setFirstCheckinDone: async v => writes.push(v) },
      calendar: { listEvents: async () => { if (unavailable) throw Error('outage'); return []; } }, clock: () => NOW, force: true });
    assert.equal(out.marked, 0); assert.equal(writes.length, 0);
    if (unavailable) assert.ok(out.error);
  }
});
