import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { prepareDocusignLink, completeDocusignConnection, createDocusignSender, handleDocusignReply, candidateFinder, looksLikeResend, isDocusignState, standardRate } from '../service/lib/docusign-send.mjs';
import { noticeStore } from '../service/lib/stuck-rejections.mjs';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { renderAddendum } from '../service/lib/compensation-addendum.mjs';

const ENV = { WISPR_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'), DOCUSIGN_INTEGRATION_KEY: 'c807de29-de8c-43ec-8dbe-8b991f9f16a3', DOCUSIGN_SECRET_KEY: '11111111-2222-3333-4444-555555555555' };
const NOW = Date.parse('2026-10-16T22:00:00Z');
const PROJECT = 'U0F9EF97D89';
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_wispr (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
async function connected(db, email = 'project@company.example') {
  const link = await prepareDocusignLink({ env: ENV, db, clock: () => NOW });
  const state = new URL(link.url).searchParams.get('state');
  const fetchImpl = async url => String(url).endsWith('/oauth/userinfo')
    ? Response.json({ sub: 'u1', email, accounts: [{ account_id: 'dcd9d815-f64e-4870-a725-4e81cb766cc0', base_uri: 'https://na4.docusign.net' }] })
    : Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 28800 });
  return completeDocusignConnection({ env: ENV, db, fetchImpl, clock: () => NOW, code: 'c', state });
}

test('DocuSign link: Project only, PKCE, the Company AI account', async () => {
  const db = d1();
  const link = await prepareDocusignLink({ env: ENV, db, clock: () => NOW });
  const url = new URL(link.url);
  assert.equal(url.host, 'account.docusign.com');
  assert.equal(url.searchParams.get('scope'), 'signature extended');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://your-project.example.com/api/docusign/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(await isDocusignState({ db, state: url.searchParams.get('state') }), true);
  await assert.rejects(connected(d1(), 'jamie@company.example').catch(e => { throw e; }), /docusign_wrong_account/);
  assert.equal((await connected(db)).accountId, 'dcd9d815-f64e-4870-a725-4e81cb766cc0');
});

test('what reads as a resend', () => {
  for (const t of ['resend the thing to him via docusign since he didnt sign', "resend Morgan's DocuSign", 'remind Morgan to sign the agreement']) assert.ok(looksLikeResend(t), t);
  for (const t of ['did Morgan sign?', 'resend the take-home link', 'send the agreement']) assert.ok(!looksLikeResend(t), t);
});

test("Project's resend: his own envelopes are resent; another sender's is named; signed ones say who it's waiting on; never twice in an hour", async () => {
  const db = d1(); await connected(db);
  const calls = [];
  const envelopes = [
    { envelopeId: '0c60cc06-13c1-8c56-810f-6c6dffda83ad', status: 'delivered', emailSubject: 'Complete with Docusign: Company - Work Trial Agreement - Morgan Ellis', sender: { userName: 'Jamie', email: 'jamie@company.example' },
      recipients: { signers: [{ name: 'Alexis Bailey', email: 'alexis@company.example', status: 'sent' }, { name: 'Morgan Ellis', email: 'morgan@example.com', status: 'delivered' }] } },
    { envelopeId: '5dc4f3e7-20ce-8d6f-800c-dc94fdd5bb98', status: 'sent', emailSubject: 'Complete with Docusign: Compensation Addendum', sender: { userName: 'Robin Cooper', email: 'robin@x' },
      recipients: { signers: [{ name: 'Robin Cooper', email: 'robin@company.example', status: 'sent' }, { name: 'Morgan Ellis', email: 'morgan@example.com', status: 'completed' }] } },
    { envelopeId: '11111111-1111-1111-1111-111111111111', status: 'sent', emailSubject: 'Complete with Docusign: NDA', sender: { userName: 'Project Owner', email: 'project@company.example' },
      recipients: { signers: [{ name: 'Morgan Ellis', email: 'morgan@example.com', status: 'sent', sentDateTime: '2026-10-10T00:00:00Z' }] } },
    { envelopeId: '22222222-2222-2222-2222-222222222222', status: 'sent', emailSubject: 'Complete with Docusign: CIIAA', sender: { userName: 'Project Owner', email: 'project@company.example' },
      recipients: { signers: [{ name: 'Morgan Ellis', email: 'morgan@example.com', status: 'sent', sentDateTime: '2026-10-16T21:00:00Z' }] } }];
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url}`);
    if (String(url).includes('/envelopes?')) return Response.json({ envelopes });
    if (String(url).includes('0c60cc06')) return Response.json({ errorCode: 'FAILED_EMAIL_SENDING' }, { status: 400 });
    return Response.json({});
  };
  // This test covers command selection/cooldown; the actual sender's content gate is tested below.
  const reader = createDocusignSender({ env: ENV, db, fetchImpl, clock: () => NOW });
  const sender = { envelopesFor: reader.envelopesFor, resend: async id => {
    calls.push(`PUT https://na4.docusign.net/restapi/v2.1/accounts/dcd9d815-f64e-4870-a725-4e81cb766cc0/envelopes/${id}?resend_envelope=true`);
    return id.startsWith('0c60cc06') ? { ok: false, code: 'FAILED_EMAIL_SENDING' } : { ok: true };
  } };
  const said = [];
  const run = text => handleDocusignReply({ event: { authorId: PROJECT, channelId: 'D0C95KBR09J', messageTs: '1.1', text }, env: ENV, db, sender, masonId: PROJECT, clock: () => NOW,
    findCandidate: async () => ({ pageId: 'p', fullName: 'Morgan Ellis', email: 'morgan@example.com' }), poster: () => async t => said.push(t) });
  const out = await run('resend the thing to him via docusign since he didnt sign');
  assert.equal(out.resent, 1);
  assert.ok(calls.includes('PUT https://na4.docusign.net/restapi/v2.1/accounts/dcd9d815-f64e-4870-a725-4e81cb766cc0/envelopes/11111111-1111-1111-1111-111111111111?resend_envelope=true'));
  assert.match(said[0], /Resent “NDA” to Morgan Ellis\./);
  assert.match(said[0], /“CIIAA” reached Morgan Ellis 1 hour ago, so I didn't send it again\./);
  assert.match(said[0], /DocuSign wouldn't let me resend “Company - Work Trial Agreement - Morgan Ellis” \(FAILED_EMAIL_SENDING\)\. Check its status and sender in DocuSign\. It's also waiting on Alexis Bailey\./);
  assert.match(said[0], /Morgan Ellis already signed “Compensation Addendum”; it's waiting on Robin Cooper\./);
  assert.ok(!said[0].includes('!'));
  await run("resend Morgan's DocuSign");
  assert.match(said[1], /“NDA” was already resent 0 minutes ago; I left it\./);
  assert.equal(calls.filter(c => c.startsWith('PUT') && c.includes('1111')).length, 1);
  assert.equal(await handleDocusignReply({ event: { authorId: 'U0A4F08721B', text: 'resend the docusign' }, db, masonId: PROJECT }), null, 'only Project');
});

