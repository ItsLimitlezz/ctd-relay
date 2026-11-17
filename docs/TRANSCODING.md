# Per-destination transcoding (design)

> Status: **draft for review** (Mid, 2026-11-09). Issue: ItsLimitlezz/ctd-relay#1.
> Items marked _(verify)_ are platform limits to confirm against current platform docs before the
> profile defaults ship.

## 1. What and why

Today Relay never re-encodes: every destination gets the feed OBS sent (`-c copy`), so the OBS
output has to suit the strictest platform on that feed (ARCHITECTURE.md §5.2). Issue #1 asks for
the opposite: send **one high-quality feed** (for example 3440×1440 AV1) and let Relay make what each
platform accepts:

| Destination | Gets |
|---|---|
| YouTube | the original, copied (AV1 3440×1440) |
| Twitch | 1920×1080 (or 1920×804 letterboxed to 1080) H.264, 60 fps, 6 Mbps |
| Kick | 1920×1080 H.264, 60 fps, 8 Mbps |

### Hard rules

1. **Off by default, opt-in per destination.** A destination without a transcode profile behaves
   exactly as today: same FFmpeg arguments, same process, same restart logic. No code path of a
   copy destination changes.
2. **Hardware-gated.** Relay only offers what this machine has proven it can do (§4). The
   owner's server (AMD HD 7870: no AV1 or HEVC decode, H.264-only VCE 1.0) must keep working
   unchanged. On that machine the UI shows what is possible and refuses what is not.
3. **A transcode failure never touches a copy destination.** Copy destinations keep reading the
   original feed; the transcode worker is a separate process (§5).
4. **Degrade, don't drop.** If an encode falls behind real time, the destination falls back to copy
   when the platform can take the original, otherwise it warns and keeps trying (§7).

### Non-goals (this feature)

- Transcoding inside the Twitch Dual Format / IVS path (`mode: 'ivs'`): it already encodes with x264
  and has its own rules (ARCHITECTURE.md §5.3). It may later reuse the encoder selection from §4.
- HDR / 10-bit output, audio mixing, overlays burned in by Relay, recording.
- Adaptive "ladder" outputs (several renditions to one platform). One destination = one rendition.

## 2. Transcode profile (per destination)

Stored with the destination (new nullable `transcode` JSON column). `null` = copy, as today.

```ts
/** shared/types.ts (proposed, additive) */
export type VideoCodec = 'h264' | 'hevc' | 'av1';

export interface TranscodeProfile {
  /** 'copy' keeps today's behaviour (also what `transcode: null` means). */
  mode: 'copy' | 'transcode';
  video: {
    codec: VideoCodec;
    /** Output frame size. The source is scaled to fit and letterboxed/pillarboxed, never stretched. */
    width: number;
    height: number;
    /** null = keep the source rate. Otherwise 24..60 (fps filter; drops/duplicates frames). */
    fps: number | null;
    /** Constant bitrate (CBR / nal-hrd) in kbit/s. */
    bitrateKbps: number;
    /** Keyframe every N seconds. Fixed at 2 in the UI (every platform asks for 2 s); kept as a field for custom RTMP. */
    keyframeSec: number;
    /** 'auto' = best working encoder for the codec (§4.3); or a specific encoder name from the capabilities. */
    encoder: 'auto' | string;
  };
  /** 'copy' keeps the source audio when it is AAC; otherwise AAC is forced. */
  audio: 'copy' | { codec: 'aac'; bitrateKbps: number };
  /** What to do when the encode can't keep up or the encoder is gone (§7). */
  fallback: 'copy' | 'stop';
}
```

Defaults the UI fills in from the platform limits (§3) when the user turns transcoding on:
`codec` = the platform's preferred codec, size = the largest size ≤ the platform limit with the
feed's aspect ratio (padded to the platform's 16:9 or 9:16 frame), `fps` = source capped at the
platform max, `bitrateKbps` = platform recommendation, `keyframeSec` = 2, `encoder` = `'auto'`,
`audio` = `'copy'`, `fallback` = `'copy'`.

