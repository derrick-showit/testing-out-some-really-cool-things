import { call } from './http.js';

// LinkedIn versions its REST API by month and retires versions after about a year,
// so default to two months back unless LINKEDIN_VERSION pins one.
function version(env) {
  if (env.LINKEDIN_VERSION) return env.LINKEDIN_VERSION;
  const d = new Date(); d.setMonth(d.getMonth() - 2);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// Commentary uses LinkedIn's "little text" format, where these characters must be escaped.
const escapeLittle = s => s.replace(/[\\|{}@[\]()<>#*_~]/g, c => '\\' + c);

export default {
  id: 'linkedin',
  oauth: 'linkedin',
  async profile(token, ctx) {
    const { data } = await call(ctx.fetch, 'https://api.linkedin.com/v2/userinfo', { token });
    return { externalId: data.sub, handle: data.name, name: data.name };
  },
  async publish(post, ctx) {
    const author = ctx.env.LINKEDIN_ORG_ID ? `urn:li:organization:${ctx.env.LINKEDIN_ORG_ID}` : `urn:li:person:${ctx.account.externalId}`;
    const headers = { 'LinkedIn-Version': version(ctx.env), 'X-Restli-Protocol-Version': '2.0.0' };
    const body = {
      author, commentary: escapeLittle(ctx.text), visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    };
    const image = post.media.find(m => m.kind === 'image' && m.src?.startsWith('/media/'));
    if (image) {
      const { data } = await call(ctx.fetch, 'https://api.linkedin.com/rest/images?action=initializeUpload', { method: 'POST', token: ctx.token, headers, json: { initializeUploadRequest: { owner: author } } });
      const { buf, mime } = await ctx.readMedia(image);
      const up = await ctx.fetch(data.value.uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': mime }, body: buf });
      if (!up.ok) throw new Error(`LinkedIn rejected the image upload (${up.status}).`);
      body.content = { media: { id: data.value.image } };
    }
    const { headers: h } = await call(ctx.fetch, 'https://api.linkedin.com/rest/posts', { method: 'POST', token: ctx.token, headers, json: body });
    const id = h.get('x-restli-id');
    return { externalId: id, url: id ? `https://www.linkedin.com/feed/update/${id}` : undefined };
  },
  dm: { supported: false, reason: 'LinkedIn only opens its messaging API to approved partners, so LinkedIn messages can’t be answered here.' },
};
