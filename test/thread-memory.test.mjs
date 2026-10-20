import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { rememberBotReply, isReplyToBot, noteHumanReply, threadTranscript } from '../service/lib/thread-memory.mjs';

const BOT = 'U0C4899BFC9';
function d1() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE uncle_sam_notices (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const prepare = sql => ({ bind: (...a) => ({ first: async () => sqlite.prepare(sql).get(...a) ?? null, run: async () => sqlite.prepare(sql).run(...a), all: async () => ({ results: sqlite.prepare(sql).all(...a) }) }) });
  return { prepare };
}
const NOW = Date.parse('2026-10-16T18:00:00Z');
const reply = (ts, text, extra = {}) => ({ channelId: 'C01D1A69CE3', threadTs: '1792100000.000100', messageTs: ts, authorId: 'U0A4F08721B', text, ...extra });

test('Thread replies: an answer to Uncle Sam in its thread counts; someone else speaking first, or tagging a person, does not', async () => {
  const db = d1();
  assert.equal(await isReplyToBot(db, reply('1792100050.000100', 'and Reagan?'), { botUserId: BOT, now: NOW }), false, 'Uncle Sam never spoke here');
  await rememberBotReply(db, { channelId: 'C01D1A69CE3', threadTs: '1792100000.000100', botTs: '1792100010.000100', now: NOW });
  assert.equal(await isReplyToBot(db, reply('1792100050.000100', 'and Reagan Turner?'), { botUserId: BOT, now: NOW }), true);
  assert.equal(await isReplyToBot(db, reply('1792100050.000100', '<@U0F9EF97D89> can you send it?'), { botUserId: BOT, now: NOW }), false, 'aimed at Project');
  assert.equal(await isReplyToBot(db, reply('1792100050.000100', `<@${BOT}> and Reagan?`), { botUserId: BOT, now: NOW }), true);
  await noteHumanReply(db, reply('1792100060.000100', 'lol nice'), NOW);
  assert.equal(await isReplyToBot(db, reply('1792100070.000100', 'and Reagan?'), { botUserId: BOT, now: NOW }), false, 'a person spoke since');
  await rememberBotReply(db, { channelId: 'C01D1A69CE3', threadTs: '1792100000.000100', botTs: '1792100080.000100', now: NOW });
  assert.equal(await isReplyToBot(db, reply('1792100090.000100', 'thanks, and Emery?'), { botUserId: BOT, now: NOW }), true, 'Uncle Sam spoke again');
  assert.equal(await isReplyToBot(db, reply('1792100090.000100', 'and Emery?'), { botUserId: BOT, now: NOW + 25 * 3600_000 }), false, 'a day later');
});

test('Thread replies: the transcript names people and Uncle Sam and leaves out the reply itself', () => {
  const text = threadTranscript([
    { ts: '1', user: 'U0F9EF97D89', text: 'Vagish withdrew' },
    { ts: '2', user: 'U0A4F08721B', text: `<@${BOT}> mark him withdrawn` },
    { ts: '3', user: BOT, botId: 'B1', text: '🫡 Done. Valen Drake is closed.' },
    { ts: '4', user: 'U0A4F08721B', text: 'and Reagan?' }], { botUserId: BOT, exceptTs: '4' });
  assert.equal(text, 'Project: Vagish withdrew\nRobin: @Uncle Sam mark him withdrawn\nUncle Sam: 🫡 Done. Valen Drake is closed.');
});
