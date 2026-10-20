import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewPrompt } from '../service/lib/prompt-review.mjs';
import { SUGGESTED_STEP, NEXT_STEPS } from '../service/lib/feedback-form.mjs';

const candidate = { fullName: 'Dylan Hayes', fields: { Stage: 'Intro Call' } };
const answering = input => ({ complete: async ({ messages }) => { answering.seen = messages[0].content; return { content: [{ type: 'tool_use', name: 'review', input }] }; } });

test('a send carries the next step the invite and record point to (Project, 2026-10-16)', async () => {
  const claude = answering({ decision: 'send', likely_next: 'take_home' });
  const verdict = await reviewPrompt({ claude, candidate, phase: 'prompt', interviewEnd: '2026-10-16T21:00:00Z', eventTitle: 'Intro', invite: 'Intro call: PyTorch background, data pipelines', room: [], notes: [] });
  assert.deepEqual(verdict, { decision: 'send', likelyNext: 'take_home' });
  assert.match(answering.seen, /PyTorch background, data pipelines/);
  const bare = await reviewPrompt({ claude: answering({ decision: 'send', likely_next: 'unclear' }), candidate, phase: 'prompt', interviewEnd: 'x', eventTitle: '', room: [], notes: [] });
  assert.deepEqual(bare, { decision: 'send' });
});

test('every suggested step opens the Advance form on a step it can book', () => {
  for (const step of Object.values(SUGGESTED_STEP)) assert.ok(NEXT_STEPS.includes(step));
});
