# Postboard

A small social media scheduler in one HTML file. Open `index.html` in a browser; everything is saved in that browser's localStorage and it starts with sample data for a fictional coffee roaster.

## What it does

- **Calendar**: 1 week, 2 weeks or 1 month, plus a list view. Campaign bands span days, cards show time, labels, channels, format and team activity. Drag a card to another day to reschedule. Filter by channel, label or status.
- **Composer**: bold and italic (toolbar or Ctrl/⌘+B, Ctrl/⌘+I), hashtags and mentions, media upload, labels, tagged accounts, feed post / reel / story, and a live preview per network with its character limit (X uses its weighted count).
- **Scheduling and sending**: Schedule, or Send now. Due posts go out while the page is open (checked every 20 seconds).
- **Approvals**: approvers per post, a workspace default, Approve / Request changes, and an Approvals queue. Use "Acting as" in the sidebar to switch teammates.
- **Team**: likes, comments with @mentions that notify teammates, and "I'll repost" sign-ups. Mentions, approval requests and send results land in the Inbox.
- **Analytics**: impressions, engagements, rate, posts, team amplification, a daily chart, per-channel bars, top posts and a best-time heatmap.
- **Grid & profile preview**: a phone-style profile per network with Grid, Feed, Reels and Stories tabs. Drag one upcoming grid tile onto another to swap their send times.

## Networks

Instagram, LinkedIn, X, TikTok, Facebook, Threads, Discord and YouTube.

| | Formats | Bold/italic |
|---|---|---|
| Instagram, TikTok, Facebook | Post, reel, story | Unicode letters |
| YouTube | Community post, Short | Unicode letters |
| LinkedIn, X, Threads | Post | Unicode letters |
| Discord | Message | Native markdown |

**Discord sends for real** through a channel webhook (Channels → paste the webhook URL). The other seven networks need an approved developer app on each platform and a server that holds OAuth tokens, so their sends are simulated and logged. Each one is a single function in `PUBLISHERS` inside `index.html`. Analytics are sample numbers generated from published posts until those insights APIs are connected.
