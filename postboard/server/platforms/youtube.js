import { call } from './http.js';

export default {
  id: 'youtube',
  oauth: 'youtube',
  async profile(token, ctx) {
    const { data } = await call(ctx.fetch, 'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { token });
    const c = data.items?.[0]; if (!c) throw new Error('That Google account has no YouTube channel.');
    return { externalId: c.id, handle: c.snippet.customUrl || c.snippet.title, name: c.snippet.title, bio: c.snippet.description || '', followers: Number(c.statistics?.subscriberCount || 0) };
  },
  async publish(post, ctx) {
    if (post.format !== 'reel') throw new Error('YouTube’s API can’t create community posts. Use the Reel / Short format with a video.');
    const video = post.media.find(m => m.kind === 'video' && m.src?.startsWith('/media/'));
    if (!video) throw new Error('YouTube Shorts need an uploaded video.');
    const { buf, mime } = await ctx.readMedia(video);
    const description = /#shorts/i.test(ctx.text) ? ctx.text : `${ctx.text}\n\n#Shorts`;
    const meta = {
      snippet: { title: (post.title || ctx.text).slice(0, 100) || 'Short', description: description.slice(0, 5000), categoryId: '22' },
      status: { privacyStatus: ctx.env.YOUTUBE_PRIVACY || 'public', selfDeclaredMadeForKids: false },
    };
    // Resumable upload: start a session, then send the bytes to the URL it returns.
    const start = await ctx.fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(buf.length) },
      body: JSON.stringify(meta),
    });
    if (!start.ok) throw new Error(`YouTube refused the upload (${start.status}): ${(await start.text()).slice(0, 200)}`);
    const { data } = await call(ctx.fetch, start.headers.get('location'), { method: 'PUT', headers: { 'Content-Type': mime }, body: buf });
    return { externalId: data.id, url: `https://youtube.com/shorts/${data.id}` };
  },
  dm: { supported: false, reason: 'YouTube doesn’t have direct messages.' },
};
