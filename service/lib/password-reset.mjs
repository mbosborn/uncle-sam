/**
 * "reset Rowan's password" from Project (Project, 2026-10-19: "can you reset his google password and then email him new
 * instructions" / "keep whatever you send in the old thread" / "why isn't rowan blake onboarded and his stuff created?").
 *
 * Only Project, in his DM with Uncle Sam. The hire's Company Google account (the address Uncle Sam recorded for them) gets a new
 * one-time password that Google makes them change at sign-in; the sign-in goes to their personal email as a reply in the
 * newest thread Project has with them (a new email when there is none). The password is never stored, logged, noted or shown
 * to Project. Once per message; an unclear answer from Google or Gmail is told, never retried.
 */
import { noticeStore } from './stuck-rejections.mjs';
import { temporaryPassword } from './accounts.mjs';
import { bannerName } from './work-trial.mjs';

export const RESET_ASK = /\b(?:reset|new|resend|send)\b[^.?!]{0,60}\bpassword\b|\bpassword\b[^.?!]{0,40}\b(?:reset|again)\b/i;
const ADDRESS = /\b[a-z0-9._%+-]+@company\.example\b/i;
const words = n => String(n ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter(w => w.length > 1);

export function signInText({ first, address, password }) {
  return [`Hi ${first},`,
    'Here is a new sign-in for your Company email:',
    `Email: ${address}\nTemporary password: ${password}`,
    'Sign in at https://mail.google.com. Google will ask you to choose your own password right away. Your Slack and Okta invitations are waiting in that inbox.',
    'Let me know if anything doesn\'t work.'].join('\n\n');
}

export async function handlePasswordReset({ event, db, findCandidate, admin = null, gmail = null, masonId, poster, clock = Date.now, sideEffects = [], password = temporaryPassword }) {
  if (!db?.prepare || event?.authorId !== masonId) return null;
  const text = String(event.text ?? '').replace(/\*Sent using\*[\s\S]*$/i, '');
  if (!RESET_ASK.test(text)) return null;
  const reply = t => poster(event.threadTs ?? event.messageTs)(t).catch(() => null);
  const who = await findCandidate(text, event).catch(() => null);
  if (who?.ambiguous) { await reply(`📋 Which one: ${who.ambiguous.slice(0, 4).join(' or ')}?`); return { kind: 'password_reset', reason: 'ambiguous' }; }
  if (!who?.pageId) { await reply('📋 Whose password? Say "reset <full name>\'s password".'); return { kind: 'password_reset', reason: 'no_candidate' }; }
  if (!admin?.get || !admin?.resetPassword) { await reply('📋 My Google admin access isn\'t working right now. Reset it in the Google admin console.'); return { kind: 'password_reset', reason: 'no_admin' }; }
  if (!gmail?.send) { await reply('📋 Your Gmail isn\'t connected to me right now, so I can\'t send them the sign-in. Nothing was changed.'); return { kind: 'password_reset', reason: 'no_gmail' }; }
  const kv = noticeStore(db), now = clock();
  const state = (await kv.get(`onboarding:${who.pageId}`)) ?? {};
  const address = String(text.match(ADDRESS)?.[0] ?? state.address ?? '').toLowerCase();
  const name = bannerName(who.fullName), first = name.split(' ')[0];
  if (!ADDRESS.test(address)) { await reply(`📋 I don't have ${name}'s Company address. Send "reset ${name}'s password <address>".`); return { kind: 'password_reset', reason: 'no_address' }; }
  if (!who.email) { await reply(`📋 ${name} has no personal email on the tracker, so I can't send the sign-in. Nothing was changed.`); return { kind: 'password_reset', reason: 'no_email' }; }
  let user;
  try { user = await admin.get(address); } catch (error) { await reply(`🚨 Google didn't answer when I looked up ${address} (${error?.code ?? 'error'}). Nothing was changed.`); return { kind: 'password_reset', reason: 'google_error' }; }
  if (!user) { await reply(`📋 ${address} doesn't exist in Google. Nothing was changed.`); return { kind: 'password_reset', reason: 'no_account' }; }
  if (!words(user.name).some(w => words(name).includes(w))) { await reply(`🚨 ${address} belongs to ${user.name}, not ${name}. I didn't touch it.`); return { kind: 'password_reset', reason: 'mismatch' }; }
  if (user.isAdmin) { await reply(`🚨 ${address} is an admin account; I don't reset those. Do it in the Google admin console.`); return { kind: 'password_reset', reason: 'admin_account' }; }
  if (!(await kv.claim(`pwreset:${event.channelId}:${event.messageTs}`, { at: now }, now))) return { kind: 'password_reset', reason: 'duplicate' };
  const secret = password();
  try { await admin.resetPassword(address, secret); }
  catch (error) { await reply(error?.uncertain ? `🚨 Resetting ${address} gave an unclear answer (${error.code}). Check it in the Google admin console; I won't try again.` : `🚨 Google refused the reset for ${address} (${error?.code ?? 'failed'}). Nothing was sent.`); return { kind: 'password_reset', reason: 'reset_failed' }; }
  // The newest email with them, to keep it in the same thread (Project, 2026-10-19: "keep whatever you send in the old thread").
  const latest = (await gmail.listInbox?.(`(from:${who.email} OR to:${who.email}) newer_than:60d`, 5).catch(() => []) ?? [])[0] ?? null;
  const subject = latest?.subject ? (/^re:/i.test(latest.subject) ? latest.subject : `Re: ${latest.subject}`) : 'Your Company email sign-in';
  try {
    await gmail.send({ to: who.email, subject, body: signInText({ first, address, password: secret }), ...(latest?.id ? { replyTo: latest.id } : {}) });
  } catch (error) {
    await reply(error?.uncertain
      ? `🚨 ${address} has a new password, but the email to ${name} may or may not have gone out (${error.code}). Check your Sent mail; if it isn't there, ask me again.`
      : `🚨 ${address} has a new password, but the email to ${name} didn't go out (${error?.code ?? 'failed'}). Ask me again to send a new one.`);
    return { kind: 'password_reset', reason: 'send_failed' };
  }
  sideEffects.push('password_reset');
  await kv.put(`pwreset:done:${address}`, { pageId: who.pageId, at: now, thread: latest?.threadId ?? null }, now);
  await reply('Roger that 🫡');
  return { kind: 'password_reset', reason: 'done' };
}
