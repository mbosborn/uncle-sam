# Candidate lookup and sourcing calibration

## Identity lookup

Identity questions use a read-only lookup before action handlers. The search includes closed records and schema-verified identifying properties: name, company, role, brief and recorded context. Every retained literal clue must match. Negative or uncertain sentences do not supply positive evidence. A unique result is fetched again before answering.

The answer returns a linked identity, preferring the recorded LinkedIn URL and otherwise using a trusted tracker link. It does not quote private notes, pay or outcomes into Slack, reopen a candidate or initiate outreach. Failed reads, ambiguous results and incomplete pagination require clarification.

Search is bounded to three 100-row pages. It is literal evidence matching with limited abbreviation and scheduling normalization; unknown synonyms or missing background may need clarification.

## Sourcing

Search planning and ranking use role-specific calibration alongside explicit feedback. Provider descriptions remain available to ranking. Only selected profiles are accepted: the requested count is a maximum, and a model failure retries instead of sending an unranked batch.

The example RL role requires an exact supporting quote about relevant work and evidence for the required location. A model still judges ownership and fit; these checks do not independently verify a profile's claims. Source provenance and company diversity limits are preserved.

`docs/sourcing-calibration-2026-10-20.json` contains synthetic examples for testing the calibration mechanism. Examples are excluded from new prospects and do not represent real evaluations, work trials or hiring decisions. Calibration remains scoped to its role when roles change or learned preferences are rebuilt.

## Tests

Tests cover closed records, private-note handling, authorization, failed reads, namesakes, stale results, pagination, safe links, role isolation, exact evidence quotes, no quota padding, model outages and retained descriptions. No live candidate data is required.
