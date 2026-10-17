import { call, publicMedia } from './http.js';
const API = 'https://open.tiktokapis.com/v2';

export default {
  id: 'tiktok',
  oauth: 'tiktok',
  async profile(token, ctx) {
    const { data } = await call(ctx.fetch, `${API}/user/info/?fields=open_id,display_name,username,follower_count`, { token });
    const u = data.data.user;
    return { externalId: u.open_id, handle: u.username || u.display_name, name: u.display_name, followers: u.follower_count || 0 };
  },
  async publish(post, ctx) {
    if (post.format === 'story') throw new Error('TikTok’s API can’t post stories.');
    // Apps that haven't passed TikTok's audit may only post privately, so pick an allowed privacy level.
    const { data: info } = await call(ctx.fetch, `${API}/post/publish/creator_info/query/`, { method: 'POST', token: ctx.token, json: {} });
    const options = info.data?.privacy_level_options || ['SELF_ONLY'];
    const wanted = ctx.env.TIKTOK_PRIVACY || 'PUBLIC_TO_EVERYONE';
    const privacy = options.includes(wanted) ? wanted : options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0];
    const media = publicMedia(post, ctx, { max: 35 });
    if (media[0].kind === 'video') {
      const { data } = await call(ctx.fetch, `${API}/post/publish/video/init/`, {
        method: 'POST', token: ctx.token,
        json: { post_info: { title: ctx.text.slice(0, 2200), privacy_level: privacy }, source_info: { source: 'PULL_FROM_URL', video_url: media[0].url } },
      });
      return { externalId: data.data.publish_id, msg: `TikTok is processing the video (${privacy === 'SELF_ONLY' ? 'private until your app passes TikTok’s audit' : 'public'}).` };
    }
    const photos = media.filter(m => m.kind === 'image');
    const { data } = await call(ctx.fetch, `${API}/post/publish/content/init/`, {
      method: 'POST', token: ctx.token,
      json: {
        media_type: 'PHOTO', post_mode: 'DIRECT_POST',
        post_info: { title: (post.title || ctx.text).slice(0, 90), description: ctx.text.slice(0, 4000), privacy_level: privacy },
        source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: photos.map(m => m.url) },
      },
    });
    return { externalId: data.data.publish_id, msg: 'TikTok is processing the photos.' };
  },
  dm: { supported: false, reason: 'TikTok’s messaging API is limited to approved business partners, so TikTok messages can’t be answered here.' },
};
