import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// Wispr Flow's OAuth redirect after Project signs in from the connect link Uncle Sam DMs him (see service/lib/wispr.mjs).
const app = createVercelApp({ env: process.env });
export default { fetch: request => app.wisprCallback(request) };
