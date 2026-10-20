import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { applyConnectEvent, connectSignatureOk, envelopeOf, paperworkOf, reconcilePaperwork } from '../service/lib/docusign.mjs';

const KEY = 'fixture-connect-hmac-key-0123456789';
const NOW = Date.parse('2026-10-16T18:00:00Z');
const JANE = { pageId: '3f26ba36-8537-8000-8000-00000000000a', fullName: 'Jane Fixture', email: 'jane@example.invalid', fields: { Stage: 'Trial' } };
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a),
    all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const event = (id, status, { at = '2026-10-16T17:00:00Z', completedAt = null, signer = 'completed' } = {}) => ({ event: `envelope-${status}`, generatedDateTime: at,
  data: { envelopeId: id, envelopeSummary: { status, emailSubject: 'Company Work Trial Agreement', sentDateTime: '2026-10-15T17:00:00Z', completedDateTime: completedAt,
    recipients: { signers: [{ email: 'Jane@Example.invalid', name: 'Jane Fixture', status: signer, signedDateTime: completedAt }] } } } });
const ID1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', ID2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

test('DocuSign Connect: only a body signed with the account key is accepted', async () => {
  const body = JSON.stringify(event(ID1, 'completed'));
  const sig = createHmac('sha256', KEY).update(body).digest('base64');
  assert.equal(await connectSignatureOk({ body, key: KEY, headers: new Headers({ 'x-docusign-signature-1': sig }) }), true);
  assert.equal(await connectSignatureOk({ body, key: KEY, headers: new Headers({ 'x-docusign-signature-2': 'nope', 'x-docusign-signature-1': sig }) }), true);
  assert.equal(await connectSignatureOk({ body: body + ' ', key: KEY, headers: new Headers({ 'x-docusign-signature-1': sig }) }), false);
  assert.equal(await connectSignatureOk({ body, key: KEY, headers: new Headers() }), false);
  assert.equal(envelopeOf(event(ID1, 'completed')).signers[0].email, 'jane@example.invalid');
});

test('Paperwork is Signed once the person has signed every envelope they are on (a countersignature may still be due)', () => {
  const E = 'jane@example.invalid', env = (status, signer, signedAt = null) => ({ status, completedAt: status === 'completed' ? signedAt : null, signers: [{ email: E, status: signer, signedAt }] });
  assert.deepEqual(paperworkOf([env('completed', 'completed', '2026-10-16T17:00:00Z'), env('sent', 'sent')], E), { value: 'Sent', signedAt: null });
  assert.deepEqual(paperworkOf([env('completed', 'completed', '2026-10-16T17:00:00Z'), env('voided', 'sent')], E), { value: 'Signed', signedAt: '2026-10-16T17:00:00.000Z' });
  assert.deepEqual(paperworkOf([env('completed', 'completed', '2026-10-16T17:00:00Z'), env('sent', 'completed', '2026-10-16T17:30:00Z')], E), { value: 'Signed', signedAt: '2026-10-16T17:30:00.000Z' }, 'Company still to countersign');
  assert.equal(paperworkOf([env('declined', 'declined'), env('completed', 'completed')], E).value, 'Declined');
  assert.equal(paperworkOf([env('sent', 'sent')], 'other@example.invalid'), null);
});

