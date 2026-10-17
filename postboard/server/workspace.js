import { uid, fail, str, arr, uniq, parseJson } from './util.js';

const DEFAULTS = {
  labels: [
    { id: 'l1', name: 'Launch', h: 22 }, { id: 'l2', name: 'Founder', h: 262 }, { id: 'l3', name: 'Case study', h: 140 },
    { id: 'l4', name: 'Community', h: 200 }, { id: 'l5', name: 'Promo', h: 340 }, { id: 'l6', name: 'Education', h: 48 },
  ],
  campaigns: [],
  settings: { requireApproval: true, defaultApprovers: [] },
};
export function getWs(app, key) {
  const r = app.db.prepare('SELECT value FROM workspace WHERE key = ?').get(key);
  return r ? parseJson(r.value, structuredClone(DEFAULTS[key])) : structuredClone(DEFAULTS[key]);
}
export function setWs(app, key, value) {
  app.db.prepare('INSERT INTO workspace (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}
const day = v => /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : fail(400, 'Campaign dates must look like 2026-10-31.');
const hue = v => Math.max(0, Math.min(360, Math.round(Number(v) || 0)));

export function updateWorkspace(app, user, body) {
  if ('labels' in body) {
    setWs(app, 'labels', arr(body.labels).slice(0, 50).map(l => ({ id: str(l.id, 40) || uid(), name: str(l.name, 40).trim() || 'Label', h: hue(l.h) })));
  }
  if ('campaigns' in body) {
    setWs(app, 'campaigns', arr(body.campaigns).slice(0, 200).map(c => {
      const s = day(c.start), e = day(c.end);
      return { id: str(c.id, 40) || uid(), name: str(c.name, 80).trim() || 'Campaign', start: s <= e ? s : e, end: s <= e ? e : s, h: hue(c.h) };
    }));
  }
  if ('settings' in body) {
    if (!user.is_admin) fail(403, 'Only admins can change approval settings.');
    const ids = new Set(app.db.prepare('SELECT id FROM users').all().map(r => r.id));
    setWs(app, 'settings', {
      requireApproval: !!body.settings.requireApproval,
      defaultApprovers: uniq(arr(body.settings.defaultApprovers).filter(id => ids.has(id))),
    });
  }
  const ws = { labels: getWs(app, 'labels'), campaigns: getWs(app, 'campaigns'), settings: getWs(app, 'settings') };
  app.events.toAll({ type: 'workspace', ...ws });
  return ws;
}
