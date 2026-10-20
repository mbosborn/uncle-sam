import { env, waitUntil } from 'cloudflare:workers';
import { createSlackIngress } from '@/lib/slack-ingress.mjs';
import { createRuntime, routesFromMap } from '@/lib/runtime.mjs';
import { APP_ID, TEAM_ID, getRoutes, type ServiceEnv } from '@/lib/config';
export const dynamic='force-dynamic';
export async function POST(request:Request) {
 const config=env as ServiceEnv;
 if(!config.DB) return Response.json({error:'service_not_configured'},{status:503});
 try {
  const runtime=createRuntime(config);
  // The allowlist is the configured route map (Phase 2) or the legacy SLACK_ROUTES_JSON.
  const allowedConversations=config.SLACK_ROUTES_JSON ? getRoutes(config) : routesFromMap(runtime.routeMap);
  return await createSlackIngress({env:config,store:runtime.store,schedule:waitUntil,
   // Phase 2: the in-Worker runner replaces the Notion wake record; same gates, same durable claim.
   wakeFactory:()=>(input:{eventId:string;attemptId:string})=>runtime.runner.runEvent(input),
   signatureConfig:{
    signingSecret:config.SLACK_SIGNING_SECRET, allowedAppIds:[APP_ID], allowedTeamIds:[TEAM_ID],
    botUserId:config.SLACK_BOT_USER_ID, allowedConversations
   }})(request);
 } catch {return Response.json({error:'service_not_ready'},{status:503});}
}
