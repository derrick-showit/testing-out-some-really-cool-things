import { call, sleep, publicMedia } from './http.js';
const API = 'https://graph.threads.net/v1.0';

export default {
  id: 'threads',
  oauth: 'threads',
  async profile(token, ctx) {
    const { data } = await call(ctx.fetch, `${API}/me?fields=id,username,name,threads_biography&access_token=${encodeURIComponent(token)}`);
    return { externalId: data.id, handle: data.username, name: data.name || data.username, bio: data.threads_biography || '' };
  },
  async publish(post, ctx) {
    const user = ctx.account.externalId;
    const create = form => call(ctx.fetch, `${API}/${user}/threads`, { method: 'POST', form: { ...form, access_token: ctx.token } }).then(r => r.data.id);
    const hasMedia = post.media.some(m => m.src?.startsWith('/media/'));
    let id;
    if (!hasMedia) id = await create({ media_type: 'TEXT', text: ctx.text });
    else {
      const media = publicMedia(post, ctx, { max: 20 });
      const one = (m, extra) => create(m.kind === 'video' ? { media_type: 'VIDEO', video_url: m.url, ...extra } : { media_type: 'IMAGE', image_url: m.url, ...extra });
      if (media.length === 1) id = await one(media[0], { text: ctx.text });
      else {
        const children = []; for (const m of media) children.push(await one(m, { is_carousel_item: 'true' }));
        id = await create({ media_type: 'CAROUSEL', children: children.join(','), text: ctx.text });
      }
      for (let i = 0; i < 40; i++) {
        const { data } = await call(ctx.fetch, `${API}/${id}?fields=status&access_token=${encodeURIComponent(ctx.token)}`);
        if (data.status === 'FINISHED') break;
        if (data.status === 'ERROR') throw new Error('Threads couldn’t process that media.');
        await sleep(ctx.pollMs ?? 3000);
      }
    }
    const { data } = await call(ctx.fetch, `${API}/${user}/threads_publish`, { method: 'POST', form: { creation_id: id, access_token: ctx.token } });
    return { externalId: data.id };
  },
  dm: { supported: false, reason: 'Threads has no public messaging API, so Threads messages can’t be answered here.' },
};
