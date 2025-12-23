import { Bot } from "grammy";
import Database from "better-sqlite3";

/**
 * FamPoints Bot (v1)
 * Features:
 * - Messages count
 * - Karma: reply "+" awards 1 point to the author of replied-to message
 * - Invites: /myinvite creates personal native Telegram invite links
 * - Invite confirmation: counts invite only after user stays 24h AND sends >=3 messages
 * - /me, /leaderboard
 */

const token = process.env.BOT_TOKEN;
if (!token) throw new Error("Missing BOT_TOKEN env var.");

const bot = new Bot(token);
const db = new Database("fampoints.db");

// --- Config knobs ---
const KARMA_COOLDOWN_SECONDS = 30;           // per giver
const INVITE_CONFIRM_AFTER_SECONDS = 24 * 3600;
const INVITE_CONFIRM_MIN_MESSAGES = 3;

// --- DB schema ---
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS stats (
  chat_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  karma INTEGER NOT NULL DEFAULT 0,
  karma_given INTEGER NOT NULL DEFAULT 0,
  invites_pending INTEGER NOT NULL DEFAULT 0,
  invites_confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS karma_cooldowns (
  chat_id INTEGER NOT NULL,
  giver_id INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, giver_id)
);

CREATE TABLE IF NOT EXISTS invite_links (
  chat_id INTEGER NOT NULL,
  inviter_id INTEGER NOT NULL,
  invite_link TEXT NOT NULL,
  PRIMARY KEY (chat_id, inviter_id)
);

