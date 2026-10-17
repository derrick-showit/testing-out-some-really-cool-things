import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApp } from '../server/server.js';
import { saveAccount, getAccount } from '../server/accounts.js';
import { seed } from '../server/seed.js';

// A fake network: records every outbound call and answers by URL.
const calls = [];
const replies = [];
const fakeFetch = async (url, init = {}) => {
  url = String(url);
  calls.push({ url, init });
  const r = replies.find(x => x.match.test(url) && (!x.method || x.method === (init.method || 'GET')));
  if (!r) return new Response(JSON.stringify({ error: { message: `no fake for ${url}` } }), { status: 500 });
  const body = typeof r.body === 'function' ? r.body(url, init) : r.body;
  return new Response(JSON.stringify(body), { status: r.status || 200, headers: r.headers || {} });
};
const fake = (match, body, extra = {}) => replies.unshift({ match, body, ...extra });

let srv, base, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postboard-'));
  srv = await createApp({ dataDir: dir, port: 0, publicUrl: 'https://postboard.example', background: false, fetch: fakeFetch,
    env: { META_APP_SECRET: 'meta-secret', META_VERIFY_TOKEN: 'verify-me', X_CLIENT_ID: 'xid', X_CLIENT_SECRET: 'xsecret' } });
  srv.app.config.pollMs = 1;
  const addr = await srv.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${addr.port}`;
});
after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

// A tiny client that keeps its own session cookie, like one browser per teammate.
function client() {
  let cookie = '';
  const req = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { 'Content-Type': 'application/json', 'X-Postboard': '1', ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  };
  return { get: p => req('GET', p), post: (p, b = {}, h) => req('POST', p, b, h), put: (p, b) => req('PUT', p, b), del: p => req('DELETE', p), cookie: () => cookie };
}

const admin = client(), maya = client(), outsider = client();
let ids = {};

test('first admin sets up the workspace, then setup is closed', async () => {
  assert.equal((await admin.get('/api/auth/status')).data.setupNeeded, true);
  const r = await admin.post('/api/auth/setup', { name: 'Derrick', email: 'derrick@example.com', password: 'correct horse battery' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.match(r.headers.get('set-cookie'), /Secure/); // PUBLIC_URL is https
  ids.derrick = r.data.user.id;
  assert.equal((await client().post('/api/auth/setup', { name: 'X', email: 'x@example.com', password: 'another password' })).status, 409);
});

test('admins invite teammates, who set their own password', async () => {
  const inv = await admin.post('/api/members', { name: 'Maya Chen', email: 'maya@example.com', role: 'Brand lead' });
  assert.equal(inv.status, 200);
  const token = inv.data.inviteUrl.split('/invite/')[1];
  assert.equal((await maya.get(`/api/auth/invite/${token}`)).data.name, 'Maya Chen');
  assert.equal((await maya.post('/api/auth/accept-invite', { token, password: 'short' })).status, 400);
  const ok = await maya.post('/api/auth/accept-invite', { token, password: 'maya has a long password' });
  assert.equal(ok.status, 200);
  ids.maya = ok.data.user.id;
  assert.equal((await client().post('/api/auth/accept-invite', { token, password: 'reuse the link again' })).status, 404);
  // a member can't invite
  assert.equal((await maya.post('/api/members', { name: 'Nope', email: 'nope@example.com' })).status, 403);
  const inv2 = await admin.post('/api/members', { name: 'Olu Ade', email: 'olu@example.com' });
  await outsider.post('/api/auth/accept-invite', { token: inv2.data.inviteUrl.split('/invite/')[1], password: 'olu has a long password' });
});

test('login checks the password, rate limits, and logout ends the session', async () => {
  const c = client();
  assert.equal((await c.post('/api/auth/login', { email: 'maya@example.com', password: 'wrong password!!' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'MAYA@example.com', password: 'maya has a long password' })).status, 200);
  assert.equal((await c.get('/api/bootstrap')).status, 200);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/bootstrap')).status, 401);
  const d = client();
  for (let i = 0; i < 10; i++) await d.post('/api/auth/login', { email: 'olu@example.com', password: 'bad password ' + i });
  assert.equal((await d.post('/api/auth/login', { email: 'olu@example.com', password: 'olu has a long password' })).status, 429);
});

test('mutations without the Postboard header are refused', async () => {
  const r = await admin.post('/api/posts', { title: 'x' }, { 'X-Postboard': '' });
  assert.equal(r.status, 403);
});

test('approval flow: request, only approvers decide, approval schedules the post', async () => {
  await admin.put('/api/accounts/x', { enabled: true, handle: 'brand' });
  const when = Date.now() + 3600e3;
  const p = (await admin.post('/api/posts', { title: 'Launch', body: '**Big** news', channels: ['x'], scheduledAt: when, approval: { approvers: [ids.maya] } })).data.post;
  assert.equal(p.status, 'draft');
  assert.equal(p.approval.required, true); // workspace requires approval by default
  assert.equal((await admin.post(`/api/posts/${p.id}/schedule`)).status, 409);
  assert.equal((await admin.post(`/api/posts/${p.id}/request-approval`)).data.post.status, 'in_review');
  assert.equal((await outsider.post(`/api/posts/${p.id}/decision`, { decision: 'approved' })).status, 403);
  const boot = await maya.get('/api/bootstrap');
  assert.ok(boot.data.notifications.some(n => /asked you to approve/.test(n.text)));
  const done = await maya.post(`/api/posts/${p.id}/decision`, { decision: 'approved' });
  assert.equal(done.data.post.status, 'scheduled');
  // editing the content after approval sends it back to review
  const edited = await admin.put(`/api/posts/${p.id}`, { body: '**Bigger** news' });
  assert.equal(edited.data.post.status, 'in_review');
  assert.deepEqual(edited.data.post.approval.decisions, {});
  ids.post = p.id;
});

test('sandbox channels record a send without calling the network', async () => {
  await maya.post(`/api/posts/${ids.post}/decision`, { decision: 'approved' });
  calls.length = 0;
  const r = await admin.post(`/api/posts/${ids.post}/publish`);
  assert.equal(r.data.post.status, 'publishing');
  await new Promise(res => setTimeout(res, 50));
  const p = (await admin.get('/api/bootstrap')).data.posts.find(x => x.id === ids.post);
  assert.equal(p.status, 'published');
  assert.equal(p.results.x.live, false);
  assert.equal(calls.length, 0);
  assert.equal((await admin.put(`/api/posts/${ids.post}`, { body: 'too late' })).status, 409);
});

test('live X publish sends Unicode bold text with the stored token', async () => {
  saveAccount(srv.app, { ...getAccount(srv.app, 'x'), enabled: true, externalId: '42', handle: 'brand', secrets: { accessToken: 'x-token' } });
  fake(/api\.x\.com\/2\/tweets$/, { data: { id: '1001' } }, { method: 'POST' });
  const p = (await admin.post('/api/posts', { title: 'T', body: '**Hi** there', channels: ['x'], approval: { approvers: [ids.maya] } })).data.post;
  await admin.post(`/api/posts/${p.id}/request-approval`);
  await maya.post(`/api/posts/${p.id}/decision`, { decision: 'approved' });
  calls.length = 0;
  await admin.post(`/api/posts/${p.id}/publish`);
  await new Promise(res => setTimeout(res, 50));
  const call = calls.find(c => c.url.endsWith('/2/tweets'));
  assert.equal(call.init.headers.Authorization, 'Bearer x-token');
  assert.equal(JSON.parse(call.init.body).text, '𝗛𝗶 there');
  const after = (await admin.get('/api/bootstrap')).data.posts.find(x => x.id === p.id);
  assert.equal(after.results.x.url, 'https://x.com/brand/status/1001');
});

test('team likes, reposts and comments with @mentions notify teammates', async () => {
  const r = await maya.post(`/api/posts/${ids.post}/react`, { kind: 'like' });
  assert.deepEqual(r.data.post.likes, [ids.maya]);
  await maya.post(`/api/posts/${ids.post}/react`, { kind: 'repost' });
  await maya.post(`/api/posts/${ids.post}/comments`, { text: 'Nice one @Derrick' });
  const n = (await admin.get('/api/bootstrap')).data.notifications;
  assert.ok(n.some(x => /mentioned you/.test(x.text)));
  assert.ok(n.some(x => /will repost/.test(x.text)));
});

test('team chat: channels are shared, direct messages are private', async () => {
  const chans = (await admin.get('/api/chat/channels')).data.channels;
  const general = chans.find(c => c.name === 'general');
  assert.ok(general);
  await admin.post(`/api/chat/channels/${general.id}/messages`, { body: 'Hello team @Maya' });
  const mayaView = (await maya.get('/api/chat/channels')).data.channels.find(c => c.id === general.id);
  assert.equal(mayaView.unread, 1);
  assert.equal((await maya.get(`/api/chat/channels/${general.id}/messages`)).data.messages.at(-1).body, 'Hello team @Maya');
  assert.ok((await maya.get('/api/bootstrap')).data.notifications.some(n => /mentioned you in #general/.test(n.text)));
  await maya.post(`/api/chat/channels/${general.id}/read`);
  assert.equal((await maya.get('/api/chat/channels')).data.channels.find(c => c.id === general.id).unread, 0);

  const dm = (await admin.post('/api/chat/channels', { with: ids.maya })).data.channel;
  assert.equal(dm.kind, 'dm');
  assert.equal((await maya.post('/api/chat/channels', { with: ids.derrick })).data.channel.id, dm.id); // same conversation
  await maya.post(`/api/chat/channels/${dm.id}/messages`, { body: 'just us' });
  assert.equal((await outsider.get(`/api/chat/channels/${dm.id}/messages`)).status, 403);
  assert.equal((await outsider.post(`/api/chat/channels/${dm.id}/messages`, { body: 'hi' })).status, 403);
  assert.ok(!(await outsider.get('/api/chat/channels')).data.channels.some(c => c.id === dm.id));
  assert.equal((await admin.post('/api/chat/channels', { name: 'Launch Team!' })).data.channel.name, 'launch-team');
});

test('chat messages arrive live over the event stream', async () => {
  const ctrl = new AbortController();
  const res = await fetch(base + '/api/events', { headers: { Cookie: maya.cookie() }, signal: ctrl.signal });
  const reader = res.body.getReader();
  const general = (await admin.get('/api/chat/channels')).data.channels.find(c => c.name === 'general');
  await admin.post(`/api/chat/channels/${general.id}/messages`, { body: 'live!' });
  let text = '';
  while (!text.includes('live!')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /"type":"chat"/);
  ctrl.abort();
});

test('sandbox DMs: replies are recorded, unsupported networks refuse', async () => {
  const t = (await admin.post('/api/inbox/simulate', { platform: 'instagram', name: 'Tess', text: 'Oat milk?' })).data.thread;
  assert.equal(t.unread, 1);
  const m = (await maya.post(`/api/inbox/threads/${t.id}/reply`, { body: 'Yes, all day!' })).data.message;
  assert.equal(m.delivery, 'sandbox');
  assert.equal(m.sentBy, ids.maya);
  assert.equal((await admin.post('/api/inbox/simulate', { platform: 'linkedin', text: 'hi' })).status, 400);
  const assigned = (await admin.put(`/api/inbox/threads/${t.id}`, { assignedTo: ids.maya, status: 'done' })).data.thread;
  assert.equal(assigned.assignedTo, ids.maya);
  assert.equal(assigned.status, 'done');
  const r = srv.app.inbox.record('linkedin', { threadExternalId: 'li-1', message: { direction: 'in', body: 'hello' } });
  assert.match((await admin.post(`/api/inbox/threads/${r.thread.id}/reply`, { body: 'hi' })).data.error, /approved partners/);
});

test('Meta webhook: bad signatures are rejected, good ones create threads', async () => {
  const payload = JSON.stringify({ object: 'instagram', entry: [{ messaging: [{ sender: { id: 'IGSID1' }, recipient: { id: 'IG1' }, timestamp: Date.now(), message: { mid: 'mid.1', text: 'Are you open Sunday?' } }] }] });
  const bad = await fetch(base + '/webhooks/meta', { method: 'POST', body: payload, headers: { 'X-Hub-Signature-256': 'sha256=00' } });
  assert.equal(bad.status, 401);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'meta-secret').update(payload).digest('hex');
  const good = await fetch(base + '/webhooks/meta', { method: 'POST', body: payload, headers: { 'X-Hub-Signature-256': sig } });
  assert.equal(good.status, 200);
  await new Promise(res => setTimeout(res, 30));
  const thread = (await admin.get('/api/inbox/threads?platform=instagram')).data.threads.find(t => t.contact.id === 'IGSID1');
  assert.equal(thread.lastText, 'Are you open Sunday?');
  // the same delivery twice doesn't duplicate
  await fetch(base + '/webhooks/meta', { method: 'POST', body: payload, headers: { 'X-Hub-Signature-256': sig } });
  await new Promise(res => setTimeout(res, 30));
  assert.equal((await admin.get(`/api/inbox/threads/${thread.id}/messages`)).data.messages.length, 1);
  const verify = await fetch(base + '/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=abc');
  assert.equal(await verify.text(), 'abc');
  ids.igThread = thread.id;
});

test('Instagram replies go to the Page messages API and respect the 24-hour window', async () => {
  saveAccount(srv.app, { ...getAccount(srv.app, 'instagram'), enabled: true, externalId: 'IG1', secrets: { accessToken: 'page-token', pageId: 'PAGE1' } });
  fake(/graph\.facebook\.com\/v23\.0\/PAGE1\/messages/, { message_id: 'm_out_1' }, { method: 'POST' });
  calls.length = 0;
  const m = (await maya.post(`/api/inbox/threads/${ids.igThread}/reply`, { body: 'Yes, 8 to 3!' })).data.message;
  assert.equal(m.delivery, 'sent');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { recipient: { id: 'IGSID1' }, message: { text: 'Yes, 8 to 3!' }, messaging_type: 'RESPONSE' });
  // two days later: human agent tag; ten days later: closed
  srv.app.db.prepare('UPDATE dm_threads SET last_inbound_at = ? WHERE id = ?').run(Date.now() - 2 * 864e5, ids.igThread);
  calls.length = 0;
  await maya.post(`/api/inbox/threads/${ids.igThread}/reply`, { body: 'Following up' });
  assert.equal(JSON.parse(calls[0].init.body).tag, 'HUMAN_AGENT');
  srv.app.db.prepare('UPDATE dm_threads SET last_inbound_at = ? WHERE id = ?').run(Date.now() - 10 * 864e5, ids.igThread);
  assert.equal((await maya.post(`/api/inbox/threads/${ids.igThread}/reply`, { body: 'Too late' })).status, 409);
});

test('X DMs sync from the API and replies post to the conversation', async () => {
  fake(/api\.x\.com\/2\/dm_events/, {
    data: [{ id: 'e1', text: 'Is the open house kid friendly?', created_at: new Date().toISOString(), sender_id: '77', dm_conversation_id: '42-77' }],
    includes: { users: [{ id: '77', name: 'Ricardo', username: 'ricardo_m' }] },
  });
  fake(/dm_conversations\/42-77\/messages/, { data: { dm_event_id: 'e2' } }, { method: 'POST' });
  const r = await srv.app.inbox.sync({ force: true });
  assert.equal(r.x.added, 1);
  const t = (await admin.get('/api/inbox/threads?platform=x')).data.threads[0];
  assert.equal(t.contact.handle, '@ricardo_m');
  const m = (await admin.post(`/api/inbox/threads/${t.id}/reply`, { body: 'Absolutely!' })).data.message;
  assert.equal(m.delivery, 'sent');
  assert.equal((await srv.app.inbox.sync({ force: true })).x.added, 0); // no duplicates on the next poll
});

test('a failed network send is kept with the error', async () => {
  fake(/dm_conversations\/42-77\/messages/, { title: 'Forbidden', detail: 'You are not permitted to DM this user.' }, { method: 'POST', status: 403 });
  const t = (await admin.get('/api/inbox/threads?platform=x')).data.threads[0];
  const m = (await admin.post(`/api/inbox/threads/${t.id}/reply`, { body: 'Hello?' })).data.message;
  assert.equal(m.delivery, 'failed');
  assert.match(m.error, /not permitted/);
});

test('uploaded media is stored as a file and served back', async () => {
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201ffa3a4a90000000049454e44ae426082', 'hex').toString('base64');
  const p = (await admin.post('/api/posts', { title: 'Pic', body: 'x', channels: ['instagram'], media: [{ kind: 'image', src: png }] })).data.post;
  assert.match(p.media[0].src, /^\/media\/[\w-]+\.png$/);
  const res = await fetch(base + p.media[0].src);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(base + '/media/../server/server.js')).status, 404);
});

test('scheduled posts go out on the scheduler tick', async () => {
  await admin.put('/api/workspace', { settings: { requireApproval: false, defaultApprovers: [] } });
  await admin.put('/api/accounts/threads', { enabled: true });
  const p = (await admin.post('/api/posts', { title: 'Tick', body: 'hello', channels: ['threads'], scheduledAt: Date.now() + 60000, approval: { required: false } })).data.post;
  assert.equal((await admin.post(`/api/posts/${p.id}/schedule`)).data.post.status, 'scheduled');
  srv.app.db.prepare('UPDATE posts SET scheduled_at = ? WHERE id = ?').run(Date.now() - 1000, p.id);
  srv.app.publisher.tick();
  await new Promise(res => setTimeout(res, 50));
  assert.equal((await admin.get('/api/bootstrap')).data.posts.find(x => x.id === p.id).status, 'published');
});

test('OAuth start sends admins to the provider with PKCE and state', async () => {
  const r = await admin.get('/api/oauth/x/start');
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://postboard.example/api/oauth/x/callback');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(loc.searchParams.get('state'));
  const bad = await admin.get('/api/oauth/x/callback?code=abc&state=wrong');
  assert.match(decodeURIComponent(bad.headers.get('location')), /expired/);
  const notAdmin = await maya.get('/api/oauth/x/start');
  assert.match(decodeURIComponent(notAdmin.headers.get('location')), /Only admins/);
});

test('channel tokens are encrypted at rest', () => {
  const row = srv.app.db.prepare("SELECT secrets FROM accounts WHERE platform = 'x'").get();
  assert.ok(!row.secrets.includes('x-token'));
});

test('the demo seed builds a full workspace', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'postboard-seed-'));
  const s = await createApp({ dataDir: d, background: false, env: {} });
  const r = await seed(s.app, { password: 'demo password 123' });
  assert.equal(r.emails.length, 4);
  assert.equal(s.app.db.prepare('SELECT COUNT(*) n FROM posts').get().n, 15);
  assert.ok(s.app.inbox.list().length >= 5);
  await s.close(); fs.rmSync(d, { recursive: true, force: true });
});
