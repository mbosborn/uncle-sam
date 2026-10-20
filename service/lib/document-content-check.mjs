/**
 * Mandatory content-integrity gate for the complete PDFs that DocuSign will send.
 * Schemas record observed wording, not legal approval. Text equality is not proof
 * of visual placement: recipient/tab geometry is checked separately by the sender.
 * Unrecognized images and annotations are rejected, not silently ignored.
 */
import { createHash } from 'node:crypto';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
// PDF.js normally imports a computed worker path. A static import makes the
// server worker traceable by Vercel and installs PDF.js's main-thread handler.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { ANCHORS } from './compensation-addendum.mjs';
import nda from './document-schemas/nda.json' with { type: 'json' };
import ciiaa from './document-schemas/ciiaa.json' with { type: 'json' };
import terms from './document-schemas/terms.json' with { type: 'json' };

export const DOCUMENT_CHECK_VERSION = '2026-10-20.1';
const SCHEMAS = Object.freeze({ nda, ciiaa, terms });
const MAX_BYTES = 10_000_000;
const MAX_PAGES = 64;
const SHA = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = text => String(text).normalize('NFC').replace(/\s+/gu, ' ').trim();
const IMAGE_OPS = new Set(Object.entries(OPS).filter(([name]) => /^paint.*Image|^paintJpeg/.test(name)).map(([, value]) => value));

export class DocumentValidationError extends Error {
  constructor(detail) {
    super('docusign_document_validation_failed');
    this.name = 'DocumentValidationError';
    this.code = 'docusign_document_validation_failed';
    this.detail = detail;
  }
}
const reject = (reason, type = 'envelope', page = null) => {
  throw new DocumentValidationError(`${type}${page === null ? '' : ` page ${page}`}: ${reason}`);
};
const validName = name => typeof name === 'string' && name === name.trim() && name.length > 0 && name.length <= 120
  && !/[\u0000-\u001f\u007f<>\\{}]|\{\{|\}\}/u.test(name);
const validEmail = email => typeof email === 'string' && email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u.test(email);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

/** Validate the authoritative inputs before rendering; no truncation or inference. */
export function validateDocumentInputs({ candidate, company, dailyRate, start = null, end = null, date } = {}) {
  if (!validName(candidate?.name) || !validEmail(candidate?.email)) reject('invalid_candidate_inputs');
  if (company !== undefined && (!validName(company?.name) || !validEmail(company?.email))) reject('invalid_company_signer_inputs');
  if (dailyRate !== undefined && (!Number.isFinite(dailyRate) || dailyRate < 10 || dailyRate > 5000
    || Math.abs(dailyRate * 100 - Math.round(dailyRate * 100)) > 0.000001)) reject('invalid_daily_rate');
  if (start !== null && !validDate(start)) reject('invalid_trial_start');
  if (end !== null && !validDate(end)) reject('invalid_trial_end');
  if (end !== null && (start === null || end < start)) reject('invalid_trial_date_order');
  if ((date !== undefined && !validDate(date)) || (dailyRate !== undefined && date === undefined)) reject('invalid_effective_date');
  return true;
}

function bytesOf(value, type) {
  if (!(value instanceof Uint8Array) || !value.byteLength || value.byteLength > MAX_BYTES) reject('invalid_pdf_bytes', type);
  const bytes = Buffer.from(value);
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) reject('invalid_pdf_header', type);
  return bytes;
}

function unstamped(text, envelopeId, type, page) {
  let count = 0;
  const result = text.replace(/Docusign Envelope ID:\s*([0-9a-f-]{36})/gi, (_, found) => {
    count++;
    if (!envelopeId || found.toLowerCase() !== envelopeId.toLowerCase()) reject('envelope_stamp_mismatch', type, page);
    return ' ';
  });
  if (count > 1 || /Docusign Envelope ID:/i.test(result)) reject('invalid_envelope_stamp', type, page);
  return normalize(result);
}

