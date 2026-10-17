import { hashPassword, verifyPassword, randomToken, sha256 } from './crypto.js';
import { uid, now, fail, str, parseCookies } from './util.js';

const SESSION_DAYS = 30;
const INVITE_DAYS = 7;
const COLORS = ['#2f45d8', '#c2410c', '#18804f', '#8b3fd1', '#0e7490', '#b45309', '#be185d', '#4d7c0f'];
export const COOKIE = 'pb_session';

export const publicUser = u => u && ({ id: u.id, name: u.name, email: u.email, role: u.role, color: u.color, isAdmin: !!u.is_admin, active: !!u.password_hash, lastSeenAt: u.last_seen_at });
export const listUsers = app => app.db.prepare('SELECT * FROM users ORDER BY created_at').all().map(publicUser);
export const userCount = app => app.db.prepare('SELECT COUNT(*) n FROM users').get().n;

function checkEmail(email) {
  const e = str(email, 200).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'Enter a valid email address.');
  return e;
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) fail(400, 'Use a password of at least 10 characters.');
  if (pw.length > 200) fail(400, 'That password is too long.');
  return pw;
}

export async function createUser(app, { email, name, role, password, isAdmin }) {
  const e = checkEmail(email);
  const n = str(name, 80).trim(); if (!n) fail(400, 'Enter a name.');
  if (app.db.prepare('SELECT 1 FROM users WHERE email = ?').get(e)) fail(409, 'Someone on the team already uses that email.');
  const id = uid();
  const hash = password ? await hashPassword(checkPassword(password)) : null;
  app.db.prepare('INSERT INTO users (id, email, name, role, color, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, e, n, str(role, 60).trim() || 'Member', COLORS[userCount(app) % COLORS.length], hash, isAdmin ? 1 : 0, now());
  return app.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function createSession(app, userId) {
  const token = randomToken();
  app.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now(), now() + SESSION_DAYS * 864e5);
  return token;
}
export function sessionCookie(app, token, maxAgeSec = SESSION_DAYS * 86400) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${app.config.secureCookies ? '; Secure' : ''}`;
}
export function userFromRequest(app, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = app.db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(sha256(token), now());
  if (row && (!row.last_seen_at || now() - row.last_seen_at > 60000)) app.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), row.id);
  return row || null;
}
export function destroySession(app, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) app.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

// Small in-memory limiter: 10 failed attempts per address per 15 minutes.
const attempts = new Map();
function limited(key) {
  const a = attempts.get(key); const t = now();
  if (!a || t - a.start > 15 * 60000) return false;
  return a.count >= 10;
}
function recordFailure(key) {
  const a = attempts.get(key); const t = now();
  if (!a || t - a.start > 15 * 60000) attempts.set(key, { start: t, count: 1 }); else a.count++;
}

export async function login(app, { email, password }, ip) {
  const key = `${ip}|${String(email).toLowerCase()}`;
  if (limited(key)) fail(429, 'Too many attempts. Wait 15 minutes and try again.');
  const u = app.db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  const ok = u?.password_hash && await verifyPassword(String(password || ''), u.password_hash);
  if (!ok) { recordFailure(key); fail(401, 'That email and password don’t match.'); }
  attempts.delete(key);
  return u;
}

export async function setupFirstAdmin(app, body) {
  if (userCount(app) > 0) fail(409, 'This workspace is already set up. Sign in instead.');
  return createUser(app, { ...body, role: body.role || 'Admin', isAdmin: true });
}

export async function invite(app, admin, body) {
  if (!admin.is_admin) fail(403, 'Only admins can invite teammates.');
  const u = await createUser(app, { email: body.email, name: body.name, role: body.role, isAdmin: !!body.isAdmin });
  return { user: u, url: newInviteLink(app, u.id) };
}
export function newInviteLink(app, userId) {
  const token = randomToken();
  app.db.prepare('DELETE FROM invites WHERE user_id = ?').run(userId);
  app.db.prepare('INSERT INTO invites (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, now() + INVITE_DAYS * 864e5);
  return `${app.config.publicUrl}/invite/${token}`;
}
export function inviteInfo(app, token) {
  const row = app.db.prepare('SELECT u.* FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ? AND i.expires_at > ?').get(sha256(String(token)), now());
  if (!row) fail(404, 'This invite link has expired or was already used. Ask an admin for a new one.');
  return row;
}
export async function acceptInvite(app, { token, password }) {
  const u = inviteInfo(app, token);
  const hash = await hashPassword(checkPassword(password));
  app.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, u.id);
  app.db.prepare('DELETE FROM invites WHERE user_id = ?').run(u.id);
  return app.db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
}
export async function changePassword(app, user, { current, next }) {
  if (!await verifyPassword(String(current || ''), user.password_hash)) fail(400, 'Your current password is wrong.');
  app.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(checkPassword(next)), user.id);
}
export function updateMember(app, admin, id, body) {
  if (!admin.is_admin && admin.id !== id) fail(403, 'Only admins can edit other teammates.');
  const u = app.db.prepare('SELECT * FROM users WHERE id = ?').get(id); if (!u) fail(404, 'No teammate with that id.');
  const name = 'name' in body ? str(body.name, 80).trim() || u.name : u.name;
  const role = 'role' in body ? str(body.role, 60).trim() || u.role : u.role;
  if ('color' in body && !/^#[0-9a-f]{6}$/i.test(String(body.color))) fail(400, 'Pick a color from the list.');
  const color = 'color' in body ? String(body.color).toLowerCase() : u.color;
  let isAdmin = u.is_admin;
  if ('isAdmin' in body && admin.is_admin) {
    isAdmin = body.isAdmin ? 1 : 0;
    if (!isAdmin && app.db.prepare('SELECT COUNT(*) n FROM users WHERE is_admin = 1 AND id != ?').get(id).n === 0) fail(400, 'The workspace needs at least one admin.');
  }
  app.db.prepare('UPDATE users SET name = ?, role = ?, color = ?, is_admin = ? WHERE id = ?').run(name, role, color, isAdmin, id);
  return app.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
export function removeMember(app, admin, id) {
  if (!admin.is_admin) fail(403, 'Only admins can remove teammates.');
  if (admin.id === id) fail(400, 'You can’t remove yourself.');
  app.db.prepare('DELETE FROM users WHERE id = ?').run(id);
}
