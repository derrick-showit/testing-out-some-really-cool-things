import { now } from './util.js';
import { PLATFORMS, FORMATS, textFor } from './format.js';
import { ADAPTERS } from './platforms/index.js';
import { getAccount, mode, platformCtx } from './accounts.js';
import { getPost, writePost, approvalComplete } from './posts.js';
import { notify } from './notifications.js';

export function createPublisher(app, log = console) {
  async function sendTo(p, ch) {
    const P = PLATFORMS[ch];
    if (!P.formats.includes(p.format)) return { ok: false, skipped: true, msg: `${P.name} doesn’t support ${FORMATS[p.format].toLowerCase()}s.` };
    const m = mode(app, getAccount(app, ch));
    if (m === 'off') return { ok: false, msg: `${P.name} isn’t connected.` };
    if (m === 'sandbox') return { ok: true, live: false, msg: 'Sandbox: recorded, not sent. Connect the account to post for real.' };
    try {
      const ctx = await platformCtx(app, ch, { text: textFor(p.body, ch) });
      const r = await ADAPTERS[ch].publish(p, ctx);
      return { ok: true, live: true, url: r.url, externalId: r.externalId, msg: r.msg };
    } catch (e) {
      return { ok: false, msg: String(e.message || e).slice(0, 400) };
    }
  }

  async function publish(id) {
    const start = getPost(app, id); if (!start) return;
    const results = {};
    for (const ch of start.channels) results[ch] = await sendTo(start, ch);
    const p = getPost(app, id) || start; // pick up comments and likes added while sending
    const ok = Object.values(results).filter(r => r.ok).length;
    const failed = Object.entries(results).filter(([, r]) => !r.ok && !r.skipped).map(([c]) => PLATFORMS[c].name);
    p.results = results;
    p.status = ok ? 'published' : 'failed';
    if (ok) p.publishedAt = now();
    p.log.push({ at: now(), who: 'system', text: ok ? `published to ${ok} channel${ok > 1 ? 's' : ''}${failed.length ? `; failed on ${failed.join(', ')}` : ''}` : 'failed to send' });
    writePost(app, p);
    notify(app, 'all', ok
      ? `“${p.title || 'Untitled'}” went out to ${ok} channel${ok > 1 ? 's' : ''}${failed.length ? `, but failed on ${failed.join(', ')}` : ''}`
      : `“${p.title || 'Untitled'}” failed to send`, { postId: p.id });
  }

  function tick() {
    const due = app.db.prepare("SELECT id FROM posts WHERE status = 'scheduled' AND scheduled_at <= ?").all(now());
    for (const { id } of due) {
      const p = getPost(app, id);
      if (!p || !approvalComplete(p)) continue;
      p.status = 'publishing'; // claim it before the first await so a second tick can't send it twice
      writePost(app, p);
      publish(id).catch(e => log.error('publish failed', e));
    }
  }

  // A crash mid-send leaves posts in "publishing". Don't retry them blindly; that could post twice.
  function recover() {
    for (const { id } of app.db.prepare("SELECT id FROM posts WHERE status = 'publishing'").all()) {
      const p = getPost(app, id);
      p.status = 'failed';
      p.log.push({ at: now(), who: 'system', text: 'sending was interrupted by a server restart. Check each network before sending again.' });
      writePost(app, p);
    }
  }

  let timer = null;
  return {
    publish, tick, recover,
    start() { recover(); timer = setInterval(tick, app.config.schedulerMs); timer.unref?.(); },
    stop() { clearInterval(timer); },
  };
}