test('who it is about: a name in the message, else the record Uncle Sam just wrote about', async () => {
  const morgan = { pageId: '3f36ba36-8537-81c9-92da-dda1c81f7486', fullName: 'Morgan Ellis', email: 'Morgan@Example.com', fields: { Outcome: 'Proceeding' } };
  const notion = { findCandidatesByName: async n => (n.startsWith('Morgan') ? [morgan] : []), getCandidate: async id => (id === morgan.pageId ? morgan : null) };
  const find = candidateFinder({ notion, history: async () => [{ text: '🚨 Project, Morgan needs attention. <https://app.notion.com/p/3f36ba36853781c992dadda1c81f7486>' }] });
  assert.equal((await find("resend Morgan's DocuSign", {})).email, 'morgan@example.com');
  assert.equal((await find('resend the thing to him via docusign', {})).pageId, morgan.pageId);
  const none = candidateFinder({ notion, history: async () => [] });
  assert.equal(await none('resend it via docusign', {}), null);
});

import { handleDocusignSend, looksLikePacketSend, rateOf } from '../service/lib/docusign-send.mjs';

const SCHEMAS = Object.fromEntries(await Promise.all(['nda', 'ciiaa', 'terms'].map(async type =>
  [type, JSON.parse(await readFile(new URL(`../service/lib/document-schemas/${type}.json`, import.meta.url), 'utf8'))])));
const DOC_NAMES = ['Company_NDA.pdf', 'Company_CIIAA_Template_Blank.pdf', 'Company_Terms_of_Service_.pdf'];
const COMPANY = { name: 'Project Owner', email: 'project@company.example' };
const TERMS = { dailyRate: 250, start: '2026-10-20', end: '2026-11-02', date: '2026-10-16' };
const ENVELOPE = '99999999-9999-9999-9999-999999999999';
async function schemaPdf(type, name, transform = text => text) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [index, template] of SCHEMAS[type].pages.entries()) {
    const page = pdf.addPage([612, 792]);
    const text = transform(template.replaceAll('{{candidateName}}', name), index);
    let line = '', y = 760;
    for (const word of text.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, 7) > 560 && line) { page.drawText(line, { x: 25, y, size: 7, font }); y -= 9; line = word; }
      else line = next;
    }
    if (line) page.drawText(line, { x: 25, y, size: 7, font });
  }
  return Buffer.from(await pdf.save());
}
const FIELD_SCHEMA = JSON.parse(await readFile(new URL('../service/lib/document-schemas/fields.json', import.meta.url), 'utf8'));
const idsByKind = { nda: '1', ciiaa: '2', terms: '3' };
const fieldTab = (f, name = 'Arlen Archer') => ({ ...(f.presentation ?? {}), documentId: idsByKind[f.kind], pageNumber: String(f.page),
  xPosition: String(f.x), yPosition: String(f.y), tabLabel: f.label, tabId: `fixture-${f.kind}-${f.role}-${f.x}-${f.y}`,
  ...(f.value ? { value: f.value.replace('{{candidateName}}', name), originalValue: f.value.replace('{{candidateName}}', name), locked: 'false' } : {}),
  ...(f.required ? { required: f.required } : {}), ...(f.optional ? { optional: f.optional } : {}) });
