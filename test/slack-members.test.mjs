import test from 'node:test';
import assert from 'node:assert/strict';
import { slackMembersNamed } from '../service/lib/onboarding.mjs';

test('a hire who joins Slack under another name is still found by their email (users:read.email)', async () => {
  const members = [{ id: 'U1', real_name: 'Arlen Archer', name: 'arlen', profile: { email: 'arlen@company.example' } },
    { id: 'U2', real_name: 'AK', name: 'ak', profile: { email: 'arlen.archer@company.example' } },
    { id: 'U3', real_name: 'Someone Else', name: 'se', profile: { email: 'se@company.example' } }];
  const fetchImpl = async () => Response.json({ ok: true, members });
  const env = { SLACK_BOT_TOKEN: 'xoxb-test-1' };
  assert.deepEqual(await slackMembersNamed({ env, fetchImpl, fullName: 'Arlen Archer', emails: ['Arlen.Archer@company.example'] }), ['U1', 'U2']);
  assert.deepEqual(await slackMembersNamed({ env, fetchImpl, fullName: 'Arlen', emails: ['arlen.archer@company.example'] }), ['U2'], 'one name and an email');
  assert.deepEqual(await slackMembersNamed({ env, fetchImpl, fullName: 'Arlen', emails: [] }), []);
});
