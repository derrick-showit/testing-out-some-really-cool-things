import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { loadKey } from './crypto.js';
import { createHub } from './events.js';
import { createMedia } from './media.js';
import { HttpError, fail, readBody, parseJson } from './util.js';
import { PLATFORMS } from './format.js';
import * as auth from './auth.js';
import * as posts from './posts.js';
import * as chat from './chat.js';
import * as accounts from './accounts.js';
import * as oauth from './oauth.js';
import { listNotifications, markRead } from './notifications.js';
import { getWs, updateWorkspace } from './workspace.js';
import { createPublisher } from './publisher.js';
import { createInbox, DM_PLATFORMS } from './inbox.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INDEX = path.join(ROOT, 'index.html');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

// ---------- routes ----------
// Each route: [method, pattern, handler, options]. Handlers get { app, req, res, user, params, query, body }.
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, opts });
const PUBLIC = { public: true };

function bootstrap(app, user) {
  return {
    me: auth.publicUser(user),
    members: auth.listUsers(app),
    online: app.events.online(),
    accounts: accounts.publicAccounts(app),
    dmPlatforms: DM_PLATFORMS,
    labels: getWs(app, 'labels'), campaigns: getWs(app, 'campaigns'), settings: getWs(app, 'settings'),
    posts: posts.listPosts(app),
    notifications: listNotifications(app, user.id),
    chat: { channels: chat.listChannels(app, user) },
    inbox: { threads: app.inbox.list() },
    publicUrl: app.config.publicUrl,
  };
}

// auth
route('GET', '/api/auth/status', ({ app, req }) => {
  const user = auth.userFromRequest(app, req);
  return { setupNeeded: auth.userCount(app) === 0, user: auth.publicUser(user) };
}, PUBLIC);
route('POST', '/api/auth/setup', async ({ app, res, body }) => {
  const u = await auth.setupFirstAdmin(app, body);
  chat.ensureDefaultChannels(app, u.id);
  const ws = getWs(app, 'settings'); ws.defaultApprovers = [u.id]; updateWorkspace(app, { ...u, is_admin: 1 }, { settings: ws });
  res.setHeader('Set-Cookie', auth.sessionCookie(app, auth.createSession(app, u.id)));
  return { user: auth.publicUser(u) };
}, PUBLIC);
route('POST', '/api/auth/login', async ({ app, req, res, body }) => {
  const u = await auth.login(app, body, req.socket.remoteAddress);
  res.setHeader('Set-Cookie', auth.sessionCookie(app, auth.createSession(app, u.id)));
  return { user: auth.publicUser(u) };
}, PUBLIC);
route('POST', '/api/auth/logout', ({ app, req, res }) => {
  auth.destroySession(app, req);
  res.setHeader('Set-Cookie', auth.sessionCookie(app, '', 0));
  return { ok: true };
}, PUBLIC);
route('GET', '/api/auth/invite/:token', ({ app, params }) => {
  const u = auth.inviteInfo(app, params.token);
  return { name: u.name, email: u.email };
}, PUBLIC);
route('POST', '/api/auth/accept-invite', async ({ app, res, body }) => {
  const u = await auth.acceptInvite(app, body);
  res.setHeader('Set-Cookie', auth.sessionCookie(app, auth.createSession(app, u.id)));
  app.events.toAll({ type: 'members', members: auth.listUsers(app) });
  return { user: auth.publicUser(u) };
}, PUBLIC);
route('POST', '/api/me/password', async ({ app, user, body }) => { await auth.changePassword(app, user, body); return { ok: true }; });

route('GET', '/api/bootstrap', ({ app, user }) => bootstrap(app, user));

// live updates
route('GET', '/api/events', ({ app, req, res, user }) => {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  app.events.add(user.id, res);
  req.on('close', () => app.events.remove(user.id, res));
  return undefined;
}, { raw: true });