const standardTabs = role => {
  const out = {};
  for (const f of FIELD_SCHEMA.fields.filter(f => f.role === role)) (out[f.type] ??= []).push(fieldTab(f));
  return out;
};
async function packetApi({ templateRecipients, documents = DOC_NAMES, sendStatus = 201, candidateName = 'Morgan Ellis', corrupt = null, alterRecipients = null, sendThrows = false } = {}) {
  const calls = [], docs = await Promise.all(documents.map(async (name, i) => {
    const type = ['nda', 'ciiaa', 'terms'][i];
    return { name, documentId: String(i + 1), type: 'content', bytes: type ? await schemaPdf(type, candidateName) : Buffer.from('invalid extra document') };
  }));
  if (corrupt) await corrupt(docs);
  const documentTabs = Object.fromEntries(docs.map(d => [d.documentId, {}]));
  for (const f of FIELD_SCHEMA.fields.filter(f => f.role === 'prefill')) {
    const tabs = documentTabs[idsByKind[f.kind]];
    if (tabs) ((tabs.prefillTabs ??= {})[f.type] ??= []).push(fieldTab(f));
  }
  let recipients = structuredClone(templateRecipients ?? { signers: [
    { recipientId: '1', roleName: 'Company', name: 'Jamie Fong', email: 'jamie@company.example', tabs: standardTabs('Company') },
    { recipientId: '2', roleName: 'Signer', name: 'Arlen Archer', email: 'arlen@example.com', tabs: standardTabs('Signer') }] });
  for (const r of recipients.signers) if (['Signer', 'Company'].includes(r.roleName) && r.tabs?.signHereTabs?.length) r.tabs = standardTabs(r.roleName);
  // Simulate DocuSign resolving the actual anchor geometry from the uploaded PDF.
  // Do not ask the production validator for its expected answer.
  const resolveTabs = async (tabs, documentId, bytes) => {
    const loading = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    const pdf = await loading.promise;
    const anchors = new Map();
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const page = await pdf.getPage(pageNumber), content = await page.getTextContent();
        for (const item of content.items) anchors.set(item.str, { pageNumber: String(pageNumber), xPosition: String(item.transform[4]), yPosition: String(page.view[3] - item.transform[5] - 4) });
      }
      return Object.fromEntries(Object.entries(tabs).map(([kind, list]) => [kind, list.map(t => {
        const resolved = anchors.get(t.anchorString); assert.ok(resolved, `fixture PDF must contain ${t.anchorString}`);
        return { ...t, documentId, ...resolved };
      })]));
    } finally { await loading.destroy(); }
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.replace(/^.*\/accounts\/[^/]+/, ''), body });
    if (u.includes('/envelopes?')) return Response.json({ envelopes: [] });
    if (method === 'POST' && u.endsWith('/envelopes')) {
      if (body.documents) {
        docs.splice(0, docs.length, ...body.documents.map(d => ({ ...d, type: 'content', bytes: Buffer.from(d.documentBase64, 'base64') })));
        for (const id of Object.keys(documentTabs)) delete documentTabs[id];
        documentTabs['1'] = {};
        recipients = structuredClone(body.recipients);
        for (const r of recipients.signers) r.tabs = await resolveTabs(r.tabs, '1', docs[0].bytes);
        if (corrupt) await corrupt(docs);
      }
      return Response.json({ envelopeId: ENVELOPE }, { status: 201 });
    }
    if (/\/recipients\/[^/]+\/tabs$/.test(u) && method === 'POST') {
      const rid = u.split('/recipients/')[1].split('/')[0], r = recipients.signers.find(x => x.recipientId === rid);
      const resolved = await resolveTabs(body, '4', docs.find(d => d.documentId === '4').bytes);
      for (const [kind, tabs] of Object.entries(resolved)) r.tabs[kind] = [...(r.tabs[kind] ?? []), ...tabs];
      return Response.json({}, { status: 201 });
    }
    if (u.includes('/recipients') && method === 'DELETE') { for (const [t, rows] of Object.entries(body)) recipients[t] = (recipients[t] ?? []).filter(r => !rows.some(x => x.recipientId === r.recipientId)); return Response.json({}); }
    if (u.includes('/recipients') && method === 'PUT') { for (const r of body.signers) Object.assign(recipients.signers.find(x => x.recipientId === r.recipientId), r); return Response.json({}); }
    if (u.includes('/recipients')) { const out = structuredClone(recipients); if (alterRecipients && u.includes('include_tabs')) alterRecipients(out); return Response.json(out); }
    if (u.endsWith('/documents') && method === 'PUT') { for (const d of body.documents) { docs.push({ ...d, type: 'content', bytes: Buffer.from(d.documentBase64, 'base64') }); documentTabs[d.documentId] = {}; } return Response.json({}); }
    if (u.endsWith('/documents')) return Response.json({ envelopeDocuments: [...docs.map(({ bytes, ...d }) => d), { name: 'Summary', type: 'summary' }] });
    const fieldsId = /\/documents\/([^/]+)\/tabs$/.exec(u)?.[1];
    if (fieldsId) {
      if (method === 'PUT') {
        const patch = body.prefillTabs ?? body;
        for (const [type, rows] of Object.entries(patch)) if (Array.isArray(rows)) for (const update of rows) {
          const target = documentTabs[fieldsId]?.prefillTabs?.[type]?.find(t => t.tabId === update.tabId);
          if (target) Object.assign(target, update);
        }
      }
      return Response.json(documentTabs[fieldsId] ?? {});
    }
    const documentId = /\/documents\/([^/?]+)$/.exec(u)?.[1];
    if (documentId) { const doc = docs.find(d => d.documentId === documentId); return new Response(doc?.bytes ?? '', { status: doc ? 200 : 404, headers: { 'content-type': 'application/pdf' } }); }
    if (u.includes('/folders/recyclebin')) return Response.json({});
    if (method === 'PUT' && /\/envelopes\/[0-9a-f-]+(?:\?resend_envelope=true)?$/.test(u)) { if (sendThrows) throw new Error('network timeout after request accepted'); return Response.json({}, { status: sendStatus }); }
    return Response.json({});
  };
  return { fetchImpl, calls, docs, documentTabs, get recipients() { return recipients; } };
}

