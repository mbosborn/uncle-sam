import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// Vercel Cron every 5 minutes (vercel.json): sourcing and outreach (service/lib/sourcing-wire.mjs), apart from the main
// tick because a Wrangle search can take minutes. Same `Authorization: Bearer $CRON_SECRET` check as the tick.
const app = createVercelApp({ env: process.env });
export default { fetch: request => app.sourcingTick(request) };
