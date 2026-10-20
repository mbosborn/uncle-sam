export const APP_ID = 'A09DDB3817C';
export const TEAM_ID = 'T07011B7862';
export const OPS_SOURCE = '32b3ba1c-6963-40eb-9a96-30f18bba29fd';
export const CONTROL_PAGE = 'c71e1782-2660-4a92-93fb-5977b1e4a8c9';
export const PEOPLE = Object.freeze({ project:'U0F9EF97D89', jamie:'U0CB213D6D6', aa:'U0BF89D1279', robin:'U0A4F08721B', alexis:'U0476A5BC82', interviewer:'U030A09DBFF' });
export type ServiceEnv = {
 DB?: D1Database; SLACK_SIGNING_SECRET?:string; SLACK_BOT_TOKEN?:string;
 SLACK_BOT_USER_ID?:string; SLACK_BOT_ID?:string; BRIDGE_MCP_TOKEN?:string; NOTION_TOKEN?:string;
 SLACK_ROUTES_JSON?:string;
 UNCLE_SAM_AUTOMATIC_ACTIVITY?:string;
 // Phase 2 (hosted runner). All are Worker secrets; see DEPLOY.md and .env.secrets.example.json.
 SLACK_ROUTE_MAP_JSON?:string;        // {"interviewer_rishi":{"channelId":"D…","type":"im"},"jamie_group":{"channelId":"G…","type":"mpim"},…}
 ANTHROPIC_API_KEY?:string; ANTHROPIC_MODEL?:string;
 NOTION_WEBHOOK_SECRET?:string;       // Notion subscription verification token
 PORTAL_WEBHOOK_SECRET?:string;       // shared secret presented by the take-home portal (x-uncle-sam-secret)
 GOOGLE_SERVICE_ACCOUNT_JSON?:string; GOOGLE_CALENDAR_IDS?:string; GOOGLE_IMPERSONATE_SUBJECT?:string;
 INTERVIEWER_EMAILS_JSON?:string;     // {"robin@company.example":"U0A4F08721B",…}
 UNCLE_SAM_CALENDAR_FLOOR?:string;    // ISO time with zone: calendar prompts only cover interviews that ended at or after it (empty = calendar path off)
 UNCLE_SAM_QA?:string;                // "enabled" turns @-mention questions on (also needs UNCLE_SAM_AUTOMATIC_ACTIVITY = "enabled")
 UNCLE_SAM_QA_ASKERS?:string;         // optional comma-separated Slack user IDs who may ask; empty = every full workspace member
};
export function getRoutes(env:ServiceEnv) {
 try {
  const parsed=JSON.parse(env.SLACK_ROUTES_JSON || '{}');
  const routes:Record<string,string[]>={};
  for(const type of ['im','mpim','group','channel']) {
   const ids=parsed[type] || [];
   if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||! /^[CDG][A-Z0-9]+$/.test(id))) throw new Error('invalid_routes');
   routes[type]=[...new Set(ids)];
  }
  return routes;
 } catch { throw new Error('invalid_routes'); }
}
