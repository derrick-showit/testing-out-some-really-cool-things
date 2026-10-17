import { seal, unseal } from './crypto.js';
import { now, fail, str, parseJson } from './util.js';
import { PLATFORMS } from './format.js';
import { ADAPTERS } from './platforms/index.js';
import { PROVIDERS, refreshTokens, providerConfigured } from './oauth.js';

export function getAccount(app, platform) {
  const r = app.db.prepare('SELECT * FROM accounts WHERE platform = ?').get(platform);
  return {
    platform,
    enabled: !!r?.enabled,
    handle: r?.handle || '', name: r?.name || '', bio: r?.bio || '', followers: r?.followers || 0,
    externalId: r?.external_id || null,
    secrets: r?.secrets ? parseJson(unseal(app.key, r.secrets), {}) : {},
    expiresAt: r?.expires_at || null,
  };
}
export function saveAccount(app, a) {
  const secrets = a.secrets && Object.values(a.secrets).some(Boolean) ? seal(app.key, JSON.stringify(a.secrets)) : null;
  app.db.prepare(`INSERT INTO accounts (platform, enabled, handle, name, bio, followers, external_id, secrets, expires_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform) DO UPDATE SET enabled = excluded.enabled, handle = excluded.handle, name = excluded.name, bio = excluded.bio,
      followers = excluded.followers, external_id = excluded.external_id, secrets = excluded.secrets, expires_at = excluded.expires_at, updated_at = excluded.updated_at`)
    .run(a.platform, a.enabled ? 1 : 0, a.handle || '', a.name || '', a.bio || '', Math.round(a.followers || 0), a.externalId ?? null, secrets, a.expiresAt ?? null, now());
}

const botToken = (app, a) => a.secrets.botToken || app.config.env.DISCORD_BOT_TOKEN || null;

// live: credentials present, sends for real. sandbox: turned on without credentials, sends are recorded only. off: skipped.
export function mode(app, a, purpose = 'publish') {
  if (a.platform === 'discord') {
    const live = purpose === 'dm' ? botToken(app, a) : a.secrets.webhook;
    return live ? 'live' : a.enabled ? 'sandbox' : 'off';
  }
  return a.secrets.accessToken ? 'live' : a.enabled ? 'sandbox' : 'off';
}

export function publicAccount(app, platform) {
  const a = getAccount(app, platform); const ad = ADAPTERS[platform];
  const publish = mode(app, a, 'publish');
  return {
    connected: publish !== 'off', mode: publish, dmMode: ad.dm.supported ? mode(app, a, 'dm') : 'unsupported',
    handle: a.handle, name: a.name, bio: a.bio, followers: a.followers,
    hasWebhook: !!a.secrets.webhook, hasBotToken: !!botToken(app, a),
    oauth: ad.oauth ? { provider: ad.oauth, configured: providerConfigured(app, ad.oauth), shared: PROVIDERS[ad.oauth].platforms.length > 1 } : null,
    dm: ad.dm.supported ? { supported: true } : { supported: false, reason: ad.dm.reason },
    expiresAt: a.expiresAt,
  };
}
export const publicAccounts = app => Object.fromEntries(Object.keys(PLATFORMS).map(p => [p, publicAccount(app, p)]));

export function updateAccount(app, user, platform, body) {
  if (!PLATFORMS[platform]) fail(404, 'Unknown channel.');
  if (!user.is_admin) fail(403, 'Only admins can change channel settings.');
  const a = getAccount(app, platform);
  if ('enabled' in body) a.enabled = !!body.enabled;
  for (const k of ['handle', 'name', 'bio']) if (k in body) a[k] = str(body[k], k === 'bio' ? 500 : 100).trim();
  if (platform === 'discord') {
    if ('webhook' in body) {
      const w = str(body.webhook, 500).trim();
      if (w && !/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/.test(w)) fail(400, 'That doesn’t look like a Discord webhook URL.');
      a.secrets.webhook = w || undefined;
    }
    if ('botToken' in body) a.secrets.botToken = str(body.botToken, 200).trim() || undefined;
  }
  saveAccount(app, a);
  if (platform === 'discord') app.inbox.restartDiscord();
  app.events.toAll({ type: 'accounts', accounts: publicAccounts(app) });
  return publicAccount(app, platform);
}

export function disconnect(app, user, platform) {
  if (!user.is_admin) fail(403, 'Only admins can change channel settings.');
  const a = getAccount(app, platform);
  a.secrets = {}; a.expiresAt = null; a.enabled = false;
  saveAccount(app, a);
  if (platform === 'discord') app.inbox.restartDiscord();
  app.events.toAll({ type: 'accounts', accounts: publicAccounts(app) });
}

// Returns a usable access token, refreshing it first when it is about to expire.
export async function accessToken(app, platform) {
  const a = getAccount(app, platform);
  if (platform === 'discord') return null;
  if (a.expiresAt && a.expiresAt < now() + 120000 && (a.secrets.refreshToken || PROVIDERS[ADAPTERS[platform].oauth]?.refreshWithAccessToken)) {
    const t = await refreshTokens(app, ADAPTERS[platform].oauth, a.secrets);
    a.secrets.accessToken = t.access_token;
    if (t.refresh_token) a.secrets.refreshToken = t.refresh_token;
    a.expiresAt = t.expires_in ? now() + t.expires_in * 1000 : null;
    saveAccount(app, a);
  }
  return a.secrets.accessToken;
}

export async function platformCtx(app, platform, extra = {}) {
  const account = getAccount(app, platform);
  return {
    account, env: app.config.env, fetch: app.fetch, publicUrl: app.config.publicUrl,
    token: platform === 'discord' ? null : await accessToken(app, platform),
    botToken: platform === 'discord' ? botToken(app, account) : null,
    readMedia: m => app.media.read(m),
    pollMs: app.config.pollMs,
    ...extra,
  };
}
