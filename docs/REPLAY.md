# Work-trial replay

The replay suite runs production workflow code against invented candidates and local service fixtures. It follows different paths into the same work-trial automation and checks the resulting emails, document terms and calendar invitations. It extends the existing unit and integration tests.

## Run it

Use Node.js 22 and the repository's installed dependencies:

```sh
npm ci
npm test
npm run test:replay
npm run test:mutate
npm run test:replay -- --report .local/replay/current.json
npm run test:replay -- --compare-ref main --report .local/replay/comparison.json
npm run test:replay -- --scenario overlapping-funnels
```

`--compare-ref` accepts a local Git revision. Fetch the desired revision first if necessary. The runner exports that revision's `service/` source to a temporary directory and runs **the current scenarios and fixtures against both versions**. Each run has its own process and database. Both revisions must have the same dependency lockfile; the runner refuses comparisons requiring historical dependencies it has not installed.

A failing scenario or unexpected external I/O attempt exits nonzero. The comparison labels each scenario `improved`, `regressed`, `passed-both` or `failed-both`. A failure in both versions still fails the candidate run. Changes in effect counts are descriptive, not quality scores: sending fewer emails is not automatically better.

Reports contain source and suite hashes, the Git revision and working-tree status, each scenario's steps, simulated elapsed time, recorded model-call counts, email/document/calendar effects, assertions that failed and comparison results. They do not estimate live model cost or score hiring quality. Generated fixture passwords are redacted before export.

## Covered paths

[Mutation testing](MUTATION-TESTING.md) checks the tests themselves by deliberately bypassing selected recipient, cancellation, compensation and calendar guards in isolated source copies. The corresponding replay assertions must fail. Execution errors and timeouts do not count as successful detection.

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
- Mailbox outages, uncertain delivery, restarts and repeated decisions. Newer cancellations, holds, withdrawals and pay corrections override stale retries; a freshly authorized correction still waits before sending.
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

Run it against the previous revision as well as the change. A useful regression fails on the old behavior and passes on the correction. Keep workflow replay separate from the fresh model evaluations below; a deterministic pass does not establish model quality or live provider readiness.

## Generated sequences and controlled races

```sh
npm run test:explore
npm run test:explore -- --runs 500 --events 30 --seed 20261020
npm run test:explore -- --seed 20261020 --path '<path from a failure report>'
npm run test:explore -- --replay .local/replay-generated/failures/<id>.json
# After fixing and reviewing a synthetic failure, keep it in the ordinary tests:
npm run test:explore -- --replay .local/replay-generated/failures/<id>.json --retain
```

[fast-check](https://fast-check.dev/docs/advanced/model-based-testing/) generates sequences across interview, deep-dive, recap and overlapping entry paths. Events include date changes, repeated approval delivery, cancellation, hold, withdrawal, identity changes, service-read outages, recovery, elapsed time and process restarts. Every sequence finishes with recovery and repeated worker runs so an outage cannot hide an unsafe retry.

The independent oracle checks effects at the simulated provider boundary. It checks recipient identity, current packet dates, candidate versus internal calendar guests, duplicate delivery and whether accepted cancellation or a hold should prevent an action. Two workers use separate connections to the same local database. A [controlled scheduler](https://fast-check.dev/docs/advanced/race-conditions/) varies when operations reach the simulated providers, including a competing cancellation. This explores those boundaries; it is not an exhaustive model of network, operating-system or provider behavior.

Failures exit nonzero and are automatically saved under `.local/replay-generated/failures/`. fast-check shrinks inputs, then deletion reduction removes events that do not contribute to the same failure. Reports preserve the seed, shrink path, reduced sequence and executed scheduling order. The reduction seeks a sequence with no removable single event under that scheduling seed, not a proof of the globally shortest counterexample. `--retain` verifies the corrected behavior and adds the synthetic sequence to `test/replay/generated-regressions/`, which `npm test` always runs. Do not weaken an invariant merely to make a failure pass.

The default exploration is 100 sequences of up to 20 generated events, with a three-minute exploration budget and a separate outer timeout. A timeout is a failed run. Use a fixed seed for repeatable CI and additional seeds for broader local coverage. Reports stay local; no candidate records are recorded or imported.

## Fresh model decision checks

```sh
npm run test:model -- --list
# Set the chosen provider's key securely in your shell. No live-service keys are needed.
npm run test:model -- --route openrouter --repeat 3
npm run test:model -- --scenario terms-withdrawn-agreement --repeat 5
```

This opt-in suite calls the real model through the production client and prompts. It covers free-text interviewer approvals, corrections, quoted instructions, unauthorized actors, recap decisions, bilateral date agreement, withdrawal, pay disputes and owner date instructions. Assertions inspect both the model's proposed decision and the resulting workflow effects. A wrong interpretation fails even if a later guard happens to block delivery. Positive cases must reach the expected queue, packet or calendar; doing nothing is not automatically safe behavior.

The network-capable parent holds only the selected model credential. The workflow runs in a separate process with a clean environment, the replay I/O blocker and a temporary database. Model requests cross a narrow IPC broker; returned tool calls execute only against synthetic adapters. No real Gmail, Calendar, Notion, document or account operation is available. The configured model provider receives the synthetic conversations and production prompts. There is no import path for real candidate or take-home content.

Default limits are three repetitions, 120 model requests, 65,536 output tokens and 25 minutes. Each request is capped at 256 KiB and 8,192 output tokens. `--max-calls` and `--max-output-tokens` adjust the bounds. Input and output tokens both incur provider charges; these are not dollar limits. API errors, missing decisions, truncated output, missing usage and exhausted budgets fail the run. The suite has no automatic retries and is not part of paid PR checks.

`--route`, `--model`, and provider environment variables select the model. An optional explicit `--config` reads only the model keys and names from a local `secrets` object; it never passes the secrets file to a workflow worker. `--report` selects a local output path. Reports retain actual model/provider identifiers, usage, request hashes, decisions, assertions and source/suite hashes. They omit API keys, raw prompts, hidden reasoning and generated account credentials. Changing source during a run invalidates it. Reports are not uploaded by CI.

The assertion approach follows [Promptfoo's expected-output patterns](https://www.promptfoo.dev/docs/configuration/expected-outputs/); no Promptfoo or Temporal runtime is required. Repeated passes describe these scenarios on that model at that time. They do not prove all possible language interpretations or live integration readiness.

## Compatibility of the included safety fixes

Queued invitations and packets are bound to the candidate identity that authorized them. A changed recipient or invitation rate requires reconciliation instead of silently redirecting old work. Cancellation uses the exact queue revision. Uncertain delivery stays held even when another funnel supplies a fresh instruction.

Pending account setups now retain their approved recipient. Older pending setups without that field are held for review. If identity or authorization changes after an account is created, credentials are withheld; verify the recipient and reset the password before delivery. The replay command never migrates a live database, activates automation or deploys these changes.

First-check-in confirmation queues also retain the personal recipient and work account. Changed recipients, changed work accounts and older queue entries without recipient evidence remain held for explicit reconciliation. Trial calendar setup honors candidate holds before creating banners or check-ins. These are runtime protections; test execution itself never changes live queue entries.
