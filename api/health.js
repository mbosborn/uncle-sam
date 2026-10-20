import { createVercelApp } from '../service/lib/vercel-handlers.mjs';

const app = createVercelApp({ env: process.env });
export default { fetch: request => app.health(request) };
