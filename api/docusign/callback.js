import { createVercelApp } from '../../service/lib/vercel-handlers.mjs';

// DocuSign's redirect after Project allows Uncle Sam to resend envelopes (service/lib/docusign-send.mjs).
const app = createVercelApp({ env: process.env });
export default { fetch: request => app.docusignCallback(request) };