test('the packet: Jamie\'s template, its leftover recipients replaced by Project then the candidate, checked, then sent', async () => {
  const db = d1(); await connected(db);
  const api = await packetApi({ templateRecipients: { signers: [
    { recipientId: '1', roleName: 'Company', name: 'Jamie Fong', email: 'jamie@company.example', tabs: { signHereTabs: [{}] } },
    { recipientId: '2', roleName: 'Signer', name: 'Arlen Archer', email: 'arlen@example.com', tabs: { signHereTabs: [{}] } },
    { recipientId: '3', roleName: 'Company', name: 'Extra', email: 'x@company.example', tabs: {} }], carbonCopies: [{ recipientId: '5', email: 'cc@x.com' }] } });
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  const said = [];
  const out = await handleDocusignSend({ event: { authorId: PROJECT, channelId: 'D0C95KBR09J', messageTs: '1.1', text: 'send the work trial docs to Morgan Ellis' }, env: ENV, db, sender, masonId: PROJECT,
    clock: () => NOW, findCandidate: async () => ({ pageId: 'p', fullName: 'Morgan Ellis', email: 'morgan@example.com' }), poster: () => async t => said.push(t) });
  assert.equal(out.reason, 'sent', JSON.stringify({ out, said }));
  assert.deepEqual(api.calls.find(c => c.method === 'POST').body, { templateId: '596b3287-75fc-489d-95e1-c595a542f34e', status: 'created', emailSubject: 'Work Trial Docs -- Morgan Ellis' });
  assert.deepEqual(api.recipients.signers.map(r => [r.roleName, r.email, r.routingOrder]).sort((a, b) => a[2] - b[2]), [['Signer', 'morgan@example.com', '1'], ['Company', 'project@company.example', '2']]);
  assert.deepEqual(api.recipients.carbonCopies, []);
  assert.deepEqual(api.documentTabs['1'].prefillTabs.textTabs.map(t => [t.value, t.originalValue, t.locked]),
    [['Morgan Ellis', 'Morgan Ellis', 'true'], ['Morgan Ellis', 'Morgan Ellis', 'true']]);
  const partyRepair = api.calls.findIndex(c => c.method === 'PUT' && c.path.endsWith('/documents/1/tabs'));
  const finalPdfRead = api.calls.findIndex(c => c.method === 'GET' && c.path.endsWith('/documents/1'));
  const finalSend = api.calls.findIndex(c => c.body?.status === 'sent');
  assert.ok(partyRepair >= 0 && finalPdfRead > partyRepair && finalSend > finalPdfRead,
    'repair both sender-prefill names, then inspect materialized PDF, then send');
  assert.ok(api.calls.some(c => c.method === 'PUT' && c.body?.status === 'sent'));
  assert.match(said[0], /Sent Morgan Ellis the work trial documents \(NDA, CIIAA, Terms of Service\) in one DocuSign envelope, to morgan@example\.com\. Morgan signs everything first; then you countersign/);
  // Never twice.
  await handleDocusignSend({ event: { authorId: PROJECT, channelId: 'D', messageTs: '1.2', text: 'send Morgan the docusign docs' }, env: ENV, db, sender, masonId: PROJECT,
    clock: () => NOW + 60_000, findCandidate: async () => ({ pageId: 'p', fullName: 'Morgan Ellis', email: 'morgan@example.com' }), poster: () => async t => said.push(t) });
  assert.match(said[1], /already got the work trial documents from me/);
  assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 1);
});

test('the packet is never sent when the template looks wrong, and the draft is thrown away', async () => {
  const db = d1(); await connected(db);
  const api = await packetApi({ documents: ['Company_NDA.pdf', 'Company_CIIAA_Template_Blank.pdf'] });
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  const said = [];
  const out = await handleDocusignSend({ event: { authorId: PROJECT, channelId: 'D', messageTs: '1.1', text: 'send the work trial docs to Morgan Ellis' }, env: ENV, db, sender, masonId: PROJECT,
    clock: () => NOW, findCandidate: async () => ({ pageId: 'p', fullName: 'Morgan Ellis', email: 'morgan@example.com' }), poster: () => async t => said.push(t) });
  assert.equal(out.reason, 'failed');
  assert.ok(api.calls.some(c => c.path.includes('/folders/recyclebin')));
  assert.ok(!api.calls.some(c => c.body?.status === 'sent'));
  assert.match(said[0], /docusign_packet_check_failed\. Nothing went out\./);
});

