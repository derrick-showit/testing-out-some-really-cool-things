// Shared request helper for platform APIs. Throws an Error whose message is the API's own explanation.
export async function call(fetchFn, url, { method = 'GET', token, headers = {}, json, form, body } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload = body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
  else if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
  const res = await fetchFn(url, { method, headers: h, body: payload });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error?.error_user_msg || data?.detail || data?.message || data?.error_description
      || data?.title || (typeof data?.error === 'string' ? data.error : '') || data?.errors?.[0]?.message || text.slice(0, 200);
    const err = new Error(`${res.status} ${msg}`.trim());
    err.status = res.status; err.data = data;
    throw err;
  }
  return { data, headers: res.headers };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Media the network fetches by URL must live on a public https address.
export function publicMedia(post, ctx, { kinds = ['image', 'video'], min = 1, max = 10 } = {}) {
  const real = post.media.filter(m => m.src?.startsWith('/media/') && kinds.includes(m.kind));
  if (real.length < min) {
    if (post.media.some(m => m.kind === 'art')) throw new Error('Sample artwork can’t be posted. Upload a real image or video.');
    throw new Error(`This needs ${kinds.includes('image') ? 'an image' : 'a video'}${kinds.length > 1 ? ' or video' : ''}.`);
  }
  if (!/^https:\/\//.test(ctx.publicUrl) || /localhost|127\.0\.0\.1/.test(ctx.publicUrl)) {
    throw new Error('Set PUBLIC_URL to an https address the network can reach, so it can fetch your media.');
  }
  return real.slice(0, max).map(m => ({ ...m, url: ctx.publicUrl + m.src }));
}
