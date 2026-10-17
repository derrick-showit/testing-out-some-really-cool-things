# Postboard

A small social media scheduler for a team: content calendar, approvals, team chat, a shared inbox for social DMs, analytics and grid previews for Instagram, LinkedIn, X, TikTok, Facebook, Threads, Discord and YouTube.

It runs two ways:

- **With the server** (`npm start`): each teammate signs in, everything is shared live, the server sends scheduled posts, and connected channels post and answer DMs for real.
- **As a standalone file**: open `index.html` directly. It uses sample data saved in that browser, and sends are simulated (except Discord webhooks).

## Run it

Needs Node.js 22.13 or newer. There are no packages to install.

```sh
cd postboard
npm run seed      # optional: demo team, posts, chat and DMs; prints the demo password
npm start         # http://localhost:3000
npm test          # API tests
```

Without the seed, the first person to open the app creates the admin account.

Copy `.env.example` to `.env` to configure the server. Data lives in `./data` (SQLite database, uploaded media, and the key that encrypts channel tokens). Back up that folder.

## Teammates and sign-in

- The first account is an admin. Admins invite teammates from **Workspace**. Each invite is a one-time link that expires in 7 days, and the teammate picks their own password.
- Passwords are hashed with scrypt. Sessions are HttpOnly cookies, and are marked Secure when `PUBLIC_URL` is https.
- Everyone can draft, comment, chat and answer DMs. Only admins can invite people, change approval rules and connect channels.
- Only the post's approvers can approve it. Editing an approved post sends it back for review.

## Team chat

Channels (`#general` and `#content-review` to start, and anyone can add more) and one-to-one messages between teammates. Messages arrive live, the sidebar shows who is online, unread counts follow each person, and `@Firstname` sends a notification.

## Social DMs (Messages)

| Network | Answer DMs here? | How messages arrive |
|---|---|---|
| Instagram | Yes | Meta webhook (`/webhooks/meta`), plus polling of Page conversations |
| Facebook Messenger | Yes | Meta webhook, plus polling |
| X | Yes (needs a paid API tier) | Polls `GET /2/dm_events` every 2 minutes |
| Discord | Yes, as your bot | Discord Gateway: the bot sees DMs sent to it |
| LinkedIn | No | LinkedIn only opens messaging to approved partners |
| TikTok | No | Business messaging is limited to approved partners |
| Threads | No | No public messaging API |
| YouTube | No | YouTube has no DMs |

You can assign a conversation to a teammate (they get notified when the customer writes again) and mark it done. Meta allows replies for 24 hours after the customer's last message. From 24 hours to 7 days, Postboard sends with the `HUMAN_AGENT` tag, which your Meta app needs approval for. After 7 days the reply box is closed.

Channels without credentials run in **sandbox** mode: replies are stored and marked "Sandbox, not sent". Admins can add test customer messages from the bottom of the Messages page.

## Connecting channels for real

Each network needs your own developer app. Put its keys in `.env`, set `PUBLIC_URL` to the address the network can reach, and register this redirect URL in the app:

```
{PUBLIC_URL}/api/oauth/{provider}/callback      provider = x | meta | linkedin | tiktok | threads | youtube
```

Then use **Channels → Connect** while signed in as an admin. Tokens are encrypted at rest (AES-256-GCM) and refreshed automatically.

- **Meta** (Facebook and Instagram): one login connects both. Instagram must be a professional account linked to the Page. For DMs, subscribe the app's webhooks to `messages` for the Page and for Instagram, using `{PUBLIC_URL}/webhooks/meta` and your `META_VERIFY_TOKEN`.
- **Discord**: paste a channel webhook URL for posts, and a bot token for DMs (Developer Portal → Bot).
- Instagram, Facebook, Threads and TikTok fetch media from your server, so `PUBLIC_URL` must be public https. YouTube posting needs a video in the Reel / Short format, because the API can't create community posts. TikTok's API can't post stories.

## Notes

- Analytics are sample numbers generated from published posts. Each network's insights API isn't wired in yet.
- If the server restarts while a post is sending, that post is marked failed instead of being sent again, so nothing gets posted twice. Check the network, then resend.
- The server is one Node process with SQLite. Run one instance behind an https proxy, and keep `DATA_DIR` on persistent disk.

## Layout

```
index.html            the whole frontend (works with or without the server)
server/server.js      HTTP routes, live events, webhooks, static files
server/auth.js        accounts, sessions, invites
server/posts.js       post rules: approvals, comments, likes, reposts
server/publisher.js   scheduler and per-network sending
server/chat.js        team chat
server/inbox.js       social DMs: storage, replies, sync, Meta webhooks, Discord gateway
server/oauth.js       network logins and token refresh
server/platforms/     one module per network
test/api.test.js      end-to-end API tests with a fake network
```
