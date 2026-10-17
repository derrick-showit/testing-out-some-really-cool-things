import path from 'node:path';

export function loadConfig(opts = {}) {
  if (!opts.env) { try { process.loadEnvFile(); } catch { /* no .env file */ } }
  const env = opts.env || process.env;
  const port = Number(opts.port ?? env.PORT ?? 3000);
  const publicUrl = String(opts.publicUrl ?? env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  return {
    env,
    port,
    host: env.HOST || '127.0.0.1',
    publicUrl,
    secureCookies: publicUrl.startsWith('https://'),
    dataDir: path.resolve(opts.dataDir ?? env.DATA_DIR ?? 'data'),
    secret: env.POSTBOARD_SECRET,
    schedulerMs: Number(env.SCHEDULER_SECONDS || 15) * 1000,
    inboxPollMs: Number(env.INBOX_POLL_SECONDS || 120) * 1000,
    background: opts.background ?? true,
  };
}
