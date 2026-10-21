# Work-trial replay

The replay suite runs production workflow code against invented candidates and local service fixtures. It follows different paths into the same work-trial automation and checks the resulting emails, document terms and calendar invitations. It extends the existing unit and integration tests.

## Run it

Use Node.js 22 and the repository's installed dependencies:

```sh
npm ci
npm test
npm run test:replay
npm run test:replay -- --report .local/replay/current.json
npm run test:replay -- --compare-ref main --report .local/replay/comparison.json
npm run test:replay -- --scenario overlapping-funnels
```

`--compare-ref` accepts a local Git revision. Fetch the desired revision first if necessary. The runner exports that revision's `service/` source to a temporary directory and runs **the current scenarios and fixtures against both versions**. Each run has its own process and database. Both revisions must have the same dependency lockfile; the runner refuses comparisons requiring historical dependencies it has not installed.

A failing scenario or unexpected external I/O attempt exits nonzero. The comparison labels each scenario `improved`, `regressed`, `passed-both` or `failed-both`. A failure in both versions still fails the candidate run. Changes in effect counts are descriptive, not quality scores: sending fewer emails is not automatically better.

Reports contain source and suite hashes, the Git revision and working-tree status, each scenario's steps, simulated elapsed time, recorded model-call counts, email/document/calendar effects, assertions that failed and comparison results. They do not estimate live model cost or score hiring quality. Generated fixture passwords are redacted before export.

## Covered paths

| Path | Expected behavior |
| --- | --- |
| Authorized interview feedback | Enters the trial queue; asks for dates when needed. |
| Technical deep-dive feedback | Reaches the same trial workflow under its own interviewer authority. |
| Fast-track with known dates and pay | Queues paperwork directly without an unnecessary availability email. |
| Authorized recap | Starts the same downstream automation. Unauthorized recommendations do not. |
| Missing pay | Waits for an authorized rate reply before candidate email. |
| Direct authorized document command | Sends through the explicit-command path; later automated entry recognizes the existing packet. This explicit command retains its existing immediate-send behavior. |
| Overlapping feedback and recap | Produces one invitation, one document packet and one sequence of follow-ups. |

The complete journeys continue through written date agreement, document confirmation, signed-paperwork evidence, account creation and welcome email, recurring check-ins, and the first-meeting confirmation. Provider results such as a signature are supplied as synthetic external events, not inferred by the test from a production outcome.

Additional scenarios exercise:

- Cancellation, holds, withdrawal and pay concerns while mail is queued.
- Recipient changes, corrected rates/dates, and changes during slow verification calls.
- Mailbox outages, uncertain delivery, restarts and repeated decisions.
- Document validation failure without a misleading “documents sent” email.
- Personal versus work addresses, team-only calendar banners, exact dates and time-zone conversion.
- Required-interviewer conflicts, incomplete calendars, missing/declined guests and moved invitations.
- Explicit first-meeting revisions, replacement-email delay and duplicate prevention.
- Two trials competing for calendar time and withdrawal cleanup.

## Execution boundary

The runner calls the actual agent runner, Notion client, Slack dispatcher, trial terms parser, queues, document orchestration, account onboarding and calendar workers. Notion and Slack REST responses are simulated. Gmail, Calendar, directory/admin and DocuSign operations use local adapters that record requests and return scripted responses. The document adapter does not validate real PDFs; the existing document validation and send-boundary tests cover that separately.

State lives in a fresh on-disk libSQL database with the production migrations and store. Restart steps close and reopen that same database. A controlled clock advances waiting periods without sleeping. Model interpretation uses a recorded synthetic response; there is no model API call.

The child process receives a small environment allowlist and runs from an empty temporary directory. It has no production credentials or `.env` loader. A preload blocks fetch, sockets, HTTPS, WebSocket and subprocess access before production modules load. Unexpected calls fail the run even if application code catches the error. This prevents accidental network use; it is not a security sandbox for intentionally hostile source code.

## Privacy

Only invented identities, example domains, synthetic messages and synthetic template text belong in these fixtures. There is no production recorder or import command. Never add candidate exports, Notion page bodies, take-home submissions, private documents, production screenshots, credentials or real mailbox histories.

The report export rejects non-example email domains and common credential formats. This is an additional check, not a complete detector of sensitive names or prose. Review every fixture change before publication. Reports stay local under ignored `.local/`; CI prints the scenario results and does not upload raw reports.

## Adding a regression

Add a scenario in `test/replay/scenarios.mjs` using `world.step` and explicitly state the expected recipient, content, timing, number of sends and calendar changes. Derive those expectations from the intended workflow, not from whichever output the code currently produces. Keep real incidents private and write a minimal invented equivalent.

Run it against the previous revision as well as the change. A useful regression fails on the old behavior and passes on the correction. Keep workflow replay separate from future evaluations of fresh model answers; a deterministic pass does not establish model quality or live provider readiness.

## Compatibility of the included safety fixes

Queued invitations and packets are bound to the candidate identity that authorized them. A changed recipient or invitation rate requires reconciliation instead of silently redirecting old work. Cancellation uses the exact queue revision. Uncertain delivery stays held even when another funnel supplies a fresh instruction.

Pending account setups now retain their approved recipient. Older pending setups without that field are held for review. If identity or authorization changes after an account is created, credentials are withheld; verify the recipient and reset the password before delivery. The replay command never migrates a live database, activates automation or deploys these changes.
