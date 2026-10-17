import { call } from './http.js';
const API = 'https://api.x.com/2';

export default {
  id: 'x',
  oauth: 'x',
  async profile(token, ctx) {
    const { data } = await call(ctx.fetch, `${API}/users/me?user.fields=public_metrics,description`, { token });
    const u = data.data;
    return { externalId: u.id, handle: u.username, name: u.name, bio: u.description || '', followers: u.public_metrics?.followers_count || 0 };
  },
  async publish(post, ctx) {
    const body = { text: ctx.text };
    const images = post.media.filter(m => m.kind === 'image' && m.src?.startsWith('/media/')).slice(0, 4);
    if (images.length) {
      const ids = [];
      for (const m of images) {
        const { buf, mime } = await ctx.readMedia(m);
        const fd = new FormData();
        fd.append('media', new Blob([buf], { type: mime }), 'image');
        fd.append('media_category', 'tweet_image');
        const { data } = await call(ctx.fetch, `${API}/media/upload`, { method: 'POST', token: ctx.token, body: fd });
        ids.push(data.data?.id ?? data.id ?? data.media_id_string);
      }
      body.media = { media_ids: ids };
    }
    const { data } = await call(ctx.fetch, `${API}/tweets`, { method: 'POST', token: ctx.token, json: body });
    return { externalId: data.data.id, url: `https://x.com/${ctx.account.handle}/status/${data.data.id}` };
  },
  dm: {
    supported: true,
    limit: 10000,
    // X has no free webhook for DMs, so the inbox polls recent DM events.
    async sync(ctx) {
      const q = 'dm_event.fields=id,text,created_at,sender_id,dm_conversation_id&event_types=MessageCreate&expansions=sender_id&user.fields=username,name,profile_image_url&max_results=50';
      const { data } = await call(ctx.fetch, `${API}/dm_events?${q}`, { token: ctx.token });
      const users = Object.fromEntries((data.includes?.users || []).map(u => [u.id, u]));
      const me = ctx.account.externalId;
      const convos = new Map();
      for (const e of data.data || []) {
        const otherId = e.dm_conversation_id.split('-').find(id => id !== me) || e.sender_id;
        if (!convos.has(e.dm_conversation_id)) {
          const u = users[otherId] || {};
          convos.set(e.dm_conversation_id, { externalId: e.dm_conversation_id, contact: { id: otherId, name: u.name || '', handle: u.username ? '@' + u.username : '', avatar: u.profile_image_url || null }, messages: [] });
        }
        convos.get(e.dm_conversation_id).messages.push({ externalId: e.id, direction: e.sender_id === me ? 'out' : 'in', body: e.text || '', at: Date.parse(e.created_at) || Date.now() });
      }
      return [...convos.values()];
    },
    async send(thread, text, ctx) {
      const { data } = await call(ctx.fetch, `${API}/dm_conversations/${encodeURIComponent(thread.external_id)}/messages`, { method: 'POST', token: ctx.token, json: { text } });
      return { externalId: data.data?.dm_event_id };
    },
  },
};
