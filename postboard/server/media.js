import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fail } from './util.js';

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };
const MIME = Object.fromEntries(Object.entries(TYPES).map(([m, e]) => [e, m]));
export const MEDIA_NAME = /^[A-Za-z0-9_-]{16,64}\.(jpg|png|gif|webp|mp4|mov|webm)$/;
const MAX_BYTES = 25 * 1024 * 1024;

export function createMedia(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = name => path.join(dir, name);
  return {
    dir,
    mimeOf: name => MIME[name.split('.').pop()] || 'application/octet-stream',
    exists: name => MEDIA_NAME.test(name) && fs.existsSync(file(name)),
    path: name => MEDIA_NAME.test(name) ? file(name) : null,
    // Composer uploads arrive as data: URLs. Store them as files and keep a /media/ path in the post.
    saveDataUrl(dataUrl) {
      const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl);
      if (!m || !TYPES[m[1]]) fail(400, 'Upload a JPG, PNG, GIF, WebP, MP4, MOV or WebM file.');
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_BYTES) fail(413, 'Media files can be up to 25 MB.');
      const name = `${crypto.randomBytes(16).toString('base64url')}.${TYPES[m[1]]}`;
      fs.writeFileSync(file(name), buf);
      return `/media/${name}`;
    },
    async read(item) {
      const name = String(item.src || '').replace(/^\/media\//, '');
      if (!MEDIA_NAME.test(name)) throw new Error('That media file is missing.');
      return { buf: await fs.promises.readFile(file(name)), mime: MIME[name.split('.').pop()], name };
    },
  };
}