test('what reads as sending the packet; the IP agreement is never in it', async () => {
  assert.ok(looksLikePacketSend('send the work trial docs to Morgan Ellis'));
  assert.ok(looksLikePacketSend('Send Morgan the docusign'));
  assert.ok(!looksLikePacketSend('resend Morgan\'s DocuSign'));
  assert.ok(!looksLikePacketSend('did Morgan sign the docs?'));
  const said = [];
  const out = await handleDocusignSend({ event: { authorId: PROJECT, channelId: 'D', messageTs: '1', text: 'send Morgan the IP docusign' }, env: ENV, db: d1(), sender: null, masonId: PROJECT,
    findCandidate: async () => null, poster: () => async t => said.push(t) });
  assert.equal(out.reason, 'ip_only');
});

test('the 4th document: their pay per day, from the message or the tracker; no rate, nothing sent', async () => {
  for (const [t, v] of [['send the work trial docs to Jane Doe at $250/day', 250], ['send docs to Jane Doe, 300 per day', 300], ['$1,200 a day', 1200], ['send the docs to Jane Doe', null]]) assert.equal(rateOf(t), v, t);
  const env = { ...ENV, UNCLE_SAM_PACKET_ADDENDUM: 'on' };
  const db = d1(); await connected(db);
  const api = await packetApi({ candidateName: 'Jane Doe' });
  const sender = createDocusignSender({ env, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  const said = [];
  const who = { pageId: 'p', fullName: 'Jane Doe', email: 'jane@example.com', dailyRate: null, trialStart: '2026-10-20', trialEnd: '2026-11-02' };
  const run = text => handleDocusignSend({ event: { authorId: PROJECT, channelId: 'D', messageTs: '1', text }, env, db, sender, masonId: PROJECT, clock: () => NOW,
    findCandidate: async () => who, poster: () => async t => said.push(t) });
  assert.equal((await run('send the work trial docs to Jane Doe')).reason, 'no_rate');
  assert.match(said[0], /I don't have Jane's pay per day on record\./);
  assert.ok(!api.calls.some(c => c.method === 'POST'), 'nothing made without a rate');
  const out = await run('send the work trial docs to Jane Doe at $250/day');
  assert.equal(out.reason, 'sent', JSON.stringify({ out, said }));
  const doc = api.calls.find(c => c.path.endsWith('/documents') && c.method === 'PUT').body.documents[0];
  assert.equal(doc.documentId, '4');
  const text = Buffer.from(doc.documentBase64, 'base64').toString('latin1');
  assert.ok(text.startsWith('%PDF'));
  assert.match(said[1], /and the compensation addendum at US\$250 per day\) in one DocuSign envelope/);
});

test('no rate said: the rate of the first send, else the tracker; a resend with nothing out sends a fresh set at that rate', async () => {
  const db = d1();
  const who = { pageId: 'p-arlen', fullName: 'Arlen Archer', email: 'arlenexample@example.test', dailyRate: 120 };
  assert.equal(await standardRate({ db, who }), 120, 'the tracker when nothing was sent');
  await noticeStore(db).put('docusign:rate:arlenexample@example.test', { rate: 100, at: NOW }, NOW);
  assert.equal(await standardRate({ db, who }), 100, 'the first send wins');
  assert.equal(await standardRate({ db, who, given: 150 }), 150, 'a rate he says wins');
  assert.equal(await standardRate({ db, who: { ...who, email: 'x@y.co', dailyRate: null } }), null, 'unknown: ask');
  await connected(db);
  const said = [], sent = [];
  const sender = { envelopesFor: async () => [{ id: 'e1', status: 'voided', subject: 'Work Trial Docs', sender: { name: 'Project Owner' }, signers: [] }], resend: async () => ({ ok: true }) };
  const out = await handleDocusignReply({ event: { authorId: PROJECT, channelId: 'D0C95KBR09J', messageTs: '1.1', text: "resend arlen's documents" }, env: ENV, db, sender, masonId: PROJECT, clock: () => NOW,
    findCandidate: async () => who, poster: () => async t => said.push(t),
    sendFresh: async w => { sent.push({ who: w, rate: await standardRate({ db, who: w }) }); return { reason: 'sent', text: '📨 Sent Arlen Archer the work trial documents. Pay per day: US$100.' }; } });
  assert.equal(out.reason, 'fresh_sent');
  assert.equal(sent[0].rate, 100);
  assert.match(said[0], /^📨 Nothing was waiting in DocuSign, so I sent a new set\. Sent Arlen Archer/);
});

test('queueWorkTrialPacket: queued with force only when asked; a cancelled one is quiet; already out is not queued. withFreshDates reads the record now', async () => {
  const { queueWorkTrialPacket, withFreshDates } = await import('../service/lib/docusign-send.mjs');
  const db = d1(), calls = [];
  const who = { pageId: 'p1', fullName: 'Jane Doe (Acme)', email: 'jane@example.com', trialStart: '2026-10-24', trialEnd: '2026-10-25' };
  const queue = async a => { calls.push(a.force ?? false); return a.force ? { reason: 'queued', at: 1 } : { reason: 'cancelled' }; };
  const none = async () => [];
  assert.deepEqual(await queueWorkTrialPacket({ db, who, rate: 100, queue, envelopesFor: none }), { reason: 'cancelled', text: null });
  assert.deepEqual(await queueWorkTrialPacket({ db, who, rate: 100, force: true, queue, envelopesFor: none }), { reason: 'queued', at: 1, text: "Roger that 🫡 Sending Jane's work trial documents now." });
  assert.deepEqual(calls, [false, true]);
  const out = async () => [{ status: 'sent', subject: 'Work Trial Docs -- Jane Doe' }, { status: 'sent', subject: 'Work Trial Agreement -- Jane Doe' }];
  assert.equal((await queueWorkTrialPacket({ db, who, rate: 100, force: true, queue, envelopesFor: out })).reason, 'already_sent');
  assert.equal(calls.length, 2);
  const moved = await withFreshDates({ notion: { getCandidate: async () => ({ pageId: 'p1', fullName: 'Jane Doe', email: 'jane@example.com', fields: { 'Trial Start': '2026-10-31', 'Trial End': '2026-11-01' } }) }, who });
  assert.deepEqual([moved.trialStart, moved.trialEnd, moved.fullName], ['2026-10-31', '2026-11-01', 'Jane Doe']);
  await assert.rejects(withFreshDates({ notion: { getCandidate: async () => { throw new Error('down'); } }, who }), /docusign_document_validation_failed/, 'unreadable current identity cannot use stale queue facts');
  await assert.rejects(withFreshDates({ notion: { getCandidate: async () => ({ ...who, archived: true }) }, who }), /docusign_document_validation_failed/);
  await assert.rejects(withFreshDates({ notion: { getCandidate: async () => ({ pageId: 'p1', fullName: 'Jane Doe', fields: {} }) }, who }), /docusign_document_validation_failed/, 'current email is mandatory');
  const blank = await withFreshDates({ notion: { getCandidate: async () => ({ pageId: 'p1', fullName: 'Jane Doe', email: 'jane@example.com', fields: {} }) }, who });
  assert.deepEqual([blank.trialStart, blank.trialEnd], ['2026-10-24', '2026-10-25'], 'form dates stand when the record has none');
});

test('actual sender blocks a legacy resend without a saved validation receipt before any DocuSign PUT', async () => {
  const db = d1(); await connected(db);
  const api = await packetApi();
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  assert.deepEqual(await sender.resend(ENVELOPE), { ok: false, code: 'docusign_document_validation_failed' });
  assert.equal(api.calls.filter(c => c.method === 'PUT').length, 0);
});

test('correct routing cannot send an NDA with the previous candidate name in its actual PDF', async () => {
  const db = d1(); await connected(db);
  const api = await packetApi({ corrupt: async docs => { docs[0].bytes = await schemaPdf('nda', 'Morgan Ellis', (text, page) => page === 0 ? text.replaceAll('Morgan Ellis', 'Arlen Archer') : text); } });
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  await assert.rejects(sender.sendPacket({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY }), /docusign_document_validation_failed/);
  assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 0);
  assert.equal((await noticeStore(db).get(`docusign:validation:${ENVELOPE}`))?.status, 'blocked', 'quarantined draft retains an audit receipt');
  assert.deepEqual(api.recipients.signers.map(r => r.email).sort(), ['project@company.example', 'morgan@example.com'].sort());
});

