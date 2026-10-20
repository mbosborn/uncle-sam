# Uncle Sam: deployment guide

This public snapshot uses synthetic identities, workspace identifiers, account domains and sample configuration. Replace them with your own configuration before connecting live services. Internal deployment history is excluded. Keep `UNCLE_SAM_AUTOMATIC_ACTIVITY` set to `off` while configuring and validating integrations.

## Local development

Use Node.js 22.18 or newer. The runtime targets Node 22; the tests also load the Drizzle TypeScript schema.

```sh
npm ci
npm test
npm run dev
```

The local development server uses the same handlers as the deployed entry points. Tests use simulated providers and temporary databases. They do not establish that a live account is connected.

## Configuration

Start with `.env.secrets.example.json`. Actual credentials belong in ignored local files or the deployment environment, never in the repository.

- Database: `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
- Scheduler: `CRON_SECRET`.
- Slack: `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_BOT_USER_ID`, `SLACK_BOT_ID`, and `SLACK_ROUTE_MAP_JSON`.
- Recruiting tracker: `NOTION_TOKEN` and your own database schema and resource identifiers.
- Model: `ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY`, with an available model configured for the selected provider.
- Optional inbound portal: `PORTAL_WEBHOOK_SECRET`.

Review `service/lib/identity.mjs`, `service/lib/slack-setup.mjs`, `service/lib/notion-client.mjs`, and the integration modules for organization-specific mappings. Defaults are examples, including the company domain, calendar owners, Slack members and document templates. Replace those examples consistently and verify the destinations before enabling delivery.

The local setup commands validate configuration without printing credential values:

```sh
npm run setup:import -- --init
# Fill the generated local paste file, then import and clear its values.
npm run setup:import
npm run setup:check
# Read-only Slack identity and scope validation:
npm run setup:slack
# Preview the deployment environment changes:
npm run setup:env -- --dry-run
```

`npm run setup:slack -- --open` opens the configured Slack conversations. Use it only after replacing the example member IDs and confirming the intended recipients. `npm run setup:check -- --probe-model` makes a small model request using a synthetic event.

## Database and deployment

Connect your own Turso/libSQL database, set its credentials in your local environment, then run:

```sh
npm run db:migrate -- --status
npm run db:migrate
npm run setup:check
```

Deploy the repository root using your Vercel account and project. `vercel.json` configures Node functions with a 300-second maximum duration and these routes:

| Route | Purpose | Schedule |
|---|---|---|
| `/api/cron/tick` | Main workflow processing | `*/5 * * * *` |
| `/api/cron/followups` | Follow-up processing | `* * * * *` |
| `/api/cron/sourcing` | Sourcing work | `*/5 * * * *` |
| `/api/slack/events` | Signed Slack events | Webhook |
| `/api/notion/webhook` | Recruiting tracker events | Webhook |
| `/api/portal/webhook` | Take-home portal events | Webhook |
| `/api/health` | Configuration and service health | Read-only |

Verify that your hosting plan supports the configured schedules and duration before deploying. Keep the automation switch off for the first deployment.

```sh
npm run setup:env
vercel deploy --prod
npm run setup:verify -- https://<your-production-domain> --signed --tick
```

Environment updates require a new deployment. Register your own stable production domain with the providers. For Notion's initial webhook handshake, inspect the `notion_webhook_verification_token` log entry privately and complete the provider's verification flow. Do not paste secrets into public issues or logs.

## Enabling workflows

Validate provider identities, route membership, tracker schema, calendar access and document templates using your own test records. Confirm each intended write and destination, then enable the specific workflows and automation control. Read back actual results; local tests alone are not evidence of successful delivery.

`UNCLE_SAM_AUTOMATIC_ACTIVITY=off` disables automatic activity. The durable control state, holds and delivery receipts also constrain dispatch. Uncertain sends must be reconciled against provider evidence before retrying.

Document schemas and wording in `service/lib/document-schemas/` are examples. Validate replacements against your own approved originals before allowing document delivery. The checker compares PDF content, fields, recipients and document identity at the final send boundary.

## Operations

Tick logs begin with `uncle_sam_tick status=`. `/api/health` reports configuration checks without exposing secret values. The database retains workflow state, claims, receipts and holds; use the following read-only diagnostics.

```sql
-- 1. The mirrored control row: mode, baseline, last refresh
SELECT mode, baseline_complete, version, pause_generation,
       datetime(activated_at / 1000, 'unixepoch') AS activated_utc,
       datetime(updated_at / 1000, 'unixepoch')   AS updated_utc
