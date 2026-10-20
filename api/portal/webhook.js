import { waitUntil } from '@vercel/functions';
import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

const app = createVercelApp({ env: process.env, schedule: waitUntil });
export default { fetch: request => app.portalWebhook(request) };
