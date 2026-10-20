import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { checkDocumentContent, validateDocumentInputs, classifyDocument } from '../service/lib/document-content-check.mjs';
import { renderAddendum, ANCHORS } from '../service/lib/compensation-addendum.mjs';
import nda from '../service/lib/document-schemas/nda.json' with { type: 'json' };
import ciiaa from '../service/lib/document-schemas/ciiaa.json' with { type: 'json' };
import terms from '../service/lib/document-schemas/terms.json' with { type: 'json' };

const candidate = { name: 'Jane Example', email: 'jane@example.com' };
const company = { name: 'Project Owner', email: 'project@company.example' };
const envelopeId = '99999999-9999-9999-9999-999999999999';
const names = ['Company_NDA.pdf', 'Company_CIIAA_Template_Blank.pdf', 'Company_Terms_of_Service_.pdf'];
const schemas = [nda, ciiaa, terms];
const input = { candidate, company, dailyRate: 100, start: '2026-10-24', end: '2026-10-25', date: '2026-10-20' };

// Synthetic PDFs contain no real candidate data; the separate overlays recreate
// the actual failure shape (recipient identity and flattened page text can differ).
async function fixture(schema, mutate = pages => pages, { image = false, blankPage = false, stamp = envelopeId } = {}) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = mutate(schema.pages.map(text => text.replaceAll('{{candidateName}}', candidate.name)));
  for (let i = 0; i < pages.length; i++) {
    const page = pdf.addPage([1200, 1800]);
    let y = 1750, line = '';
    for (const word of pages[i].split(/\s+/)) {
      if ((line + ' ' + word).length > 165) {
        page.drawText(line, { x: 35, y, size: 10, font }); y -= 15; line = '';
      }
      line += (line ? ' ' : '') + word;
    }
    if (line) page.drawText(line, { x: 35, y, size: 10, font });
    if (stamp) page.drawText(`Docusign Envelope ID: ${stamp}`, { x: 35, y: 20, size: 8, font });
    if (image && i === 0) {
      const png = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
      page.drawImage(png, { x: 5, y: 5, width: 10, height: 10 });
    }
  }
  if (blankPage) pdf.addPage([612, 792]).drawRectangle({ x: 1, y: 1, width: 5, height: 5, color: rgb(1, 1, 1) });
  return pdf.save();
}
const standard = await Promise.all(schemas.map((schema, i) => fixture(schema).then(bytes => ({ documentId: String(i + 1), name: names[i], bytes }))));
const addendumBytes = await renderAddendum({ name: candidate.name, email: candidate.email, company, dailyRate: 100, start: input.start, end: input.end, date: input.date });
const addendum = { documentId: '4', name: `Work Trial Compensation Addendum - ${candidate.name}.pdf`, bytes: addendumBytes };
const run = (documents = standard, extra = {}) => checkDocumentContent({ documents, candidate, envelopeId, ...extra });
const blocked = async (promise, reason) => assert.rejects(promise, error => error.code === 'docusign_document_validation_failed'
  && (!reason || error.detail.includes(reason)) && !error.detail.includes(candidate.email));

test('complete 41-page standard packet passes and returns hashes for every page', async () => {
  const receipt = await run();
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(receipt.documents.map(d => [d.kind, d.pageCount]), [['nda', 3], ['ciiaa', 4], ['terms', 34]]);
  for (const doc of receipt.documents) {
    assert.match(doc.sha256, /^[a-f0-9]{64}$/);
    assert.equal(doc.pages.length, doc.pageCount);
    assert.ok(doc.pages.every(page => /^[a-f0-9]{64}$/.test(page.textSha256)));
  }
});

test('wrong names in two NDA body slots block even when other documents carry correct identity', async () => {
  const bytes = await fixture(nda, pages => pages.map((text, i) => i === 0 ? text.replaceAll(candidate.name, 'Previous Candidate') : text));
  await blocked(run([{ ...standard[0], bytes }, ...standard.slice(1)]), 'nda page 1: page_content_mismatch');
});

test('wrong signature identity, extra name and wording drift anywhere are blocked', async () => {
  for (const [index, page, mutate] of [
    [1, 2, text => text.replace(candidate.name, 'Previous Candidate')],
    [2, 33, text => text.replace(candidate.name, 'Previous Candidate')],
    [0, 1, text => text + ' Another Candidate'],
    [2, 19, text => text.replace('twelve (12)', 'twenty-four (24)')],
  ]) {
    const bytes = await fixture(schemas[index], pages => pages.map((text, i) => i === page ? mutate(text) : text));
    const docs = standard.map((doc, i) => i === index ? { ...doc, bytes } : doc);
    await blocked(run(docs), 'page_content_mismatch');
  }
});

test('all actual documents must have a unique recognized type and ID', async () => {
  await blocked(run(standard.slice(0, 2)), 'document_count_mismatch');
  await blocked(run([...standard, { ...standard[0], documentId: '5' }]), 'document_count_mismatch');
  await blocked(run(standard.map((doc, i) => i === 1 ? { ...doc, name: 'Unreviewed.pdf' } : doc)), 'unrecognized_document_name');
  await blocked(run(standard.map((doc, i) => i === 1 ? { ...doc, documentId: '1' } : doc)), 'invalid_or_duplicate_document_id');
  await blocked(run(standard.map((doc, i) => i === 1 ? { ...doc, name: names[0] } : doc)), 'duplicate_or_unexpected_document_type');
});

