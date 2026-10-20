import test from 'node:test';
import assert from 'node:assert/strict';
import { nameParts, bodyBlock, richTextBlock, trustedLinkedin, linkedinProfileUrl } from '../service/lib/name-links.mjs';
import { renderSlackBlocks, renderSlackMessage } from '../service/lib/slack-dispatch.mjs';

const LI = 'https://www.linkedin.com/in/jane-doe-12';

test('a name is linked at each whole-word occurrence, and only to a canonical LinkedIn', () => {
  assert.deepEqual(nameParts('📋 Next step for Jane Doe: Jane Doe’s deep dive.', 'Jane Doe', LI), [
    { text: '📋 Next step for ' }, { link: { url: LI, label: 'Jane Doe' } }, { text: ': ' }, { link: { url: LI, label: 'Jane Doe' } }, { text: '’s deep dive.' }]);
  assert.equal(nameParts('Jane Doesmith applied', 'Jane Doe', LI), null, 'not inside a longer word');
  assert.equal(nameParts('Jane Doe applied', 'Jane Doe', 'https://evil.example/in/jane'), null);
  assert.equal(nameParts('Jane Doe applied', 'Jane Doe', 'https://www.linkedin.com/in/jane-doe-12?x=<y>'), null);
  assert.equal(trustedLinkedin(linkedinProfileUrl('in.linkedin.com/in/jane-doe-12/')), LI);
  assert.deepEqual(bodyBlock('Hi Jane Doe', { fullName: 'Jane Doe' }), { type: 'section', text: { type: 'plain_text', text: 'Hi Jane Doe', emoji: true } });
  assert.deepEqual(bodyBlock('Hi Jane Doe', { fullName: 'Jane Doe', linkedin: LI }), richTextBlock([{ text: 'Hi ' }, { link: { url: LI, label: 'Jane Doe' } }]));
});

const PAGE = '3f26ba36-8537-8000-8000-000000000001';
const request = (action, payload = {}, linkedin) => ({ action, requestKey: 'usam:v1:x', candidateId: PAGE,
  payload: { ...payload, candidate: { pageId: PAGE, fullName: 'Jane Doe', email: 'jane@example.invalid', emailVerified: true,
    url: `https://www.notion.so/Jane-Doe-${PAGE.replaceAll('-', '')}`, ...(linkedin ? { linkedin } : {}) } } });

test('Uncle Sam\'s notifications show the candidate\'s name linked to LinkedIn; the message text (fallback and receipt) is unchanged', () => {
  for (const [action, payload] of [['next_step.project', { booking: 'book the deep dive' }], ['interview.feedback_request', { roleRound: 'R2' }],
    ['email.takehome_pending', { who: 'Robin', when: 'at 3:40 PM' }], ['takehome.grading_request', { submittedDay: 'today' }]]) {
    const linked = request(action, payload, LI), plain = request(action, payload);
    const text = renderSlackMessage(linked);
    assert.equal(text, renderSlackMessage(plain), action);
    const blocks = renderSlackBlocks(linked, text);
    const rich = blocks[0];
    assert.equal(rich.type, 'rich_text', action);
    assert.deepEqual(rich.elements[0].elements.find(e => e.type === 'link'), { type: 'link', url: LI, text: 'Jane Doe' }, action);
    assert.equal(rich.elements[0].elements.map(e => e.text).join(''), text.slice(0, text.lastIndexOf('\n')), action);
    assert.ok(JSON.stringify(blocks).includes('s record>'), `${action}: the record link stays`);
  }
  assert.equal(renderSlackBlocks(request('next_step.project', { booking: 'x' }), renderSlackMessage(request('next_step.project', { booking: 'x' }))), null,
    'no LinkedIn: a plain notice stays plain text');
  const bad = request('next_step.project', { booking: 'x' }, 'https://evil.example/in/jane');
  assert.equal(renderSlackBlocks(bad, renderSlackMessage(bad)), null, 'a link trusted code did not build is dropped');
});