CREATE TABLE IF NOT EXISTS invite_joins (
  chat_id INTEGER NOT NULL,
  joined_user_id INTEGER NOT NULL,
  inviter_id INTEGER,
  joined_at INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, joined_user_id)
);
`);

const now = () => Math.floor(Date.now() / 1000);

function upsertUser(chatId, u) {
  if (!u?.id) return;

  db.prepare(`
    INSERT INTO users (chat_id, user_id, username, first_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name
  `).run(chatId, u.id, u.username || null, u.first_name || null);

  db.prepare(`
    INSERT INTO stats (chat_id, user_id) VALUES (?, ?)
    ON CONFLICT(chat_id, user_id) DO NOTHING
  `).run(chatId, u.id);
}

function displayName(row) {
  if (row.username) return `@${row.username}`;
  return row.first_name || String(row.user_id);
}

// --- Commands ---
bot.command("me", async (ctx) => {
  const chatId = ctx.chat.id;
  const u = ctx.from;
  upsertUser(chatId, u);

  const s = db.prepare(`
    SELECT messages, karma, karma_given, invites_pending, invites_confirmed
    FROM stats WHERE chat_id=? AND user_id=?
  `).get(chatId, u.id) || {
    messages: 0,
    karma: 0,
    karma_given: 0,
    invites_pending: 0,
    invites_confirmed: 0,
  };

  await ctx.reply(
    `👤 ${u.first_name}${u.username ? ` (@${u.username})` : ""}\n` +
    `➕ FamPoints: ${s.karma}\n` +
    `💬 Messages: ${s.messages}\n` +
    `🤝 Given: ${s.karma_given}\n` +
    `🎟️ Invites: ${s.invites_confirmed} confirmed (${s.invites_pending} pending)\n` +
    `🆔 ID: ${u.id}`
  );
});

bot.command("leaderboard", async (ctx) => {
  const chatId = ctx.chat.id;

  const top = db.prepare(`
    SELECT u.user_id, u.first_name, u.username,
           s.karma, s.messages, s.invites_confirmed
    FROM stats s
    JOIN users u ON u.chat_id=s.chat_id AND u.user_id=s.user_id
    WHERE s.chat_id=?
    ORDER BY s.karma DESC, s.invites_confirmed DESC, s.messages DESC
    LIMIT 10
  `).all(chatId);

  if (!top.length) return ctx.reply("No FamPoints yet.");

  const lines = top.map((r, i) => {
    const name = displayName(r);
    return `${i + 1}. ${name} — ➕${r.karma} | 🎟️${r.invites_confirmed} | 💬${r.messages}`;
  });

  await ctx.reply("🏆 FamPoints Leaderboard\n" + lines.join("\n"));
});

bot.command("myinvite", async (ctx) => {
  const chatId = ctx.chat.id;
  const u = ctx.from;
  upsertUser(chatId, u);

  const existing = db.prepare(`
    SELECT invite_link FROM invite_links WHERE chat_id=? AND inviter_id=?
  `).get(chatId, u.id);

  if (existing?.invite_link) {
    return ctx.reply(`Here’s your invite link:\n${existing.invite_link}`);
  }

  // Requires bot admin permission: Manage Invite Links
  const link = await ctx.api.createChatInviteLink(chatId, {
    name: `invited by ${u.username ? "@"+u.username : u.first_name}`,
  });

  db.prepare(`
    INSERT INTO invite_links (chat_id, inviter_id, invite_link)
    VALUES (?, ?, ?)
  `).run(chatId, u.id, link.invite_link);

  await ctx.reply(`Here’s your invite link:\n${link.invite_link}`);
});

// --- Message handlers ---
bot.on("message", async (ctx) => {
  const chatId = ctx.chat.id;
  const u = ctx.from;

  // Track joins (service message)
  if (ctx.message?.new_chat_members?.length) {
    for (const joinUser of ctx.message.new_chat_members) {
      upsertUser(chatId, joinUser);

      // If joined via an invite link, telegram includes it
      const inviteLink = ctx.message.invite_link?.invite_link;

      let inviterId = null;
      if (inviteLink) {
        const inviter = db.prepare(`
          SELECT inviter_id FROM invite_links WHERE chat_id=? AND invite_link=?
        `).get(chatId, inviteLink);
        if (inviter?.inviter_id) inviterId = inviter.inviter_id;
      }

      db.prepare(`
        INSERT INTO invite_joins (chat_id, joined_user_id, inviter_id, joined_at, confirmed)
        VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(chat_id, joined_user_id) DO NOTHING
      `).run(chatId, joinUser.id, inviterId, now());

      if (inviterId) {
        db.prepare(`
          INSERT INTO stats (chat_id, user_id) VALUES (?, ?)
          ON CONFLICT(chat_id, user_id) DO NOTHING
        `).run(chatId, inviterId);

        db.prepare(`
          UPDATE stats SET invites_pending = invites_pending + 1
          WHERE chat_id=? AND user_id=?
        `).run(chatId, inviterId);
      }
    }
    return;
  }

  // For normal messages, we need a sender
  if (!u?.id) return;
  upsertUser(chatId, u);

  const text = (ctx.message.text || "").trim();

  // Count messages (ignore commands)
  if (ctx.message.text && !text.startsWith("/")) {
    db.prepare(`
      UPDATE stats SET messages = messages + 1
      WHERE chat_id=? AND user_id=?
    `).run(chatId, u.id);
  }

  // Karma: reply "+" awards author of replied-to message
  if (ctx.message.text && text === "+" && ctx.message.reply_to_message?.from) {
    const target = ctx.message.reply_to_message.from;
    if (!target?.id) return;

    // No self-upvotes
    if (target.id === u.id) return;

    // Cooldown per giver
    const cd = db.prepare(`
      SELECT last_at FROM karma_cooldowns WHERE chat_id=? AND giver_id=?
    `).get(chatId, u.id);

    const t = now();
    if (cd && (t - cd.last_at) < KARMA_COOLDOWN_SECONDS) return;

    db.prepare(`
      INSERT INTO karma_cooldowns (chat_id, giver_id, last_at)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id, giver_id) DO UPDATE SET last_at=excluded.last_at
    `).run(chatId, u.id, t);

    upsertUser(chatId, target);

    db.prepare(`
      UPDATE stats SET karma = karma + 1
      WHERE chat_id=? AND user_id=?
    `).run(chatId, target.id);

    db.prepare(`
      UPDATE stats SET karma_given = karma_given + 1
      WHERE chat_id=? AND user_id=?
    `).run(chatId, u.id);

    // Optional: delete "+" spam if you give bot delete perms
    // await ctx.api.deleteMessage(chatId, ctx.message.message_id).catch(()=>{});
  }

  // Lightweight confirmation checks (do a few per message)
  const candidates = db.prepare(`
    SELECT joined_user_id, inviter_id, joined_at
    FROM invite_joins
    WHERE chat_id=? AND confirmed=0 AND inviter_id IS NOT NULL
    LIMIT 5
  `).all(chatId);

  for (const c of candidates) {
    if ((now() - c.joined_at) < INVITE_CONFIRM_AFTER_SECONDS) continue;

    const msgCount = db.prepare(`
      SELECT messages FROM stats WHERE chat_id=? AND user_id=?
    `).get(chatId, c.joined_user_id)?.messages || 0;

    if (msgCount < INVITE_CONFIRM_MIN_MESSAGES) continue;

    db.prepare(`
      UPDATE invite_joins SET confirmed=1
      WHERE chat_id=? AND joined_user_id=?
    `).run(chatId, c.joined_user_id);

    db.prepare(`
      UPDATE stats
      SET invites_pending = CASE WHEN invites_pending > 0 THEN invites_pending - 1 ELSE 0 END,
          invites_confirmed = invites_confirmed + 1
      WHERE chat_id=? AND user_id=?
    `).run(chatId, c.inviter_id);
  }
});

bot.start();
console.log("FamPoints running ✅");
