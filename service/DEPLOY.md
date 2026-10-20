> **Superseded 2026-10-14.** Uncle Sam's hosting moved from Cloudflare Workers + D1 to Vercel Functions + Turso at the engineer's direction. Follow `../DEPLOY-VERCEL.md`. This Cloudflare runbook (and `scripts/deploy.mjs`, `build/sites-worker.ts` and the Wrangler/D1 settings it describes) is kept only as a record and is no longer the deployment path.

# Uncle Sam · Phase 2 deployment (Company's own Cloudflare account)

Phase 2 runs the whole coordinator inside one Cloudflare Worker: real-time Slack events, a 5-minute cron
tick, Notion and take-home-portal webhooks, D1 for durable claims/receipts, and Claude (Anthropic API)
as the reasoning layer. Claude only ever proposes; trusted code validates, executes and reads back.
The **Notion control row stays the operating switch** (Mode Off / Test / Live); D1 mirrors it every run.

Nothing in this document requires pasting a secret into chat. All values live in `service/.env.secrets.json`
(gitignored) and are uploaded with `wrangler secret bulk` by `scripts/deploy.mjs`, which prints key names and
pass/fail only.

## 0. What you need (one-time)

| Item | Where | Notes |
|---|---|---|
| Cloudflare account + API token | dash.cloudflare.com → My Profile → API Tokens → Create → *Edit Cloudflare Workers* template, plus **D1 Edit** | Free plan is enough (Workers 100k req/day, D1 5 GB). Account ID is on the Workers & Pages overview. |
| Slack app `A09DDB3817C` | api.slack.com/apps | Signing Secret (Basic Information); Bot token `xoxb-…` (OAuth & Permissions, after *Install to Workspace*); scopes: `chat:write`, `im:history`, `im:read`, `im:write`, `mpim:history`, `mpim:read`, `mpim:write`, `users:read`, `channels:read`, `groups:read`. Bot user id / bot id come from `auth.test` (the deploy preflight tells you if they do not match). |
| Notion internal integration | notion.so/profile/integrations → New → Internal | Capabilities: read content, update content, insert content, no user info needed. Then **share** *Uncle Sam Operations* (database) and the *Recruiting* database with it (⋯ → Connections). |
| Anthropic API key | console.anthropic.com → API keys (Company workspace) | Set `ANTHROPIC_MODEL` to the current Sonnet-class model id; preflight verifies the id exists. |
| Slack route conversations | Slack | One DM between the bot and each of Robin, Alexis, AA, Interviewer, Project (open the bot's DM once); two group DMs **Project + Jamie + bot** and **Project + AA + bot**. Copy the `D…`/`G…` ids (channel details → copy link, the id is in the URL) into `SLACK_ROUTE_MAP_JSON`. |
| Google Calendar (optional, for automatic feedback prompts) | Google Cloud → service account → Calendar API enabled | Either share Robin's/Alexis's calendars (read) with the service-account e-mail, or use domain-wide delegation and set `GOOGLE_IMPERSONATE_SUBJECT`. Paste the key JSON as one string into `GOOGLE_SERVICE_ACCOUNT_JSON`. Without it the Worker still handles Slack/Notion/portal events; only calendar-driven prompts are skipped. |
| Portal webhook (optional, Interviewer) | company-takehome.vercel.app | POST `/api/portal/webhook` on upload with header `x-uncle-sam-secret` and body `{event:"submission.uploaded", deliveryId, candidateEmail, submissionId, submissionUrl, uploadedAt}`. |

## 1. Deploy

```bash
cd service
cp .env.secrets.example.json .env.secrets.json      # fill it in; keep UNCLE_SAM_AUTOMATIC_ACTIVITY "off" for the first deploy
node scripts/deploy.mjs --check                    # validates the file and the Slack/Notion/Anthropic credentials, deploys nothing
node scripts/deploy.mjs                            # build → D1 create/reuse → deploy → migrations → secrets → health check
```

The script ends with the Worker URL (`https://uncle-sam.<account>.workers.dev`) and prints the three URLs to
register. `GET /api/health` must show `"automaticActionsEnabled": false` and the configuration booleans you expect.

## 2. Connect the inbound events

1. **Slack** → app → *Event Subscriptions* → Request URL `…/api/slack/events` (Slack sends `url_verification`; the
   route answers it). Subscribe to bot events `message.im`, `message.mpim`. Save, then reinstall if prompted.
2. **Notion** → integration → *Webhooks* → add `…/api/notion/webhook`. Notion POSTs a `verification_token`; read it
   with `npx wrangler tail uncle-sam --config dist/server/wrangler.deploy.json` (look for `notion_webhook_verification_token=`),
   paste it into Notion to verify **and** into `NOTION_WEBHOOK_SECRET`, then run `node scripts/deploy.mjs --secrets-only`.
   Subscribe to `page.properties_updated` and `page.content_updated` for the Recruiting database and Uncle Sam Operations.
3. **Portal** (when Interviewer is ready): give him the Worker URL and the value of `PORTAL_WEBHOOK_SECRET` directly (not through chat).

## 3. Turn it on, safely

1. Notion control row `c71e1782-2660-4a92-93fb-5977b1e4a8c9`: **Mode = Test**. In Test the Worker processes only
   fixture events (none arrive from Slack), simulates dispatch, writes nothing to Notion candidates and ignores
   real events permanently — it is a smoke test of the plumbing, visible in `wrangler tail` and `/api/health`.
2. Set `UNCLE_SAM_AUTOMATIC_ACTIVITY` to `"enabled"` in `.env.secrets.json` → `node scripts/deploy.mjs --secrets-only`.
   The tick now runs every 5 minutes and writes a heartbeat into the control row's *Source cursors* field (hourly, or
   whenever it did something; *Result evidence* stays the human log).
