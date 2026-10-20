import { createVercelApp } from '../service/lib/vercel-handlers.mjs';

// A work trialer's payout setup link from the mid-trial email (see service/lib/payout-setup.mjs).
const app = createVercelApp({ env: process.env });
export default { fetch: request => app.payoutSetup(request) };