async function extract(bytes, type, envelopeId = null) {
  let loading, pdf;
  try {
    // Copy because PDF.js may transfer the supplied buffer to its worker.
    loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false,
      disableFontFace: true, stopAtErrors: true, verbosity: 0 });
    pdf = await loading.promise;
    if (!Number.isInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > MAX_PAGES) reject('invalid_page_count', type);
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const [content, operators, annotations] = await Promise.all([
        page.getTextContent(), page.getOperatorList(), page.getAnnotations({ intent: 'display' }),
      ]);
      const pageWidth = page.view[2] - page.view[0], pageHeight = page.view[3] - page.view[1];
      const anchorLocations = [];
      if (type === 'expected_addendum') {
        if (page.view[0] !== 0 || page.view[1] !== 0 || page.rotate !== 0
          || !Number.isFinite(pageWidth) || !Number.isFinite(pageHeight) || pageWidth <= 0 || pageHeight <= 0) reject('unsupported_page_geometry', type, i);
        for (const item of content.items.filter(item => typeof item.str === 'string' && item.str.trim())) {
          const x = item.transform?.[4], y = item.transform?.[5], width = item.width, height = item.height;
          if (![x, y, width, height].every(Number.isFinite) || width < 0 || height <= 0
            || x < -0.5 || y < -0.5 || x + width > pageWidth + 0.5 || y + height > pageHeight + 0.5) reject('text_outside_page', type, i);
          for (const anchor of Object.values(ANCHORS)) if (item.str.includes(anchor)) {
            if (item.str.trim() !== anchor) reject('ambiguous_anchor_text', type, i);
            anchorLocations.push({ anchor, page: i, x, baselineY: pageHeight - y, height });
          }
        }
      }
      const allowedImages = [...(SCHEMAS[type]?.allowedImagesPerPage?.[i - 1] ?? [])];
      const images = [];
      for (let op = 0; op < operators.fnArray.length; op++) {
        if (!IMAGE_OPS.has(operators.fnArray[op])) continue;
        // Only the exact decoded, visually inspected company logo is allowed.
        // Other image modes (masks, repetitions, inline images) fail closed.
        if (operators.fnArray[op] !== OPS.paintImageXObject) reject('unreviewed_image_content', type, i);
        const objectId = operators.argsArray[op]?.[0];
        if (typeof objectId !== 'string') reject('unreviewed_image_content', type, i);
        const objects = objectId.startsWith('g_') ? page.commonObjs : page.objs;
        if (!objects) reject('unreadable_image_content', type, i);
        const image = await new Promise((resolve, fail) => {
          const timer = setTimeout(() => fail(new DocumentValidationError(`${type} page ${i}: unreadable_image_content`)), 2000);
          objects.get(objectId, value => { clearTimeout(timer); resolve(value); });
        });
        if (!(image?.data instanceof Uint8Array || image?.data instanceof Uint8ClampedArray)) reject('unreadable_image_content', type, i);
        const digest = SHA(image.data);
        const match = allowedImages.findIndex(known => known.sha256 === digest && known.width === image.width
          && known.height === image.height && known.kind === image.kind);
        if (match < 0) reject('unreviewed_image_content', type, i);
        allowedImages.splice(match, 1);
        images.push(digest);
      }
      const imageOperations = images.length;
      if (annotations.length) reject('unreviewed_annotation_content', type, i);
      const text = unstamped(content.items.filter(item => typeof item.str === 'string').map(item => item.str).join(' '), envelopeId, type, i);
      if (!text) reject('empty_or_unreadable_page', type, i);
      if (/\{\{[^{}]+\}\}|<<\s*(?:candidate|name|email|date|rate)\b/i.test(text)) reject('unresolved_placeholder', type, i);
      pages.push({ text, textSha256: SHA(text), imageOperations, imageSha256s: images, pageWidth, pageHeight, anchorLocations });
      page.cleanup();
    }
    return pages;
  } catch (error) {
    if (error instanceof DocumentValidationError) throw error;
    reject('pdf_extraction_failed', type);
  } finally {
    if (loading) await loading.destroy().catch(() => {});
  }
}

