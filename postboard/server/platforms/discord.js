import { call } from './http.js';
const API = 'https://discord.com/api/v10';

export default {
  id: 'discord',
  oauth: null,
  // Posts go through a channel webhook; DMs go through a bot.
  async publish(post, ctx) {
    const url = ctx.account.secrets.webhook;
    const payload = { content: ctx.text.slice(0, 2000), username: ctx.account.name || 'Postboard' };
    const file = post.media.find(m => m.src?.startsWith('/media/'));
    let body, headers = {};
    if (file) {
      const { buf, mime, name } = await ctx.readMedia(file);
      body = new FormData();
      body.append('payload_json', JSON.stringify(payload));
      body.append('files[0]', new Blob([buf], { type: mime }), name);
    } else { body = JSON.stringify(payload); headers['Content-Type'] = 'application/json'; }
    const { data } = await call(ctx.fetch, url + (url.includes('?') ? '&' : '?') + 'wait=true', { method: 'POST', headers, body });
    return { externalId: data.id };
  },
  dm: {
    supported: true,
    limit: 2000,
    async send(thread, text, ctx) {
      const { data } = await call(ctx.fetch, `${API}/channels/${thread.external_id}/messages`, {
        method: 'POST', headers: { Authorization: `Bot ${ctx.botToken}` }, json: { content: text },
      });
      return { externalId: data.id };
    },
  },
};

// Minimal Gateway client: listens for DMs to the bot (DIRECT_MESSAGES intent) using Node's built-in WebSocket.
export function startDiscordGateway({ token, onMessage, log = console, WebSocketImpl = globalThis.WebSocket }) {
  let ws, heartbeat, seq = null, stopped = false, backoff = 1000, botId = null;
  const connect = () => {
    ws = new WebSocketImpl('wss://gateway.discord.gg/?v=10&encoding=json');
    ws.onmessage = ev => {
      const p = JSON.parse(ev.data);
      if (p.s != null) seq = p.s;
      if (p.op === 10) {
        clearInterval(heartbeat);
        heartbeat = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: seq })); }, p.d.heartbeat_interval);
        ws.send(JSON.stringify({ op: 2, d: { token, intents: 1 << 12, properties: { os: 'linux', browser: 'postboard', device: 'postboard' } } }));
      } else if (p.op === 0 && p.t === 'READY') { botId = p.d.user.id; backoff = 1000; }
      else if (p.op === 0 && p.t === 'MESSAGE_CREATE' && !p.d.guild_id) onMessage(p.d, botId);
      else if (p.op === 7 || p.op === 9) ws.close();
    };
    ws.onclose = ev => {
      clearInterval(heartbeat);
      if (ev?.code === 4004) { log.warn('Discord rejected the bot token. DMs are paused until it is fixed.'); return; }
      if (!stopped) setTimeout(connect, backoff = Math.min(backoff * 2, 60000));
    };
    ws.onerror = () => {};
  };
  connect();
  return { stop() { stopped = true; clearInterval(heartbeat); try { ws?.close(); } catch {} } };
}
