// Mirrors the formatting rules in index.html so server sends match the composer preview.
export const PLATFORMS = {
  instagram: { name: 'Instagram', limit: 2200, formats: ['post', 'reel', 'story'], needsMedia: true },
  linkedin: { name: 'LinkedIn', limit: 3000, formats: ['post'] },
  x: { name: 'X', limit: 280, formats: ['post'], weighted: true },
  tiktok: { name: 'TikTok', limit: 2200, formats: ['post', 'reel', 'story'], needsMedia: true },
  facebook: { name: 'Facebook', limit: 63206, formats: ['post', 'reel', 'story'] },
  threads: { name: 'Threads', limit: 500, formats: ['post'] },
  discord: { name: 'Discord', limit: 2000, formats: ['post'], markdown: true },
  youtube: { name: 'YouTube', limit: 5000, formats: ['post', 'reel'] },
};
export const FORMATS = { post: 'Feed post', reel: 'Reel / Short', story: 'Story' };

export function segments(src) {
  const out = []; const re = /\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|(?<![\w])_([^_\n]+?)_(?![\w])/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: src.slice(last, m.index) });
    if (m[1] != null) out.push({ t: m[1], b: 1, i: 1 });
    else if (m[2] != null) out.push({ t: m[2], b: 1 });
    else out.push({ t: m[3] ?? m[4], i: 1 });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ t: src.slice(last) });
  return out;
}
function styleChar(c, b, i) {
  const cp = c.codePointAt(0); const up = cp >= 65 && cp <= 90, lo = cp >= 97 && cp <= 122, dg = cp >= 48 && cp <= 57;
  const base = b && i ? [0x1D63C, 0x1D656, 0x1D7EC] : b ? [0x1D5D4, 0x1D5EE, 0x1D7EC] : [0x1D608, 0x1D622, 0];
  if (up) return String.fromCodePoint(base[0] + cp - 65);
  if (lo) return String.fromCodePoint(base[1] + cp - 97);
  if (dg && base[2]) return String.fromCodePoint(base[2] + cp - 48);
  return c;
}
export function textFor(body, ch) {
  if (PLATFORMS[ch]?.markdown) return body;
  return segments(body).map(s => (s.b || s.i) ? [...s.t].map(c => styleChar(c, s.b, s.i)).join('') : s.t).join('');
}
export function countFor(text, ch) {
  if (!PLATFORMS[ch].weighted) return [...text].length;
  let n = 0; let t = text;
  (text.match(/https?:\/\/\S+/g) || []).forEach(u => { t = t.replace(u, ''); n += 23; });
  for (const c of t) { const cp = c.codePointAt(0); n += (cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247)) ? 1 : 2; }
  return n;
}