// members
route('POST', '/api/members', async ({ app, user, body }) => {
  const { user: u, url } = await auth.invite(app, user, body);
  app.events.toAll({ type: 'members', members: auth.listUsers(app) });
  return { member: auth.publicUser(u), inviteUrl: url };
});
route('POST', '/api/members/:id/invite', ({ app, user, params }) => {
  if (!user.is_admin) fail(403, 'Only admins can invite teammates.');
  const u = app.db.prepare('SELECT * FROM users WHERE id = ?').get(params.id); if (!u) fail(404, 'No teammate with that id.');
  if (u.password_hash) fail(409, `${u.name} has already joined.`);
  return { inviteUrl: auth.newInviteLink(app, u.id) };
});
route('PUT', '/api/members/:id', ({ app, user, params, body }) => {
  const u = auth.updateMember(app, user, params.id, body);
  app.events.toAll({ type: 'members', members: auth.listUsers(app) });
  return { member: auth.publicUser(u) };
});
route('DELETE', '/api/members/:id', ({ app, user, params }) => {
  auth.removeMember(app, user, params.id);
  app.events.toAll({ type: 'members', members: auth.listUsers(app) });
  return { ok: true };
});

// workspace
route('PUT', '/api/workspace', ({ app, user, body }) => updateWorkspace(app, user, body));

// posts
route('POST', '/api/posts', ({ app, user, body }) => ({ post: posts.createPost(app, user, body) }), { bigBody: true });
route('PUT', '/api/posts/:id', ({ app, user, params, body }) => ({ post: posts.updatePost(app, user, params.id, body) }), { bigBody: true });
route('DELETE', '/api/posts/:id', ({ app, user, params }) => { posts.deletePost(app, user, params.id); return { ok: true }; });
route('POST', '/api/posts/:id/request-approval', ({ app, user, params }) => ({ post: posts.requestApproval(app, user, params.id) }));
route('POST', '/api/posts/:id/decision', ({ app, user, params, body }) => ({ post: posts.decide(app, user, params.id, body.decision, body.note) }));
route('POST', '/api/posts/:id/schedule', ({ app, user, params }) => ({ post: posts.schedule(app, user, params.id) }));
route('POST', '/api/posts/:id/unschedule', ({ app, user, params }) => ({ post: posts.unschedule(app, user, params.id) }));
route('POST', '/api/posts/:id/publish', ({ app, user, params }) => ({ post: posts.startPublish(app, user, params.id) }));
route('POST', '/api/posts/:id/react', ({ app, user, params, body }) => ({ post: posts.react(app, user, params.id, body.kind) }));
route('POST', '/api/posts/:id/comments', ({ app, user, params, body }) => ({ post: posts.comment(app, user, params.id, body.text) }));

// notifications
route('POST', '/api/notifications/read', ({ app, user, body }) => { markRead(app, user.id, body.ids === 'all' ? 'all' : body.ids || []); return { ok: true }; });

// channels / accounts
route('GET', '/api/accounts', ({ app }) => ({ accounts: accounts.publicAccounts(app) }));
route('PUT', '/api/accounts/:platform', ({ app, user, params, body }) => ({ account: accounts.updateAccount(app, user, params.platform, body) }));
route('POST', '/api/accounts/:platform/disconnect', ({ app, user, params }) => { accounts.disconnect(app, user, params.platform); return { ok: true }; });
route('POST', '/api/accounts/discord/test', async ({ app, user }) => {
  if (!user.is_admin) fail(403, 'Only admins can test channels.');
  const ctx = await accounts.platformCtx(app, 'discord', { text: '**Postboard test**: this channel is connected.' });
  if (!ctx.account.secrets.webhook) fail(400, 'Add a Discord webhook URL first.');
  await (await import('./platforms/discord.js')).default.publish({ media: [] }, ctx);
  return { ok: true };
});
route('GET', '/api/oauth/:provider/start', ({ app, user, params, res }) => {
  let location;
  try { location = oauth.startUrl(app, user, params.provider); }
  catch (e) { location = `/?oauth_error=${encodeURIComponent(e.message)}#channels`; }
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location }); res.end();
}, { raw: true, redirectOnAuth: true });
route('GET', '/api/oauth/:provider/callback', async ({ app, user, params, query, res }) => {
  let target = '/#channels';
  try {
    const list = await oauth.finish(app, user, params.provider, query);
    for (const a of list) {
      const cur = accounts.getAccount(app, a.platform);
      accounts.saveAccount(app, { ...cur, ...a, enabled: true, secrets: { ...cur.secrets, ...a.secrets } });
    }
    app.events.toAll({ type: 'accounts', accounts: accounts.publicAccounts(app) });
    target = `/?connected=${encodeURIComponent(list.map(a => a.platform).join(','))}#channels`;
  } catch (e) {
    target = `/?oauth_error=${encodeURIComponent(String(e.message || e).slice(0, 300))}#channels`;
  }
  res.writeHead(302, { ...SECURITY_HEADERS, Location: target }); res.end();
}, { raw: true, redirectOnAuth: true });

