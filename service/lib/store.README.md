# Uncle Sam store

`createStore(env.DB, { authorized: true })` is an internal D1 repository. Set `authorized` only after the route validates the caller's admin credentials or Slack signature. Without it, only `getPublicStatus()` is available. `getStatus()` returns controls and request counts, never raw events, candidate payloads or credentials. Do not store credentials in payloads or errors.

Migrations come from `db/schema.ts`; the store does not run migrations. All timestamps are stored as epoch milliseconds. ISO datetime inputs must include a timezone. `recordEvent()` derives Slack activity time from `messageTs`, separately from observation time. Event payloads are bounded to 256 KiB before a write; other JSON fields are bounded to 128 KiB.

## Controls and action delivery

- `getControl()` / `ensureControl()` initialize Off, baseline incomplete, version 0, pause generation 0.
- `updateControl({expectedVersion, mode?, baselineComplete?, activatedAt?})` performs a compare-and-swap. Live requires a completed baseline and immutable activation boundary.
- `ensureRequest({requestKey,candidateId,occurrenceId,action,recipientIds,payload,triggerAt,dueAt?,isFixture?,baselined?,sourceEventId?})` preserves the first request. A key with a different immutable scope throws. Request creation and its source-event link are transactional.
- `claimRequest({requestKey,claimToken,expectedControlVersion,expectedPauseGeneration})` atomically claims only a due Pending request. Off cannot claim. Test can claim only a trusted fixture, with `dryRun:true`. Live requires a completed baseline and post-activation trigger. Historical baseline records stay excluded.
- Immediately before the external action, call `authorizeDispatch({requestKey,claimToken})`. Changed controls, a pause/resume, or an applicable hold invalidate the claim.
- Both claim and final dispatch checks exclude requests linked to edited/deleted Slack source messages. Matching includes source, workspace, app, channel, original message timestamp and fixture status. A signed amendment arriving before the original event also invalidates later reliance on it. It never authorizes a replacement decision.
- After verified delivery/read-back, call `completeRequest({requestKey,claimToken,state:'Sent'|'Complete',receipt:{verified:true,resultId,...}})`. Genuine receipts remain recordable after a concurrent pause.
- A lost or ambiguous response calls `markUncertain({requestKey,claimToken,reason})`. Neither Sending nor Uncertain automatically expires or becomes retryable. Only verified reconciliation with the original claim can complete it.
- Test calls `markSimulated({requestKey,claimToken,result})`; it cannot record a real delivery.

`setActionHold({holdKey,candidateId?,occurrenceId?,action,reason,sourceEventId})` applies to existing and future matching actions. A null candidate or occurrence widens that dimension; `action` remains explicit. A hold atomically increments control version and pause generation. `releaseActionHold({holdKey,expectedVersion,sourceEventId})` requires the current hold version and sourced release. Authorization of the human instruction belongs in the caller's policy checks.

## Candidate conversation threads

`reserveCandidateThread()` binds one candidate and approved route to an immutable conversation. The first request owns creation of the root message. Other requests must wait for its verified thread timestamp instead of creating duplicate roots. Jamie and AA use different route keys and separately verified conversations.

`saveCandidateThread()` persists the verified Slack root timestamp through compare-and-swap with its owner request and previous value. A failed or uncertain root delivery blocks reuse until reconciliation; it does not release the reservation for a blind retry. These bindings are created by `0002_candidate_threads.sql`.

## Events and Notion wake recovery

`recordEvent({eventId,appId,teamId,channelId,channelType,authorId,messageTs,threadTs,text,isFixture?})` deduplicates the source event ID. `isFixture` must come from trusted server metadata; `payload.isFixture` never controls it. Raw event content is evidence, not authorization.

Use `listUnprocessedEvents({limit:50})`, `getEvent(eventId)` and `markEventProcessed({eventId,receipt})` for source processing. `markEventProcessed` does not erase the source. `linkEventToRequest` links corroborating sources to the same semantic action.

Notion wake creation follows this sequence:

1. `claimEventWake({eventId,attemptId})` reserves an unattempted event under the current eligible D1 control version and pause generation.
2. Check the authoritative Notion controls, and call `authorizeEventWake({eventId,attemptId})` immediately before creation. The caller must keep D1 and authoritative controls synchronized; unsynchronized D1 defaults safely Off.
3. Successful creation calls `markEventNotionWake({eventId,attemptId,pageId})`, which returns `recorded:true` when that page is saved.
4. A proven failure before any page could have been created may call `releaseEventWake({eventId,attemptId,reason,preCreateFailure:true})`.
5. Timeout, network loss, server error or ambiguous result calls `markWakeUncertain({eventId,attemptId,reason})`. It becomes NeedsAttention, excluded from `listWakePendingEvents()`, and cannot be re-created automatically. Verified discovery of the existing page can complete the original attempt.

Database claims prevent competing workers from reserving the same action; they cannot make a remote API call atomic with a database update. A pause arriving after the final check cannot undo an in-flight request. Preserve and reconcile the actual result.

## Verification

Run the Node 24 built-in test runner on `uncle-sam/test/store.test.mjs`. Tests execute the actual deployment migrations against `node:sqlite`, compare the resulting columns to Drizzle, and exercise D1-compatible prepared statements and transactional batches. They perform no external actions.
