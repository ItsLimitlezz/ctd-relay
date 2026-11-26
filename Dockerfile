# syntax=docker/dockerfile:1
#
# CTD Relay: one image with the web UI + API (Node), MediaMTX (RTMP ingest), FFmpeg (relay),
# srtla_rec (bonded SRT ingest) and Playwright Chromium (browser-driven platforms). Requires BuildKit (default since Docker 23).
#
#   docker build -t ctd-relay .
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/itslimitlezz/ctd-relay .
#
# Node >= 24.7 is required (node:sqlite, crypto.argon2). Bump the tag below for Node security releases:
# https://hub.docker.com/_/node/tags?name=24-bookworm-slim
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

# ---------------------------------------------------------------------------------------------------
# 1. deps: every dependency (dev included) for the build. Runs on the build machine's architecture:
#    the build output (server JS + static web assets) is architecture-independent.
# ---------------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------------------------------
# 2. build: server -> dist/server, web UI -> dist/web
# ---------------------------------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json vite.config.ts ./
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build

# ---------------------------------------------------------------------------------------------------
# 3. prod-deps: runtime dependencies only, installed on the TARGET architecture so any native module
#    gets the right binary.
# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------------------------------
# 4. tools: pinned, checksum-verified MediaMTX + FFmpeg/ffprobe static builds for the TARGET
#    architecture. The script only downloads and extracts (never runs them), so this stage runs on the
#    build machine. TARGETARCH is set by BuildKit; fall back to the build machine's arch without it.
# ---------------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS tools
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tar xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY scripts/setup-tools.mjs ./scripts/setup-tools.mjs
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in \
      amd64) arch=x64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "Unsupported architecture: $arch (supported: amd64, arm64)" >&2; exit 1 ;; \
    esac; \
    node scripts/setup-tools.mjs --os linux --arch "$arch" --dest /opt/ctd/tools --skip-srtla

# ---------------------------------------------------------------------------------------------------
# 5. srtla: the SRTLA receiver (bonded SRT from BELABOX/Moblin, docs/SRTLA.md), built from source for
#    the TARGET architecture (plain C + make, no dependencies; under QEMU for a cross build, like
#    prod-deps). Upstream https://github.com/BELABOX/srtla (AGPL-3.0) at a pinned commit: the commit id
#    pins the content and is checked after the fetch. Same pin as scripts/setup-tools.mjs.
# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS srtla
ARG SRTLA_COMMIT=37862da3d0c13b46956efd3f88877053293d97d6
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git gcc libc6-dev make \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src/srtla
RUN set -eu; \
    git init -q; \
    git fetch -q --depth 1 https://github.com/BELABOX/srtla.git "$SRTLA_COMMIT"; \
    git -c advice.detachedHead=false checkout -q FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$SRTLA_COMMIT"; \
    make srtla_rec VERSION="$(printf %.7s "$SRTLA_COMMIT")"; \
    mkdir -p /opt/srtla; \
    install -m 0755 srtla_rec /opt/srtla/srtla_rec; \
    cp LICENSE /opt/srtla/LICENSE; \
    printf 'srtla_rec from https://github.com/BELABOX/srtla at commit %s (AGPL-3.0, see LICENSE). Unmodified.\n' "$SRTLA_COMMIT" > /opt/srtla/SOURCE

# ---------------------------------------------------------------------------------------------------
# 6. runtime
# ---------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="CTD Relay" \
      org.opencontainers.image.description="Self-hosted multistreaming: landscape + vertical from OBS to every platform, one title, one chat." \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIR=/app/dist/web \
    MEDIAMTX_BIN=/opt/ctd/tools/mediamtx \
    FFMPEG_BIN=/opt/ctd/tools/ffmpeg \
    SRTLA_BIN=/opt/ctd/tools/srtla_rec \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CTD_IN_CONTAINER=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# tini: PID 1 that forwards signals and reaps FFmpeg/MediaMTX/srtla_rec/Chromium children.
# Fonts: so pages in the browser login view render text and emoji.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates fonts-liberation fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# Unprivileged user. 568:568 is TrueNAS's built-in "apps" user/group, so files on the dataset stay
# manageable from TrueNAS. /data must be writable by this uid when it is a bind mount.
RUN groupadd --system --gid 568 ctd \
 && useradd --system --uid 568 --gid ctd --create-home --home-dir /home/ctd --shell /usr/sbin/nologin ctd \
 && mkdir -p /data \
 && chown ctd:ctd /data

WORKDIR /app

# Production node_modules first: this layer only changes with package-lock.json, which keeps the large
# Chromium layer below cached across code changes.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./

# Playwright's Chromium (+ headless shell) matching the installed playwright version, plus the system
# libraries it needs (--with-deps runs apt-get as root here).
RUN npx --no playwright install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache /tmp/*

COPY --from=tools /opt/ctd/tools /opt/ctd/tools
COPY --from=srtla /opt/srtla/srtla_rec /opt/ctd/tools/srtla_rec
COPY --from=srtla /opt/srtla/LICENSE /opt/srtla/SOURCE /usr/share/doc/srtla/
COPY --from=build /app/dist ./dist
COPY scripts/healthcheck.mjs ./scripts/healthcheck.mjs
COPY LICENSE ./LICENSE

# Which build this is (shown at the bottom of the web UI). CI passes the commit and build time;
# declared last so a new commit doesn't invalidate the cached layers above.
ARG CTD_BUILD_COMMIT=""
ARG CTD_BUILD_DATE=""
ENV CTD_BUILD_COMMIT=${CTD_BUILD_COMMIT} \
    CTD_BUILD_DATE=${CTD_BUILD_DATE}

USER 568:568

# 8443 web UI (HTTPS unless TLS_MODE=off) · 8080 Let's Encrypt HTTP-01 + redirect · 1935 RTMP (LAN only)
# · 8890/udp SRT (low-delay ingest + pull links, docs/SRT.md; SRT_PORT, 0 = off)
# · 5000/udp SRTLA (bonded SRT from BELABOX/Moblin, docs/SRTLA.md; SRTLA_PORT, 0 = off; needs SRT on)
EXPOSE 8443 8080 1935 8890/udp 5000/udp
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "/app/scripts/healthcheck.mjs"]

# -s: register as subreaper, so reaping also works when Docker's own init (`init: true`) is PID 1.
# Plain SIGTERM goes to Node only, which ends lives and stops FFmpeg/MediaMTX/Chromium itself.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "dist/server/src/index.js"]
