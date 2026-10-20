import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { documentsOf, runDocumentsSync, docName, NOTHING } from '../service/lib/docusign-documents.mjs';

function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-16T20:00:00Z');
const MORGAN = 'morgan@example.com';
const env = (id, subject, status, sentAt, signers) => ({ id, subject, status, sentAt, signers: signers.map(([email, st, name = 'X Y']) => ({ email, status: st, name })) });
const morganEnvelopes = [
  env('a', 'Work Trial Docs -- Morgan Ellis', 'completed', '2026-10-01T18:00:00Z', [[MORGAN, 'completed']]),
  env('b', 'Work Trial Compensation Addendum -- Morgan Ellis', 'sent', '2026-10-05T18:00:00Z', [[MORGAN, 'completed'], ['robin@company.example', 'sent', 'Robin Cooper']]),
  env('c', 'Work Trial Agreement - Morgan Ellis.pdf', 'sent', '2026-10-16T18:00:00Z', [[MORGAN, 'sent']]),
  env('d', 'Work Trial Docs -- Morgan Ellis', 'voided', '2026-09-30T18:00:00Z', [[MORGAN, 'sent']]),
];

test('each live document and who still has to sign it; Signed only when they signed every one', () => {
  assert.equal(docName('Complete with Docusign: Work Trial Compensation Addendum -- A B'), 'Compensation addendum');
  const { lines, paperwork } = documentsOf(morganEnvelopes, MORGAN);
  assert.deepEqual(lines, [
    '✅ Work trial documents (NDA, CIIAA, Terms of Service): signed',
    "✅ Compensation addendum: signed, waiting on Robin's countersignature",
    '⏳ Work Trial Agreement: not signed (sent Oct 16)',
  ]);
  assert.equal(paperwork.value, 'Sent');
  assert.equal(documentsOf(morganEnvelopes.slice(0, 2), MORGAN).paperwork.value, 'Signed');
  assert.equal(documentsOf([morganEnvelopes[3]], MORGAN).paperwork.value, 'Voided');
  assert.equal(documentsOf([], MORGAN).paperwork, null);
});

test('the hourly sync: Documents written, a wrong Paperwork corrected and Project told once; nothing in DocuSign leaves Paperwork alone', async () => {
  const db = d1(), writes = [], said = [];
  const people = [
    { pageId: 'p-morgan', fullName: 'Morgan Ellis', email: MORGAN, fields: { Stage: 'Trial', Paperwork: 'Signed' } },
    { pageId: 'p-reagan', fullName: 'Reagan Turner', email: 'reagan@example.com', fields: { Stage: 'Case Study', Paperwork: 'Signed' } },
    { pageId: 'p-new', fullName: 'Not Yet', email: 'no@example.com', fields: { Stage: 'Interview' } },
  ];
  const notion = { listActiveCandidates: async () => people, setDocuments: async w => { writes.push(w); }, appendCandidateNote: async () => null };
  const sender = { envelopesFor: async email => (email === MORGAN ? morganEnvelopes : []) };
  const out = await runDocumentsSync({ db, notion, sender, poster: async t => said.push(t), clock: () => NOW });
  assert.deepEqual(out.fixed, ['Morgan Ellis: Paperwork Signed → Sent']);
  assert.deepEqual(out.unbacked, ['Reagan Turner']);
  assert.equal(writes.length, 2, 'the person at Interview with no Paperwork is not checked');
  assert.equal(writes[0].paperwork, 'Sent');
  assert.equal(writes[1].documents, NOTHING);
  assert.ok(!('paperwork' in writes[1]), 'Paperwork left alone when DocuSign has nothing');
  assert.match(said[0], /Morgan Ellis: Paperwork Signed → Sent[\s\S]*Reagan Turner: Paperwork says Signed, but DocuSign has nothing/);
  assert.equal((await runDocumentsSync({ db, notion, sender, poster: async t => said.push(t), clock: () => NOW + 60_000 })).state, 'not_due');
  people[0].fields = { ...people[0].fields, Paperwork: 'Signed' };
  await runDocumentsSync({ db, notion, sender, poster: async t => said.push(t), clock: () => NOW + 2 * 3600_000 });
  assert.equal(said.length, 1, 'each correction told once');
});

test('Rylan: a signed later copy and a signed Agreement make the leftovers not count; Paperwork is Signed (Project, 2026-10-20)', () => {
  const R = 'rylanking@example.test';
  const list = [
    env('old', 'Complete with Docusign: Work Trial Docs -- Rylan King', 'delivered', '2026-10-16T22:36:01Z', [['jamie@company.example', 'completed'], [R, 'delivered']]),
    env('agr', 'Complete with Docusign: Company - Work Trial Agreement - Rylan King', 'completed', '2026-10-16T22:35:58Z', [['alexis@company.example', 'completed'], [R, 'completed']]),
    env('add', 'Work Trial Compensation Addendum -- Rylan King', 'sent', '2026-10-19T20:12:20Z', [[R, 'delivered'], ['project@company.example', 'created', 'Project Owner']]),
    env('new', 'Complete with Docusign: Work Trial Docs -- Rylan King', 'sent', '2026-10-19T20:48:45Z', [['project@company.example', 'sent', 'Project Owner'], [R, 'completed']]),
  ];
  const { lines, paperwork } = documentsOf(list, R);
  assert.equal(paperwork.value, 'Signed', lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith('➖ Work trial documents')), lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith('➖ Compensation addendum')), lines.join('\n'));
  // Morgan: an addendum never stands in for an unsigned Agreement.
  assert.equal(documentsOf(morganEnvelopes, MORGAN).paperwork.value, 'Sent');
});
