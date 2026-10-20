import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// Google's OAuth redirect after Project grants Uncle Sam Gmail sending from the connect link it DMs him (see service/lib/gmail.mjs).
const app = createVercelApp({ env: process.env });
export default { fetch: request => app.googleCallback(request) };
