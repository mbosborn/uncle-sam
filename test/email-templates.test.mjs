import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotionClient } from '../service/lib/notion-client.mjs';
import { parseTemplate } from '../service/lib/takehome-review.mjs';
import { fillTakeHomeEmail, insertTakeHomeLink } from '../service/lib/takehome-invite.mjs';
import { fillReminder } from '../service/lib/takehome-nudge.mjs';

const GUIDES = '5c014824-4335-4fd3-94aa-440d34b93739';
const page = parts => ({ object: 'page', id: '8b6b201d-3942-455f-9918-cccf59411ab4', parent: { type: 'data_source_id', data_source_id: GUIDES }, properties: { 'Full email': { type: 'rich_text', rich_text: parts } } });
const t = (text, href = null) => ({ type: 'text', plain_text: text, href, text: { content: text, link: href ? { url: href } : null } });
const client = body => createNotionClient({ env: { NOTION_TOKEN: 'ntn_fixture_only_0123456789abcdef' }, fetchImpl: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) });

test('Email templates: a slot written as a Notion link still fills (take-home invite and reminder, edited Oct 16)', async () => {
  const invite = await client(page([t('Subject: Company AI Take-Home Assessment\n\nHi [First name],\n\nHere’s '), t('your take-home assessment link', '[Unique%20candidate%20Vercel%20link]'), t('.\n\nLet me know.')])).getEmailTemplate('8b6b201d-3942-455f-9918-cccf59411ab4');
  const email = fillTakeHomeEmail(parseTemplate(invite), { firstName: 'Ana' });
  assert.ok(email);
  assert.match(insertTakeHomeLink(email.body, 'https://company-takehome.vercel.app/c/x'), /your take-home assessment link \(https:\/\/company-takehome\.vercel\.app\/c\/x\)/);
  const reminder = await client(page([t('Subject: Company AI Take-Home Assessment\n\nHi {{candidate_first_name}},\n\nHere’s '), t('your take-home assessment link', '%7B%7Btakehome_link%7D%7D'), t(' again; it stays open for {{days_left}}.')])).getEmailTemplate('8b6b201d-3942-455f-9918-cccf59411ab4');
  assert.ok(fillReminder(parseTemplate(reminder), { firstName: 'Ana', link: 'https://company-takehome.vercel.app/c/x', daysLeft: '3 more days' }));
  const real = await client(page([t('Subject: S\n\nBook '), t('here', 'https://calendly.com/x'), t('.')])).getEmailTemplate('8b6b201d-3942-455f-9918-cccf59411ab4');
  assert.equal(real, 'Subject: S\n\nBook here.', 'real links stay plain text as before');
});

test('a held take-home reminder states the days left as of when it goes out', async () => {
  const { refreshDaysLeft } = await import('../service/lib/takehome-nudge.mjs');
  const sent = Date.parse('2026-10-12T17:00:00Z'), closes = sent + 7 * 86400_000;
  const queued = 'Here’s your take-home assessment link (https://company-takehome.vercel.app/c/x) again; it stays open for 4 more days.\n\nIf that timing doesn’t work for you, reply here.';
  // Queued on day 3, moved to the candidate's own day (day 5): it says 2, not 4.
  assert.match(refreshDaysLeft(queued, closes, sent + 5 * 86400_000), /stays open for 2 more days\./);
  assert.match(refreshDaysLeft(queued, closes, sent + 6 * 86400_000), /stays open for 1 more day\./);
  assert.equal(refreshDaysLeft(queued, closes, closes - 3 * 3600_000), null, 'about to close: no count fits, no reminder');
  assert.equal(refreshDaysLeft('no count here', closes, sent), null);
});
