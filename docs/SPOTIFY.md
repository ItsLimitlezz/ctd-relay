# Spotify: now playing and chat song requests

Each streaming profile can connect a Spotify account. Relay then:

- **reads what plays** (title, artists, album art, progress) and sends it to the CTD Overlay, the
  OBS plugin, the phone app and any other API client (`music.nowplaying`, [API §13](API.md#13-spotify-now-playing-and-song-requests-v18));
- **takes song requests from chat**: a viewer types `!sr <song>` on Twitch, Kick, YouTube or any
  other chat Relay reads, and Relay adds the best match to your Spotify queue. `!song` tells
  chat what is playing.

Relay never controls playback: it doesn't skip, pause or change the volume.

> **Music on stream:** this shows and queues Spotify songs; it doesn't send Spotify's audio
> anywhere. Playing licensed Spotify music on Twitch, Kick or YouTube can get your stream muted or
> a DMCA strike. That risk is the same with or without Relay.

## What you need

- **Spotify Premium** on the account that owns the developer app. Spotify requires it for apps in
  Development Mode, and adding to the queue needs Premium on the account you play on.
- A free **Spotify developer app** (once, shared by every profile).

## 1. Create the Spotify app

1. Open [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard), sign in and click **Create app**.
2. **App name / description:** anything, e.g. "CTD Relay".
3. **Redirect URI:** `http://127.0.0.1:8888/callback`. Paste it and click **Add**. It must match exactly.
4. **Which API/SDKs are you planning to use?** Tick **Web API**, accept the terms and **Save**.
5. If the Spotify account you play music on is not the app's owner, add it under **User
   Management** (Development Mode allows up to 5 users).
6. Open the app's **Settings** and copy the **Client ID**. No client secret is needed.

## 2. Connect it in Relay

1. **Settings → Spotify**, paste the Client ID, **Save**.
2. Pick the profile in the top bar, then click **Connect Spotify** → **Open Spotify** and approve.
3. Spotify sends you to `http://127.0.0.1:8888/callback?code=…`, a page that doesn't load. That's
   expected. Copy the whole address from the address bar, paste it into Relay and click **Finish**.

Repeat step 2 for every profile that should use Spotify (each can use its own account).

## 3. Song requests

Under **Song requests**: turn on **Take song requests (!sr)** and choose:

| Setting | Default | |
|---|---|---|
| Who can request | Everyone | Everyone / subscribers (YouTube members too), VIPs and moderators / VIPs and moderators / moderators only. Moderators and the broadcaster always may. |
| Cooldown per viewer | 60 s | Moderators have none. |
| Longest song | 10 min | |
| Allow explicit songs | On | When off, Relay picks the first clean match. |
| Chat replies | On | Adds "🎵 NightOwl added …" (or why not) to Relay's chat. |

Viewers can type `!sr daft punk one more time` or paste a Spotify song link
(`!sr https://open.spotify.com/track/…`). Other links (YouTube, albums, playlists) are refused.

Relay can't write in the platforms' own chats, so the replies show where Relay's chat is shown:
the dashboard, the OBS dock and the chat overlay. **Spotify must be playing on a device**
(desktop app, phone…) for songs to be added. Otherwise the request is refused with "Spotify is
not playing on any device right now".

The latest 20 requests are listed under Song requests.

## Troubleshooting

| Message | Fix |
|---|---|
| "Spotify rejected the Client ID" | Copy the Client ID again from the app's Settings. |
| "INVALID_CLIENT: Invalid redirect URI" on Spotify's page | The app's Redirect URI must be exactly `http://127.0.0.1:8888/callback`. |
| "Spotify refused … User Management …" | Add the account under User Management in the Spotify app; the app's owner needs Premium. |
| "The Spotify login expired. Connect Spotify again." | Click **Connect again** in Settings → Spotify. |
| "Adding to the queue needs Spotify Premium." | The account you play music on needs Premium. |
