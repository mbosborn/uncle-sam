import { waitUntil } from '@vercel/functions';
import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// Unipile webhooks: LinkedIn replies and accepted invitations for outreach (see service/lib/unipile.mjs, outreach.mjs).
// Answered at once; the work runs after the 200, so it is handed to waitUntil.
const app = createVercelApp({ env: process.env, schedule: waitUntil });
export default { fetch: request => app.unipileWebhook(request) };
