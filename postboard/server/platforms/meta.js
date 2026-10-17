import { call, sleep, publicMedia } from './http.js';

// Facebook Pages and Instagram (professional accounts linked to a Page) share one Meta app and one login.
const G = ctx => `https://graph.facebook.com/${ctx.env.META_GRAPH_VERSION || 'v23.0'}`;
const DAY = 864e5;

async function waitForContainer(ctx, id, field = 'status_code') {
  for (let i = 0; i < 60; i++) {
    const { data } = await call(ctx.fetch, `${G(ctx)}/${id}?fields=${field}&access_token=${encodeURIComponent(ctx.token)}`);
    if (data[field] === 'FINISHED' || data[field] === 'PUBLISHED') return;
    if (data[field] === 'ERROR' || data[field] === 'EXPIRED') throw new Error('Instagram couldn’t process that media. Check its format and size.');
    await sleep(ctx.pollMs ?? 3000);
  }
  throw new Error('Instagram is still processing the media. Try sending again in a few minutes.');
}

function pageMessaging(platform) {
  return {
    supported: true,
    limit: platform === 'instagram' ? 1000 : 2000,
    // Meta allows replies for 24 hours after the customer's last message. With the
    // Human Agent permission, a teammate can still answer for up to 7 days.
    window: { standard: DAY, humanAgent: 7 * DAY },
    async sync(ctx) {
      const pageId = platform === 'instagram' ? ctx.account.secrets.pageId : ctx.account.externalId;
      const fields = 'participants,updated_time,messages.limit(20){id,message,from,created_time}';
      const { data } = await call(ctx.fetch, `${G(ctx)}/${pageId}/conversations?platform=${platform === 'instagram' ? 'instagram' : 'messenger'}&fields=${encodeURIComponent(fields)}&limit=25&access_token=${encodeURIComponent(ctx.token)}`);
      const me = ctx.account.externalId;
      return (data.data || []).map(c => {
        const other = (c.participants?.data || []).find(p => p.id !== me && p.id !== pageId) || {};
        return {
          externalId: other.id,
          contact: { id: other.id, name: other.name || other.username || '', handle: other.username ? '@' + other.username : '' },
          messages: (c.messages?.data || []).map(m => ({ externalId: m.id, direction: m.from?.id === other.id ? 'in' : 'out', body: m.message || '', at: Date.parse(m.created_time) || Date.now() })),
        };
      }).filter(c => c.externalId);
    },
    async send(thread, text, ctx, opts = {}) {
      const pageId = platform === 'instagram' ? ctx.account.secrets.pageId : ctx.account.externalId;
      const json = { recipient: { id: thread.contact_id || thread.external_id }, message: { text } };
      if (opts.humanAgent) { json.messaging_type = 'MESSAGE_TAG'; json.tag = 'HUMAN_AGENT'; } else json.messaging_type = 'RESPONSE';
      const { data } = await call(ctx.fetch, `${G(ctx)}/${pageId}/messages?access_token=${encodeURIComponent(ctx.token)}`, { method: 'POST', json });
      return { externalId: data.message_id };
    },
    async contact(id, ctx) {
      const fields = platform === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic';
      const { data } = await call(ctx.fetch, `${G(ctx)}/${id}?fields=${fields}&access_token=${encodeURIComponent(ctx.token)}`);
      return { name: data.name || [data.first_name, data.last_name].filter(Boolean).join(' '), handle: data.username ? '@' + data.username : '', avatar: data.profile_pic || null };
    },
  };
}

