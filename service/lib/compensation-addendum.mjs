/**
 * The Work Trial Compensation Addendum, the 4th document in the work-trial packet (Project, 2026-10-16: "the file where we list
 * how much money they will make ... the main thing for that is how much money per day we are giving them").
 *
 * Built per person as a PDF (pdf-lib): the wording of Robin's addendum for Morgan Ellis (Oct 11) with the per-day fee, made
 * standard: the bespoke parts of Morgan's (hourly fee, profit share, his current employer) and the Insightful time tracking
 * are left out. What changes per person:
 * their name and email, the fee per day, and the trial dates when the tracker has them. Signature places are invisible anchor
 * words (white text) that DocuSign turns into signing fields: \c_sig\ \c_date\ for the candidate, \v_sig\ \v_date\ \v_title\
 * for Company.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const ANCHORS = Object.freeze({ candidateSign: '\\c_sig\\', candidateDate: '\\c_date\\', companySign: '\\v_sig\\', companyDate: '\\v_date\\', companyTitle: '\\v_title\\' });
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? '')); return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : null; };
export const money = n => `US$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The addendum's text, section by section (also what Claude shows Project for review). */
export function addendumText({ name, email, dailyRate, start = null, end = null, date }) {
  const dates = longDate(start) && longDate(end) ? `The Trial begins on ${longDate(start)} and ends on ${longDate(end)}.`
    : longDate(start) ? `The Trial begins on ${longDate(start)}; its end date will be agreed between the parties in writing.`
      : 'The Trial’s start and end dates will be agreed between the parties in writing.';
  return {
    title: 'WORK TRIAL COMPENSATION ADDENDUM',
    subtitle: 'to Work Trial Agreement',
    intro: `This Work Trial Compensation Addendum (this “Addendum”) is entered into as of ${longDate(date)} by and between Company AI, Inc. (the “Company”) and ${name} (“Contractor”). It supplements the Terms of Service, Non-Disclosure Agreement and Confidential Information and Invention Assignment Agreement between the parties, and any Work Trial Agreement between them (together, the “Agreement”). If this Addendum conflicts with the Agreement on compensation, this Addendum controls; otherwise the Agreement controls.`,
    sections: [
      { heading: '1. WORK TRIAL', body: [`Contractor will perform services for the Company on a part-time, independent-contractor basis as a work trial (the “Trial”). ${dates} This Addendum covers the Trial only.`] },
      // No time-tracking tool (Project, 2026-10-16: "no one else in the near future is using Insightful so drop that for now").
      { heading: '2. DAILY FEE', items: [
        `2.1 The Company will pay Contractor ${money(dailyRate)} per day for each approved day worked on the Trial.`,
        '2.2 Contractor will agree the working days with the Company in advance. Only days worked as agreed and approved by the Company are payable.',
        '2.3 Fees are paid biweekly in arrears through the Company\u2019s designated payment platform. Expenses are reimbursed only if approved in writing in advance.'] },
      { heading: '3. WORK PRODUCT', body: ['All deliverables and other work product from the Trial, including pipelines, code and data, belong solely to the Company and are assigned to it under the Agreement. Contractor will not share them with anyone else. The terms of this Addendum are Company confidential information.'] },
      { heading: '4. GENERAL', body: ['Contractor is an independent contractor, responsible for Contractor’s own taxes, with no employee benefits. Nothing in this Addendum or any prior discussion promises employment, salary or equity; any full-time role will be negotiated separately and set out in a written offer. This Addendum and the Agreement are the entire agreement on Trial compensation and replace all prior discussions on it, including by call, email or WhatsApp. Amendments must be in writing signed by both parties. Governing law is as set out in the Agreement. Electronic signatures are valid.'] },
    ],
    witness: 'IN WITNESS WHEREOF, the parties have executed this Addendum as of the date first written above.',
    contractor: { name, email },
  };
}

/** The PDF, as bytes. `company` = { name } of who countersigns. */
export async function renderAddendum({ name, email, dailyRate, start = null, end = null, date, company }) {
  if (!Number.isFinite(dailyRate) || dailyRate <= 0) throw new Error('addendum_rate_invalid');
  const t = addendumText({ name, email, dailyRate, start, end, date });
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Work Trial Compensation Addendum - ${name}`); pdf.setAuthor('Company AI'); pdf.setCreator('Uncle Sam');
  const font = await pdf.embedFont(StandardFonts.TimesRoman), bold = await pdf.embedFont(StandardFonts.TimesRomanBold), small = await pdf.embedFont(StandardFonts.Helvetica);
  const W = 612, H = 792, M = 72, size = 11, lead = 14.5;
  let page = pdf.addPage([W, H]), y = H - M, pageNo = 1;
  const footer = () => page.drawText(`CONFIDENTIAL — Work Trial Compensation Addendum (${name}) Page ${pageNo}`, { x: M, y: 36, size: 8, font: small, color: rgb(0.35, 0.35, 0.35) });
  const newPage = () => { footer(); page = pdf.addPage([W, H]); pageNo++; y = H - M; };
  const ensure = need => { if (y - need < M) newPage(); };
  const lines = (text, f, s, width) => {
    const out = []; let line = '';
    for (const word of String(text).split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (f.widthOfTextAtSize(next, s) > width && line) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out;
  };
  const para = (text, { indent = 0, f = font, s = size, gap = 6 } = {}) => {
    for (const l of lines(text, f, s, W - 2 * M - indent)) { ensure(lead); page.drawText(l, { x: M + indent, y, size: s, font: f }); y -= lead; }
    y -= gap;
  };
  const centered = (text, f, s) => { ensure(lead + 4); page.drawText(text, { x: (W - f.widthOfTextAtSize(text, s)) / 2, y, size: s, font: f }); y -= lead + 2; };
  centered(t.title, bold, 13); centered(t.subtitle, font, 11); y -= 8;
  para(t.intro);
  for (const sct of t.sections) {
    ensure(lead * 3); para(sct.heading, { f: bold, gap: 2 });
    for (const b of sct.body ?? []) para(b);
    for (const it of sct.items ?? []) para(it, { indent: 18 });
  }
  para(t.witness, { gap: 18 });
  // Signature blocks, side by side; the anchors are white so only DocuSign sees them.
  ensure(150);
  const L = M, R = W / 2 + 10, top = y;
  const anchor = (text, x, yy) => page.drawText(text, { x, y: yy, size: 6, font: small, color: rgb(1, 1, 1) });
  const label = (text, x, yy, f = font) => page.drawText(text, { x, y: yy, size: size, font: f });
  label('COMPANY AI, INC.', L, top, bold); label('CONTRACTOR', R, top, bold);
  label('By: ______________________________', L, top - 34); anchor(ANCHORS.companySign, L + 24, top - 30);
  label('______________________________', R, top - 34); anchor(ANCHORS.candidateSign, R + 4, top - 30);
  label(`Name: ${company?.name ?? ''}`, L, top - 54); label(`Name: ${name}`, R, top - 54);
  label('Title: ', L, top - 72); anchor(ANCHORS.companyTitle, L + 32, top - 72); label(`Email: ${email}`, R, top - 72);
  label('Date: ', L, top - 90); anchor(ANCHORS.companyDate, L + 32, top - 90); label('Date: ', R, top - 90); anchor(ANCHORS.candidateDate, R + 32, top - 90);
  footer();
  return pdf.save();
}
