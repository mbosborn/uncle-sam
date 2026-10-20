# First check-in reliability — October 20, 2026

## Intended behavior

Schedule changes are legitimate when availability or trial dates change. The first meeting must nevertheless be dependable: no silent automatic optimization of its time, no email based on a stale series target, and no claim that a revised time is confirmed until the invitation is verified. Later check-ins retain their normal adaptive scheduling.

The first invitation is protected from creation. A dedicated **Your first Company AI work-trial check-in** email is sent only after the exact occurrence passes the checks below. General invitation, paperwork and account emails should not make their own unverified first-time promise.

## Checks before a first-time promise

1. Current active candidate, confirmed trial dates, resolved pay/terms, candidate time zone and verified Company work address.
2. Read back exactly one actual calendar occurrence, including original recurring identity; confirm its start/end, candidate and team guests, and Meet link.
3. Require Robin and Interviewer/Quinn calendars to be readable and complete; check conflicts with a five-minute buffer, candidate hours and team scheduling bounds.
4. Use the actual first day when selecting recurring times; record the first event actually created, including late setup. Do not promise a past skipped target.
5. Use IANA time zones and print the full candidate-local date/time and Pacific date/time. Handle weekend dates, overnight night meetings and daylight saving.
6. Send during 9 AM–9 PM candidate-local hours, including weekends. The implementation uses a conservative **12-hour notice margin**; this is a safety default chosen for this repair, not a number Project specified. If waiting until waking hours leaves insufficient notice, hold and tell Project; do not silently push the meeting or send an overnight promise.
7. Check personal and work-address Sent mail for an existing first-check-in confirmation; existing manual correspondence requires reconciliation rather than a duplicate.
8. Preserve the existing 30-minute automatic-email delay and candidate-specific cancel command. Re-read identity, dates, time zone, work address, holds, control mode and calendar before sending. Atomically reserve delivery. Verified sends are recorded; uncertain sends are held rather than blindly retried. A definite pre-send failure can retry.

## Adaptation and exceptional changes

- Routine optimization, conflict repair, duplicate removal and automatic trial-date rebuild cannot silently move/cancel the first occurrence. A conflict produces one actionable message to Project. Later occurrences still adapt normally.
- Project can reply in that conflict thread with an explicit same-date Pacific time including AM/PM. The authenticated handler checks the proposed replacement before changing the invitation, sends calendar guest updates, reads it back, and queues a dedicated **Updated: your first Company AI work-trial check-in** email showing old and new times. It says delivery is queued, not sent.
- Competing changes and email sends use atomic version reservations. A pending or uncertain confirmation blocks another revision. A calendar-write timeout preserves the proposed version for reconciliation and never blindly restores the old time.
- Changed trial dates, an ambiguous time/date/time zone, too little notice, or an externally edited invitation require explicit coordination. They are not permission for arbitrary rescheduling. The team can arrange an exception directly, update the invitation with guest notifications, and ensure the candidate receives the revised time. The bot does not automatically bless or undo outside edits.
- Existing registrations receive a historical calendar baseline and **no bulk first-check-in email**. If history cannot establish which meeting is first, the guard declines to guess. Closed-trial cleanup still operates.

## Verification and limits

Regression tests cover Saturday starts, waking hours, daylight saving, date/account/time-zone changes during verification, missing/declined guests, conflicts, unavailable/truncated calendars, moved/cancelled invitations, earlier meetings, existing mail, duplicate workers, uncertain sends, legitimate explicit revisions, concurrent revisions, and write failures. Existing later-meeting and closed-trial behavior remains covered.

This checker governs Uncle Sam's paths. Humans and other agents can still send emails or edit calendars outside it. Mail delivery evidence does not prove that a candidate read or accepted a new time. Legacy baseline state does not reconstruct the content of every historical email. These boundaries must remain explicit.

Local tests use simulated providers; live integration validation is deployment-specific.