// team chat
route('GET', '/api/chat/channels', ({ app, user }) => ({ channels: chat.listChannels(app, user) }));
route('POST', '/api/chat/channels', ({ app, user, body }) => ({ channel: body.with ? chat.openDirect(app, user, body.with) : chat.createChannel(app, user, body.name) }));
route('GET', '/api/chat/channels/:id/messages', ({ app, user, params, query }) => ({ messages: chat.messages(app, user, params.id, query.before) }));
route('POST', '/api/chat/channels/:id/messages', ({ app, user, params, body }) => ({ message: chat.postMessage(app, user, params.id, body.body) }));
route('POST', '/api/chat/channels/:id/read', ({ app, user, params }) => { chat.markRead(app, user, params.id); return { ok: true }; });

// social inbox
route('GET', '/api/inbox/threads', ({ app, query }) => ({ threads: app.inbox.list(query) }));
route('GET', '/api/inbox/threads/:id/messages', ({ app, params }) => ({ messages: app.inbox.messages(params.id) }));
route('POST', '/api/inbox/threads/:id/reply', async ({ app, user, params, body }) => ({ message: await app.inbox.reply(user, params.id, body.body) }));
route('POST', '/api/inbox/threads/:id/read', ({ app, params }) => { app.inbox.markRead(params.id); return { ok: true }; });
route('PUT', '/api/inbox/threads/:id', ({ app, user, params, body }) => ({ thread: app.inbox.update(user, params.id, body) }));
route('POST', '/api/inbox/sync', async ({ app }) => ({ result: await app.inbox.sync() }));
// Sandbox helper: lets an admin drop in a test message from a customer on a channel that isn't live.
route('POST', '/api/inbox/simulate', ({ app, user, body }) => {
  if (!user.is_admin) fail(403, 'Only admins can add test messages.');
  if (!DM_PLATFORMS.includes(body.platform)) fail(400, 'That network doesn’t support messages here.');
  if (accounts.mode(app, accounts.getAccount(app, body.platform), 'dm') === 'live') fail(409, 'This channel is live, so test messages are turned off.');
  const name = String(body.name || 'Test customer').slice(0, 80);
  const r = app.inbox.record(body.platform, {
    threadExternalId: `sandbox-${body.platform}-${name.toLowerCase().replace(/\W+/g, '-')}`, sandbox: true,
    contact: { id: null, name, handle: body.handle ? String(body.handle).slice(0, 80) : '' },
    message: { direction: 'in', body: String(body.text || 'Hi! Is this thing on?').slice(0, 2000), at: Date.now() },
  });
  return { thread: r && app.inbox.shapeThread(r.thread) };
});

// webhooks (signed by the platform, so no session or CSRF header)
route('GET', '/webhooks/meta', ({ app, query, res }) => {
  const token = app.config.env.META_VERIFY_TOKEN;
  if (query['hub.mode'] === 'subscribe' && token && query['hub.verify_token'] === token) { send(res, 200, String(query['hub.challenge'] || '')); return; }
  send(res, 403, 'Verification failed');
}, { raw: true, public: true });
route('POST', '/webhooks/meta', async ({ app, req, res, rawBody }) => {
  if (!app.inbox.verifyMeta(rawBody, req.headers['x-hub-signature-256'])) { send(res, 401, 'Bad signature'); return; }
  send(res, 200, 'EVENT_RECEIVED'); // acknowledge fast; Meta retries slow endpoints
  try { await app.inbox.handleMeta(JSON.parse(rawBody.toString('utf8'))); } catch (e) { console.warn('meta webhook error', e.message); }
}, { raw: true, public: true, webhook: true });

