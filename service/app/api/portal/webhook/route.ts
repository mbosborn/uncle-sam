import { env, waitUntil } from 'cloudflare:workers';
import { handlePortalWebhook } from '@/lib/webhooks.mjs';
import { createRuntime } from '@/lib/runtime.mjs';
import { type ServiceEnv } from '@/lib/config';
export const dynamic='force-dynamic';
export async function POST(request:Request) {
 const config=env as ServiceEnv;
 if(!config.DB) return Response.json({error:'service_not_configured'},{status:503});
 try {
  const runtime=createRuntime(config);
  return await handlePortalWebhook(request,{secret:config.PORTAL_WEBHOOK_SECRET,store:runtime.store,schedule:waitUntil,
   run:input=>runtime.runner.runEvent(input)});
 } catch {return Response.json({error:'service_not_ready'},{status:503});}
}
