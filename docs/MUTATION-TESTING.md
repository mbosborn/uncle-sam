# Testing the safeguards themselves

Passing tests are useful only if they notice when important behavior breaks. This campaign uses [StrykerJS](https://github.com/stryker-mutator/stryker-js) to deliberately bypass selected guards in a temporary copy, then runs the actual hiring replay against that copy. It also forces each guard to block valid work, so a system that never sends anything cannot pass.

```sh
npm ci
npm run test:mutate
```

Use Node.js 22. The command needs no credentials, network access or model calls after dependencies are installed. It does not deploy code or change running automation.

## What it checks

The campaign targets thirteen conditions across trial invitations, document queues, account onboarding and first check-in confirmations. It covers cancelled work, cancellation during a slow verification call, approved recipient identity, stale compensation, changes before credential delivery, exact meeting times, required guests and interviewer conflicts. Each condition produces two mutations: always true and always false.

Every mutation runs the complete authored replay, including the different ways candidates enter a work trial. The bypass must fail the specific negative scenarios named in [the target manifest](../test/mutation/targets.mjs). The opposite mutation must fail a real assertion too. The unmodified, instrumented baseline must first pass every scenario.

The command fails if a mutation survives, its expected scenario does not detect it, a scenario is missing, a target disappears after a refactor, or the engine produces an unexpected active mutation. Syntax errors, execution errors, blocked network attempts and timeouts do not count as caught safeguards. This is stricter than relying on the engine's aggregate mutation score.

## Isolation and results

Only explicitly allowed source files, static validation schemas and synthetic fixtures enter the temporary snapshot. The copy excludes secrets, operational state, private documents and Git history, and refuses source symlinks. Installed dependencies are shared read-only by convention; production source is copied and its hash is checked after the run. Each replay gets a new process and database, a small environment allowlist and the existing network/subprocess blocker.

The Stryker adapter follows the project's [plugin interface](https://stryker-mutator.io/docs/stryker-js/guides/create-a-plugin/). It distinguishes assertion failures from infrastructure failures and records which scenarios detected each change. The compact report is saved to ignored `.local/mutation/latest.json`. Raw Stryker reports contain source text, so they are kept inside the temporary directory and removed with it. No dashboard reporter or report upload is enabled.

## Extending the campaign

Add a unique source condition and its expected negative scenarios to the target manifest. Write expectations in terms of intended behavior, such as zero messages after cancellation or exact recipient, pay and calendar details. Run the unmodified baseline, then verify that bypassing the condition fails those assertions. Do not weaken the expected behavior to make a score pass.

The scope intentionally excludes mutations of wording, arithmetic and nested subexpressions. This is a focused safeguard campaign, not a repository-wide coverage score or a guarantee against every possible failure. A refactor can make a selected mutation harmless because another guard now catches it; review that result and update the target deliberately. Do not silently ignore a survivor.
