# Reliability repairs — 20 October 2026

Release identifier: `2026-10-20.2` (`/api/health.reliabilityVersion`). Live integration verification is deployment-specific.

## Pending compensation corrections

An explicit new rate for a pending packet replaces the earlier queued rate and restarts its 30-minute cancellation period. Automatic rediscovery cannot replace the correction. Queue updates and dispatch use atomic version comparisons, so a worker holding the old queue entry cannot send it after the correction wins. Once dispatch starts, the bot refuses to pretend it changed an in-flight document.

Before dispatch, a nonempty tracker rate conflicting with the queued rate holds the packet and tells Project. Resolve the conflicting instruction/tracker values before retrying; the bot does not silently select one. Delivery completion refuses to overwrite an observed newer, different tracker rate. Notion provides no atomic cross-system transaction with DocuSign: a rate change after a provider request begins requires review of the issued document.

## Recovering from outages

Invitation candidate reads, template reads and Sent-mail duplicate checks remain pending on read failures, with exponential retry delays from five minutes up to one hour. Definite temporary send refusals can retry; ambiguous delivery retains its send claim and requires reconciliation. Missing/archived candidates and actual invalid templates still stop the invitation.

Failed DocuSign validation attempts are stored separately from approved document/field hashes. Temporary read failures hold the current resend without erasing approval. A later healthy attempt reruns all checks and compares the same fingerprints; changed content stays blocked. Scheduled pre-start reminders release only their pre-send retry marker when validation explicitly reports a retryable read failure. They never release it after an ambiguous resend.

Already-destroyed receipts cannot be reconstructed by this change. Existing legacy/validation holds and previously dropped invitations are not blindly revived. No candidate backfill, mass resend, send-claim deletion or existing check-in reversal is performed by the release.

## Preserving candidate evidence

Gmail notes and reply watching retain a fixed scan interval and continuation token. A page completes before its cursor advances; the watermark advances only after the final page. The notes lane handles up to 40 messages per page; replies handle 25. A small overlap and durable message IDs prevent normal boundary gaps and repeated processing. Active failed pages remain pending instead of expiring out of the normal two-day reply query.

Slack DM reading likewise keeps the original interval and page cursor until drained. Page sizes fit the text/message budget, avoiding a skipped tail.

Reply interpretation validates its tool output. Provider errors, missing/malformed tools and truncated responses create a retry record, not the legitimate business classification “other.” No withdrawal/date action or generic reply handling is performed for a failed classification. Subsequent successful interpretation uses the existing source-quote and authority safeguards. A persistently unclassifiable reply keeps its page pending and reports an error; this release does not guess a classification or silently discard it.

The first-check-in worker no longer uses an ended trial or three elapsed days as completion evidence. Calendar failures return unknown/error, and no matching event means no completion write. The existing positive rule remains a candidate-linked, non-cancelled check-in on Project's calendar whose end time has passed. This establishes a scheduled event that ended, not independently verified attendance. Existing checked boxes are left unchanged; any retrospective attendance audit is separate.

## Verification

The regression suite covers 100-message Gmail backlogs, 70-message reply backlogs, 105-message Slack backlogs, interrupted pages, provider/classifier failure then recovery, rate correction during an awaited candidate read, conflicting pay, dispatch already started, stale tracker writes, missing calendar evidence, invitation read/send outages, and a valid resend after 429/503 while changed PDF bytes remain blocked.

Tests use in-memory databases and simulated providers. They send no real documents/messages and alter no real candidates. The full suite and live deployment identity must both be verified; local tests are not live-delivery proof.
