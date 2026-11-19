# Platforms

How each platform is supported, how to connect it, and how to register the free developer apps some of them need.

## Overview

| Platform | Default feed | Connect with | Stream key | Title | Chat (read-only) | Status |
|---|---|---|---|---|---|---|
| [Twitch](#twitch) | landscape (+ vertical with Dual Format) | Device code + your Twitch app | API | API | Twitch chat (IRC) | Supported. Relaying both feeds as Dual Format is **experimental** (not yet tested with a real stream). |
| [YouTube](#youtube) | landscape and/or vertical | Device code + your Google app | API (a new broadcast per stream) | API | API | Supported |
| [Kick](#kick) | landscape | OAuth + your Kick app | Pasted once | API | Kick's public chat feed | Supported |
| [Facebook Page](#facebook) | landscape | OAuth + your Meta app | API (a new live video per stream) | API | API | Supported |
| [Facebook profile](#facebook) | landscape | Browser login | Persistent key, pasted once | Browser | Browser | **Experimental** |
| [X](#x) | landscape | Browser login | Live Studio source, pasted once | Browser | Browser | **Experimental** |
| [Instagram](#instagram) | vertical | Browser login | Browser, **new key every stream** | Browser | Browser | **Experimental** |
| [TikTok](#tiktok) | vertical | Browser login | Browser, **new key every stream** | Browser | Browser | **Experimental** |
| [Custom RTMP](#custom-rtmp) | either | None | Pasted once | — | — | Supported |

- **API** means the platform's official API. **Browser** means the app drives the platform's website in its built-in Chromium (Playwright). Browser automation is best-effort and can break whenever a platform changes its site.
- **Title:** one shared title for every platform, set on the dashboard. The app only ever changes the **title**. It never touches the category, game or topic. Titles longer than a platform allows are shortened for that platform.
- **Chat** is read-only: messages from every platform are merged into one view (and an optional OBS overlay). Replying is not supported.

## The three steps

1. **Developer app** (Twitch, YouTube, Kick, Facebook Page only). An open-source, self-hosted app can't ship shared API secrets, so you register your own free developer app once and paste its credentials into **Settings → Developer apps**. The steps for each platform are below and also shown in the app.
2. **Account**: **Accounts → Add account**, pick the platform, then **Connect**.
3. **Destination**: **Destinations → Add destination**. Pick the platform, the connected account, the feed (landscape or vertical) and the platform's options. You can create several destinations per platform, for example a landscape and a vertical YouTube destination.

Only admins can manage developer apps, accounts and destinations. Operators can go live, change the title, read chat, and turn destinations on or off.

---

## Twitch

**What works:** relays the landscape feed (or Dual Format, see [OBS setup](OBS-SETUP.md#twitch-dual-format)); reads your stream key from the API, so there's nothing to paste; sets the title before and during the stream; reads chat.

### Developer app

1. Turn on two-factor authentication on your Twitch account. The developer console requires it.
2. Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → **Register Your Application**.
3. **Name:** anything unique, e.g. `CTD Relay <your name>`.
4. **OAuth Redirect URLs:** `http://localhost`. It isn't used (the app signs in with the device code flow), but the form requires one.
5. **Category:** Broadcaster Suite.
6. **Client Type:** **Public**.
7. **Create**, then **Manage** → copy the **Client ID** into **Settings → Developer apps → Twitch**. No client secret is needed.

### Connect

**Accounts → Add account → Twitch → Connect.** The app shows a code. Open [twitch.tv/activate](https://www.twitch.tv/activate), enter it and approve. The app asks for permission to edit your broadcast (title), read your stream key, read your followers (for follow alerts) and read the chatters list (for watch time in [stream reports](REPORTS.md)).

### Notes

- **Alerts:** subs, gifted subs, Bits and raids come from chat; **follows** come from Twitch EventSub while the destination is live. An account connected before follow alerts existed shows "Reconnect this account to turn on follow alerts": click **Connect** on it once.
- **Dual Format** modes per destination: "Relay one feed" (default), "OBS sends Dual Format directly", or "Relay both feeds as Dual Format": the app encodes the tracks Twitch's Enhanced Broadcasting asks for (two per feed) on the server and publishes them with the required performance metrics. See [OBS setup](OBS-SETUP.md#twitch-dual-format).
- **Watch time in reports** comes from Twitch's chatters list (`moderator:read:chatters`), read every 5 minutes while live. Accounts connected before stream reports existed don't have that permission: reports show "No watch time" until you click **Connect** on the account once.
- **Bandwidth test** (destination option) streams to Twitch without going live publicly, which is handy for testing.
- Twitch expires the sign-in of a public-client app after about 30 days without use. If you haven't streamed for a month, the account may ask you to connect again.

## YouTube

**What works:** landscape and vertical (create one destination per feed; each becomes its own broadcast, and vertical lives can show in the Shorts feed). For every stream the app creates a broadcast with your title and options, sends video to a reusable stream, updates the title while live, reads chat, and ends the broadcast when you stop.

**Destination options:** privacy (public, unlisted, private), latency (normal, low, ultra-low), made for kids, chat on/off.

**Before you start:** live streaming must be enabled on your channel ([youtube.com/features](https://www.youtube.com/features)). The first time, YouTube can take up to 24 hours to enable it.

### Developer app

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library** → **YouTube Data API v3** → **Enable**.
3. **Google Auth Platform** (formerly "OAuth consent screen") → **Get started**: app name, your e-mail, **Audience: External**, contact e-mail, create.
4. **Audience → Test users:** add the Google account that owns your channel.
5. **Audience → Publish app** so the status becomes **In production**. This matters: while an app is in "Testing", Google expires its refresh tokens after 7 days and you would have to reconnect every week. Your own app doesn't need Google's verification for personal use.
6. **Clients → Create client** → application type **TVs and Limited Input devices** → **Create**.
7. Copy the **Client ID** and **Client secret** into **Settings → Developer apps → YouTube**.

### Connect

**Accounts → Add account → YouTube → Connect.** Open the link shown (google.com/device), enter the code and choose the account that owns the channel. Because the app is yours and unverified, Google shows "Google hasn't verified this app": choose **Advanced → Go to … (unsafe)** and allow access.

### Notes

- The YouTube Data API has a daily quota (10,000 units by default). Reading chat uses most of it, so chat is polled at a modest rate and can lag a few seconds.

## Kick

**What works:** relays the landscape feed with your stream key, sets the title through the official API before and during the stream, and reads chat.

### Developer app

1. Turn on two-factor authentication on your Kick account. The developer settings require it.
2. Go to [kick.com/settings/developer](https://kick.com/settings/developer) and create an app.
3. **Redirect URL:** copy it from **Settings → Developer apps → Kick** in CTD Relay. It looks like `https://<your-address>/oauth/callback/kick`.
4. Enable the scopes the app lists there.
5. Copy the **Client ID** and **Client Secret** into **Settings → Developer apps → Kick**.

### Connect

**Accounts → Add account → Kick → Connect** opens Kick's authorization page. After you approve, the browser goes to the redirect URL. If CTD Relay is reachable at that address and you are logged in, it finishes on its own. If the page doesn't load (for example, you're on the LAN and your router doesn't support NAT loopback), copy the full URL from the address bar and paste it into the app.

### Destination

Paste your stream key from the Kick dashboard (**Settings → Stream URL & Key**) into the destination when the app asks for it. The default server URL is filled in for you.

### Notes

- Chat is read from Kick's public chat feed (a Pusher websocket with a built-in app key), which is not an official API and may change. If chat fails with "Kick may have changed its chat key", set the new key and cluster with the `KICK_PUSHER_KEY` and `KICK_PUSHER_CLUSTER` environment variables (default cluster `us2`; see [`.env.example`](../.env.example)) and restart the app.

## Facebook

When you add a Facebook account you pick a mode:

- **Page** (recommended): your Facebook Page through Meta's official Live Video API.
- **Profile** (**experimental**): your personal profile, with a persistent stream key and browser automation.

### Page mode

**What works:** a new live video on your Page for every stream (the app gets the stream URL automatically), the title set and updated while live, comments as chat, and the live video ended when you stop.

#### Developer app

These steps match the ones shown in **Settings → Developer apps → Facebook**.

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app**, and enter a name and your e-mail.
2. Choose the use case **Manage everything on your Page**. Connecting a business portfolio is optional.
3. In the dashboard, **customize** that use case and add the permissions `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` and `pages_read_user_content`. The first three are required to connect; `pages_read_user_content` is used for chat (commenter names). `pages_show_list` may already be included, which is fine.
4. Open **Facebook Login for Business** (or **Facebook Login**) → **Settings** and add the redirect URI shown in **Settings → Developer apps → Facebook** (`https://<your-address>/oauth/callback/facebook`) to **Valid OAuth Redirect URIs**, then save.
5. Leave the app in **Development** mode. As the app's admin you can use it with your own Pages without App Review; only accounts with a role on the app can connect.
6. **App settings → Basic:** copy the **App ID** and **App secret** into **Settings → Developer apps → Facebook**.
7. Optional: if the login dialog insists on a configuration, create one under **Facebook Login for Business → Configurations** (token type **User access token**, the same permissions) and paste its ID into **Login configuration ID**. With a configuration ID set, the app doesn't request permissions itself, so the configuration must include them.

An "Invalid Scopes" error in the Facebook login dialog means the permissions in step 3 weren't added to the use case (or to the configuration).

#### Connect

**Accounts → Add account → Facebook**, mode **Page** (optionally a Page ID; empty = your first Page) → **Connect**. Approve the permissions and select your Page. Finishing works the same way as for [Kick](#kick): automatic, or paste the final URL.

### Profile mode (experimental)

1. In [Live Producer](https://www.facebook.com/live/producer), choose streaming software and turn on the **persistent stream key**. Copy the server URL and stream key into the destination.
2. **Connect** the account and log in to Facebook in the browser view, so the app can set the title and read comments.

Video always goes out with the persistent key. Title and comments are best-effort browser automation: if they fail, the app logs a warning and keeps streaming.

## X

**Experimental.** Requires **X Premium** and access to **Live Studio**, which X offers in selected regions only.

1. Open [Live Studio](https://studio.x.com/) (Creator Studio → Live Studio), create a source of type **RTMP** in the region closest to you, and copy its **server URL** and **stream key** into the destination. The source is reusable.
2. **Connect** the account and log in to X in the browser view. The app uses the session to set the title, go live and read chat where X requires it.

Video goes out with the pasted source. The browser steps are best-effort.

## Instagram

**Experimental.** Vertical feed only.

**Eligibility:** Instagram only lets accounts go live that meet its rules. Since August 2025 that includes a **public account with at least 1,000 followers**. The account must be able to start a live video from instagram.com on a computer.

**How it works:** for every stream the app opens Instagram's live setup in its browser, sets the title and audience, reads the **new** stream URL and key, sends the vertical feed, waits for Instagram's preview and clicks **Go live**. It reads comments during the live and ends it when you stop.

**Destination options:**

- **Audience:** Public, or **Practice** (only you can see it). Use Practice to test.
- **Go-live timeout:** how long to wait for Instagram to receive the video (default 90 s).

The title can't be changed after the live has started.

### How the comments are read

Instagram has no live chat API, so the app reads the **Comments** panel of Instagram's live page in its own browser, once a second:

1. It opens the **Comments** tab when the panel is not showing, and again whenever the page goes back to another tab.
2. It finds the comments container, then the comment rows in it, and reads each row: who wrote it and the text. Mentions, emoji and long comments come through as written.
3. It decides which rows are new. A row is delivered once, also when Instagram re-renders the list, drops old rows from a long list, shows them again after scrolling, or reloads the page. The same words posted twice are two comments.

What is not a comment:

- "<name> joined" lines are delivered as **events** with `join: true` (docs/API.md → `chat.message`), so a chat box can hide them.
- A **pinned** copy of a comment is not delivered again.
- Instagram's own **notices** in the list ("We're telling your followers…") are dropped.
- Whatever was already on screen when the reader started is not delivered. Comments written while the Comments tab was not open yet are delivered when it opens.

### Tuning the chat reader live

Instagram changes its page often. Everything the reader knows about the page is in a **selector pack**: CSS selectors, attribute names, text patterns and timings, as JSON. The pack built into the app is the default. An operator can put an **override** on top of it while a live is running. The reader uses it on its next poll (within a second), and it is kept across restarts. **Settings → Advanced → Instagram chat reader** shows which pack is active and has **Revert to built-in**.

A pack is data only. It can't run code: selectors are only used to find elements, and patterns are only tested against short pieces of text. The server refuses a pack that is too large (16 KB), has unknown settings, has anything that is not a plain CSS selector, or has a pattern that is slow on long input.

You need an API token with the **Operator tools** permission (`system:admin`). Create it in **Settings → API** for **every profile**, give it only to someone you trust, and revoke it when the work is done. Apps can't get this permission by pairing. The routes are in docs/API.md §15. In the examples, `$RELAY` is your Relay's address and `$TOKEN` the token.

**1. Look at what the reader sees** (during a live):

```bash
curl -s -X POST "$RELAY/api/v1/platforms/instagram/chat/debug" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

The answer has, for each Instagram live being read:

- `reader`: which container strategy matched (`container`), how many rows it found (`rows`), what happened with the Comments tab (`tab`), how many comments it kept and dropped, and pack entries the page could not use (`bad`).
- `snapshot.tree`: the structure of the comments panel. Tag names, class names, roles and attribute names are there. **Text is not**: every text is replaced by its length, links by their depth (`path/1`), and other attribute values by their shape (`word/12`, `digits/5`). Labels such as `alt` and `aria-label` show interface words only, with every other word as `#` marks (`profile photo of ##########`). No user names, no comment text, no addresses, no cookies. Elements the reader tagged carry `"ctd": "container"` or `"ctd": "row"`.
- `snapshot.selectors`: for every selector in the pack, how many elements it matches in the page and in the container. `snapshot.patterns`: how many labels each label pattern matches.
- `decisions`: the last parse decisions. Each says `kept` or `dropped` and why (`new`, `late`, `baseline`, `rerender`, `pinned`, `system`, `duplicate-id`, `pack-changed`), with lengths only.

When no panel is found, send `{"scope": "page"}` to get the whole page's structure, or `{"up": 2}` to start two parents above the container.

**2. Send an override** with only the settings you change:

```bash
curl -s -X PUT "$RELAY/api/v1/platforms/instagram/chat/selector-pack" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{
    "schema": 1,
    "version": "2026-11-20 a",
    "note": "comment rows moved to data-comment-id",
    "container": { "css": ["[data-testid=\"live-comments\"]"] },
    "row": { "css": ["[data-comment-id]"], "idAttrs": ["data-comment-id"] },
    "text": { "css": [".xtext"] }
  }'
```

`version` is your own label. A list you send replaces the built-in list. A `400` answer lists every problem with its path (`row.css.0: …`). `GET` on the same address returns the active pack with every setting, which is the easiest way to see the built-in values.

**3. Check** with the debug capture again: `reader.rows` should be above zero and `decisions` should show `kept` entries as comments arrive. When the old pack could not read anything, the comments on screen are delivered once the new pack works. When the old pack was reading, the first read under the new pack is a new baseline (nothing is delivered twice).

**4. Go back** any time: `curl -X DELETE …/selector-pack`, or **Revert to built-in** in Settings → Advanced.

What each part of a pack does:

| Setting | What it is for |
|---|---|
| `tab.css`, `tab.roles`, `tab.name` | The **Comments** tab the reader clicks when no panel is showing: a selector, else an element with one of the roles whose name matches the pattern. |
| `container.css` | The element that holds the comments. Tried first. |
| `container.panelLabel` | Else: a tab panel, a labelled element or a heading whose label matches this pattern. |
| `container.composerCss`, `composerHint` | Else: the area around the comment box (an input whose placeholder or label matches the hint). |
| `row.css` | One comment row. When set, the avatar rule below is not used. |
| `row.avatarCss`, `row.avatarAlt` | Else: a row is the smallest element around one avatar that also holds text. `avatarAlt` reads the user name from the avatar's alt text (capture group 1). |
| `row.fallbackCss`, `row.excludeCss`, `row.maxAvatars` | Rows without an avatar; what a row never contains (the comment box); how many avatars a row may hold. |
| `row.idAttrs` | Attributes that hold a comment id. With an id, a comment can never be delivered twice. |
| `text.css` | The element holding the comment text. When set, only its text is the comment. |
| `text.authorCss`, `text.skipCss`, `text.emojiCss` | Where the user name is when the avatar does not give it; elements whose text is never comment text; images read as emoji. |
| `text.meta` | Patterns for labels inside a row that are not comment text ("Reply", "2m"). |
| `classify.event`, `classify.join` | Text that makes a row an event, and which events are "joined" lines. |
| `classify.system`, `systemCss` | Instagram's own notices, dropped. |
| `classify.pinned`, `pinnedCss` | What marks a pinned copy, dropped. |
| `composer.css`, `composer.post` | The comment box and its Post button, used only for the test comment of a Practice live. |
| `timing.pollMs`, `tabRetryMs`, `backoffMaxMs` | How often the panel is read, how often the tab is tried again, and the longest wait between tries while the page is reloading. |
| `limits.maxRows`, `limits.history` | How many rows are read at most, and how many delivered comments are remembered to recognise re-rendered rows. |

Selector changes need no release. A change to how the reader *works* (not just where it looks) still does. Send the debug capture with the report: it is safe to share.

## TikTok

**Experimental.** Vertical feed only.

**Eligibility:** you need TikTok **LIVE stream key access** (LIVE Producer). TikTok reportedly requires about 1,000 followers, age 18+, an account in good standing, and it varies by region. Without access the account shows "not eligible".

**How it works:** like Instagram, through TikTok LIVE Producer: set the title, generate the new server URL and key, send the vertical feed, click **Go LIVE**, read comments, and **End LIVE** when you stop. The app never changes the LIVE topic. If TikTok requires one and none is selected, pick it once yourself in LIVE Producer.

## Custom RTMP

Any RTMP or RTMPS server: Trovo, Owncast, a friend's restreamer, another CTD instance. Enter the server URL and, optionally, a stream key (appended to the URL). Title and chat are not supported.

---

## Browser login

Instagram, TikTok, X and Facebook profile are driven through a real Chromium browser inside the app. Connecting such an account:

1. **Accounts → Connect** opens a live view of that browser in the web UI (admins only).
2. Log in by hand, including 2FA and captchas. **The app never stores or types your password.**
3. Click **I'm logged in**. The app saves the session (cookies and site storage) encrypted on the server.

Each account gets its own isolated browser session. When a platform ends the session, the account shows **needs login**: connect it again.

Things to know:

- Platforms can change their websites at any time. When that breaks a step, the destination shows an error and the other platforms keep streaming.
- The app acts at a human pace and reuses one long-lived session per account to avoid looking like a bot, but platforms may still flag or limit automated use. Automating a website may also conflict with its terms of service. Decide for yourself whether that's acceptable for your account.
- The browser login view controls live sessions to your accounts. Only admins can open it, and every use is written to the audit log.
