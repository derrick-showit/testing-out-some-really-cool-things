import { uid, now } from './util.js';

const shape = r => ({ id: r.id, at: r.at, to: r.user_id, text: r.text, postId: r.post_id, link: r.link, read: !!r.read });

export function notify(app, to, text, { postId = null, link = null, except = null } = {}) {
  const ids = to === 'all' ? app.db.prepare('SELECT id FROM users').all().map(r => r.id) : [].concat(to);
  for (const userId of new Set(ids)) {
    if (!userId || userId === except) continue;
    const row = { id: uid(), user_id: userId, text, post_id: postId, link, at: now(), read: 0 };
    app.db.prepare('INSERT INTO notifications (id, user_id, text, post_id, link, at, read) VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(row.id, userId, text, postId, link, row.at);
    app.events.toUser(userId, { type: 'notification', notification: shape(row) });
  }
}
export const listNotifications = (app, userId) =>
  app.db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY at DESC LIMIT 200').all(userId).map(shape);
export function markRead(app, userId, ids) {
  if (ids === 'all') app.db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId);
  else for (const id of [].concat(ids)) app.db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND id = ?').run(userId, String(id));
}