export function classifyDocument(name, candidate = null) {
  if (typeof name !== 'string') reject('invalid_document_name');
  if (/^Company_NDA(?:\.pdf)?$/i.test(name)) return 'nda';
  if (/^Company_CIIAA_Template_Blank(?:\.pdf)?$/i.test(name)) return 'ciiaa';
  if (/^Company_Terms_of_Service_(?:\.pdf)?$/i.test(name)) return 'terms';
  // Match the existing sender's filename shortening, independently of PDF identity.
  if (candidate && name === `Work Trial Compensation Addendum - ${candidate.name.replace(/\s+/g, ' ').slice(0, 80)}.pdf`) return 'addendum';
  if (!candidate && /^Work Trial Compensation Addendum - .+\.pdf$/.test(name)) return 'addendum';
  reject('unrecognized_document_name');
}

/**
 * Check every document and every page. expectedAddendumBytes must be regenerated
 * by the sender from its trusted terms snapshot, never copied from received bytes.
 */
export async function checkDocumentContent({ documents, candidate, envelopeId, expectedAddendumBytes, mode = 'packet' } = {}) {
  validateDocumentInputs({ candidate });
  if (!['packet', 'addendum'].includes(mode)) reject('invalid_check_mode');
  if (typeof envelopeId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(envelopeId)) reject('invalid_envelope_id');
  const required = mode === 'addendum' ? ['addendum'] : ['nda', 'ciiaa', 'terms', ...(expectedAddendumBytes !== undefined && expectedAddendumBytes !== null ? ['addendum'] : [])];
  if (!Array.isArray(documents) || documents.length !== required.length) reject('document_count_mismatch');
  const ids = new Set(), types = new Set(), assignments = [];
  for (const doc of documents) {
    const id = String(doc?.documentId ?? '');
    if (!/^\d{1,10}$/.test(id) || ids.has(id)) reject('invalid_or_duplicate_document_id');
    const type = classifyDocument(doc?.name, candidate);
    if (!required.includes(type) || types.has(type)) reject('duplicate_or_unexpected_document_type', type);
    ids.add(id); types.add(type);
    assignments.push({ documentId: id, type, bytes: bytesOf(doc.bytes, type) });
  }
  if (required.some(type => !types.has(type))) reject('missing_document_type');
  let addendumExpected = null;
  if (types.has('addendum')) addendumExpected = await extract(bytesOf(expectedAddendumBytes, 'expected_addendum'), 'expected_addendum');
  const expectedAddendumAnchors = {};
  if (addendumExpected) {
    const locations = addendumExpected.flatMap(page => page.anchorLocations);
    for (const anchor of Object.values(ANCHORS)) {
      const found = locations.filter(location => location.anchor === anchor);
      if (found.length !== 1) reject('missing_or_duplicate_signing_anchor', 'expected_addendum');
      const { anchor: ignored, ...geometry } = found[0];
      expectedAddendumAnchors[anchor] = geometry;
    }
  }
  const receipts = [];
  for (const { documentId, type, bytes } of assignments) {
    const actual = await extract(bytes, type, envelopeId);
    const schema = SCHEMAS[type];
    const expected = type === 'addendum' ? addendumExpected.map(page => page.text)
      : schema.pages.map(page => normalize(page.replaceAll('{{candidateName}}', candidate.name)));
    if (actual.length !== expected.length) reject('page_count_mismatch', type);
    for (let i = 0; i < actual.length; i++) {
      if (actual[i].text !== expected[i]) reject('page_content_mismatch', type, i + 1);
    }
    receipts.push({ documentId, type, kind: type, sha256: SHA(bytes), pageCount: actual.length,
      schemaVersion: schema?.schemaVersion ?? 'trusted_addendum_renderer',
      ...(type === 'addendum' ? { expectedSha256: SHA(expectedAddendumBytes) } : { schemaSourceSha256: schema.provenance.sourceSha256 }),
      pages: actual.map((page, i) => ({ page: i + 1, textSha256: page.textSha256, imageOperations: page.imageOperations, imageSha256s: page.imageSha256s })) });
  }
  return { status: 'passed', validatorVersion: DOCUMENT_CHECK_VERSION, envelopeId, mode, documents: receipts,
    ...(addendumExpected ? { expectedAddendumAnchors,
      expectedAddendumPages: addendumExpected.map((page, i) => ({ page: i + 1, width: page.pageWidth, height: page.pageHeight })) } : {}),
    limitations: ['Exact text comparison does not establish legal approval or verify visual placement; recipient and tab geometry require separate validation.'] };
}
