# Document delivery checker

Implemented 2026-10-20. Validator revision: `2026-10-20.1`.

## Purpose

Changing recipient names is insufficient when a PDF or sender-prefill field still contains a prior identity. The checker validates rendered content and fields before dispatch. Synthetic regression fixtures cover stale overlays, unexpected documents and incorrect recipients.

## Mandatory behavior

Every bot-controlled initial packet, separate compensation addendum, manual
resend and automatic reminder passes the common DocuSign boundary. There is no
environment flag that disables validation.

1. Validate candidate/company signer identity, email, rate and real calendar dates.
   Re-read queued identity and dates; an unavailable or archived candidate blocks.
   Re-resolve a pending name confirmation instead of trusting its cached record.
2. Create a draft. Replace the two specific NDA party-name prefills identified
   by document, label, page and coordinates. Do not globally replace names or
   change legal wording.
3. Fetch the final PDFs and recipient/document field inventories from DocuSign.
4. Check every document and every page against versioned full-text schemas.
   Instantiate candidate placeholders from the trusted identity. Regenerate the
   addendum from the trusted name/email/rate/date snapshot and compare its complete
   text. Check only the exact current envelope-ID stamp as an allowed format variant.
5. Check exact recipient names/emails/order, the standard forms' field
   types/labels/positions and required flags, and addendum signing anchors.
   Check both recipient and document field inventories. Unknown/hidden/conditional
   fields, missing required fields and unexpected filled values block.
6. Reject unsupported/missing/extra/duplicate documents, unreadable or empty pages,
   unexpected images and annotations. Only the observed Company logo's exact
   decoded pixels and dimensions are allowed on standard documents' first pages.
7. Save hashes, schema/validator versions, field fingerprint and trusted input
   snapshot before sending. Persist the candidate claim's envelope ID before the
   final request. Only then request `status: sent`.
8. Re-fetch and validate the whole envelope on a resend. Require the prior
   successful receipt and matching document-byte and field fingerprints.

The three-document packet remains supported where the existing addendum setting
is off; if an addendum is present it must pass too. Unrecognized agreements and
legacy envelopes without receipts block. A candidate's completed signatures or
DocuSign rewrites can change bytes; these conservative blocks require review.

## Holds, receipts and recovery

`docusign:validation:<envelopeId>` contains the validation state and receipt.
It contains hashes/expected inputs and concise errors, not copied PDF contents.
`docusign:packet:<email>` or `docusign:addendum:<email>` binds the operation to
its envelope. The email queue distinguishes `validationBlocked` and
`deliveryUncertain` from `done`.

On a content failure, preserve the draft for diagnosis, hold delivery and report
the document/page/field reason. Do not send a candidate confirmation or mark the
packet sent. Repeated ticks do not send or repeat the same queue warning.

On a timeout/5xx at the final send, look up that envelope's status. Confirmed
sent/delivered/completed reconciles success. Otherwise retain `uncertain` and
the envelope ID indefinitely; do not create a replacement after an hour.
A crash during send retains `send_pending` and also holds retries.

To recover:

1. Inspect the identified envelope, candidate record, expected terms and receipt.
2. Correct the source fields/draft. A revised form needs deliberate schema review,
   all-page extraction and visual review, then updated tests; never bless a failing
   candidate document automatically.
3. For uncertain sends, reconcile the existing envelope directly before clearing
   a hold. Do not delete the claim merely to make the queue retry.
4. Revalidate corrected content. Sending corrected paperwork or voiding an
   already-issued envelope is a separate authorized operation.

Do not advise “resend by hand” as a way around a checker failure.

## Verification and limits

Tests cover correct recipients with wrong embedded names; multiple candidates;
all four forms; unexpected/unreadable/image-only PDFs; changed compensation and
dates; incorrect recipient/field ownership and coordinates; changed prefill
values; unsupported/conditional fields; missing required signing fields; legacy
and mutated resends; and uncertain-send/crash holds after two hours.

Run `node --test test/*.test.mjs` before deployment. The public health response
reports `documentChecker.enabled`, version and `block_send_and_resend`.
That proves the deployed build exposes the checker, not that an individual
packet passed. Only that envelope's validation receipt is packet-level evidence.

These are content-integrity schemas based on the existing forms, not a new legal
review. Standard forms name “Company Artificial Intelligence Corporation”; the
existing addendum names “Company AI, Inc.” This change preserves both. Terms page 1
contains fixed October 15 document-version dates; they are not trial dates.
Required date-signed fields populate the NDA/CIIAA effective-date blanks.

No software can promise that every conceivable document error is impossible.
This checker prevents the demonstrated stale-name path and blocks unknown
content rather than guessing. It cannot control manual sends outside Uncle Sam
or guarantee a document will not be edited after verification. Full extracted
text, approved image content and field geometry are checked; arbitrary malicious
PDF vector/visibility tricks are not a complete visual-equivalence proof.
