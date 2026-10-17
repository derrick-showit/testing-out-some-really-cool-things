import crypto from 'node:crypto';

export const uid = () => crypto.randomBytes(9).toString('base64url');
export const now = () => Date.now();

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const fail = (status, message) => { throw new HttpError(status, message); };

export async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'That request is too large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const parseJson = (v, fallback) => { try { return v == null ? fallback : JSON.parse(v); } catch { return fallback; } };
export const str = (v, max) => String(v ?? '').slice(0, max);
export const uniq = a => [...new Set(a)];
export const arr = v => Array.isArray(v) ? v : [];
