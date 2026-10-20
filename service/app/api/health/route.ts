import { env } from 'cloudflare:workers';
import { describeConfiguration } from '@/lib/runtime.mjs';
import { type ServiceEnv } from '@/lib/config';
export const dynamic='force-dynamic';
export function GET(){
 const config=env as ServiceEnv;
 const enabled=config.UNCLE_SAM_AUTOMATIC_ACTIVITY==='enabled';
 // Unauthenticated: booleans only, never values. Detailed status lives behind the bearer-protected bridge.
 return Response.json({service:'Uncle Sam',phase:enabled?'phase2-live':'setup',automaticActionsEnabled:enabled,
  configuration:describeConfiguration(config as unknown as Record<string,unknown>)},{headers:{'cache-control':'no-store'}});
}
