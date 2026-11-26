# Stream reports

CTD Relay records a report of every stream: how many people watched on each platform over time,
how busy the chat was, what went wrong and when, and, on your own self-hosted Relay, who in your
audience chats, joins and watches the most. You read them on the **Reports** page and export them
to **Excel (.xlsx)**, CSV or JSON.

- Web UI: **Reports** in the main menu. Any signed-in user can read reports; only an admin changes
  the recording settings or forgets a viewer.
- API: `GET /api/v1/reports/…` with a token that has **Read stream reports** (`reports:read`),
  docs/API.md §16.
- Code: `server/src/reports/` (recorder, store, math, exports), `web/src/pages/ReportsPage.tsx`.

## What a "stream" is

One report per **session**: a profile going live, from the moment its session starts (OBS connects
and auto go-live starts it, or you press Go live) until the profile is offline again. Each profile
has its own reports. A Relay restart during a stream ends that report at the last moment Relay
recorded it (marked "Relay restarted during this stream"); the stream that starts after the
restart is a new report.

## What is recorded

| What | How often | Notes |
|---|---|---|
| Title | every change, with the time | |
| Test mode | once | Test-mode streams are left out of date-range totals and leaderboards unless you include them |
| Destinations | once per destination | platform, name, canvas (landscape/vertical), Twitch Dual Format mode |
| Live periods | each start and end | a recovery (the platform ended the live and Relay made a fresh one) starts a new period |
| Events | as they happen | live, offline, retrying, recovery (with reason), error (with message), blocked feed, feed online/offline, title change |
| Issues | as they happen | the alerts open during the stream (docs/API.md §17): what went wrong, what it affected, its worst severity, when it started and cleared, how it ended. Read from the **7-day issue history** (below), not stored in the report tables |
| Viewers | every 30 s per destination, and whenever the count changes | **unknown is stored as unknown (null), never as 0** |
| Chat | per platform per minute | messages, joins, other events (subs, gifts, raids…), distinct chatters |
| Feeds | per minute per canvas | online or not, codec, resolution, fps, average bitrate, keyframe interval |
| Audience | per person per stream | see below; only with audience tracking on |

Messages' **text is never stored** in reports, only counts and times.

Recording listens to Relay's internal events and never sits in the go-live path: if writing a
report fails, it is logged and streaming carries on. Its event handlers only update memory; the
database writes are queued and written together in one transaction right after (chat counts and
people every 30 s with the viewer sample), so a busy chat costs no database work while messages are
passed on. If Relay stops abruptly, up to the last 30 s of chat counts can be missing from that
report.

## Audience

With **Audience tracking** on (the default), Relay keeps, per person and per stream:

- who: the platform's user id when the platform gives one (Twitch, YouTube, Kick…), otherwise the
  display name (`<platform>:name:<display name>`, the same id the chat API uses); the latest
  display name;
- messages, joins, other chat events, the time of their first and last message;
- **presence**, only where the platform tells Relay who is there. Today that is **Twitch**: every
  5 minutes Relay reads the channel's chatters list (Twitch "Get Chatters", which needs the
  `moderator:read:chatters` permission; it is asked for when you connect or reconnect the Twitch
  account). Someone in two samples in a row is credited the time between them (at most 10
  minutes, so a missed sample is not counted as watching). Twitch lists logged-in chat users only,
  a few minutes behind.
- On every other platform nobody has a watch time ("not reported"). Someone **attended** a stream
  when they chatted, joined (Instagram/TikTok "joined" lines) or appeared in a presence list.
  Relay never makes up watch time.
- Instagram's "*name* and 3 others joined": *name* gets a join; the 3 are added to that stream's
  **anonymous joins** (no names).

### Privacy controls (Reports → Recording and privacy, admin)

- **Record stream reports**: off stops recording; a stream being recorded ends its report now.
- **Audience tracking**: off records counts only (no names or ids in report tables) from the next
  message on. Distinct-chatter counts are still worked out in memory, never stored per person.
- **Audience tracking** turned off during a live also drops what was added up about people since
  the last write (at most 30 s); nothing more about people is written.
- **Keep reports for**: **365 days** (the default), 90 days or keep everything. Older streams are deleted (checked at
  start-up, when you change the setting and every 6 hours), and so is everyone only seen in them.
  Deleting goes 20 streams per transaction and pauses every 50 ms, so a large clean-up never holds
  the database or the server for long.
