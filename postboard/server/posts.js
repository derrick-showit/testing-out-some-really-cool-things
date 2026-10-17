import { uid, now, fail, str, arr, uniq } from './util.js';
import { PLATFORMS, FORMATS, textFor, countFor } from './format.js';
import { getWs } from './workspace.js';
import { notify } from './notifications.js';
import { getAccount, mode } from './accounts.js';

const CONTENT_KEYS = ['title', 'body', 'channels', 'format', 'media', 'tagged'];
const LOCKED = ['published', 'publishing'];
const userName = (app, id) => app.db.prepare('SELECT name FROM users WHERE id = ?').get(id)?.name || 'Someone';
const first = (app, id) => userName(app, id).split(' ')[0];
const titleOf = p => `“${p.title || 'Untitled'}”`;

export function getPost(app, id) {
  const r = app.db.prepare('SELECT data FROM posts WHERE id = ?').get(String(id));
  return r ? JSON.parse(r.data) : null;
}
export const listPosts = app => app.db.prepare('SELECT data FROM posts').all().map(r => JSON.parse(r.data));
export function mustGet(app, id) { const p = getPost(app, id); if (!p) fail(404, 'That post no longer exists.'); return p; }

export function writePost(app, p) {
  app.db.prepare(`INSERT INTO posts (id, status, scheduled_at, data, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET status = excluded.status, scheduled_at = excluded.scheduled_at, data = excluded.data, updated_at = excluded.updated_at`)
    .run(p.id, p.status, p.scheduledAt ?? null, JSON.stringify(p), now());
  app.events.toAll({ type: 'post', post: p });
  return p;
}
const log = (p, who, text) => p.log.push({ at: now(), who, text });

export const approvalComplete = p => !p.approval.required || (p.approval.approvers.length > 0 && p.approval.approvers.every(a => p.approval.decisions[a] === 'approved'));

function cleanMedia(app, list) {
  return arr(list).slice(0, 10).map(m => {
    if (m?.kind === 'art') return { kind: 'art', h: Math.round(Number(m.h) || 0) % 360, label: str(m.label, 60) };
    if (m?.kind !== 'image' && m?.kind !== 'video') return null;
    const src = String(m.src || '');
    if (src.startsWith('data:')) return { kind: m.kind, src: app.media.saveDataUrl(src) };
    if (src.startsWith('/media/') && app.media.exists(src.slice(7))) return { kind: m.kind, src };
    return null;
  }).filter(Boolean);
}

function clean(app, input) {
  const out = {};
  if ('title' in input) out.title = str(input.title, 200);
  if ('body' in input) out.body = str(input.body, 70000);
  if ('channels' in input) out.channels = uniq(arr(input.channels).filter(c => PLATFORMS[c]));
  if ('format' in input) { if (!FORMATS[input.format]) fail(400, 'Unknown post format.'); out.format = input.format; }
  if ('scheduledAt' in input) {
    const t = input.scheduledAt == null || input.scheduledAt === '' ? null : Number(input.scheduledAt);
    if (t != null && !Number.isFinite(t)) fail(400, 'That send time isn’t a valid date.');
    out.scheduledAt = t;
  }
  if ('labels' in input) out.labels = uniq(arr(input.labels).map(String)).slice(0, 20);
  if ('tagged' in input) out.tagged = str(input.tagged, 500);
  if ('media' in input) out.media = cleanMedia(app, input.media);
  return out;
}

function applyApproval(app, p, input) {
  const settings = getWs(app, 'settings');
  const ids = new Set(app.db.prepare('SELECT id FROM users').all().map(r => r.id));
  if (input?.approval) {
    if ('required' in input.approval) p.approval.required = !!input.approval.required;
    if ('approvers' in input.approval) {
      p.approval.approvers = uniq(arr(input.approval.approvers).filter(id => ids.has(id)));
      for (const id of Object.keys(p.approval.decisions)) if (!p.approval.approvers.includes(id)) delete p.approval.decisions[id];
    }
  }
  if (settings.requireApproval) p.approval.required = true; // the workspace rule wins
}