test('the final send boundary refuses extra, missing, unreadable and image-only documents', async t => {
  const scenarios = {
    extra: async docs => docs.push({ name: 'Unapproved.pdf', documentId: '5', type: 'content', bytes: docs[0].bytes }),
    missing: async docs => docs.splice(1, 1),
    unreadable: async docs => { docs[0].bytes = Buffer.from('not a pdf'); },
    scanned: async docs => {
      const pdf = await PDFDocument.create();
      const image = await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
      for (let i = 0; i < 3; i++) pdf.addPage([612, 792]).drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
      docs[0].bytes = Buffer.from(await pdf.save());
    },
  };
  for (const [name, corrupt] of Object.entries(scenarios)) await t.test(name, async () => {
    const db = d1(); await connected(db); const api = await packetApi({ corrupt });
    const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
    await assert.rejects(sender.sendPacket({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY }), /docusign_(?:document_validation|packet_check)_failed/);
    assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 0);
    if (['extra', 'missing'].includes(name)) assert.ok(api.calls.some(c => c.path.includes('/folders/recyclebin')));
    else assert.equal((await noticeStore(db).get(`docusign:validation:${ENVELOPE}`))?.status, 'blocked');
  });
});

test('the final send boundary refuses wrong signer names, missing required dates and tabs on nonexistent pages', async t => {
  const scenarios = {
    name: people => { people.signers.find(r => r.roleName === 'Signer').name = 'Arlen Archer'; },
    missingDate: people => { people.signers.find(r => r.roleName === 'Signer').tabs.dateSignedTabs = []; },
    wrongPage: people => { people.signers.find(r => r.roleName === 'Signer').tabs.signHereTabs[0].pageNumber = '99'; },
    wrongPrefill: people => { people.signers.find(r => r.roleName === 'Signer').tabs.textTabs = [{ documentId: '1', pageNumber: '1', xPosition: '100', yPosition: '100', value: 'Arlen Archer' }]; },
    optionalSignature: people => { people.signers.find(r => r.roleName === 'Signer').tabs.signHereTabs[0].optional = 'true'; },
  };
  for (const [name, alterRecipients] of Object.entries(scenarios)) await t.test(name, async () => {
    const db = d1(); await connected(db); const api = await packetApi({ alterRecipients });
    const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
    await assert.rejects(sender.sendPacket({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY }), /docusign_(?:document_validation|packet_check)_failed/);
    assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 0);
  });
});

