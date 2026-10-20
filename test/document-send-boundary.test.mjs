import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkDocumentFields } from '../service/lib/document-field-check.mjs';

const SCHEMA = JSON.parse(await readFile(new URL('../service/lib/document-schemas/fields.json', import.meta.url), 'utf8'));
function valid() {
  const documents = [{ documentId: '1', name: 'Company_NDA.pdf' }, { documentId: '2', name: 'Company_CIIAA_Template_Blank.pdf' },
    { documentId: '3', name: 'Company_Terms_of_Service_.pdf' }];
  const candidate = { name: 'Skyler Dawson', email: 'skyler@example.com' }, company = { name: 'Project Owner', email: 'project@company.example' };
  const signers = [{ ...candidate, recipientId: '2', roleName: 'Signer', routingOrder: '1', tabs: {} },
    { ...company, recipientId: '1', roleName: 'Company', routingOrder: '2', tabs: {} }];
  const documentTabs = { 1: {}, 2: {}, 3: {} }, ids = { nda: '1', ciiaa: '2', terms: '3' };
  for (const f of SCHEMA.fields) {
    const owner = signers.find(r => r.roleName === f.role), id = ids[f.kind];
    const dest = owner ? owner.tabs : (documentTabs[id].prefillTabs ??= {});
    (dest[f.type] ??= []).push({ ...(f.presentation ?? {}), documentId: id, pageNumber: String(f.page), xPosition: String(f.x), yPosition: String(f.y), tabLabel: f.label,
      ...(owner ? { recipientId: owner.recipientId } : {}), ...(f.required ? { required: f.required } : {}),
      ...(f.optional ? { optional: f.optional } : {}), ...(f.value ? { value: f.value.replace('{{candidateName}}', candidate.name), locked: 'true' } : {}) });
  }
  return { candidate, company, documents, documentTabs, recipients: { signers } };
}
const textTab = value => ({ documentId: '1', pageNumber: '1', xPosition: '120', yPosition: '80', value, locked: 'true' });
const rejected = input => assert.throws(() => checkDocumentFields(input), error => error.code === 'docusign_document_validation_failed');

test('field checker accepts required candidate/countersigner fields and stable receipt digests', () => {
  const input = valid(), one = checkDocumentFields(input), two = checkDocumentFields(structuredClone(input));
  assert.equal(one.fieldCount, SCHEMA.fields.length);
  assert.match(one.fieldSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(two, one);
});

test('field checker rejects every conditional, hidden, wrong-owner or unknown field', async t => {
  const mutations = {
    conditional: x => { x.recipients.signers[0].tabs.signHereTabs[0].conditionalParentLabel = 'skip'; },
    formula: x => { x.recipients.signers[0].tabs.signHereTabs[0].formula = 'IF(1,1,0)'; },
    hidden: x => { x.documentTabs['1'].prefillTabs.textTabs[0].concealValueOnDocument = 'true'; },
    hiddenBoolean: x => { x.documentTabs['1'].prefillTabs.textTabs[0].concealValueOnDocument = true; },
    wrongOwner: x => { x.recipients.signers[0].tabs.signHereTabs[0].recipientId = '1'; },
    unknownType: x => { x.recipients.signers[0].tabs.radioGroupTabs = [textTab('yes')]; },
    unknownRecipient: x => { x.recipients.carbonCopies = [{ recipientId: '9', email: 'other@example.com' }]; },
    wrongIdentity: x => { x.recipients.signers[0].name = 'Arlen Archer'; },
    swappedRouting: x => { x.recipients.signers[0].routingOrder = '2'; },
    repeatedRecipient: x => { x.recipients.signers[1].recipientId = '2'; },
    optionalSign: x => { x.recipients.signers[0].tabs.signHereTabs[0].optional = true; },
    missingDate: x => { x.recipients.signers[0].tabs.dateSignedTabs = []; },
    outsidePage: x => { x.recipients.signers[0].tabs.signHereTabs[0].pageNumber = '4'; },
    missingPosition: x => { delete x.recipients.signers[0].tabs.signHereTabs[0].xPosition; },
    outsidePosition: x => { x.recipients.signers[0].tabs.signHereTabs[0].yPosition = '900'; },
    invisibleText: x => { x.documentTabs['1'].prefillTabs.textTabs[0].fontColor = 'white'; },
    microscopicText: x => { x.documentTabs['1'].prefillTabs.textTabs[0].fontSize = 'size1'; },
    clippedName: x => { x.documentTabs['1'].prefillTabs.textTabs[0].width = '1'; },
    tinySignature: x => { x.recipients.signers[0].tabs.signHereTabs[0].scaleValue = '0.1'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => { const input = valid(); mutate(input); rejected(input); });
});

test('field checker rejects stale/blank/editable text and stale automatic identity/date values', async t => {
  const mutations = {
    oldName: x => { x.recipients.signers[0].tabs.textTabs = [textTab('Arlen Archer')]; },
    oldNameInSenderPrefill: x => { x.documentTabs['1'].prefillTabs.textTabs[0].value = 'Arlen Archer'; },
    blank: x => { x.recipients.signers[0].tabs.textTabs = [textTab('')]; },
    editableIdentity: x => { x.recipients.signers[0].tabs.textTabs = [{ ...textTab('Skyler Dawson'), locked: 'false' }]; },
    staleFullName: x => { x.recipients.signers[0].tabs.fullNameTabs[0].value = 'Arlen Archer'; },
    staleEmail: x => { x.recipients.signers[0].tabs.emailTabs = [textTab('arlen@example.com')]; },
    signedDate: x => { x.recipients.signers[0].tabs.dateSignedTabs[0].value = '10/01/2026'; },
    staleTitle: x => { x.recipients.signers[0].tabs.titleTabs[0].value = 'Engineer'; },
    unreviewedDate: x => { x.documentTabs['1'].prefillTabs = { textTabs: [textTab('10/15/2026')] }; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, () => { const input = valid(); mutate(input); rejected(input); });
});

test('moving an approved name overlay or losing a required effective-date field blocks the envelope', () => {
  const shifted = valid(); shifted.documentTabs['1'].prefillTabs.textTabs[0].xPosition = '300'; rejected(shifted);
  const dateMissing = valid(); dateMissing.recipients.signers[0].tabs.dateSignedTabs = dateMissing.recipients.signers[0].tabs.dateSignedTabs.filter(t => !(t.documentId === '1' && t.pageNumber === '1')); rejected(dateMissing);
  const labelChanged = valid(); labelChanged.documentTabs['1'].prefillTabs.textTabs[0].tabLabel = 'new unidentified slot'; rejected(labelChanged);
});
