import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// Slack's OAuth redirect after Project allows Uncle Sam to read his DMs with the team (see service/lib/slack-dm-watch.mjs).
const app = createVercelApp({ env: process.env });
export default { fetch: request => app.slackUserCallback(request) };