- **Forget this user** (on a viewer's page): deletes every report row about them, including what the
  recorder holds in memory during a live (their counts since the last write, and their last
  presence sample, so no watch time is credited from before). The deleted bytes are overwritten
  and the database's write-ahead log is emptied, so the name is not left behind in `app.db` or
  `app.db-wal`. **Backups and dataset snapshots taken before keep their copy**: forgetting can't
  reach them. The audit log says "reports.forget_user: a twitch viewer", without the name. If they
  chat again later they are recorded again as a new viewer (turn audience tracking off to stop that
  for everyone).

Reports hold personal data about your viewers (names and when they were there). Treat exports and
`reports:read` tokens accordingly.

## How the numbers are worked out

- **Duration**: session start to end (to now while live).
- **Live time / uptime**: time at least one destination of the platform was live. For one
  platform, uptime = live time ÷ duration. The total's uptime is the mean over every destination.
- **Concurrent viewers**: a viewer sample holds until the next sample of that destination, for at
  most 90 s (three missed samples). Longer gaps are unknown. A platform's value is the sum of its
  destinations (e.g. YouTube landscape + vertical); the **total** is the sum of the platforms that
  reported a count at that moment, so the total dips when one platform stops reporting. It is
  unknown when no platform reports.
- **Peak** (and when), **average concurrent viewers**: the average is time-weighted over the time
  the count was known (unknown time is not counted as zero viewers).
- **Viewer-minutes**: viewers × minutes (10 people for 30 minutes = 300). It is **not** unique
  viewers; platforms do not tell Relay how many different people watched.
- **Chat per 1k viewer-minutes**: messages ÷ viewer-minutes × 1000.
- **Unique chatters**: distinct people with at least one message, per platform (a person on two
  platforms counts twice). Over a date range it needs audience tracking (people are matched
  across streams); without it the range shows "—".
- **Recoveries**: fresh lives Relay made after a platform ended one. **Errors**: destinations that
  went to error or were blocked (e.g. an HEVC feed).
- **Date range**: streams that *started* in the range (days in your browser's time zone). Sums for
  counts and viewer-minutes, the highest peak, averages over all the known time.

### Leaderboards

Per stream or date range, all platforms or one:

| Board | Ranks by |
|---|---|
| Top chatters | messages |
| Most loyal | streams attended (chatted, joined or present) |
| Longest watch time | watch time; only people on platforms that report presence |
| Newest regulars | people whose first recorded stream is in the range and who came to at least 2 streams in it (for one stream: first-timers) |

Click a name to see that person's streams.

## Export

On a stream: **Export: Excel (.xlsx)**, **CSV (.zip)**, **JSON**. On the list: **Export period**
(every stream in the date range, with an "All streams" row). Times in the .xlsx and CSV are in your
browser's time zone (the column headers name it); JSON times are UTC.

The **.xlsx** is written by Relay itself (no add-ons, no macros, no formulas). Every sheet has a
frozen header row and column widths; dates are real Excel dates, durations real Excel times
(`[h]:mm:ss`), percentages and numbers are numbers, and unknown values are empty cells.

| Sheet | One row per |
|---|---|
| Summary | stream (+ "All streams" for a range) |
| Per platform | stream and platform, plus Total |
| Viewers | 30 s sample: a column per platform + Total; a line chart beside it (one stream) |
| Chat per minute | minute and platform |
| Events | event |
| Top chatters | person (up to 500) |
| Audience | person per stream |
| Anonymous joins | stream and platform |
| Feeds | minute and canvas |
| Issues | issue open during the stream: started, severity, issue, affects, detail, cleared, duration, how it ended, kind |

The CSV export is the same tables, one UTF-8 CSV file per sheet in a .zip. Names that start like a
spreadsheet formula (`=`, `+`, `-`, `@`) are prefixed with `'` so a spreadsheet does not run them.

## Storage and upgrades

Reports live in `app.db` (DATA_DIR) in tables named `report_*` and `audience_*`, with their own
schema version in `reports_meta`. The main schema (`PRAGMA user_version`) stays at **v4**, so
rolling back to 0.2.40 or earlier still starts: older versions ignore these tables. Updating again
continues where it left off. Back them up with `app.db` as usual.

Size, measured on a simulated 90-minute stream on 6 destinations (`npx tsx scripts/report-sample.ts`):
about 470 KiB in `app.db`, most of it viewer samples. Plan on **about 25–30 KiB per destination
per hour** plus a little per chatter: a 4-hour stream on 5 destinations is roughly 0.6 MB, so
streaming daily adds roughly 55 MB per 90 days or 220 MB per year. The default, 365 days, keeps it
at about that (freed space is reused, the file does not shrink); 90 days keeps less, "keep
everything" keeps growing by that much.

The report tables are created in a few milliseconds (new tables only; nothing existing is
rewritten). Lists and date ranges keep the worked-out numbers of streams that have ended in memory,
so after the first look (or a few seconds after start-up, when Relay works them out in the
background one stream at a time) the Reports page does not read every viewer sample again.

## Issues in a report

A stream's **Issues** (on its page and in the Issues sheet) are the issues (docs/API.md §17) that
were open at any time during it: raised during the stream, or raised before and still open when it
started (an OBS camera that was already offline). They come from the **issue history**, which keeps
issues for **7 days** after they cleared (at most 5,000), in its own table (`issue_history`, own
schema track, docs/CONTRACTS.md → Storage conventions); the report tables themselves are unchanged.
So a stream older than 7 days shows "its issues are no longer kept", not "no issues". The `issues`
field of the JSON export and of `GET /api/v1/reports/sessions/{id}` is the same list (UTC ISO times).

## Past streams

Streams from before this version **cannot be backfilled**: Relay kept no viewer counts, chat
counts or audience before (chat lived only in memory). The audit log has go-live start and stop
times, which would only give empty reports, so none are made. Reports start with the first stream
after the update.