test('standalone addendum validates actual fetched PDF against the intended rate and identity', async () => {
  const db = d1(); await connected(db);
  const api = await packetApi();
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  const pdfBase64 = Buffer.from(await renderAddendum({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY, ...TERMS, dailyRate: 100 })).toString('base64');
  await assert.rejects(sender.sendAddendum({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY, pdfBase64, terms: TERMS }), /docusign_document_validation_failed/);
  assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 0);
  assert.equal((await noticeStore(db).get(`docusign:validation:${ENVELOPE}`))?.status, 'blocked');
});

test('validated packet saves its receipt, but a document mutation blocks every later resend', async () => {
  const db = d1(); await connected(db); const api = await packetApi();
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  assert.equal((await sender.sendPacket({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY })).ok, true);
  assert.equal((await sender.resend(ENVELOPE)).ok, true);
  const resends = () => api.calls.filter(c => c.method === 'PUT' && c.path.includes('resend_envelope=true')).length;
  assert.equal(resends(), 1);
  api.docs[0].bytes = await schemaPdf('nda', 'Arlen Archer');
  assert.deepEqual(await sender.resend(ENVELOPE), { ok: false, code: 'docusign_document_validation_failed' });
  assert.equal(resends(), 1);
});

test('an unclear final send keeps the packet claim and never creates a second envelope on retry', async () => {
  const { sendWorkTrialPacket } = await import('../service/lib/docusign-send.mjs');
  const db = d1(); await connected(db); const api = await packetApi({ sendThrows: true });
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  const input = { env: ENV, db, sender, who: { pageId: 'p', fullName: 'Morgan Ellis', email: 'morgan@example.com' }, clock: () => NOW };
  assert.equal((await sendWorkTrialPacket(input)).reason, 'uncertain');
  assert.equal((await sendWorkTrialPacket(input)).reason, 'uncertain');
  assert.equal((await sendWorkTrialPacket({ ...input, clock: () => NOW + 2 * 3600_000 })).reason, 'uncertain', 'an uncertain external send remains locked after the old one-hour claim window');
  assert.equal(api.calls.filter(c => c.method === 'POST' && c.path === '/envelopes').length, 1);
  assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 1);
});


test('a correct standalone addendum is fetched and validated before final send', async () => {
  const db = d1(); await connected(db); const api = await packetApi();
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  const pdfBase64 = Buffer.from(await renderAddendum({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY, ...TERMS })).toString('base64');
  assert.equal((await sender.sendAddendum({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY, pdfBase64, terms: TERMS })).ok, true);
  const pdfRead = api.calls.findIndex(c => c.method === 'GET' && c.path.endsWith('/documents/1'));
  const send = api.calls.findIndex(c => c.body?.status === 'sent');
  assert.ok(pdfRead >= 0 && send > pdfRead, 'the final envelope PDF is read before the send transition');
});

test('a recipient or prefill change after validation cannot be resent', async () => {
  const db = d1(); await connected(db); const api = await packetApi();
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  assert.equal((await sender.sendPacket({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY })).ok, true);
  api.recipients.signers.find(r => r.roleName === 'Signer').email = 'wrong@example.com';
  assert.deepEqual(await sender.resend(ENVELOPE), { ok: false, code: 'docusign_document_validation_failed' });
  assert.equal(api.calls.filter(c => c.method === 'PUT' && c.path.includes('resend_envelope=true')).length, 0);
});

test('send_pending is durable before final send and a restarted worker cannot duplicate it after the claim window', async () => {
  const { sendWorkTrialPacket } = await import('../service/lib/docusign-send.mjs');
  const db = d1(); await connected(db); const api = await packetApi();
  let release, observed;
  const held = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { observed = resolve; });
  const fetchImpl = async (url, init = {}) => {
    if (init.method === 'PUT' && init.body && JSON.parse(init.body).status === 'sent') {
      // Simulate a worker disappearing after persisting the request but before receiving the provider response.
      const pending = await noticeStore(db).get('docusign:packet:morgan@example.com');
      assert.equal(pending.status, 'send_pending'); assert.equal(pending.envelopeId, ENVELOPE);
      assert.equal((await noticeStore(db).get(`docusign:validation:${ENVELOPE}`)).status, 'send_pending');
      observed(); await held;
    }
    return api.fetchImpl(url, init);
  };
  const who = { pageId: 'p', fullName: 'Morgan Ellis', email: 'morgan@example.com' };
  const sending = sendWorkTrialPacket({ env: ENV, db, who, sender: createDocusignSender({ env: ENV, db, fetchImpl, clock: () => NOW }), clock: () => NOW });
  await reached;
  try {
    const restartedSender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW + 2 * 3600_000 });
    const retry = await sendWorkTrialPacket({ env: ENV, db, who, sender: restartedSender, clock: () => NOW + 2 * 3600_000 });
    assert.equal(retry.reason, 'uncertain'); assert.equal(retry.envelopeId, ENVELOPE);
    assert.equal(api.calls.filter(c => c.method === 'POST' && c.path === '/envelopes').length, 1);
    assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 0);
  } finally { release(); }
  assert.equal((await sending).reason, 'sent');
  assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 1);
});

