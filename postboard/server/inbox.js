import crypto from 'node:crypto';
import { uid, now, fail, str } from './util.js';
import { safeEqual } from './crypto.js';
import { PLATFORMS } from './format.js';
import { ADAPTERS } from './platforms/index.js';
import { getAccount, mode, platformCtx } from './accounts.js';
import { startDiscordGateway } from './platforms/discord.js';
import { notify } from './notifications.js';

export const DM_PLATFORMS = Object.keys(ADAPTERS).filter(p => ADAPTERS[p].dm.supported);

const shapeThread = t => t && ({
  id: t.id, platform: t.platform, contact: { id: t.contact_id, name: t.contact_name, handle: t.contact_handle, avatar: t.contact_avatar },
  lastAt: t.last_at, lastInboundAt: t.last_inbound_at, lastText: t.last_text, unread: t.unread, status: t.status,
  assignedTo: t.assigned_to, sandbox: !!t.sandbox, replyWindow: replyWindow(t),
});
const shapeMessage = m => ({ id: m.id, threadId: m.thread_id, direction: m.direction, body: m.body, sentBy: m.sent_by, at: m.at, delivery: m.delivery, error: m.error });

// Meta only lets businesses reply within 24 hours of the last inbound message (7 days for a human agent).
export function replyWindow(t, at = now()) {
  const w = ADAPTERS[t.platform]?.dm.window;
  if (!w || !t.last_inbound_at) return { open: true };
  const since = at - t.last_inbound_at;
  if (since <= w.standard) return { open: true, closesAt: t.last_inbound_at + w.standard };
  if (since <= w.humanAgent) return { open: true, humanAgent: true, closesAt: t.last_inbound_at + w.humanAgent };
  return { open: false, closedAt: t.last_inbound_at + w.humanAgent };
}