export function problems(app, p) {
  const out = [];
  if (!p.channels.length) out.push('Pick at least one channel.');
  if (!p.body.trim() && !p.media.length) out.push('Add some text or media.');
  for (const c of p.channels) {
    const P = PLATFORMS[c];
    if (!P.formats.includes(p.format)) continue;
    const n = countFor(textFor(p.body, c), c);
    if (n > P.limit) out.push(`${P.name}: ${n - P.limit} characters over the limit.`);
    if ((P.needsMedia || p.format !== 'post') && !p.media.length) out.push(`${P.name} ${FORMATS[p.format].toLowerCase()}s need an image or video.`);
    if (mode(app, getAccount(app, c)) === 'off') out.push(`${P.name} isn’t connected. Turn it on in Channels.`);
  }
  return out;
}
const requireSendable = (app, p) => { const e = problems(app, p); if (e.length) fail(400, e.join(' ')); };

export function createPost(app, user, input) {
  const settings = getWs(app, 'settings');
  const c = clean(app, input || {});
  const p = {
    id: uid(), title: '', body: '', channels: [], format: 'post', scheduledAt: null, status: 'draft', labels: [], tagged: '', media: [],
    author: user.id, approval: { required: settings.requireApproval, approvers: settings.defaultApprovers.filter(a => a !== user.id), decisions: {} },
    likes: [], reposts: [], comments: [], log: [], results: null, publishedAt: null, createdAt: now(), ...c,
  };
  if (!p.approval.approvers.length) p.approval.approvers = settings.defaultApprovers.slice();
  applyApproval(app, p, input);
  log(p, user.id, 'created the post');
  return writePost(app, p);
}

export function updatePost(app, user, id, input) {
  const p = mustGet(app, id);
  if (LOCKED.includes(p.status)) fail(409, 'This post has already gone out, so it can’t be edited. Duplicate it instead.');
  const c = clean(app, input || {});
  const contentChanged = CONTENT_KEYS.some(k => k in c && JSON.stringify(c[k]) !== JSON.stringify(p[k]));
  const timeChanged = 'scheduledAt' in c && c.scheduledAt !== p.scheduledAt;
  Object.assign(p, c);
  applyApproval(app, p, input);
  if (timeChanged && p.status === 'scheduled' && (!p.scheduledAt || p.scheduledAt < now())) fail(400, 'Pick a send time in the future.');
  // Editing an approved post sends it back for review so approvers see what actually goes out.
  if (contentChanged && p.approval.required && Object.values(p.approval.decisions).includes('approved')) {
    p.approval.decisions = {};
    p.status = 'in_review';
    log(p, user.id, 'edited the post, so approval starts again');
    notify(app, p.approval.approvers, `${userName(app, user.id)} edited ${titleOf(p)} after approval. It needs your review again.`, { postId: p.id, except: user.id });
  } else if (!approvalComplete(p) && ['approved', 'scheduled'].includes(p.status)) {
    p.status = 'in_review';
  } else log(p, user.id, timeChanged && !contentChanged ? `moved it to ${new Date(p.scheduledAt).toISOString()}` : 'saved changes');
  return writePost(app, p);
}

export function requestApproval(app, user, id) {
  const p = mustGet(app, id);
  if (LOCKED.includes(p.status)) fail(409, 'This post has already gone out.');
  if (!p.approval.required) fail(400, 'This post doesn’t need approval. Schedule it instead.');
  if (!p.approval.approvers.length) fail(400, 'Pick at least one approver.');
  requireSendable(app, p);
  p.approval.decisions = {}; p.status = 'in_review';
  log(p, user.id, 'requested approval');
  notify(app, p.approval.approvers, `${userName(app, user.id)} asked you to approve ${titleOf(p)}`, { postId: p.id, except: user.id });
  return writePost(app, p);
}

