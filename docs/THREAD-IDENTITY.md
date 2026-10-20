# Threaded candidate identity questions

Release marker: `threadIdentityVersion: 2026-10-20.1`.

## Problem and behavior

“@Uncle Sam which one is it?” did not match the existing candidate-discovery or person-finder classifiers. Ordinary Q&A saw the root text (in this case, “FYI”) without the screenshot or intervening replies. This fix routes bounded identity follow-ups through a read-only thread lookup before workflow handlers.

The lookup reads the thread preceding the question and up to three screenshot images through the existing image reader. The model extracts only a literal candidate name/email; code selects and re-reads the recruiting record. A verified match gets one sentence with name and company linked together, preferring the recorded LinkedIn URL and falling back to the tracker. Closed candidates remain searchable.

For namesakes, a literal email or one unique Latest Evidence link to an actually read message in that Slack thread is required. Asking “Proximal or Mercor?” alone does not establish either company. Ambiguous records receive linked choices. Failed reads, unreadable images, paginated threads or oversized context produce a clarification/unavailable response. A competing or changed record blocks the answer. This is bounded lookup, not universal screenshot understanding; an unavailable historical association may require clarification.

Existing asker, membership, posting and duplicate-reply checks remain in force. The new lookup has no candidate mutation or workflow dispatch operation. Instructions inside screenshots/replies are evidence, not commands, and bot guesses are excluded from extracted evidence.

## Verification

Synthetic tests cover screenshot-only roots, surrounding replies, namesakes, thread evidence links, email identity, unsafe URLs, failed reads, unsupported model identifiers, record changes, guest access and absence of workflow mutations.