export function createInbox(app, log = console) {
  const getThread = id => app.db.prepare('SELECT * FROM dm_threads WHERE id = ?').get(String(id));
  const broadcast = (thread, message) => app.events.toAll({ type: 'dm', thread: shapeThread(thread), message: message && shapeMessage(message) });

  // Store one message, creating the thread on first contact. Duplicate external ids are ignored.
  function record(platform, { threadExternalId, contact = {}, message, sandbox = false }) {
    if (!threadExternalId) return null;
    let t = app.db.prepare('SELECT * FROM dm_threads WHERE platform = ? AND external_id = ?').get(platform, String(threadExternalId));
    if (!t) {
      const id = uid();
      app.db.prepare(`INSERT INTO dm_threads (id, platform, external_id, contact_id, contact_name, contact_handle, contact_avatar, last_at, sandbox)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, platform, String(threadExternalId), contact.id ?? null, contact.name || '', contact.handle || '', contact.avatar ?? null, message.at || now(), sandbox ? 1 : 0);
      t = getThread(id);
    } else if (contact.name || contact.handle || contact.avatar) {
      app.db.prepare('UPDATE dm_threads SET contact_name = COALESCE(NULLIF(?, \'\'), contact_name), contact_handle = COALESCE(NULLIF(?, \'\'), contact_handle), contact_avatar = COALESCE(?, contact_avatar) WHERE id = ?')
        .run(contact.name || '', contact.handle || '', contact.avatar ?? null, t.id);
    }
    const m = { id: uid(), thread_id: t.id, external_id: message.externalId ?? null, direction: message.direction, body: str(message.body, 20000), sent_by: message.sentBy ?? null, at: message.at || now(), delivery: message.delivery || (message.direction === 'in' ? 'received' : 'sent'), error: message.error ?? null };
    const r = app.db.prepare(`INSERT OR IGNORE INTO dm_messages (id, thread_id, external_id, direction, body, sent_by, at, delivery, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(m.id, m.thread_id, m.external_id, m.direction, m.body, m.sent_by, m.at, m.delivery, m.error);
    if (!r.changes) return null;
    const inbound = m.direction === 'in';
    app.db.prepare(`UPDATE dm_threads SET last_at = MAX(last_at, ?), last_text = CASE WHEN ? >= last_at THEN ? ELSE last_text END,
      unread = unread + ?, last_inbound_at = CASE WHEN ? THEN MAX(COALESCE(last_inbound_at, 0), ?) ELSE last_inbound_at END,
      status = CASE WHEN ? THEN 'open' ELSE status END WHERE id = ?`)
      .run(m.at, m.at, m.body.slice(0, 200), inbound ? 1 : 0, inbound ? 1 : 0, m.at, inbound ? 1 : 0, t.id);
    t = getThread(t.id);
    broadcast(t, m);
    if (inbound && t.assigned_to) notify(app, t.assigned_to, `New ${PLATFORMS[platform].name} message from ${t.contact_name || t.contact_handle || 'a customer'}`, { link: `dm:${t.id}` });
    return { thread: t, message: m };
  }

  function list(filter = {}) {
    const rows = app.db.prepare('SELECT * FROM dm_threads ORDER BY last_at DESC LIMIT 300').all();
    return rows.filter(t => (!filter.platform || t.platform === filter.platform) && (!filter.status || t.status === filter.status)).map(shapeThread);
  }
  function messages(threadId) {
    const t = getThread(threadId); if (!t) fail(404, 'That conversation doesn’t exist.');
    return app.db.prepare('SELECT * FROM dm_messages WHERE thread_id = ? ORDER BY at').all(t.id).map(shapeMessage);
  }
  function markRead(threadId) {
    const t = getThread(threadId); if (!t) fail(404, 'That conversation doesn’t exist.');
    app.db.prepare('UPDATE dm_threads SET unread = 0 WHERE id = ?').run(t.id);
    broadcast(getThread(t.id));
  }
  function update(user, threadId, body) {
    const t = getThread(threadId); if (!t) fail(404, 'That conversation doesn’t exist.');
    if ('status' in body) {
      if (!['open', 'done'].includes(body.status)) fail(400, 'Status must be open or done.');
      app.db.prepare('UPDATE dm_threads SET status = ? WHERE id = ?').run(body.status, t.id);
    }
    if ('assignedTo' in body) {
      const to = body.assignedTo ? String(body.assignedTo) : null;
      if (to && !app.db.prepare('SELECT 1 FROM users WHERE id = ?').get(to)) fail(400, 'No teammate with that id.');
      app.db.prepare('UPDATE dm_threads SET assigned_to = ? WHERE id = ?').run(to, t.id);
      if (to && to !== user.id) notify(app, to, `${user.name} assigned you a ${PLATFORMS[t.platform].name} conversation with ${t.contact_name || t.contact_handle || 'a customer'}`, { link: `dm:${t.id}` });
    }
    const next = getThread(t.id); broadcast(next); return shapeThread(next);
  }

  async function reply(user, threadId, body) {
    const t = getThread(threadId); if (!t) fail(404, 'That conversation doesn’t exist.');
    const ad = ADAPTERS[t.platform];
    if (!ad.dm.supported) fail(400, ad.dm.reason);
    const text = str(body, 20000).trim(); if (!text) fail(400, 'Write a reply first.');
    if ([...text].length > ad.dm.limit) fail(400, `${PLATFORMS[t.platform].name} replies can be up to ${ad.dm.limit.toLocaleString()} characters.`);
    const win = replyWindow(t);
    if (!win.open) fail(409, `${PLATFORMS[t.platform].name} only allows replies within 7 days of the customer’s last message.`);
    const base = { direction: 'out', body: text, sentBy: user.id, at: now() };
    const live = !t.sandbox && mode(app, getAccount(app, t.platform), 'dm') === 'live';
    if (!live) return shapeMessage(record(t.platform, { threadExternalId: t.external_id, message: { ...base, delivery: 'sandbox' } }).message);
    try {
      const ctx = await platformCtx(app, t.platform);
      const r = await ad.dm.send(t, text, ctx, { humanAgent: !!win.humanAgent });
      const saved = record(t.platform, { threadExternalId: t.external_id, message: { ...base, externalId: r.externalId ?? null, delivery: 'sent' } });
      // A gateway echo may already have stored this message under the same id.
      return saved ? shapeMessage(saved.message) : shapeMessage(app.db.prepare('SELECT * FROM dm_messages WHERE thread_id = ? AND external_id = ?').get(t.id, r.externalId));
    } catch (e) {
      return shapeMessage(record(t.platform, { threadExternalId: t.external_id, message: { ...base, delivery: 'failed', error: String(e.message || e).slice(0, 400) } }).message);
    }
  }

  // Pull recent conversations from networks that support it (X, Instagram, Facebook).
  let lastSync = 0;
  async function sync({ force = false } = {}) {
    if (!force && now() - lastSync < 30000) return { skipped: true };
    lastSync = now();
    const out = {};
    for (const p of DM_PLATFORMS) {
      const ad = ADAPTERS[p];
      if (!ad.dm.sync || mode(app, getAccount(app, p), 'dm') !== 'live') continue;
      try {
        const ctx = await platformCtx(app, p);
        const convos = await ad.dm.sync(ctx);
        let added = 0;
        for (const c of convos) for (const m of c.messages.sort((a, b) => a.at - b.at)) if (record(p, { threadExternalId: c.externalId, contact: c.contact, message: m })) added++;
        out[p] = { ok: true, added };
      } catch (e) { out[p] = { ok: false, error: String(e.message || e) }; log.warn(`inbox sync failed for ${p}: ${e.message}`); }
    }
    return out;
  }

  // Meta webhooks: verify the signature against the app secret, then store each message.
  function verifyMeta(rawBody, signature) {
    const secret = app.config.env.META_APP_SECRET;
    if (!secret || !signature) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  }
  async function handleMeta(payload) {
    const platform = payload.object === 'instagram' ? 'instagram' : payload.object === 'page' ? 'facebook' : null;
    if (!platform) return 0;
    let n = 0;
    for (const entry of payload.entry || []) {
      for (const ev of entry.messaging || []) {
        if (!ev.message || ev.message.is_deleted) continue;
        const echo = !!ev.message.is_echo;
        const contactId = echo ? ev.recipient?.id : ev.sender?.id;
        if (!contactId) continue;
        const exists = app.db.prepare('SELECT 1 FROM dm_threads WHERE platform = ? AND external_id = ?').get(platform, contactId);
        let contact = { id: contactId };
        if (!exists && mode(app, getAccount(app, platform), 'dm') === 'live') {
          try { contact = { id: contactId, ...(await ADAPTERS[platform].dm.contact(contactId, await platformCtx(app, platform))) }; } catch { /* profile lookup is optional */ }
        }
        const text = ev.message.text || (ev.message.attachments?.length ? `[${ev.message.attachments.map(a => a.type).join(', ')}]` : '');
        if (record(platform, { threadExternalId: contactId, contact, message: { externalId: ev.message.mid, direction: echo ? 'out' : 'in', body: text, at: ev.timestamp || now() } })) n++;
      }
    }
    return n;
  }

  let discord = null;
  function restartDiscord() {
    discord?.stop(); discord = null;
    if (!app.config.background) return;
    const a = getAccount(app, 'discord');
    const token = a.secrets.botToken || app.config.env.DISCORD_BOT_TOKEN;
    if (!token) return;
    discord = startDiscordGateway({
      token, log,
      onMessage(d, botId) {
        const out = d.author?.id === botId;
        if (out && !app.db.prepare("SELECT 1 FROM dm_threads WHERE platform = 'discord' AND external_id = ?").get(d.channel_id)) return;
        record('discord', {
          threadExternalId: d.channel_id,
          contact: out ? {} : { id: d.author.id, name: d.author.global_name || d.author.username, handle: '@' + d.author.username, avatar: d.author.avatar ? `https://cdn.discordapp.com/avatars/${d.author.id}/${d.author.avatar}.png` : null },
          message: { externalId: d.id, direction: out ? 'out' : 'in', body: d.content || (d.attachments?.length ? '[attachment]' : ''), at: Date.parse(d.timestamp) || now() },
        });
      },
    });
  }

  let timer = null;
  return {
    record, list, messages, markRead, update, reply, sync, verifyMeta, handleMeta, restartDiscord,
    shapeThread,
    start() {
      restartDiscord();
      timer = setInterval(() => sync().catch(() => {}), app.config.inboxPollMs); timer.unref?.();
      setTimeout(() => sync({ force: true }).catch(() => {}), 2000).unref?.();
    },
    stop() { clearInterval(timer); discord?.stop(); },
  };
}