export const facebook = {
  id: 'facebook',
  oauth: 'meta',
  async publish(post, ctx) {
    const page = ctx.account.externalId; const tk = ctx.token; const base = G(ctx);
    const post1 = (path, form) => call(ctx.fetch, `${base}/${page}/${path}`, { method: 'POST', form: { ...form, access_token: tk } });
    if (post.format === 'story') {
      const [m] = publicMedia(post, ctx, { kinds: ['image'] });
      const { data: photo } = await post1('photos', { url: m.url, published: 'false' });
      const { data } = await post1('photo_stories', { photo_id: photo.id });
      return { externalId: data.post_id || photo.id };
    }
    const hasMedia = post.media.some(m => m.src?.startsWith('/media/'));
    if (post.format === 'reel' || post.media.find(m => m.src?.startsWith('/media/'))?.kind === 'video') {
      const [m] = publicMedia(post, ctx, { kinds: ['video'] });
      const { data } = await post1('videos', { file_url: m.url, description: ctx.text });
      return { externalId: data.id, url: `https://www.facebook.com/${data.id}` };
    }
    if (hasMedia) {
      const media = publicMedia(post, ctx, { kinds: ['image'] });
      if (media.length === 1) {
        const { data } = await post1('photos', { url: media[0].url, caption: ctx.text });
        return { externalId: data.post_id || data.id };
      }
      const ids = [];
      for (const m of media) ids.push((await post1('photos', { url: m.url, published: 'false' })).data.id);
      const { data } = await post1('feed', { message: ctx.text, attached_media: JSON.stringify(ids.map(media_fbid => ({ media_fbid }))) });
      return { externalId: data.id, url: `https://www.facebook.com/${data.id}` };
    }
    const { data } = await post1('feed', { message: ctx.text });
    return { externalId: data.id, url: `https://www.facebook.com/${data.id}` };
  },
  dm: pageMessaging('facebook'),
};

export const instagram = {
  id: 'instagram',
  oauth: 'meta',
  async publish(post, ctx) {
    const ig = ctx.account.externalId; const base = G(ctx);
    const create = form => call(ctx.fetch, `${base}/${ig}/media`, { method: 'POST', form: { ...form, access_token: ctx.token } }).then(r => r.data.id);
    const asMedia = (m, extra = {}) => m.kind === 'video' ? { media_type: 'VIDEO', video_url: m.url, ...extra } : { image_url: m.url, ...extra };
    let container;
    if (post.format === 'story') {
      const [m] = publicMedia(post, ctx);
      container = await create(m.kind === 'video' ? { media_type: 'STORIES', video_url: m.url } : { media_type: 'STORIES', image_url: m.url });
    } else if (post.format === 'reel') {
      const [m] = publicMedia(post, ctx, { kinds: ['video'] });
      container = await create({ media_type: 'REELS', video_url: m.url, caption: ctx.text });
    } else {
      const media = publicMedia(post, ctx);
      if (media.length > 1) {
        const children = [];
        for (const m of media) { const id = await create(asMedia(m, { is_carousel_item: 'true' })); await waitForContainer(ctx, id); children.push(id); }
        container = await create({ media_type: 'CAROUSEL', children: children.join(','), caption: ctx.text });
      } else if (media[0].kind === 'video') {
        container = await create({ media_type: 'REELS', video_url: media[0].url, caption: ctx.text });
      } else container = await create({ image_url: media[0].url, caption: ctx.text });
    }
    await waitForContainer(ctx, container);
    const { data } = await call(ctx.fetch, `${base}/${ig}/media_publish`, { method: 'POST', form: { creation_id: container, access_token: ctx.token } });
    return { externalId: data.id };
  },
  dm: pageMessaging('instagram'),
};

// After Facebook Login: trade for a long-lived token, then find the Page and its Instagram account.
export async function connectMeta(tokens, ctx) {
  const base = G(ctx);
  const { data: ll } = await call(ctx.fetch, `${base}/oauth/access_token?grant_type=fb_exchange_token&client_id=${ctx.env.META_APP_ID}&client_secret=${ctx.env.META_APP_SECRET}&fb_exchange_token=${encodeURIComponent(tokens.access_token)}`);
  const fields = 'id,name,username,access_token,followers_count,instagram_business_account{id,username,name,biography,followers_count}';
  const { data } = await call(ctx.fetch, `${base}/me/accounts?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(ll.access_token)}`);
  const pages = data.data || [];
  const page = pages.find(p => p.id === ctx.env.META_PAGE_ID) || pages[0];
  if (!page) throw new Error('No Facebook Page was shared with Postboard. Log in again and pick a Page.');
  const out = [{ platform: 'facebook', externalId: page.id, handle: page.username || page.name, name: page.name, followers: page.followers_count || 0, secrets: { accessToken: page.access_token } }];
  const ig = page.instagram_business_account;
  if (ig) out.push({ platform: 'instagram', externalId: ig.id, handle: ig.username, name: ig.name || ig.username, bio: ig.biography || '', followers: ig.followers_count || 0, secrets: { accessToken: page.access_token, pageId: page.id } });
  return out;
}
