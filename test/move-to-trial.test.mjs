import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotionClient, RECRUITING_SOURCE_ID } from '../service/lib/notion-client.mjs';

const sel = name => ({ type: 'select', select: name ? { name } : null });
const id = '11111111-2222-4333-8444-555555555555';
function client(fields) {
  const page = { object: 'page', id, url: 'https://www.notion.so/x', archived: false, parent: { type: 'data_source_id', data_source_id: RECRUITING_SOURCE_ID },
    properties: { Candidate: { type: 'title', title: [{ plain_text: 'Jane Doe' }] }, Email: { type: 'email', email: 'jane@example.invalid' },
      ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, sel(v)])) } };
  const patches = [];
  const c = createNotionClient({ env: { NOTION_TOKEN: 'ntn_synthetic' }, fetchImpl: async (url, init) => {
    if (init.method === 'PATCH') {
      const props = JSON.parse(init.body).properties;
      patches.push(props);
      for (const [name, value] of Object.entries(props)) page.properties[name] = sel(value.select?.name ?? null);
    }
    return Response.json(page);
  } });
  return { c, patches, page };
}

test('moveToTrial: Stage Trial from an earlier stage only, read back; India Stage untouched; closed, later or another email refused', async () => {
  for (const stage of [null, 'Outreach', 'Intro Call', 'Interview', 'Case Study']) {
    const t = client({ Stage: stage, Outcome: 'Proceeding', 'India Stage': 'Take Home' });
    assert.deepEqual(await t.c.moveToTrial({ pageId: id, expectedEmail: 'jane@example.invalid' }), { changed: true, reason: 'moved' }, String(stage));
    assert.deepEqual(t.patches, [{ Stage: { select: { name: 'Trial' } } }], 'Stage only, never India Stage');
  }
  const cases = [[{ Stage: 'Trial' }, 'already_trial'], [{ Stage: 'Decision' }, 'later_stage'], [{ Stage: 'Extended Offer' }, 'later_stage'],
    [{ Stage: 'Closed' }, 'closed'], [{ Stage: 'Hired' }, 'closed'], [{ Stage: 'Interview', Outcome: 'Not Selected' }, 'closed'],
    [{ Stage: 'Interview', Outcome: 'Withdrawn or Unavailable' }, 'closed'], [{ Stage: 'Case Study', Outcome: 'Hired' }, 'closed']];
  for (const [fields, reason] of cases) {
    const t = client(fields);
    assert.deepEqual(await t.c.moveToTrial({ pageId: id, expectedEmail: 'jane@example.invalid' }), { changed: false, reason }, JSON.stringify(fields));
    assert.equal(t.patches.length, 0);
  }
  const other = client({ Stage: 'Interview' });
  assert.deepEqual(await other.c.moveToTrial({ pageId: id, expectedEmail: 'someone-else@example.invalid' }), { changed: false, reason: 'email_mismatch' });
  assert.equal(other.patches.length, 0);
});
