import { createHash } from 'node:crypto';
import schema from './document-schemas/fields.json' with { type: 'json' };
import { ANCHORS } from './compensation-addendum.mjs';

const fail = detail => {
  const error = new Error('docusign_document_validation_failed');
  error.code = error.message; error.detail = detail; throw error;
};
const text = value => String(value ?? '').normalize('NFC').trim();
const email = value => text(value).toLowerCase();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const kindOf = name => /compensation addendum/i.test(name) ? 'addendum'
  : /ciiaa/i.test(name) ? 'ciiaa' : /terms.of.service/i.test(name) ? 'terms' : /nda/i.test(name) ? 'nda' : null;
const pagesOf = kind => ({ nda: 3, ciiaa: 4, terms: 34, addendum: 2 })[kind];
const signingPages = kind => ({ nda: [3], ciiaa: [3, 4], terms: [34], addendum: [2] })[kind];

/**
 * Independent check of the fields DocuSign will overlay on the PDF.
 * PDF text inspection alone cannot detect a stale, hidden, editable or conditional tab.
 * Unknown field types/values stop sending until their schema has been reviewed.
 */
export function checkDocumentFields({ recipients, documents, documentTabs, candidate, company, expectedAddendumAnchors }) {
  const signers = recipients?.signers;
  if (!Array.isArray(signers) || signers.length !== 2) fail('exactly_two_signers_required');
  for (const [type, rows] of Object.entries(recipients ?? {})) {
    if (type !== 'signers' && Array.isArray(rows) && rows.length) fail('unexpected_recipient');
  }
  const expected = [{ role: 'Signer', ...candidate, order: '1' }, { role: 'Company', ...company, order: '2' }];
  for (const e of expected) {
    const found = signers.filter(s => s.roleName === e.role);
    if (found.length !== 1 || text(found[0].name) !== text(e.name)
      || email(found[0].email) !== email(e.email) || String(found[0].routingOrder) !== e.order) fail(`recipient_mismatch:${e.role}`);
  }
  if (new Set(signers.map(s => s.recipientId)).size !== 2) fail('duplicate_recipient_id');
  const ids = new Map(documents.map(d => [String(d.documentId), kindOf(d.name)]));
  if (ids.size !== documents.length || [...ids].some(([id, kind]) => !/^[0-9a-z]{1,20}$/i.test(id) || !kind)) fail('document_inventory_invalid');
  const allowedTypes = new Set(['signHereTabs', 'dateSignedTabs', 'dateTabs', 'fullNameTabs', 'emailTabs', 'titleTabs', 'textTabs']);
  const inspected = [];
  const inspect = (tabs, owner, documentId = null) => {
    if (!tabs || typeof tabs !== 'object' || Array.isArray(tabs)) fail('tabs_unreadable');
    for (const [type, rows] of Object.entries(tabs)) {
      if (type === 'prefillTabs') { inspect(rows, 'prefill', documentId); continue; }
      if (!Array.isArray(rows)) continue; // API metadata, never a field collection.
      if (!rows.length) continue;
      if (!allowedTypes.has(type)) fail(`unsupported_field:${type}`);
      for (const tab of rows) {
        const id = String(tab.documentId ?? documentId ?? ''), kind = ids.get(id), page = Number(tab.pageNumber);
        if (!kind || !Number.isInteger(page) || page < 1 || page > pagesOf(kind)) fail(`field_location_invalid:${id}`);
        if (tab.conditionalParentLabel || tab.conditionalParentValue || tab.formula || String(tab.concealValueOnDocument) === 'true') fail(`conditional_or_hidden_field:${id}`);
        if (tab.recipientId && owner !== 'prefill' && String(tab.recipientId) !== String(owner)) fail(`field_owner_mismatch:${id}`);
        const x = Number(tab.xPosition), y = Number(tab.yPosition);
        if (tab.xPosition == null || tab.yPosition == null || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 612 || y > 792) fail(`field_coordinates_invalid:${id}`);
        const value = text(tab.value);
        const person = signers.find(s => String(s.recipientId) === String(owner));
        const role = owner === 'prefill' ? 'prefill' : person?.roleName;
        if (kind !== 'addendum') {
          const expectedField = schema.fields.find(f => f.kind === kind && f.role === role && f.type === type
            && f.page === page && f.x === x && f.y === y && f.label === tab.tabLabel);
          if (!expectedField) fail(`unrecognized_field_layout:${id}:${page}`);
          for (const [key, value] of Object.entries(expectedField.presentation ?? {})) {
            if (String(tab[key]) !== String(value)) fail(`field_presentation_changed:${id}:${page}:${key}`);
          }
          if (expectedField.required && String(tab.required) !== expectedField.required) fail(`required_field_changed:${id}:${page}`);
          if (expectedField.optional && String(tab.optional ?? 'false') !== expectedField.optional) fail(`optional_signature:${id}:${page}`);
          if (expectedField.value && value !== expectedField.value.replace('{{candidateName}}', candidate.name)) fail(`prefilled_value_mismatch:${id}:${page}`);
        } else {
          const anchors = role === 'Signer' ? { signHereTabs: ANCHORS.candidateSign, dateSignedTabs: ANCHORS.candidateDate }
            : role === 'Company' ? { signHereTabs: ANCHORS.companySign, dateSignedTabs: ANCHORS.companyDate, titleTabs: ANCHORS.companyTitle } : {};
          if (page !== 2 || !anchors[type] || tab.anchorString !== anchors[type]
            || String(tab.optional ?? 'false') === 'true' || (type === 'titleTabs' && String(tab.required) !== 'true')) fail(`addendum_field_mismatch:${id}`);
          const location = expectedAddendumAnchors?.[tab.anchorString];
          if (!location || location.page !== page || tab.anchorUnits !== 'pixels'
            || Number(tab.anchorXOffset) !== 0 || Number(tab.anchorYOffset) !== -4
            || String(tab.anchorIgnoreIfNotPresent) !== 'false' || String(tab.anchorMatchWholeWord) !== 'true'
            || Math.abs(x - location.x) > 2 || Math.abs(y - (location.baselineY - 4)) > 10) fail(`addendum_anchor_geometry_mismatch:${id}`);
        }
        if (type === 'fullNameTabs' && value && value !== text(person?.name)) fail(`field_name_mismatch:${id}`);
        if (type === 'emailTabs' && value && email(value) !== email(person?.email)) fail(`field_email_mismatch:${id}`);
        if (type === 'textTabs' && value) {
          const values = new Set([text(candidate.name), email(candidate.email), text(company.name), email(company.email)]);
          // These are the Terms document revision/effective dates, not trial dates.
          if (kind === 'terms' && page === 1) values.add('10/15/2026');
          if (!values.has(value)) fail(`unrecognized_prefilled_value:${id}:${page}`);
          if (String(tab.locked) !== 'true' && owner !== 'prefill') fail(`editable_prefilled_value:${id}:${page}`);
        }
        if (type === 'textTabs' && !value) fail(`unresolved_text_field:${id}:${page}`);
        if (type === 'dateSignedTabs' && value) fail(`already_signed_date_requires_review:${id}`);
        if (type === 'titleTabs' && value) fail(`prefilled_title_requires_review:${id}`);
        inspected.push({ owner: String(owner), role, kind, type, id, page, x, y, value,
          label: tab.tabLabel ?? '', anchor: tab.anchorString ?? '',
          presentation: Object.fromEntries(['font', 'fontColor', 'fontSize', 'width', 'height', 'scaleValue', 'disableAutoSize'].map(k => [k, String(tab[k] ?? '')])),
          optional: String(tab.optional ?? 'false'), required: String(tab.required ?? ''), locked: String(tab.locked ?? '') });
      }
    }
  };
  for (const signer of signers) inspect(signer.tabs, signer.recipientId);
  for (const doc of documents) {
    const tabs = documentTabs?.[String(doc.documentId)];
    if (!tabs) fail(`document_fields_unreadable:${doc.documentId}`);
    // This endpoint may return both recipient tabs and sender tabs. Check sender
    // fields here; the authoritative recipient tabs above include their ownership.
    if (tabs.prefillTabs) inspect(tabs.prefillTabs, 'prefill', String(doc.documentId));
    for (const [type, rows] of Object.entries(tabs)) {
      if (!Array.isArray(rows) || !rows.length) continue;
      for (const tab of rows) {
        // Both API views must agree. Do not silently ignore an extra field merely
        // because its recipientId belongs to an expected signer.
        if (tab.recipientId && signers.some(s => String(s.recipientId) === String(tab.recipientId))) {
          inspect({ [type]: [tab] }, tab.recipientId, String(doc.documentId));
          const duplicate = inspected.pop();
          if (!inspected.some(t => JSON.stringify(t) === JSON.stringify(duplicate))) fail(`field_inventory_disagreement:${doc.documentId}`);
          continue;
        }
        inspect({ [type]: [tab] }, 'prefill', String(doc.documentId));
      }
    }
  }
  for (const [id, kind] of ids) {
    if (kind === 'addendum') {
      if (inspected.filter(t => t.id === id).length !== 5) fail(`addendum_field_count:${id}`);
    } else {
      const expected = schema.fields.filter(f => f.kind === kind);
      const actual = inspected.filter(t => t.id === id);
      if (actual.length !== expected.length) fail(`field_count_mismatch:${id}`);
      for (const f of expected) if (actual.filter(t => t.role === f.role && t.type === f.type && t.page === f.page
        && t.x === f.x && t.y === f.y && t.label === f.label).length !== 1) fail(`required_field_missing:${id}`);
    }
  }
  for (const signer of signers) {
    for (const [id, kind] of ids) {
      if (signer.roleName === 'Company' && kind === 'terms') continue;
      for (const type of ['signHereTabs', 'dateSignedTabs']) {
        if (!inspected.some(t => t.owner === String(signer.recipientId) && t.id === id && t.type === type
          && signingPages(kind).includes(t.page) && t.optional !== 'true')) fail(`required_signing_field_missing:${id}:${signer.roleName}:${type}`);
      }
    }
  }
  inspected.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { fieldCount: inspected.length, fieldSha256: digest(inspected),
    recipientSha256: digest(expected.map(({ role, name, email: address, order }) => ({ role, name: text(name), email: email(address), order }))) };
}