FROM uncle_sam_control;
```

```sql
-- 2. The last 20 events (Slack, Notion, portal) and what became of them
SELECT event_id, source, status, wake_state, is_fixture,
       datetime(observed_at / 1000, 'unixepoch')  AS observed_utc,
       datetime(processed_at / 1000, 'unixepoch') AS processed_utc,
       substr(coalesce(wake_error, ''), 1, 100)   AS wake_error
FROM uncle_sam_events
ORDER BY observed_at DESC
LIMIT 20;
```

```sql
-- 3. Events that did not finish: Observed for over 15 minutes (normal only while Mode is Off), or flagged
SELECT event_id, source, status, wake_state,
       datetime(observed_at / 1000, 'unixepoch') AS observed_utc,
       substr(coalesce(wake_error, ''), 1, 160)  AS wake_error
FROM uncle_sam_events
WHERE (status = 'Observed' AND observed_at < (strftime('%s', 'now') - 900) * 1000)
   OR status = 'NeedsAttention' OR wake_state = 'NeedsAttention'
ORDER BY observed_at;
```

```sql
-- 4. Real (non-fixture) requests by state
SELECT state, count(*) AS requests
FROM uncle_sam_requests
WHERE is_fixture = 0
GROUP BY state
ORDER BY requests DESC;
```

```sql
-- 5. Requests that need a human: Uncertain (a send may or may not have happened) or NeedsAttention
SELECT request_key, action, state,
       datetime(due_at / 1000, 'unixepoch') AS due_utc,
       substr(coalesce(last_error, ''), 1, 160) AS last_error
FROM uncle_sam_requests
WHERE state IN ('Uncertain', 'NeedsAttention')
ORDER BY updated_at DESC
LIMIT 20;
```

```sql
-- 6. Active holds (Robin, Alexis or Project told it to wait)
SELECT hold_key, candidate_id, action, reason,
       datetime(created_at / 1000, 'unixepoch') AS created_utc
FROM uncle_sam_action_holds
WHERE active = 1
ORDER BY created_at;
```

## Repository map


| Path | Role |
|---|---|
| `api/slack/events.js`, `api/notion/webhook.js`, `api/portal/webhook.js`, `api/health.js`, `api/cron/tick.js` | The five Vercel entry points. Each is a few lines that call the app below. |
| `service/lib/vercel-handlers.mjs` | Adapts Vercel (environment, `waitUntil`, Turso, Cron) to the modules below; owns the time budgets. |
| `service/lib/runtime.mjs` | Composition root: `createRuntime()` and `runScheduled()`. |
| `service/lib/agent-runner.mjs` | The Claude loop (read tools plus one terminal `propose`) and `validateProposal`, which enforces authority. |
| `service/lib/policy.mjs`, `workflow-policy.mjs`, `protocol.mjs` | Pure rules: who may do what, templates, timing, Slack signature checks. |
| `service/lib/store.mjs`, `service/drizzle/*.sql` | Durable claims, receipts and holds (SQLite dialect). |
| `service/lib/libsql-d1.mjs`, `migrate.mjs`, `turso.mjs` | The Turso adapter, the migration runner and the client factory. |
| `service/lib/slack-ingress.mjs`, `slack-dispatch.mjs`, `notion-client.mjs`, `notion-wake.mjs`, `webhooks.mjs`, `google-calendar.mjs`, `anthropic.mjs` | The edges: Slack in and out, Notion, webhooks, Calendar, the Anthropic API. |
| `scripts/setup.mjs`, `db-migrate.mjs`, `dev-server.mjs` | `setup:check`, `setup:env`, `setup:verify`; migrations; the local server. |
| `scripts/import-secrets.mjs`, `slack-bootstrap.mjs`, `scripts/lib/local-files.mjs`, `service/lib/slack-setup.mjs` | `setup:import` (paste file → `.env.secrets.json`) and `setup:slack` (token, app and scope checks, bot ids, opening and verifying the conversations); the shared file helpers and the pure Slack rules behind them. |
| `test/` | Automated tests with simulated providers. Includes `docs.test.mjs`, which runs this runbook's SQL and checks every command, path and variable it names. |
| `src/` | Three one-line re-exports so tests import short paths. |
| `STATUS.md`, `ARCHITECTURE-DECISION-2026-10-14.md` | Public source status and architecture overview. `service/DEPLOY.md` is the **superseded** Cloudflare runbook; the rest of `service/` is the earlier Sites/Cloudflare starter. |
