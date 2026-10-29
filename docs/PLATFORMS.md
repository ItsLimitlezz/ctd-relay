# Platforms

How each platform is supported, how to connect it, and how to register the free developer apps some of them need.

## Overview

| Platform | Default feed | Connect with | Stream key | Title | Chat (read-only) | Status |
|---|---|---|---|---|---|---|
| [Twitch](#twitch) | landscape (+ vertical with Dual Format) | Device code + your Twitch app | API | API | Twitch chat (IRC) | Supported. Relaying both feeds as Dual Format is **experimental** (Twitch currently refuses it). |
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

**Accounts → Add account → Twitch → Connect.** The app shows a code. Open [twitch.tv/activate](https://www.twitch.tv/activate), enter it and approve. The app asks for permission to edit your broadcast (title), read your stream key and read your followers (for follow alerts).

### Notes

- **Alerts:** subs, gifted subs, Bits and raids come from chat; **follows** come from Twitch EventSub while the destination is live. An account connected before follow alerts existed shows "Reconnect this account to turn on follow alerts": click **Connect** on it once.
- **Dual Format** modes per destination: "Relay one feed" (default), "OBS sends Dual Format directly", or "Relay both feeds as Dual Format": the app encodes the tracks Twitch's Enhanced Broadcasting asks for (two per feed) on the server and publishes them with the required performance metrics. See [OBS setup](OBS-SETUP.md#twitch-dual-format).
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