// ---------- request handling ----------
async function serveMedia(app, req, res, name) {
  const file = app.media.path(name);
  if (!file || !fs.existsSync(file)) return send(res, 404, 'Not found');
  const stat = fs.statSync(file);
  const type = app.media.mimeOf(name);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const headers = { ...SECURITY_HEADERS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' };
  if (range) {
    const start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (!(start >= 0 && start <= end)) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
}

async function handle(app, req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html' || p.startsWith('/invite/'))) {
      return send(res, 200, fs.readFileSync(INDEX), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
    }
    if (req.method === 'GET' && p.startsWith('/media/')) return serveMedia(app, req, res, p.slice(7));
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

    const r = routes.find(x => x.method === req.method && x.re.test(p));
    if (!r) {
      if (routes.some(x => x.re.test(p))) return send(res, 405, { error: 'Method not allowed.' });
      return send(res, 404, p.startsWith('/api/') ? { error: 'Not found.' } : 'Not found');
    }
    const params = r.re.exec(p).groups || {};
    const query = Object.fromEntries(url.searchParams);
    const user = auth.userFromRequest(app, req);
    if (!r.opts.public && !user) {
      if (r.opts.redirectOnAuth) { res.writeHead(302, { Location: '/' }); return res.end(); }
      return send(res, 401, { error: 'Sign in to continue.' });
    }
    // Mutating API calls must carry this header. Browsers won't send it cross-site without CORS, which we never allow.
    if (req.method !== 'GET' && !r.opts.webhook && req.headers['x-postboard'] !== '1') return send(res, 403, { error: 'Missing request header.' });

    let body = {}, rawBody = null;
    if (req.method !== 'GET') {
      rawBody = await readBody(req, r.opts.bigBody ? 300 * 1024 * 1024 : 2 * 1024 * 1024);
      if (!r.opts.webhook && rawBody.length) {
        body = parseJson(rawBody.toString('utf8'), null);
        if (!body || typeof body !== 'object') fail(400, 'Send a JSON body.');
      }
    }
    const out = await r.handler({ app, req, res, user, params, query, body, rawBody });
    if (!r.opts.raw) send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server. Check its log for details.' });
  }
}

export async function createApp(opts = {}) {
  const config = loadConfig(opts);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const app = {
    config,
    db: openDb(opts.dbFile || path.join(config.dataDir, 'postboard.db')),
    key: loadKey(config.dataDir, config.secret),
    fetch: opts.fetch || globalThis.fetch,
    events: createHub(),
    media: createMedia(path.join(config.dataDir, 'media')),
  };
  app.publisher = createPublisher(app);
  app.inbox = createInbox(app);
  if (config.background) { app.publisher.start(); app.inbox.start(); }
  const server = http.createServer((req, res) => handle(app, req, res));
  server.requestTimeout = 0; // event streams stay open
  return {
    app, server,
    listen: (port = config.port, host = config.host) => new Promise(resolve => server.listen(port, host, () => resolve(server.address()))),
    async close() {
      app.publisher.stop(); app.inbox.stop(); app.events.close();
      await new Promise(r => server.close(r)); server.closeAllConnections?.();
      app.db.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { listen, app } = await createApp();
  const addr = await listen();
  const live = Object.keys(PLATFORMS).filter(p => accounts.mode(app, accounts.getAccount(app, p)) === 'live');
  console.log(`Postboard is running at http://${addr.address === '127.0.0.1' ? 'localhost' : addr.address}:${addr.port}`);
  console.log(`Public URL: ${app.config.publicUrl}${live.length ? ` · live channels: ${live.join(', ')}` : ' · no live channels yet (sends are sandboxed)'}`);
  if (auth.userCount(app) === 0) console.log('No accounts yet. Open the app to create the first admin, or run `npm run seed` for demo data.');
}