test('corrupt PDFs, empty pages, omitted pages, unexpected image overlays and other envelope stamps block', async () => {
  for (const [bytes, reason] of [
    [Buffer.from('%PDF-broken'), 'pdf_extraction_failed'],
    [await fixture(nda, pages => pages, { blankPage: true }), 'empty_or_unreadable_page'],
    [await fixture(nda, pages => pages.slice(0, 2)), 'page_count_mismatch'],
    [await fixture(nda, pages => pages, { image: true }), 'unreviewed_image_content'],
    [await fixture(nda, pages => pages, { stamp: '11111111-1111-1111-1111-111111111111' }), 'envelope_stamp_mismatch'],
  ]) await blocked(run([{ ...standard[0], bytes }, ...standard.slice(1)]), reason);
});

test('unsigned draft without envelope stamp passes; unresolved template markers block', async () => {
  const bytes = await fixture(nda, pages => pages, { stamp: null });
  assert.equal((await run([{ ...standard[0], bytes }, ...standard.slice(1)])).status, 'passed');
  const bad = await fixture(nda, pages => pages.map((text, i) => i === 0 ? text.replace(candidate.name, '{{candidateName}}') : text));
  await blocked(run([{ ...standard[0], bytes: bad }, ...standard.slice(1)]), 'unresolved_placeholder');
});

test('standalone and packet addendum require and compare independently regenerated expected content', async () => {
  const receipt = await run([addendum], { mode: 'addendum', expectedAddendumBytes: addendumBytes });
  assert.equal(receipt.status, 'passed');
  assert.deepEqual(Object.keys(receipt.expectedAddendumAnchors).sort(), Object.values(ANCHORS).sort());
  assert.equal(receipt.expectedAddendumAnchors[ANCHORS.candidateSign].x, 320);
  assert.equal(receipt.expectedAddendumAnchors[ANCHORS.candidateSign].page, 2);
  assert.equal(receipt.expectedAddendumAnchors[ANCHORS.candidateSign].height, 6);
  assert.equal(receipt.expectedAddendumAnchors[ANCHORS.candidateSign].baselineY, 102);
  assert.deepEqual(receipt.expectedAddendumPages, [{ page: 1, width: 612, height: 792 }, { page: 2, width: 612, height: 792 }]);
  assert.equal((await run([...standard, addendum], { expectedAddendumBytes: addendumBytes })).documents.length, 4);
  await blocked(run([addendum], { mode: 'addendum' }), 'invalid_pdf_bytes');
  for (const change of [{ dailyRate: 200 }, { start: '2026-10-23' }, { name: 'Previous Candidate' }, { email: 'other@example.com' }]) {
    const bytes = await renderAddendum({ name: candidate.name, email: candidate.email, company, dailyRate: 100, start: input.start, end: input.end, date: input.date, ...change });
    await blocked(run([{ ...addendum, bytes }], { mode: 'addendum', expectedAddendumBytes: addendumBytes }), 'page_content_mismatch');
  }
});

test('expected addendum must have exactly one occurrence of every anchor and no text outside a page', async () => {
  for (const [reason, edit] of [
    ['missing_or_duplicate_signing_anchor', (pdf, font) => pdf.getPages()[1].drawText(ANCHORS.candidateSign, { x: 72, y: 200, size: 6, font })],
    ['text_outside_page', (pdf, font) => pdf.getPages()[1].drawText('Outside page', { x: 610, y: 200, size: 12, font })],
  ]) {
    const pdf = await PDFDocument.load(addendumBytes), font = await pdf.embedFont(StandardFonts.Helvetica);
    edit(pdf, font);
    const bytes = await pdf.save();
    await blocked(run([{ ...addendum, bytes }], { mode: 'addendum', expectedAddendumBytes: bytes }), reason);
  }
});

test('authoritative inputs reject malformed dates, missing effective date, fractional cents, invalid identities and date order', () => {
  assert.equal(validateDocumentInputs(input), true);
  assert.equal(validateDocumentInputs({ candidate }), true);
  for (const change of [
    { start: '2026-02-30' }, { start: '2026-13-01' }, { end: '2026-10-23' },
    { start: null }, { date: undefined }, { dailyRate: 100.001 },
    { dailyRate: NaN }, { dailyRate: 0 }, { candidate: { ...candidate, name: '' } },
    { candidate: { ...candidate, name: 'Jane\nExample' } }, { candidate: { ...candidate, email: 'wrong' } },
  ]) assert.throws(() => validateDocumentInputs({ ...input, ...change }), error => error.code === 'docusign_document_validation_failed');
  assert.equal(classifyDocument('Company_NDA.pdf'), 'nda');
  assert.equal(classifyDocument(addendum.name), 'addendum');
});
