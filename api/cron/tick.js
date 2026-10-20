import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET` (see vercel.json). The tick runs inside
// the request, so no waitUntil is needed; the runner stops starting work before the function time limit.
const app = createVercelApp({ env: process.env });
export default { fetch: request => app.tick(request) };
