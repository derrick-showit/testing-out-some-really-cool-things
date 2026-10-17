// Server-sent events: one stream per open tab, grouped by user so we know who is online.
export function createHub() {
  const clients = new Map(); // userId -> Set<res>
  const write = (res, ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* closed */ } };
  const online = () => [...clients.keys()];
  const toAll = ev => { for (const set of clients.values()) for (const res of set) write(res, ev); };
  const ping = setInterval(() => { for (const set of clients.values()) for (const res of set) { try { res.write(': ping\n\n'); } catch {} } }, 25000);
  ping.unref();
  return {
    online,
    toAll,
    toUser(id, ev) { for (const res of clients.get(id) || []) write(res, ev); },
    toUsers(ids, ev) { for (const id of new Set(ids)) for (const res of clients.get(id) || []) write(res, ev); },
    add(userId, res) {
      const first = !clients.has(userId);
      if (first) clients.set(userId, new Set());
      clients.get(userId).add(res);
      if (first) toAll({ type: 'presence', online: online() });
    },
    remove(userId, res) {
      const set = clients.get(userId); if (!set) return;
      set.delete(res);
      if (!set.size) { clients.delete(userId); toAll({ type: 'presence', online: online() }); }
    },
    close() { clearInterval(ping); for (const set of clients.values()) for (const res of set) { try { res.end(); } catch {} } clients.clear(); },
  };
}