test('DocuSign Connect: sent then signed updates the tracker, notes it, and tells Project once everything is signed', async () => {
  const db = d1(), rows = [], patches = [], notes = [], posted = [];
  const candidate = { ...JANE, fields: { ...JANE.fields } };
  const notion = { findCandidatesByEmail: async email => email === 'jane@example.invalid' ? [candidate] : [],
    upsertOperationsRecord: async r => { rows.push(r); return { verified: true }; },
    setPaperwork: async p => { patches.push(p); candidate.fields.Paperwork = p.value; if (p.signedAt) candidate.fields['Paperwork signed'] = p.signedAt; return { verified: true }; },
    appendCandidateNote: async n => { notes.push(n); return { verified: true }; } };
  const poster = async t => posted.push(t);
  await applyConnectEvent({ event: event(ID1, 'sent', { signer: 'sent' }), db, notion, poster, clock: () => NOW });
  await applyConnectEvent({ event: event(ID2, 'sent', { signer: 'sent' }), db, notion, poster, clock: () => NOW });
  assert.deepEqual(patches.map(p => p.value), ['Sent']);
  await applyConnectEvent({ event: event(ID1, 'completed', { at: '2026-10-16T17:10:00Z', completedAt: '2026-10-16T17:10:00Z' }), db, notion, poster, clock: () => NOW });
  assert.equal(candidate.fields.Paperwork, 'Sent', 'one of two still out');
  assert.equal(posted.length, 0);
  await applyConnectEvent({ event: event(ID2, 'completed', { at: '2026-10-16T17:20:00Z', completedAt: '2026-10-16T17:20:00Z' }), db, notion, poster, clock: () => NOW });
  assert.equal(candidate.fields.Paperwork, 'Signed');
  assert.equal(patches.at(-1).signedAt, '2026-10-16T17:20:00.000Z');
  assert.equal(posted.length, 1); assert.match(posted[0], /^📋 Jane Fixture signed all their DocuSign paperwork/);
  assert.equal(rows.filter(r => r.action === 'docusign').length, 4);
  // A late, older event never moves it back; a repeat changes nothing.
  await applyConnectEvent({ event: event(ID2, 'sent', { at: '2026-10-16T17:05:00Z', signer: 'sent' }), db, notion, poster, clock: () => NOW });
  await applyConnectEvent({ event: event(ID2, 'completed', { at: '2026-10-16T17:20:00Z', completedAt: '2026-10-16T17:20:00Z' }), db, notion, poster, clock: () => NOW });
  assert.equal(candidate.fields.Paperwork, 'Signed'); assert.equal(posted.length, 1); assert.equal(rows.length, 4);
});

test('DocuSign catch-up: a signing whose update failed is put on the record within minutes; three failures reach Project once; never backwards', async () => {
  const db = d1(), posts = [], writes = [];
  let record = { ...JANE, fields: { Stage: 'Trial', Paperwork: 'Sent' } }, failing = true;
  const notion = { findCandidatesByEmail: async () => [structuredClone(record)], appendCandidateNote: async () => ({ verified: true }),
    upsertOperationsRecord: async () => ({ verified: true }),
    setPaperwork: async a => { if (failing) throw Object.assign(new Error('x'), { code: 'notion_http_502' }); writes.push(a); record.fields.Paperwork = a.value; record.fields['Paperwork signed'] = a.signedAt; return { verified: true }; } };
  const done = event(ID1, 'completed', { at: '2026-10-16T17:00:00Z', completedAt: '2026-10-16T16:59:00Z' });
  await assert.rejects(applyConnectEvent({ event: done, db, notion, clock: () => NOW }), 'the live update fails');
  const run = now => reconcilePaperwork({ db, notion, poster: async t => { posts.push(t); }, clock: () => now });
  for (let i = 0; i < 3; i++) await run(NOW + i * 11 * 60_000);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /couldn't put it on the tracker after 3 tries \(notion_http_502\)/);
  await run(NOW + 40 * 60_000);
  assert.equal(posts.length, 1, 'told once');

  const db2 = d1(); record = { ...JANE, fields: { Stage: 'Trial', Paperwork: 'Sent' } };
  await assert.rejects(applyConnectEvent({ event: done, db: db2, notion, clock: () => NOW }));
  failing = false;
  const fixed = await reconcilePaperwork({ db: db2, notion, poster: async t => { posts.push(t); }, clock: () => NOW + 11 * 60_000 });
  assert.equal(fixed.fixed, 1);
  assert.deepEqual(writes[0], { pageId: JANE.pageId, expectedEmail: JANE.email, value: 'Signed', signedAt: '2026-10-16T16:59:00.000Z' });
  assert.match(posts.at(-1), /^📋 Jane Fixture signed all their DocuSign paperwork\./);
  assert.equal((await reconcilePaperwork({ db: db2, notion, clock: () => NOW + 22 * 60_000 })).fixed, 0, 'in step: nothing to do');
  record.fields.Paperwork = 'Voided';
  assert.equal((await reconcilePaperwork({ db: db2, notion, clock: () => NOW + 33 * 60_000 })).fixed, 0, 'a value set past it by hand is left alone');
});