test('unrecognized terms cannot override the authoritative candidate identity', async () => {
  const db = d1(); await connected(db); const api = await packetApi();
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  const pdfBase64 = Buffer.from(await renderAddendum({ name: 'Arlen Archer', email: 'arlen@example.com', company: COMPANY, ...TERMS })).toString('base64');
  await assert.rejects(sender.sendAddendum({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY, pdfBase64,
    terms: { ...TERMS, name: 'Arlen Archer', email: 'arlen@example.com' } }), /docusign_document_validation_failed/);
  assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 0);
});

test('a field visible only on the document endpoint cannot hide behind a known recipient ID', async () => {
  const db = d1(); await connected(db); const api = await packetApi();
  api.documentTabs['1'].textTabs = [{ recipientId: '2', documentId: '1', pageNumber: '1', xPosition: '90', yPosition: '90',
    tabLabel: 'unapproved-name-field', tabId: 'unapproved-tab-id', value: 'Arlen Archer', locked: 'true' }];
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  await assert.rejects(sender.sendPacket({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY }), /docusign_document_validation_failed/);
  assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 0);
});

test('a byte change after approval blocks resend even when extracted document text is unchanged', async () => {
  const db = d1(); await connected(db); const api = await packetApi();
  const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
  assert.equal((await sender.sendPacket({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY })).ok, true);
  const changed = await PDFDocument.load(api.docs[0].bytes); changed.setTitle('Revised after approval');
  api.docs[0].bytes = Buffer.from(await changed.save());
  assert.deepEqual(await sender.resend(ENVELOPE), { ok: false, code: 'docusign_document_validation_failed' });
  assert.equal(api.calls.filter(c => c.method === 'PUT' && c.path.includes('resend_envelope=true')).length, 0);
});

test('resolved addendum signature fields must agree with the rendered anchor geometry and configuration', async t => {
  const mutations = {
    wrongX: r => { r.tabs.signHereTabs[0].xPosition = '500'; },
    wrongY: r => { r.tabs.signHereTabs[0].yPosition = '700'; },
    wrongUnits: r => { r.tabs.signHereTabs[0].anchorUnits = 'inches'; },
    wrongOffset: r => { r.tabs.signHereTabs[0].anchorYOffset = '100'; },
    ignoredMissingAnchor: r => { r.tabs.signHereTabs[0].anchorIgnoreIfNotPresent = 'true'; },
  };
  for (const [name, change] of Object.entries(mutations)) await t.test(name, async () => {
    const db = d1(); await connected(db);
    const api = await packetApi({ alterRecipients: people => change(people.signers.find(r => r.roleName === 'Signer')) });
    const sender = createDocusignSender({ env: ENV, db, fetchImpl: api.fetchImpl, clock: () => NOW });
    const pdfBase64 = Buffer.from(await renderAddendum({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY, ...TERMS })).toString('base64');
    await assert.rejects(sender.sendAddendum({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY, pdfBase64, terms: TERMS }), /docusign_document_validation_failed/);
    assert.equal(api.calls.filter(c => c.body?.status === 'sent').length, 0);
  });
});

test('temporary document read failures preserve approved hashes and healthy resend revalidates', async () => {
  for (const status of [429, 503]) {
    const db = d1(); await connected(db); const api = await packetApi(); let down = false;
    const sender = createDocusignSender({ env: ENV, db, clock: () => NOW, fetchImpl: async (url, init) => {
      if (down && String(url).endsWith('/documents')) return Response.json({}, { status });
      return api.fetchImpl(url, init);
    } });
    assert.equal((await sender.sendPacket({ name: 'Morgan Ellis', email: 'morgan@example.com', company: COMPANY })).ok, true);
    const kv = noticeStore(db), key = `docusign:validation:${ENVELOPE}`, before = await kv.get(key);
    down = true;
    assert.deepEqual(await sender.resend(ENVELOPE), { ok: false, code: 'docusign_validation_unavailable', retryable: true });
    assert.deepEqual(await kv.get(key), before, 'approved receipt must remain byte-for-byte equal');
    assert.equal(api.calls.filter(c => c.path.includes('resend_envelope=true')).length, 0);
    down = false;
    assert.deepEqual(await sender.resend(ENVELOPE), { ok: true });
    assert.equal(api.calls.filter(c => c.path.includes('resend_envelope=true')).length, 1);
    const changed = await PDFDocument.load(api.docs[0].bytes); changed.setTitle('changed'); api.docs[0].bytes = Buffer.from(await changed.save());
    assert.deepEqual(await sender.resend(ENVELOPE), { ok: false, code: 'docusign_document_validation_failed' });
    assert.equal(api.calls.filter(c => c.path.includes('resend_envelope=true')).length, 1, 'changed content still blocked');
  }
});
