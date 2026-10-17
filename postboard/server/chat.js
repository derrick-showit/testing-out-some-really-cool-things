import { uid, now, fail, str } from './util.js';
import { notify } from './notifications.js';
import { mentionedUsers } from './posts.js';

const allUserIds = app => app.db.prepare('SELECT id FROM users').all().map(r => r.id);
const memberIds = (app, ch) => ch.kind === 'channel' ? allUserIds(app) : app.db.prepare('SELECT user_id FROM chat_members WHERE channel_id = ?').all(ch.id).map(r => r.user_id);

export function ensureDefaultChannels(app, userId) {
  if (app.db.prepare("SELECT 1 FROM chat_channels WHERE kind = 'channel'").get()) return;
  for (const name of ['general', 'content-review']) {
    app.db.prepare("INSERT INTO chat_channels (id, kind, name, created_by, created_at) VALUES (?, 'channel', ?, ?, ?)").run(uid(), name, userId, now());
  }
}

function channelFor(app, user, id) {
  const ch = app.db.prepare('SELECT * FROM chat_channels WHERE id = ?').get(String(id));
  if (!ch) fail(404, 'That conversation doesn’t exist.');
  if (ch.kind === 'dm' && !app.db.prepare('SELECT 1 FROM chat_members WHERE channel_id = ? AND user_id = ?').get(ch.id, user.id)) fail(403, 'You aren’t part of that conversation.');
  return ch;
}

function shapeChannel(app, user, ch) {
  const read = app.db.prepare('SELECT last_read_at FROM chat_members WHERE channel_id = ? AND user_id = ?').get(ch.id, user.id)?.last_read_at || 0;
  const unread = app.db.prepare('SELECT COUNT(*) n FROM chat_messages WHERE channel_id = ? AND at > ? AND user_id != ?').get(ch.id, read, user.id).n;
  const last = app.db.prepare('SELECT at FROM chat_messages WHERE channel_id = ? ORDER BY at DESC LIMIT 1').get(ch.id);
  const out = { id: ch.id, kind: ch.kind, name: ch.name, unread, lastAt: last?.at || ch.created_at };
  if (ch.kind === 'dm') out.with = memberIds(app, ch).find(id => id !== user.id) || user.id;
  return out;
}

export function listChannels(app, user) {
  const rows = app.db.prepare(`SELECT * FROM chat_channels WHERE kind = 'channel'
    OR id IN (SELECT channel_id FROM chat_members WHERE user_id = ?) ORDER BY kind, name, created_at`).all(user.id);
  return rows.map(ch => shapeChannel(app, user, ch));
}

export function createChannel(app, user, name) {
  const n = str(name, 40).toLowerCase().trim().replace(/^#/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!n) fail(400, 'Give the channel a name using letters, numbers or dashes.');
  if (app.db.prepare("SELECT 1 FROM chat_channels WHERE kind = 'channel' AND name = ?").get(n)) fail(409, `#${n} already exists.`);
  const id = uid();
  app.db.prepare("INSERT INTO chat_channels (id, kind, name, created_by, created_at) VALUES (?, 'channel', ?, ?, ?)").run(id, n, user.id, now());
  const ch = app.db.prepare('SELECT * FROM chat_channels WHERE id = ?').get(id);
  for (const u of allUserIds(app)) app.events.toUser(u, { type: 'chat-channel', channel: shapeChannel(app, { id: u }, ch) });
  return shapeChannel(app, user, ch);
}

export function openDirect(app, user, otherId) {
  if (!app.db.prepare('SELECT 1 FROM users WHERE id = ?').get(String(otherId))) fail(404, 'No teammate with that id.');
  const key = [user.id, String(otherId)].sort().join(':');
  let ch = app.db.prepare('SELECT * FROM chat_channels WHERE dm_key = ?').get(key);
  if (!ch) {
    const id = uid();
    app.db.prepare("INSERT INTO chat_channels (id, kind, dm_key, created_by, created_at) VALUES (?, 'dm', ?, ?, ?)").run(id, key, user.id, now());
    for (const u of new Set([user.id, String(otherId)])) app.db.prepare('INSERT INTO chat_members (channel_id, user_id) VALUES (?, ?)').run(id, u);
    ch = app.db.prepare('SELECT * FROM chat_channels WHERE id = ?').get(id);
  }
  return shapeChannel(app, user, ch);
}

export function messages(app, user, channelId, before) {
  const ch = channelFor(app, user, channelId);
  const rows = app.db.prepare('SELECT * FROM chat_messages WHERE channel_id = ? AND at < ? ORDER BY at DESC LIMIT 60').all(ch.id, Number(before) || 8.64e15);
  return rows.reverse().map(m => ({ id: m.id, channelId: m.channel_id, userId: m.user_id, body: m.body, at: m.at }));
}

export function markRead(app, user, channelId) {
  const ch = channelFor(app, user, channelId);
  app.db.prepare(`INSERT INTO chat_members (channel_id, user_id, last_read_at) VALUES (?, ?, ?)
    ON CONFLICT(channel_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at`).run(ch.id, user.id, now());
}

export function postMessage(app, user, channelId, body) {
  const ch = channelFor(app, user, channelId);
  const text = str(body, 4000).trim(); if (!text) fail(400, 'Write a message first.');
  const m = { id: uid(), channelId: ch.id, userId: user.id, body: text, at: now() };
  app.db.prepare('INSERT INTO chat_messages (id, channel_id, user_id, body, at) VALUES (?, ?, ?, ?, ?)').run(m.id, ch.id, user.id, text, m.at);
  markRead(app, user, ch.id);
  const members = memberIds(app, ch);
  for (const u of members) app.events.toUser(u, { type: 'chat', message: m, channel: shapeChannel(app, { id: u }, ch) });
  if (ch.kind === 'channel') {
    const mentioned = mentionedUsers(app, text).map(u => u.id).filter(id => id !== user.id);
    const name = app.db.prepare('SELECT name FROM users WHERE id = ?').get(user.id).name;
    notify(app, mentioned, `${name} mentioned you in #${ch.name}`, { link: `chat:${ch.id}` });
  }
  return m;
}