**Validation on save** (zod + server checks): the codec is one the platform accepts; size, fps and
bitrate within the platform limits; the codec has at least one working encoder on this machine
(capabilities, §4); a named encoder must exist and have passed its test encode. A profile that was
valid when saved but no longer is at go-live (GPU removed, driver broken) does not block the
session: §7 applies.

A **global switch** `Settings → Transcoding → Allow transcoding on this server` (setting
`'transcode'` → `{ enabled: boolean, maxWorkers: number }`, default `{ enabled: false, maxWorkers: 2 }`)
gates everything: while off, every profile is treated as copy and the destination editor shows the
transcode section read-only. This keeps the owner's server exactly as it is until someone turns it on.

## 3. Platforms: codecs and limits

What each platform's ingest accepts over RTMP(S) (late 2026). Relay checks profiles against this
table (`server/src/platforms/<id>/` exposes it as `PlatformInfo.transcode`, additive).

| Platform | Feed | Codecs (RTMP ingest) | Max size | Max fps | Recommended bitrate | Notes |
|---|---|---|---|---|---|---|
| YouTube | landscape / vertical | H.264, HEVC, AV1 (Enhanced RTMP) | 3840×2160 (2160p) | 60 | H.264 1080p60 12 Mbps · AV1/HEVC 1440p60 ~16–24 Mbps _(verify)_ | Any aspect ratio; ultrawide is shown pillar/letterboxed by the player. Usually **copy**. |
| Twitch | landscape (+ vertical via Dual Format) | **H.264** on plain RTMP. HEVC/AV1 only through Enhanced Broadcasting (client-config handshake) | 1920×1080 | 60 | 6000 kbps (Partner up to ~8500) _(verify)_ | Relay's `ivs` mode stays H.264 x264 (non-goal above). |
| Kick | landscape | **H.264** (HEVC not accepted on RTMP ingest _(verify)_) | 1920×1080 | 60 | 8000 kbps _(verify)_ | Issue #1 mentions H.265 for Kick: allowed in the profile only once verified; table flag `hevc: false` until then. |
| Facebook | landscape | H.264 | 1920×1080 | 60 | 6000–9000 kbps _(verify)_ | |
| X | landscape | H.264 | 1920×1080 | 60 | 9000 kbps _(verify)_ | |
| Instagram | vertical | H.264 | 1080×1920 (720×1280 recommended) | 30 | 3500–6000 kbps _(verify)_ | |
| TikTok | vertical | H.264 | 1080×1920 | 30 (60 for some accounts) | 6000 kbps _(verify)_ | |
| Custom RTMP | any | H.264, HEVC, AV1 | any (≤ 7680×4320) | ≤ 120 | user's choice | No checks beyond sanity limits. |

Audio is AAC-LC 48 kHz everywhere; 128–160 kbps stereo.

Copy-mode warnings stay as they are. New: when a copy destination's platform can't take the
**feed's** codec (e.g. AV1 to Kick), the dashboard says so and offers "Turn on transcoding" (only
when the capabilities allow it).

## 4. Capability detection

