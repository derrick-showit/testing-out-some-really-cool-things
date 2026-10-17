// Fills an empty workspace with a demo team, posts, chat and sandbox DMs for a fictional coffee roaster.
// Usage: npm run seed            (prints a generated password)
//        SEED_PASSWORD=... npm run seed
import { pathToFileURL } from 'node:url';
import { createApp } from './server.js';
import { createUser, userCount } from './auth.js';
import { randomToken } from './crypto.js';
import { uid } from './util.js';
import { writePost } from './posts.js';
import { setWs } from './workspace.js';
import { saveAccount, getAccount } from './accounts.js';
import { ensureDefaultChannels } from './chat.js';

const DAY = 864e5;

export async function seed(app, { password = process.env.SEED_PASSWORD || randomToken(9) } = {}) {
  if (userCount(app) > 0) throw new Error('This workspace already has accounts. Point DATA_DIR at an empty folder to seed a demo.');
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const at = (d, h, m = 0) => { const x = new Date(t0); x.setDate(x.getDate() + d); x.setHours(h, m, 0, 0); return x.getTime(); };
  const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  const people = [
    ['derrick@larkspur.test', 'Derrick', 'Admin', true],
    ['maya@larkspur.test', 'Maya Chen', 'Brand lead', true],
    ['jordan@larkspur.test', 'Jordan Ellis', 'Social manager', false],
    ['priya@larkspur.test', 'Priya Nair', 'Designer', false],
  ];
  const u = {};
  for (const [email, name, role, isAdmin] of people) u[name.split(' ')[0].toLowerCase()] = (await createUser(app, { email, name, role, password, isAdmin })).id;
  const { derrick, maya, jordan, priya } = u;

  const acct = (platform, handle, name, followers, bio = '') => saveAccount(app, { ...getAccount(app, platform), enabled: true, handle, name, followers, bio });
  acct('instagram', 'larkspurcoffee', 'Larkspur Coffee', 18400, 'Small-batch roaster · Portland, OR\nOpen 7–4 daily ☕ Roasting Tue + Fri\nlarkspur.coffee');
  acct('linkedin', 'larkspur-coffee-co', 'Larkspur Coffee Co.', 3200);
  acct('x', 'larkspurcoffee', 'Larkspur Coffee', 7100);
  acct('tiktok', 'larkspurcoffee', 'Larkspur Coffee', 26900);
  acct('facebook', 'LarkspurCoffeePDX', 'Larkspur Coffee', 9800);
  acct('threads', 'larkspurcoffee', 'Larkspur Coffee', 4100);
  acct('discord', 'Larkspur Regulars', 'Larkspur Bot', 860);
  acct('youtube', '@larkspurcoffee', 'Larkspur Coffee', 5300);

  setWs(app, 'settings', { requireApproval: true, defaultApprovers: [maya] });
  setWs(app, 'campaigns', [
    { id: 'c1', name: 'Fall menu launch', start: dayKey(at(-9, 0)), end: dayKey(at(-5, 0)), h: 28 },
    { id: 'c2', name: 'Roaster open house', start: dayKey(at(1, 0)), end: dayKey(at(4, 0)), h: 230 },
    { id: 'c3', name: 'Holiday blend', start: dayKey(at(6, 0)), end: dayKey(at(12, 0)), h: 350 },
  ]);

  const art = (h, label) => [{ kind: 'art', h, label }];
  const P = o => ({
    id: uid(), title: '', body: '', channels: [], format: 'post', scheduledAt: null, status: 'draft', labels: [], tagged: '', media: [],
    author: jordan, approval: { required: true, approvers: [maya], decisions: {} }, likes: [], reposts: [], comments: [], log: [],
    results: null, publishedAt: null, createdAt: Date.now() - 12 * DAY, ...o,
  });
  const pub = o => {
    const p = P({ status: 'published', ...o });
    p.publishedAt = p.scheduledAt; p.approval.decisions = { [maya]: 'approved' };
    p.results = Object.fromEntries(p.channels.map(c => [c, { ok: true, live: false, msg: 'Sandbox: recorded, not sent.' }]));
    p.log = [{ at: p.scheduledAt - DAY, who: p.author, text: 'requested approval' }, { at: p.scheduledAt - 6e7, who: maya, text: 'approved' }, { at: p.scheduledAt, who: 'system', text: `published to ${p.channels.length} channels` }];
    return p;
  };
  const c = (who, text, when) => ({ id: uid(), who, text, at: when });
  const posts = [
    pub({ title: 'New mugs in the shop', body: 'Stoneware mugs from **Hollow Clay Studio** just landed. Each one is thrown by hand, so no two match.\n\nShop link in bio. #handmade #coffeegear', channels: ['instagram', 'facebook'], scheduledAt: at(-13, 11), labels: ['l5'], media: art(190, 'Hollow Clay mugs'), likes: [maya, priya] }),
    pub({ title: 'Sunrise at the roastery', body: 'First batch of the day, 6:12am. *This is the quiet part nobody sees.*', channels: ['instagram', 'threads', 'x'], scheduledAt: at(-11, 7, 30), labels: ['l4'], media: art(36, 'Sunrise roast'), author: priya }),
    pub({ title: 'Fall menu is here', body: 'Our **fall menu** lands today.\n\n*Maple cardamom latte* is back, plus two new pastries from Bramble Bakery.\n\nWhich one are you trying first? #fallmenu #pdxcoffee', channels: ['instagram', 'facebook', 'threads', 'x'], scheduledAt: at(-9, 9, 30), labels: ['l1'], media: art(24, 'Fall menu'), likes: [derrick, maya, priya], reposts: [derrick, maya], comments: [c(maya, 'Love the photo crop on this one.', at(-10, 15))] }),
    pub({ title: 'Maple cardamom latte', body: 'How we build the **maple cardamom latte**, start to finish. 30 seconds, no cuts. #latteart', channels: ['instagram', 'tiktok', 'youtube', 'facebook'], format: 'reel', scheduledAt: at(-8, 12), labels: ['l1', 'l6'], media: art(32, 'Latte reel'), likes: [derrick, maya], reposts: [priya] }),
    pub({ title: 'Behind the roast: Huila, Colombia', body: 'Our new single origin comes from the **Rojas family farm** in Huila. We paid $4.10/lb, 82% above the C price.\n\nHere is what that premium funds, and why we publish the number every time.', channels: ['linkedin', 'facebook', 'instagram'], scheduledAt: at(-7, 8), labels: ['l4'], media: art(110, 'Huila origin'), author: maya, likes: [derrick, jordan], comments: [c(derrick, '@Jordan can we pin this on LinkedIn?', at(-7, 10)), c(jordan, 'Done, pinned for two weeks.', at(-7, 11))] }),
    pub({ title: 'Last call: pumpkin bread', body: 'Last trays of pumpkin bread today. *Get here before noon.*', channels: ['instagram', 'facebook'], format: 'story', scheduledAt: at(-4, 8), labels: ['l5'], media: art(18, 'Last call') }),
    pub({ title: 'Regulars night recap', body: '**Regulars night recap**\nThanks to the 40 of you who came out. Next one is on the 3rd Thursday. Bring a mug, get a free refill.', channels: ['discord', 'threads'], scheduledAt: at(-2, 19), labels: ['l4'] }),
    pub({ title: 'Founder note: pricing', body: 'We raised our bag price by $1 this month. **All of it goes to farm partners.** A short note on why, and what changes for you: nothing else.', channels: ['linkedin', 'x'], scheduledAt: at(-1, 9), labels: ['l2'], author: derrick, likes: [maya, jordan, priya], reposts: [maya, jordan] }),
    P({ title: 'Weekend pour-over class', body: 'Two seats left for **Saturday pour-over basics**. 90 minutes, all gear provided, you leave with a bag of the Huila.\n\nBook at larkspur.coffee/classes', channels: ['instagram', 'facebook', 'threads'], scheduledAt: Date.now() + 95 * 6e4, status: 'scheduled', labels: ['l6', 'l5'], media: art(60, 'Pour-over class'), approval: { required: true, approvers: [maya], decisions: { [maya]: 'approved' } }, likes: [maya] }),
    P({ title: 'Open house countdown', body: 'Open house in 3 days. **Free cupping at 10, 12 and 2.**', channels: ['instagram', 'tiktok'], format: 'story', scheduledAt: at(1, 11), status: 'in_review', labels: ['l5'], media: art(230, '3 days'), author: priya }),
    P({ title: 'Roaster open house: this Saturday', body: 'Come see the **Loring S15** in action. Tours every hour from 10 to 3, free cupping, and 20% off beans all day.\n\n*Kids and dogs welcome.* #openhouse #pdx', channels: ['instagram', 'facebook', 'linkedin', 'threads', 'x'], scheduledAt: at(2, 9, 30), status: 'scheduled', labels: ['l5', 'l4'], media: art(220, 'Open house'), approval: { required: true, approvers: [maya], decisions: { [maya]: 'approved' } }, tagged: '@loringroasters', likes: [derrick, priya] }),
    P({ title: 'Cupping 101 with Jordan', body: 'What does "bright" actually mean? Jordan breaks down a **cupping form** in under a minute. #coffeeeducation', channels: ['tiktok', 'instagram', 'youtube'], format: 'reel', scheduledAt: at(3, 15), status: 'in_review', labels: ['l6'], media: art(48, 'Cupping 101'), approval: { required: true, approvers: [maya, derrick], decisions: { [maya]: 'approved' } }, comments: [c(maya, 'Approved from my side. @Derrick can you check the captions?', Date.now() - 3 * 36e5)] }),
    P({ title: 'Customer story: Night Shift Nurses', body: 'Every Tuesday at 6am we drop two carafes at **St. Vincent\'s night shift**. Charge nurse Alma told us what that hour means to her team.', channels: ['linkedin', 'facebook'], scheduledAt: at(4, 8, 30), status: 'changes', labels: ['l3'], author: maya, approval: { required: true, approvers: [derrick], decisions: { [derrick]: 'changes' } }, comments: [c(derrick, 'Need Alma\'s written OK on the quote before this goes out.', Date.now() - 20 * 36e5)] }),
    P({ title: 'Holiday blend teaser', body: 'Something *dark, a little spicy*, and only around until January.', channels: ['instagram', 'tiktok', 'x'], scheduledAt: at(6, 10), labels: ['l1'], media: art(350, 'Holiday blend'), author: priya }),
    P({ title: 'Discord AMA with our head roaster', body: '**AMA tonight, 7pm** in #roastery-chat.\nAsk Sam anything about roast curves, green sourcing, or why we stopped doing dark roasts.', channels: ['discord', 'x', 'threads'], scheduledAt: at(9, 12), status: 'scheduled', labels: ['l4'], approval: { required: true, approvers: [maya], decisions: { [maya]: 'approved' } } }),
  ];
  for (const p of posts) { if (!p.log.length) p.log.push({ at: p.createdAt, who: p.author, text: 'created the post' }); writePost(app, p); }

  // Team chat
  ensureDefaultChannels(app, derrick);
  const general = app.db.prepare("SELECT id FROM chat_channels WHERE name = 'general'").get().id;
  const review = app.db.prepare("SELECT id FROM chat_channels WHERE name = 'content-review'").get().id;
  const say = (ch, who, body, when) => app.db.prepare('INSERT INTO chat_messages (id, channel_id, user_id, body, at) VALUES (?, ?, ?, ?, ?)').run(uid(), ch, who, body, when);
  const ago = m => Date.now() - m * 6e4;
  say(general, maya, 'Morning! Open house prep meeting moved to 2pm.', ago(300));
  say(general, jordan, 'Got it. I’ll bring the shot list for the roaster tour.', ago(290));
  say(general, priya, 'Holiday blend label art is in the shared folder. Two options, both **draft**.', ago(180));
  say(review, jordan, 'Cupping 101 is in review. @Derrick the captions are the only open item.', ago(200));
  say(review, maya, 'I approved it. The hook in the first 2 seconds works.', ago(190));
  const dm = uid();
  app.db.prepare("INSERT INTO chat_channels (id, kind, dm_key, created_by, created_at) VALUES (?, 'dm', ?, ?, ?)").run(dm, [derrick, maya].sort().join(':'), maya, ago(400));
  for (const id of [derrick, maya]) app.db.prepare('INSERT INTO chat_members (channel_id, user_id) VALUES (?, ?)').run(dm, id);
  say(dm, maya, 'Can you look at the Night Shift Nurses post today? Alma sent her OK.', ago(60));

  // Sandbox social DMs. Replies to these are recorded but not sent.
  const thread = (platform, name, handle, msgs, extra = {}) => {
    for (const [dir, body, minsAgo, who] of msgs) {
      app.inbox.record(platform, {
        threadExternalId: `sandbox-${platform}-${handle}`, sandbox: true, contact: { id: null, name, handle },
        message: { direction: dir, body, at: ago(minsAgo), sentBy: who || null, delivery: dir === 'out' ? 'sandbox' : 'received' },
      });
    }
    if (extra.assignedTo || extra.status) {
      app.db.prepare('UPDATE dm_threads SET assigned_to = ?, status = ? WHERE platform = ? AND external_id = ?')
        .run(extra.assignedTo || null, extra.status || 'open', platform, `sandbox-${platform}-${handle}`);
    }
  };
  thread('instagram', 'Tess Alvarez', '@pdx.latte.lover', [['in', 'Do you have oat milk for the maple cardamom latte?? 😍', 42]]);
  thread('instagram', 'Kenji Mori', '@kenji.brews', [['in', 'Loved the latte reel. What grinder is that?', 600], ['out', 'Thanks Kenji! It’s a Mahlkönig EK43. We dial it in every morning.', 590, jordan], ['in', 'Amazing, thank you!', 585]], { status: 'done' });
  thread('x', 'Ricardo M.', '@ricardo_m', [['in', 'Is the open house kid friendly? Want to bring my 6yo', 95]], { assignedTo: jordan });
  thread('facebook', 'Dana Whitfield', 'Dana Whitfield', [['in', 'Hi! Do you cater office meetings? About 25 people, next Thursday.', 30 * 60], ['in', 'Just following up on this 🙂', 26 * 60]]);
  thread('discord', 'sam_roasts', '@sam_roasts', [['in', 'hey, can I bring green beans to the AMA for a quick look?', 15]]);
  app.db.prepare("UPDATE dm_threads SET unread = 0 WHERE status = 'done'").run();

  app.db.prepare('INSERT INTO notifications (id, user_id, text, post_id, at, read) VALUES (?, ?, ?, ?, ?, 0)')
    .run(uid(), derrick, 'Jordan Ellis asked you to approve “Cupping 101 with Jordan”', posts[11].id, Date.now() - 4 * 36e5);
  return { password, emails: people.map(p => p[0]) };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { app, close } = await createApp({ background: false });
  try {
    const { password, emails } = await seed(app);
    console.log('Demo workspace ready. Sign in with any of these:');
    for (const e of emails) console.log(`  ${e}`);
    console.log(`Password for all demo accounts: ${password}`);
    console.log('Start the server with `npm start`.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  await close();
}