3. **Mode = Live** (Baseline complete ✓, Activated at set — both already true from Phase 1). From now on:
   interview-ended → feedback prompt to the interviewer's DM (+10 min, exact fixed template) → next-business-day
   reminder → reply recorded into the candidate's brief/next action through the guarded plan → Operations receipts.
4. **Retire Phase 1**: set the Claude scheduled task "Uncle Sam coordinator" to disabled (or leave it; it also honours
   the same control row, but two coordinators prompting is not wanted).

**Pause**: Mode = Off in Notion (takes effect on the next event/tick, ≤5 min) or `UNCLE_SAM_AUTOMATIC_ACTIVITY: "off"`
+ `--secrets-only` (immediate). Both fail closed; the dispatcher also re-checks both right before every send.

## 4. What the Worker does and does not do

Does: prompt/remind interviewers (fixed templates, one thread per candidate+route, request-key dedupe, readback);
record interviewer feedback into *Candidate brief* / *Next action* / *Action Status* (never colours, never Stage/Outcome)
plus a dated append-only note; ask Robin/Alexis to confirm a rejection and tell Project when they do; set holds on
Robin/Alexis/Project instruction; request private grading from Interviewer on portal upload; route failures and
ambiguities to Project (DM) or to *Needs attention* rows in Uncle Sam Operations.

Does not: send e-mail (the separate rejection sender stays independent), change Outcome/Stage, create candidates,
touch payments, decide hires, send take-homes, run onboarding/offboarding messages (Phase 2b), or act on anyone
outside the fixed people map.

## 5. Operating notes

- Logs: `npx wrangler tail uncle-sam --config dist/server/wrangler.deploy.json` (one `uncle_sam_tick …` line per tick).
- Status: `GET /api/health` (booleans), `/api/bridge/mcp` with `Authorization: Bearer <BRIDGE_MCP_TOKEN>` (counts, events).
- Every action has a D1 row (`uncle_sam_requests` / `uncle_sam_events`) and, in Live, an Operations row keyed by the
  same request key. *Needs attention* rows are Project's inbox; *Held* rows are active holds.
- Changing the people map, templates or routes is a code change in `lib/` (tests in `../test`), never a prompt edit.
- Re-deploy code: `node scripts/deploy.mjs`. Re-upload secrets only: `--secrets-only`.