Runs once at startup in the background (it never delays boot), cached in memory, re-run on demand
(admin "Re-check" button). Implemented in ticket **TC-1** (this design's first PR).

### 4.1 What is probed

1. `ffmpeg -version` → version line.
2. `ffmpeg -hide_banner -hwaccels` → hwaccel methods compiled in (`cuda`, `vaapi`, `qsv`, `amf`, `vulkan`, …).
3. `ffmpeg -hide_banner -encoders` / `-decoders` → which of the candidate encoders (§4.2) and which
   H.264 / HEVC / AV1 decoders (`libdav1d`, `av1_cuvid`, `av1_qsv`, …) are compiled in.
4. Devices: `/dev/dri/renderD*` render nodes (VAAPI / QSV), `/dev/nvidia*` (NVENC), CPU logical core
   count and model (`os.availableParallelism()`, `os.cpus()`).
5. **A test encode per compiled-in candidate**: 30 frames of a synthetic 1280×720 @ 30 fps source
   (`-f lavfi -i testsrc2`) to `-f null`, with `-progress` to read the achieved speed. Sequential,
   one at a time, at low process priority (`nice` 10), 15 s timeout each. VAAPI is tried once per
   render node (`-vaapi_device <node> -vf format=nv12,hwupload`); the first node that works is
   recorded. Hardware encoders that fail report the first FFmpeg error line (e.g.
   `Cannot load libcuda.so.1`, `No VA display found for device /dev/dri/renderD128`,
   `DLL libamfrt64.so.1 failed to open`). The speed (×real time at 720p30) is a **rough** indicator,
   used for warnings and admission (§7), not a promise.

The pinned FFmpeg (BtbN `n8.1.3` linux64 GPL, `scripts/setup-tools.mjs`) was checked: it has
`libx264`, `libx265`, `libsvtav1`, `libaom-av1`, `librav1e`, `h264/hevc/av1_nvenc`,
`h264/hevc/av1_qsv`, `h264/hevc/av1_vaapi`, `h264/hevc/av1_amf`, `*_vulkan`, and decoders
`libdav1d`, `av1/h264/hevc_cuvid`, `*_qsv`, `*_amf`; hwaccels `cuda vaapi qsv drm opencl vulkan amf`.
The arm64 build has the software encoders and `v4l2m2m` only (no NVENC/QSV/AMF).

### 4.2 Candidates

| Codec | Software | NVIDIA | Intel | AMD (Linux) | AMD (Windows) |
|---|---|---|---|---|---|
| H.264 | `libx264` | `h264_nvenc` | `h264_qsv`, `h264_vaapi` | `h264_vaapi` | `h264_amf` |
| HEVC | `libx265` | `hevc_nvenc` | `hevc_qsv`, `hevc_vaapi` | `hevc_vaapi` | `hevc_amf` |
| AV1 | `libsvtav1` | `av1_nvenc` (RTX 40+) | `av1_qsv`, `av1_vaapi` (Arc, Core Ultra) | `av1_vaapi` (RX 7000+) | `av1_amf` (RX 7000+) |

Not candidates for now: `*_vulkan` encoders (young in FFmpeg 8, revisit), `libaom-av1`/`librav1e`
(too slow for live), `libopenh264`, `libkvazaar`, `v4l2m2m` (arm64 boards; revisit on request).

### 4.3 "auto" choice

For a codec: first working hardware encoder in the order NVENC → QSV → VAAPI → AMF, else the
software encoder **only if** its measured speed is ≥ 1.5× at 720p30 and the profile's pixel rate
fits (§7.1). Otherwise the codec counts as unsupported for `auto`.

**Owner's server (HD 7870, GCN 1.0 / VCE 1.0):** no AV1/HEVC hardware at all; VCE 1.0 H.264 encode
through Mesa VAAPI may or may not initialise (GCN 1.0 needs the `amdgpu` kernel driver with SI
support or `radeon`; AMF does not support GCN 1.0). The probe will tell. Expected result: H.264 via
`libx264` only, and **AV1 input must be decoded in software** (`libdav1d`), which at 3440×1440 60 fps
needs a strong CPU. So on that server the realistic set-up stays copy mode (or OBS sends H.264), and
the UI will say so instead of failing at go-live.

### 4.4 API (additive)

- `GET /api/system/transcode-capabilities` (web UI, any signed-in user) and
  `GET /api/v1/system/transcode-capabilities` (external API, `status:read`): the cached result.
  `state: 'probing'` until the first probe finishes.
- `POST /api/system/transcode-capabilities/refresh` (admin, CSRF, audited `transcode.recheck`): re-probe. (TC-2.)
- Web: **Settings → About → "Transcoding: supported encoders"** line (TC-1); later the Transcoding
  settings section shows the full table (TC-9).

Shape (`shared/api.ts`):

```ts
interface TranscodeCapabilities {
  state: 'probing' | 'ready' | 'unavailable';
  probedAt: string | null;
  durationMs: number | null;
  ffmpegVersion: string | null;
  hwaccels: string[];
  decoders: Record<VideoCodec, string[]>;
  encoders: TranscodeEncoderResult[]; // every compiled-in candidate, tested
  supported: Record<VideoCodec, boolean>; // at least one encoder passed
  cpu: { cores: number; model: string | null };
  devices: { renderNodes: string[]; nvidia: boolean };
  error: string | null; // 'unavailable': why (FFmpeg missing, …)
}
interface TranscodeEncoderResult {
  encoder: string; codec: VideoCodec; backend: 'software' | 'nvenc' | 'qsv' | 'vaapi' | 'amf';
  ok: boolean; speed: number | null; device: string | null; error: string | null;
}
```

Paths of binaries and devices beyond `/dev/dri/renderD*` names are not exposed.

## 5. Media pipeline: one decode per feed, many encodes

```
OBS ─RTMP─► MediaMTX live/<slug>/landscape ──┬──► FFmpeg copy ─► YouTube      (unchanged)
                                             │
                                             └──► Transcode worker (1 per profile+feed)
                                                    decode once (hwaccel if possible)
                                                    split ─┬─ scale+fps ─ h264_nvenc 1080p60 6M ─► MediaMTX _r/<slug>/landscape/<rid1>
                                                           └─ scale+fps ─ h264_nvenc 1080p60 8M ─► MediaMTX _r/<slug>/landscape/<rid2>
                                                                                │
                                         FFmpeg copy (normal push) ◄────────────┘ ─► Twitch / Kick
```

- **Renditions are de-duplicated**: destinations whose profiles produce the same output (codec, size,
  fps, bitrate, keyframe, encoder, audio) share one rendition. Rendition id = short hash of that
  tuple.
- **One worker per (profile, feed)**, started when the first transcoding destination on that feed
  goes live, restarted when the set of renditions changes, stopped when the last one ends. It reads
  the feed with the internal reader user (as pushes do), decodes once, `split`s into one branch per
  rendition and publishes each as RTMP to a loopback-only MediaMTX path `_r/<slug|default>/<feed>/<rid>`.
- **Destinations stay copy pushes.** A transcoding destination's `PushPlan` just reads the rendition
  path instead of the feed path (`media.readUrl(feed, { rendition: rid })`). The push supervisor,
  progress parsing, restart backoff and stats are reused untouched; a platform dropping restarts
  only its own push, not the encode.
- MediaMTX: a second path pattern `~^_r/…$`; the auth hook allows **publish** on it only from
  loopback with the internal password and **read** as for feeds. Never reachable from OBS.
- **Decode:** hwaccel when the capabilities show a decoder for the feed's codec on the same device
  as the chosen encoders (`-hwaccel cuda -hwaccel_output_format cuda` + `scale_cuda`, `-hwaccel qsv`
  + `vpp_qsv`, `-hwaccel vaapi` + `scale_vaapi`); otherwise software decode (`libdav1d` with threads
  for AV1) and `scale` + `format`. Mixed (software decode → hardware encode) uses `hwupload`.
- **Per rendition:** `fps=<n>` (when set), `scale=w:h:force_original_aspect_ratio=decrease,pad=…`,
  CBR with `-b:v = -maxrate`, `-bufsize` = 1 s, GOP = fps × keyframeSec with forced keyframes on the
  clock (`-force_key_frames expr:gte(t,n_forced*2)`), no scene-cut keyframes, B-frames ≤ 2 (0 for
  Instagram/TikTok _(verify)_). Audio: copy when AAC, else `aac 160k 48 kHz` once per worker.
- Output container to MediaMTX: Enhanced RTMP (HEVC/AV1 need E-FLV; FFmpeg 8 muxes it).
- Latency added: one encode (~1–2 frames on hardware, more with x264 `veryfast`) plus a loopback hop.

Why not one FFmpeg per destination: decodes the 3440×1440 AV1 once per destination (the expensive
part). Why not one FFmpeg with the `tee` muxer straight to the platforms: one platform's network
error kills every platform's output, and the copy supervisor's per-destination restarts and stats
would have to be rebuilt.

## 6. Contracts (all additive)

Owned by the maintainer (CONTRACTS.md): each change below goes in as its own small PR with the
maintainer's OK, and the external API changes get a hub AGENT-REQUESTS.md entry.

| File | Change |
|---|---|
| `shared/types.ts` | `VideoCodec`, `TranscodeProfile`; `Destination.transcode?: TranscodeProfile \| null`; `DestinationStatus.transcode?: { state: 'off' \| 'starting' \| 'running' \| 'behind' \| 'fallback-copy' \| 'failed'; encoder: string \| null; speed: number \| null; message: string \| null }`; `PlatformInfo.transcode?: PlatformTranscodeLimits` |
| `shared/api.ts` | `TranscodeCapabilities`, `TranscodeEncoderResult`, `TranscodeSettings`; `CreateDestinationRequest`/`UpdateDestinationRequest` gain optional `transcode` |
| `server/src/platforms/types.ts` | `PushPlan.input?: { rendition: string }` (absent = the feed, as today) |
| `server/src/services.ts` | `MediaServer.readUrl(feed, profile?, opts?: { rendition?: string })`; `TranscodeService` interface |
| `server/src/events.ts` | `transcode` event (worker state, speed) |
| DB | migration v5: `destinations.transcode_json TEXT NULL` |
| External API v1.10 | `GET /system/transcode-capabilities` (`status:read`); `destinations[].transcode` in `/status` (`status:read`); event `transcode.status` |

## 7. Load and health guards

### 7.1 Admission (before go-live and on save)

- Estimated load = Σ over renditions of (output pixel rate ÷ 1280·720·30) ÷ that encoder's measured
  speed, plus the decode (software AV1 decode is estimated from a short `libdav1d` benchmark, TC-3).
- \> 100 % of one encoder's estimate: **warn** on save ("This needs about 140 % of what libx264 managed
  in the test") and at go-live; the destination still starts and §7.2 decides.
- `maxWorkers` (default 2) caps concurrent workers; NVENC session limits on consumer cards are
  reported by the encoder's own error and handled by §7.2.

### 7.2 While live

The worker's `-progress` output gives `speed` every 2 s.

| Condition | Action |
|---|---|
| `speed` < 0.97 for 10 s | state `behind`, `transcode.status` event, dashboard warning |
| `behind` for 30 s, or the worker fails 3 times within 2 min, or the encoder fails to open | **fallback**: `fallback: 'copy'` and the platform accepts the feed's codec/size → restart that destination's push from the original feed (`fallback-copy`); otherwise (or `fallback: 'stop'`) the destination goes to `error` with the reason, other destinations untouched |
| worker exits unexpectedly | restart with the push supervisor's backoff (1, 2, 4 … 30 s); destinations reading its renditions retry on their own |
| feed resolution/codec changes mid-session | restart the worker (MediaMTX re-publish already triggers this) |

A destination in `fallback-copy` stays there for the rest of the session (no flapping); the next
session tries transcoding again. Copy destinations are never touched by any of this.

## 8. Docker / TrueNAS GPU passthrough

The container runs as uid 568 with `cap_drop: ALL` and `no-new-privileges`; none of that needs to
change. GPU access is devices + group membership.

| Vendor | Host needs | Compose / TrueNAS YAML | Image needs |
|---|---|---|---|
| **NVIDIA** (NVENC, CUDA decode) | NVIDIA driver + NVIDIA Container Toolkit. TrueNAS SCALE: install the NVIDIA drivers (Apps → Settings) | `deploy.resources.reservations.devices: [{ driver: nvidia, count: 1, capabilities: [gpu, video] }]` and `NVIDIA_DRIVER_CAPABILITIES=compute,video,utility` | nothing: the toolkit mounts `libcuda`/`libnvidia-encode` |
| **Intel** (QSV / VAAPI) | i915/xe driver (stock) | `devices: ["/dev/dri:/dev/dri"]`, `group_add: ["<gid of /dev/dri/renderD128>"]` (`stat -c %g /dev/dri/renderD128` on the host; TrueNAS differs from Debian) | `intel-media-va-driver-non-free` (iHD) + `libmfx-gen1.2` / `libvpl2` for QSV, amd64 only _(verify Debian package names in bookworm non-free)_ |
| **AMD** (VAAPI) | amdgpu (stock) | same as Intel | `mesa-va-drivers` |
| **AMD AMF** | Windows (from source), or Linux with AMD's proprietary AMF runtime (`libamfrt64.so.1`) | — | not shipped in the image; AMF is for from-source Windows installs |

- The image adds `mesa-va-drivers` (both arches) and the Intel driver (amd64) — roughly +60–90 MB _(measure)_.
  Without a GPU passed in these are inert; the probe reports software encoders only.
- `docker-compose.yml` and `deploy/truenas/ctd-relay.yaml` get **commented-out** blocks per vendor;
  nothing is enabled by default. `docs/INSTALL-TRUENAS.md` gets a "GPU for transcoding" section.
- Windows from source: the pinned win64 build has NVENC, QSV and AMF; no setup beyond drivers.

## 9. Test plan

**Unit (CI, every PR; no GPU, no network):**
- Capability parsing of `-encoders` / `-decoders` / `-hwaccels` / `-version` output and the probe
  flow with a mocked runner (success, encoder open failure, timeout, FFmpeg missing) — TC-1.
- Profile validation against platform limits and capabilities — TC-4.
- `buildTranscodeArgs` (pure): golden argument lists per backend (software, NVENC, QSV, VAAPI,
  AMF), hwaccel decode vs software decode, rendition de-duplication, keyframe/GOP math — TC-5.
- Worker supervisor + health guard state machine with a fake spawn and fake clock: behind →
  fallback-copy; repeated failure → error; copy destinations unaffected — TC-7, TC-8.

**Integration (CI, real pinned FFmpeg, software encoders only, small sizes):**
- `rtmp-test-server` + MediaMTX: publish a 320×180 30 fps `testsrc2` H.264 feed, two destinations
  (copy + transcode `libx264` 160×90 300 kbps), assert the transcode output's codec/size/keyframe
  interval with ffprobe and that the copy output is byte-identical in codec parameters to the input.
- Same with an AV1 (`libsvtav1` preset 12) 320×180 input transcoded to H.264 (the issue's case).
- Kill the worker mid-stream: the copy destination's push never restarts.
- Lives next to `npm run smoke` and skips when `./tools` is missing. `ci.yml` doesn't download the
  tools today: TC-10 adds a cached `npm run setup-tools` step (≈ 100 MB, checksum-pinned).

**Manual (PC and community testers, test mode only):**
- Owner's server (HD 7870): capability line shows H.264 `libx264` (+ `h264_vaapi` if VCE works);
  AV1/HEVC "not supported"; transcode section hidden by the global switch; copy streaming unchanged
  (regression: Go live in test mode to Twitch, as today).
- NVIDIA (any RTX): 3440×1440 AV1 → YouTube copy + Twitch H.264 1080p60 + Kick H.264, test mode, 30 min;
  speed ≥ 1.0 throughout, dashboard shows encoder.
- Intel iGPU (QSV) and an AMD RX 6000/7000 (VAAPI) box if available.

## 10. Rollout

1. TC-1 (capabilities) ships first: harmless, read-only, and tells us what users' machines can do.
2. Contracts + storage + UI behind the global switch (off).
3. Worker + guards; integration tests; then turn the UI on (switch still defaults off).
4. Docker image drivers + docs last (they only matter once there is something to use them for).

This is a multi-ticket feature; "in a build this week" realistically means TC-1 (capability
detection) this week and the pipeline over the following ones.

## 11. Tickets

Hub ticket format. Branches `<tier>/<issue#>-<slug>`; all reference #1.

### TC-1 — Capability detection (probe, cache, API, Settings line)
**Goal:** Relay knows and shows which video encoders work on this machine.
**Context:** Issue #1, this doc §4. First, read-only step; no transcoding.
**Files:** `server/src/media/transcode-capabilities.ts` (+ test) — probe and parse; `server/src/http/routes/system.ts` (+ test) — web route; `server/src/api/v1.ts`, `openapi.ts`, `docs/API.md` — v1 route; `server/src/main.ts` — start probe; `shared/api.ts`, `web/src/api.ts` — types/client (additive); `web/src/pages/settings/AboutTab.tsx` (+ component, test).
**Done when:** probe runs in the background at startup; `GET /api/system/transcode-capabilities` and `GET /api/v1/system/transcode-capabilities` (`status:read`) return the cached result; Settings → About shows "Transcoding: supported encoders …"; unit tests with mocked FFmpeg output.
**Test:** `npm test`; run the server, open Settings → About.
**Out of scope:** profiles, pipeline, refresh endpoint, Docker drivers.
**Tier:** Mid — Agent: — (done in the PR next to this doc)

### TC-2 — Re-check endpoint + Transcoding settings switch
**Goal:** An admin can re-run the probe and turn transcoding on/off for the server.
**Context:** §2 global switch, §4.4.
**Files:** `server/src/http/routes/system.ts` — `POST …/refresh` (requireAdmin, audit `transcode.recheck`); `server/src/http/routes/settings.ts` — `'transcode'` setting `{ enabled, maxWorkers }`; `shared/api.ts` — `TranscodeSettings` (contract, maintainer OK); `web/src/pages/settings/` — "Transcoding" tab with switch, re-check button and the full encoder table; tests next to each.
**Done when:** switch persists and defaults off; re-check replaces the cached result and is audited; table lists every candidate with ok/speed/error.
**Test:** `npm test`; UI: toggle, reload, still set; press Re-check, timestamp changes.
**Out of scope:** using the switch anywhere else.
**Tier:** JR — Agent: Sonnet

### TC-3 — Decode benchmark
**Goal:** Capabilities include how fast this machine decodes AV1/HEVC/H.264 (software and hwaccel).
**Context:** §4.3, §7.1 (owner's server can't hardware-decode AV1).
**Files:** `server/src/media/transcode-capabilities.ts` — encode a 2 s 1280×720 sample with the first working encoder of each codec, then decode it with `-hwaccel <each>` and with the software decoder; record speed; tests with mocked runner.
**Done when:** `decoders` entries carry `{ name, hw, ok, speed }`; probe still < 20 s on a 4-core box.
**Test:** `npm test`; on the PC, compare against `ffmpeg -benchmark`.
**Out of scope:** UI changes beyond showing the new fields in the TC-2 table.
**Tier:** Mid — Agent: —

### TC-4 — Transcode profile: contract, storage, validation
**Goal:** Destinations can store a validated transcode profile; nothing uses it yet.
**Context:** §2, §3, §6.
**Files:** `shared/types.ts`, `shared/api.ts` (maintainer-approved contract PR); `server/src/db/database.ts` (migration v5) + `destinations-repo.ts`; `server/src/platforms/*/index.ts` — `transcode` limits per §3; `server/src/http/routes/destinations.ts` — zod + capability/limit checks; tests.
**Done when:** create/update round-trips `transcode`; invalid codec/size/fps/bitrate for the platform → 400 with a clear message; codec with no working encoder → 400; `null` keeps today's behaviour; migration test passes.
**Test:** `npm test` (repo, route, migration tests).
**Out of scope:** UI, pipeline.
**Tier:** Mid — Agent: —

### TC-5 — Transcode argument builder (pure)
**Goal:** A pure function builds the worker's FFmpeg arguments for any set of renditions and backend.
**Context:** §5.
**Files:** `server/src/media/transcode-args.ts` (+ test).
**Done when:** golden tests for software/NVENC/QSV/VAAPI/AMF, hw vs sw decode, letterbox math, GOP = fps × 2 with forced keyframes, CBR, audio copy vs AAC, rendition de-dup and stable ids; output args never contain the reader password in logs (redaction helper used).
**Test:** `npm test`; run one generated command by hand with the pinned FFmpeg on the PC.
**Out of scope:** spawning processes.
**Tier:** Mid — Agent: —

### TC-6 — MediaMTX rendition paths
**Goal:** Workers can publish renditions to MediaMTX on loopback only, and pushes can read them.
**Context:** §5.
**Files:** `server/src/media/paths.ts`, `mediamtx-config.ts`, `authorize.ts` (+ tests); `services.ts` `readUrl` option (contract).
**Done when:** `_r/<slug>/<feed>/<rid>` publish allowed only from loopback with the internal password; OBS can't publish or read there; config test covers the new path regex.
**Test:** `npm test`; `npm run smoke` still passes.
**Out of scope:** starting workers.
**Tier:** Mid — Agent: —

### TC-7 — Transcode worker supervisor + orchestrator wiring
**Goal:** Going live starts one worker per (profile, feed) with transcoding destinations, and those destinations push from their rendition.
**Context:** §5, §7.2 (restart part).
**Files:** `server/src/media/transcode-supervisor.ts` (+ test, fake spawn); `server/src/orchestrator/destination-runner.ts`, `orchestrator.ts` (+ tests); `server/src/main.ts`.
**Done when:** worker refcounted by destinations; rendition set change restarts the worker once; copy destinations' push args are byte-identical to before (regression test); worker crash doesn't restart copy pushes.
**Test:** `npm test`; integration test from §9 (TC-10).
**Out of scope:** health fallback (TC-8), UI.
**Tier:** Mid — Agent: —

### TC-8 — Health guards and fallback to copy
**Goal:** An encode that falls behind or keeps failing degrades to copy (or stops) per the profile, with a visible reason.
**Context:** §7.
**Files:** `server/src/media/transcode-supervisor.ts`, `server/src/orchestrator/destination-runner.ts`, `server/src/events.ts` (contract) (+ tests with fake clock).
**Done when:** the §7.2 table holds in tests; `DestinationStatus.transcode` and `transcode.status` events carry state/speed/message; admission warnings (§7.1) returned on save and at go-live.
**Test:** `npm test`.
**Out of scope:** UI rendering of the warnings (TC-9).
**Tier:** Mid — Agent: —

### TC-9 — Web UI: destination transcode section + dashboard status
**Goal:** Users set a destination's transcode profile and see its live state.
**Context:** §2, §3, §7.
**Files:** `web/src/pages/destinations/*` (editor section: off by default, options filtered by platform limits and capabilities, disabled with a reason when the global switch is off); `web/src/pages/DashboardPage.tsx` + helpers (badge: encoder, speed, `behind`, `fallback-copy`); tests.
**Done when:** unsupported codecs aren't offered; defaults come from the platform; the dashboard badge follows events; copy destinations look exactly as today.
**Test:** `npm test`; manual on the PC with `npm run dev:sim`.
**Out of scope:** server logic.
**Tier:** JR — Agent: Argon (visual)

### TC-10 — Integration tests with software encode
**Goal:** CI proves the pipeline end to end with small software encodes.
**Context:** §9.
**Files:** `server/src/media/transcode.integration.test.ts` (skips without `./tools`), `scripts/smoke-test.ts`.
**Done when:** H.264→H.264 and AV1→H.264 cases pass at 320×180; worker-kill case shows copy untouched; runs in < 60 s.
**Test:** `npm run setup-tools && npm test`; `npm run smoke`.
**Out of scope:** GPU tests.
**Tier:** JR — Agent: Sonnet

### TC-11 — Docker GPU support + docs
**Goal:** The image can use Intel/AMD VAAPI and NVIDIA NVENC when a GPU is passed in.
**Context:** §8.
**Files:** `Dockerfile` (VAAPI/QSV runtime packages), `docker-compose.yml`, `deploy/truenas/ctd-relay.yaml` (commented blocks), `docs/INSTALL-TRUENAS.md`, `README.md`; `scripts/repo-config.test.mjs` if it checks these files.
**Done when:** image builds for amd64+arm64; size delta noted in the PR; with `/dev/dri` passed on an Intel box the About line shows `h264_vaapi`/`h264_qsv`.
**Test:** `docker build -t ctd-relay .` on the PC; run with and without `/dev/dri`.
**Out of scope:** AMF runtime in the image.
**Tier:** JR — Agent: Sonnet

### TC-12 — Docs
**Goal:** Users and app developers know transcoding exists and how to set it up.
**Context:** after TC-7..TC-9 land.
**Files:** `docs/ARCHITECTURE.md` (§1 non-goals, §5.2), `docs/PLATFORMS.md` (codec table), `docs/API.md` (v1.10), `docs/OBS-SETUP.md` ("send one high-quality feed").
**Done when:** docs match shipped behaviour; hub AGENT-REQUESTS.md entry for the API change.
**Test:** read-through; links resolve.
**Out of scope:** code.
**Tier:** JR — Agent: Sonnet