export function decide(app, user, id, decision, note) {
  const p = mustGet(app, id);
  if (!['approved', 'changes'].includes(decision)) fail(400, 'Decision must be approved or changes.');
  if (!p.approval.approvers.includes(user.id)) fail(403, 'You aren’t an approver on this post.');
  if (p.status !== 'in_review') fail(409, 'This post isn’t waiting for review.');
  p.approval.decisions[user.id] = decision;
  log(p, user.id, decision === 'approved' ? 'approved' : 'requested changes');
  if (note && String(note).trim()) p.comments.push({ id: uid(), who: user.id, text: str(note, 4000).trim(), at: now() });
  if (decision === 'changes') {
    p.status = 'changes';
    notify(app, p.author, `${userName(app, user.id)} requested changes on ${titleOf(p)}`, { postId: p.id, except: user.id });
  } else if (approvalComplete(p)) {
    p.status = p.scheduledAt && p.scheduledAt > now() ? 'scheduled' : 'approved';
    notify(app, p.author, `${titleOf(p)} is approved${p.status === 'scheduled' ? ' and scheduled' : ''}`, { postId: p.id, except: user.id });
  }
  return writePost(app, p);
}

export function schedule(app, user, id) {
  const p = mustGet(app, id);
  if (LOCKED.includes(p.status)) fail(409, 'This post has already gone out.');
  if (!approvalComplete(p)) fail(409, 'This post needs approval before it can be scheduled.');
  if (!p.scheduledAt || p.scheduledAt <= now()) fail(400, 'Pick a send time in the future, or send it now.');
  requireSendable(app, p);
  p.status = 'scheduled';
  log(p, user.id, `scheduled it for ${new Date(p.scheduledAt).toISOString()}`);
  return writePost(app, p);
}

export function unschedule(app, user, id) {
  const p = mustGet(app, id);
  if (p.status !== 'scheduled') fail(409, 'This post isn’t scheduled.');
  p.status = p.approval.required ? 'approved' : 'draft';
  log(p, user.id, 'took it off the schedule');
  return writePost(app, p);
}

export function startPublish(app, user, id) {
  const p = mustGet(app, id);
  if (LOCKED.includes(p.status)) fail(409, 'This post is already sending or sent.');
  if (!approvalComplete(p)) fail(409, 'This post needs approval before it can be sent.');
  requireSendable(app, p);
  p.status = 'publishing';
  if (!p.scheduledAt || p.scheduledAt > now()) p.scheduledAt = now();
  log(p, user.id, 'sent the post now');
  writePost(app, p);
  app.publisher.publish(p.id); // runs in the background; progress arrives as post events
  return p;
}

export function react(app, user, id, kind) {
  const key = kind === 'like' ? 'likes' : kind === 'repost' ? 'reposts' : fail(400, 'Reaction must be like or repost.');
  const p = mustGet(app, id);
  const i = p[key].indexOf(user.id);
  if (i >= 0) p[key].splice(i, 1);
  else {
    p[key].push(user.id);
    log(p, user.id, kind === 'like' ? 'liked the post' : 'signed up to repost');
    notify(app, p.author, `${userName(app, user.id)} ${kind === 'like' ? 'liked' : 'will repost'} ${titleOf(p)}`, { postId: p.id, except: user.id });
  }
  return writePost(app, p);
}

export function mentionedUsers(app, text) {
  return app.db.prepare('SELECT id, name FROM users').all().filter(u => new RegExp(`@${u.name.split(' ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
}

export function comment(app, user, id, text) {
  const t = str(text, 4000).trim(); if (!t) fail(400, 'Write a comment first.');
  const p = mustGet(app, id);
  p.comments.push({ id: uid(), who: user.id, text: t, at: now() });
  log(p, user.id, 'commented');
  const mentioned = mentionedUsers(app, t).map(u => u.id).filter(u => u !== user.id);
  notify(app, mentioned, `${userName(app, user.id)} mentioned you on ${titleOf(p)}`, { postId: p.id });
  if (!mentioned.includes(p.author)) notify(app, p.author, `${userName(app, user.id)} commented on ${titleOf(p)}`, { postId: p.id, except: user.id });
  return writePost(app, p);
}

export function deletePost(app, user, id) {
  const p = mustGet(app, id);
  if (p.status === 'publishing') fail(409, 'Wait for this post to finish sending.');
  app.db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
  app.events.toAll({ type: 'post-deleted', id: p.id });
}
