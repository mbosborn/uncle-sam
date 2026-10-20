import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// Vercel Cron, every minute (vercel.json): interview follow-up questions 3 minutes after the calendar says a call ended.
const app = createVercelApp({ env: process.env });
export default { fetch: request => app.followups(request) };
