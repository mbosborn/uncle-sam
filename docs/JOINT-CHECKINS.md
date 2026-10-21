# Check-ins planned across trials

Upcoming trials share the same interviewer calendars. Picking a good time for one trial can use the only practical slot for another. The forecast and new booking paths now use the same bounded planner, with existing invitations treated as occupied time.

## How it chooses a schedule

The planner uses the existing rules for candidate time zones, morning and evening windows, team working hours, required attendees, optional attendance and five-minute buffers. It precomputes legal starts and compares at most 32 deterministic trial orderings for up to eight trials, each no longer than 21 days. It prefers fewer missing check-ins, then fewer incomplete trials, fewer late exceptions and the existing time preferences. Dates outside the planning limits are explicitly deferred.

This is a bounded search, not a guarantee of a globally optimal schedule. It needs no additional service, model call or solver dependency. The retained synthetic capacity fixture demonstrates an improvement from one missing check-in to none using identical calendars and rules.

## From forecast to invitations

`runWorkTrials` prepares banners and readiness before scheduling the batch. Account-ready and time-zone reply entry points use the same setup function. Only candidates with the existing confirmed-date, account, banner and hold checks can be booked. The forecast can also inspect confirmed future trials before their accounts are ready.

The booking path creates two series with explicit UTC `RDATE` occurrences. A time that works on the first day is not silently repeated on other days. The local time zone remains on the event, including across daylight-saving changes. Google documents explicit recurrence dates in its [calendar event model](https://developers.google.com/workspace/calendar/api/concepts/events-calendars).

If a candidate's full remaining schedule cannot be placed, no invitations are created for that candidate. Other complete plans can proceed. Unknown or truncated required-calendar reads block booking. The search remains bounded, so a held plan means no complete plan was verified by this search, not that every mathematically possible schedule has been ruled out.

## Reservations and changes

One database lease serializes these setup paths. Durable slot reservations cover provider propagation delays and incomplete writes. Every series creation rechecks the full planned schedule, current candidate identity, dates, work address, holds, operating mode and lease ownership. The organizer's existing check-ins count as busy even when marked free on that calendar.

Provider IDs are chosen and saved before inserts. A partial or uncertain result retains its attempted ID, confirmed receipts and reserved slots for review. It is not retried automatically. The first-check-in confirmation remains ineligible until both series and the final validation complete. Existing first-confirmation readback checks still apply.

Existing invitations are never moved by the new planner. Newly booked joint schedules are also protected from the periodic guard's automatic time changes; conflicts request an explicit decision. An approved reschedule updates the durable reservation. Known invitations for closed candidates remain eligible for the existing cancellation cleanup. Uncertain writes still require reconciliation.

Google Calendar offers no atomic transaction across people's availability and event insertion. A person can change a calendar after the last read. These checks reduce that window; they do not eliminate it. The separate audit finding about conditional updates to existing events remains outside this change.

## Verification

The synthetic tests cover the capacity counterexample, multiple entry funnels, exact recurrence dates, later-day conflicts, daylight-saving changes, competing setup workers, changed recipients and dates, holds, operating pauses, lease loss, incomplete reads, uncertain writes, cancellation between series and preservation of published times. The existing authored replay, generated exploration and safeguard mutation campaign also run against this implementation.

Run the focused cases with Node.js 22:

```sh
node --test test/joint-checkins.test.mjs test/checkin-plan.test.mjs test/early-checkins.test.mjs test/checkins.test.mjs
```

All fixtures are invented. Tests use simulated calendars and do not contact or invite real candidates. The health marker `jointCheckinVersion` identifies the deployed implementation; it is not proof that a real booking has occurred.
