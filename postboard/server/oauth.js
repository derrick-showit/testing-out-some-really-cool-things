import crypto from 'node:crypto';
import { randomToken } from './crypto.js';
import { now, fail } from './util.js';
import { call } from './platforms/http.js';
import { ADAPTERS } from './platforms/index.js';
import { connectMeta } from './platforms/meta.js';

const metaVer = env => env.META_GRAPH_VERSION || 'v23.0';

// One entry per login provider. Meta covers both Facebook and Instagram.
export const PROVIDERS = {
  x: {
    platforms: ['x'], idEnv: 'X_CLIENT_ID', secretEnv: 'X_CLIENT_SECRET',
    authorize: () => 'https://x.com/i/oauth2/authorize', token: () => 'https://api.x.com/2/oauth2/token',
    scope: () => 'tweet.read tweet.write users.read dm.read dm.write media.write offline.access', pkce: true, basicAuth: true,
  },
  meta: {
    platforms: ['facebook', 'instagram'], idEnv: 'META_APP_ID', secretEnv: 'META_APP_SECRET',
    authorize: env => `https://www.facebook.com/${metaVer(env)}/dialog/oauth`, token: env => `https://graph.facebook.com/${metaVer(env)}/oauth/access_token`,
    scope: () => 'pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_metadata,pages_messaging,instagram_basic,instagram_content_publish,instagram_manage_messages,business_management',
    finish: (tokens, ctx) => connectMeta(tokens, ctx),
  },
  linkedin: {
    platforms: ['linkedin'], idEnv: 'LINKEDIN_CLIENT_ID', secretEnv: 'LINKEDIN_CLIENT_SECRET',
    authorize: () => 'https://www.linkedin.com/oauth/v2/authorization', token: () => 'https://www.linkedin.com/oauth/v2/accessToken',
    scope: env => `openid profile w_member_social${env.LINKEDIN_ORG_ID ? ' w_organization_social' : ''}`,
  },
  tiktok: {
    platforms: ['tiktok'], idEnv: 'TIKTOK_CLIENT_KEY', secretEnv: 'TIKTOK_CLIENT_SECRET', idParam: 'client_key',
    authorize: () => 'https://www.tiktok.com/v2/auth/authorize/', token: () => 'https://open.tiktokapis.com/v2/oauth/token/',
    scope: () => 'user.info.basic,user.info.stats,video.publish,video.upload',
  },
  threads: {
    platforms: ['threads'], idEnv: 'THREADS_APP_ID', secretEnv: 'THREADS_APP_SECRET',
    authorize: () => 'https://threads.net/oauth/authorize', token: () => 'https://graph.threads.net/oauth/access_token',
    scope: () => 'threads_basic,threads_content_publish', refreshWithAccessToken: true,
    // Swap the 1-hour token for a 60-day one.
    async exchange(tokens, ctx) {
      const { data } = await call(ctx.fetch, `https://graph.threads.net/access_token?grant_type=th_exchange_token&client_secret=${encodeURIComponent(ctx.env.THREADS_APP_SECRET)}&access_token=${encodeURIComponent(tokens.access_token)}`);
      return data;
    },
    async refresh(secrets, ctx) {
      const { data } = await call(ctx.fetch, `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(secrets.accessToken)}`);
      return data;
    },
  },
  youtube: {
    platforms: ['youtube'], idEnv: 'GOOGLE_CLIENT_ID', secretEnv: 'GOOGLE_CLIENT_SECRET',
    authorize: () => 'https://accounts.google.com/o/oauth2/v2/auth', token: () => 'https://oauth2.googleapis.com/token',
    scope: () => 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
};

export const providerConfigured = (app, id) => !!(app.config.env[PROVIDERS[id].idEnv] && app.config.env[PROVIDERS[id].secretEnv]);
const redirectUri = (app, id) => `${app.config.publicUrl}/api/oauth/${id}/callback`;

export function startUrl(app, user, id) {
  const p = PROVIDERS[id]; if (!p) fail(404, 'Unknown login provider.');
  if (!user.is_admin) fail(403, 'Only admins can connect channels.');
  if (!providerConfigured(app, id)) fail(400, `Add ${p.idEnv} and ${p.secretEnv} to the server’s environment first.`);
  const state = randomToken(24);
  const verifier = p.pkce ? randomToken(48) : null;
  app.db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(now() - 15 * 60000);
  app.db.prepare('INSERT INTO oauth_states (state, provider, verifier, user_id, created_at) VALUES (?, ?, ?, ?, ?)').run(state, id, verifier, user.id, now());
  const q = new URLSearchParams({
    response_type: 'code', [p.idParam || 'client_id']: app.config.env[p.idEnv], redirect_uri: redirectUri(app, id),
    scope: p.scope(app.config.env), state, ...(p.extra || {}),
  });
  if (verifier) { q.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url')); q.set('code_challenge_method', 'S256'); }
  return `${p.authorize(app.config.env)}?${q}`;
}

function tokenRequest(app, id, form) {
  const p = PROVIDERS[id]; const env = app.config.env;
  const headers = {};
  if (p.basicAuth) headers.Authorization = 'Basic ' + Buffer.from(`${env[p.idEnv]}:${env[p.secretEnv]}`).toString('base64');
  else Object.assign(form, { [p.idParam || 'client_id']: env[p.idEnv], client_secret: env[p.secretEnv] });
  if (p.basicAuth) form.client_id = env[p.idEnv];
  return call(app.fetch, p.token(env), { method: 'POST', headers, form }).then(r => r.data);
}

export async function finish(app, user, id, query) {
  const p = PROVIDERS[id]; if (!p) fail(404, 'Unknown login provider.');
  if (query.error) fail(400, String(query.error_description || query.error));
  const row = app.db.prepare('SELECT * FROM oauth_states WHERE state = ? AND provider = ?').get(String(query.state || ''), id);
  app.db.prepare('DELETE FROM oauth_states WHERE state = ?').run(String(query.state || ''));
  if (!row || row.user_id !== user.id || now() - row.created_at > 15 * 60000) fail(400, 'That login link expired. Start the connection again.');
  const form = { grant_type: 'authorization_code', code: String(query.code || ''), redirect_uri: redirectUri(app, id) };
  if (row.verifier) form.code_verifier = row.verifier;
  let tokens = await tokenRequest(app, id, form);
  tokens = tokens.data && !tokens.access_token ? tokens.data : tokens; // some providers nest the payload
  const ctx = { env: app.config.env, fetch: app.fetch };
  if (p.exchange) tokens = { ...tokens, ...(await p.exchange(tokens, ctx)) };
  const accounts = p.finish ? await p.finish(tokens, ctx) : [{
    platform: p.platforms[0],
    ...(await ADAPTERS[p.platforms[0]].profile(tokens.access_token, ctx)),
    secrets: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
    expiresAt: tokens.expires_in ? now() + Number(tokens.expires_in) * 1000 : null,
  }];
  return accounts;
}

export async function refreshTokens(app, id, secrets) {
  const p = PROVIDERS[id];
  if (p.refresh) return p.refresh(secrets, { env: app.config.env, fetch: app.fetch });
  const t = await tokenRequest(app, id, { grant_type: 'refresh_token', refresh_token: secrets.refreshToken });
  return t.data && !t.access_token ? t.data : t;
}
