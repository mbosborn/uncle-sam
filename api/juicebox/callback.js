import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// Juicebox's OAuth redirect after Project signs in from the connect link Uncle Sam DMs him (see service/lib/juicebox.mjs).
const app = createVercelApp({ env: process.env });
export default { fetch: request => app.juiceboxCallback(request) };
