import { waitUntil } from '@vercel/functions';
import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// DocuSign Connect: envelope events for the Company AI account, HMAC-signed (see service/lib/docusign.mjs).
// The tracker update runs after the 200, so it must be handed to waitUntil or Vercel drops it.
const app = createVercelApp({ env: process.env, schedule: waitUntil });
export default { fetch: request => app.docusignConnect(request) };
