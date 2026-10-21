// Deliberate guard removals, not a repository-wide mutation score. Anchors must
// remain unique; a refactor cannot silently remove a safeguard from this campaign.
export const targets = [
  ['invite-queue-state', 'trial-invite', "!q?.pageId || q.sentAt || q.dropped || q.deliveryUncertain || q.dispatchingAt || now < q.at", ['invite-cancel']],
  ['invite-final-evidence', 'trial-invite', `!latest || latest.archived || !sameRecipient(q, latest)
        || CLOSED.includes(fields.Outcome) || ['Closed', 'Hired'].includes(fields.Stage) || fields.Outcome === 'On Hold'
        || ['Sent', 'Signed'].includes(fields.Paperwork) || (dayOnly(fields['Trial Start']) && dayOnly(fields['Trial End']))
        || (latest.payment?.dailyRate != null && latest.payment.dailyRate !== q.rate)
        || await kv.get(\`trialterms:hold:\${q.pageId}\`)`, ['invite-identity-during-check', 'invite-rate-during-check', 'invite-hold-during-check']],
  ['invite-reservation', 'trial-invite', '!(await kv.compareAndSwap(key, q, sending, now))', ['cancel-during-invite-check']],
  ['packet-recipient', 'email-queue', `!q.email || String(c.email ?? '').toLowerCase() !== q.email.toLowerCase() || c.emailVerified === false
        || (q.name && String(c.fullName ?? '').trim().toLowerCase() !== q.name.trim().toLowerCase())`, ['packet-identity-change']],
  ['packet-rate', 'email-queue', 'currentRate != null && q.rate != null && currentRate !== q.rate', ['packet-unapproved-rate-change']],
  ['packet-reservation', 'email-queue', '!(await kv.compareAndSwap(key, q, sending, now))', ['cancel-during-packet-check']],
  ['account-cancellation', 'onboarding', 'a.stopped', ['account-email-cancel']],
  ['account-recipient', 'onboarding', `!a.email || a.email.toLowerCase() !== String(candidate.email ?? '').toLowerCase()
        || a.name !== candidate.fullName`, ['account-email-identity']],
  ['credential-final-evidence', 'onboarding', `!latest || latest.email !== candidate.email || latest.fullName !== candidate.fullName
        || dayOnly(latest.fields?.['Trial Start']) !== start || await accountGate(latest)
        || (await notion.readControl())?.mode !== 'Live'`, ['account-recipient-changes-during-template-read']],
  ['confirmation-recipient', 'first-checkin-confirmation', "!prior.to || prior.to !== candidate.email || prior.name !== candidateName || candidate.emailVerified === false", ['first-recipient-change']],
  ['calendar-guests', 'first-checkin-confirmation', "!guest || ([workEmail, ...MUST].includes(email) && guest.responseStatus === 'declined')", ['first-missing-work-guest', 'first-declined-interviewer']],
  ['calendar-time', 'first-checkin-confirmation', 'at !== lock.at || end !== lock.end', ['first-moved-first-meeting']],
  ['calendar-conflict', 'first-checkin-confirmation', 'busy[email].some(b => b.start < end + 300_000 && b.end > at - 300_000)', ['first-required-conflict']],
].map(([id, module, condition, witnesses]) => ({ id, file: `service/lib/${module}.mjs`, condition, witnesses }));

export function locateTargets(read) {
  return targets.map(target => {
    const source = read(target.file), anchor = `if (${target.condition})`, at = source.indexOf(anchor);
    if (at < 0 || source.indexOf(anchor, at + 1) >= 0) throw Error(`Mutation anchor missing or ambiguous: ${target.id}`);
    const start = at + 4;
    const position = offset => {
      const lines = source.slice(0, offset).split('\n');
      return { line: lines.length, column: lines.at(-1).length };
    };
    return { ...target, start: position(start), end: position(start + target.condition.length) };
  });
}
