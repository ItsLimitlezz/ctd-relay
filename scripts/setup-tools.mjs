#!/usr/bin/env node
// Downloads pinned MediaMTX + FFmpeg static builds into ./tools (or --dest), and on Linux builds the
// pinned SRTLA receiver + sender (BELABOX/srtla, plain C; docs/SRTLA.md) when a C compiler, make and git
// are there. Without them SRTLA is skipped with a message (Relay runs without it: SRTLA shows as off).
//
//   node scripts/setup-tools.mjs [--os linux|win32|darwin] [--arch x64|arm64] [--dest <dir>] [--force] [--skip-srtla]
//
// Plain Node ESM, no dependencies. Archives are verified against the SHA-256 pinned below AND the
// release's own checksums.sha256 asset, then extracted with the system `tar`
// (bsdtar on Windows 10+ handles .zip; GNU tar on Linux needs xz-utils for .tar.xz).

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// MediaMTX: https://github.com/bluenviron/mediamtx/releases/tag/v1.21.2
const MEDIAMTX = {
  version: 'v1.21.2',
  base: 'https://github.com/bluenviron/mediamtx/releases/download/v1.21.2',
  assets: {
    'linux-x64': ['mediamtx_v1.21.2_linux_amd64.tar.gz', '121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27'],
    'linux-arm64': ['mediamtx_v1.21.2_linux_arm64.tar.gz', '180a235374a548d9133cdd5e20f5dbd8b01317be1c86e0d7e66df585dc42ed6f'],
    'win32-x64': ['mediamtx_v1.21.2_windows_amd64.zip', 'a84224f5a490855684e62ba6fb71e80ea2a5e16aed61883bb58380290e93e467'],
  },
};

// FFmpeg 8.1.3 static GPL builds. BtbN keeps month-end autobuilds long-term (daily ones are pruned),
// so pin a month-end tag: https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-30-13-08
const FFMPEG = {
  version: 'n8.1.3-9-g29e619e767',
  base: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08',
  assets: {
    'linux-x64': ['ffmpeg-n8.1.3-9-g29e619e767-linux64-gpl-8.1.tar.xz', '97ce978979194b5cf7e06a5e68020dbdaa7a4f3294c5452b6a1bc347100dbb79'],
    'linux-arm64': ['ffmpeg-n8.1.3-9-g29e619e767-linuxarm64-gpl-8.1.tar.xz', '10523d1e0be6b3ce62a9708cc50815c4b5eb5f36ae147fbe2afeecda6f2d6845'],
    'win32-x64': ['ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-8.1.zip', '7b801cdd3a1a0bb54ae6f572187e68b4ed54f52086cfee133fab2180bfb429fa'],
  },
};

// SRTLA: https://github.com/BELABOX/srtla (AGPL-3.0), built from this exact commit (a git commit id pins
// the content; it is checked after the fetch). Same pin as the Dockerfile's srtla stage and shared/srtla.ts.
const SRTLA = {
  version: '37862da3d0c13b46956efd3f88877053293d97d6',
  repo: 'https://github.com/BELABOX/srtla.git',
};

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const IDLE_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const opts = { os: process.platform, arch: process.arch, dest: path.resolve('tools'), force: false, skipSrtla: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (!v) throw new Error(`Missing value for ${a}`);
      return v;
    };
    if (a === '--os') opts.os = next();
    else if (a === '--arch') opts.arch = next();
    else if (a === '--dest') opts.dest = path.resolve(next());
    else if (a === '--force') opts.force = true;
    else if (a === '--skip-srtla') opts.skipSrtla = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/setup-tools.mjs [--os linux|win32|darwin] [--arch x64|arm64] [--dest <dir>] [--force] [--skip-srtla]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!['linux', 'win32', 'darwin'].includes(opts.os)) throw new Error(`Unsupported --os ${opts.os}`);
  if (!['x64', 'arm64'].includes(opts.arch)) throw new Error(`Unsupported --arch ${opts.arch}`);
  return opts;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Stream a URL to a file, hashing as it goes. Returns the hex SHA-256. */
async function download(url, file) {
  const ctrl = new AbortController();
  const total = setTimeout(() => ctrl.abort(new Error('download timed out')), DOWNLOAD_TIMEOUT_MS);
  let idle = setTimeout(() => ctrl.abort(new Error('download stalled')), IDLE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'ctd-relay-setup' } });
    if (!res.ok || !res.body) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    const size = Number(res.headers.get('content-length')) || 0;
    const hash = createHash('sha256');
    let received = 0;
    let lastPct = -1;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        clearTimeout(idle);
        idle = setTimeout(() => ctrl.abort(new Error('download stalled')), IDLE_TIMEOUT_MS);
        hash.update(chunk);
        received += chunk.length;
        if (size && process.stdout.isTTY) {
          const pct = Math.floor((received / size) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            process.stdout.write(`\r  ${path.basename(file)} ${pct}%   `);
          }
        }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(file), { signal: ctrl.signal });
    if (process.stdout.isTTY && size) process.stdout.write('\n');
    return hash.digest('hex');
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'ctd-relay-setup' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

/** Look up `name` in a `<sha256>  <file>` checksums listing. */
function checksumFor(listing, name) {
  for (const line of listing.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return null;
}

function tarBinary() {
  if (process.platform === 'win32') {
    // Prefer Windows' bsdtar: Git's GNU tar can't read .zip and treats "C:" as a remote host.
    const sys = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    return sys;
  }
  return 'tar';
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], ...opts });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}: ${stderr.trim().slice(-500)}`));
    });
  });
}

/** stdout of a command (for `git rev-parse`). */
function output(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], ...opts });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

/** Is a command on PATH (and runnable)? */
async function hasCommand(cmd, args = ['--version']) {
  try {
    await output(cmd, args);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build srtla_rec + srtla_send at the pinned commit (Linux only: it uses epoll; native arch only: no
 * cross compiler). Never fails setup: returns a reason when it skips.
 */
async function buildSrtla(opts) {
  if (opts.os !== 'linux' || process.platform !== 'linux') return 'SRTLA builds on Linux only (the Docker image has it)';
  if (opts.arch !== process.arch) return `cannot cross-compile SRTLA for ${opts.arch} on ${process.arch} (the Docker image builds it per architecture)`;
  const missing = [];
  if (!(await hasCommand('cc'))) missing.push('a C compiler (cc)');
  if (!(await hasCommand('make'))) missing.push('make');
  if (!(await hasCommand('git'))) missing.push('git');
  if (missing.length) return `${missing.join(', ')} not found (Debian/Ubuntu: apt install build-essential git)`;
  const work = path.join(opts.dest, `.tmp-srtla-${randomBytes(4).toString('hex')}`);
  await fs.mkdir(work, { recursive: true });
  try {
    console.log(`srtla ${SRTLA.version.slice(0, 7)}: fetching ${SRTLA.repo}`);
    await run('git', ['init', '-q'], { cwd: work });
    await run('git', ['fetch', '-q', '--depth', '1', SRTLA.repo, SRTLA.version], { cwd: work });
    await run('git', ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], { cwd: work });
    const head = await output('git', ['rev-parse', 'HEAD'], { cwd: work });
    if (head !== SRTLA.version) throw new Error(`srtla: fetched ${head}, expected ${SRTLA.version}`);
    console.log('srtla: commit OK, building (make)');
    // VERSION on the command line: the Makefile would otherwise ask git for it.
    await run('make', ['srtla_rec', 'srtla_send', `VERSION=${SRTLA.version.slice(0, 7)}`], { cwd: work });
    for (const file of ['srtla_rec', 'srtla_send']) {
      const dst = path.join(opts.dest, file);
      await fs.rm(dst, { force: true });
      await fs.copyFile(path.join(work, file), dst);
      await fs.chmod(dst, 0o755);
    }
    return null;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function extract(archive, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const flags = archive.endsWith('.tar.xz') && process.platform !== 'win32' ? '-xJf' : archive.endsWith('.tar.gz') && process.platform !== 'win32' ? '-xzf' : '-xf';
  try {
    await run(tarBinary(), [flags, archive, '-C', outDir]);
  } catch (err) {
    if (archive.endsWith('.tar.xz')) throw new Error(`${err.message}\n(.tar.xz extraction needs xz-utils installed)`);
    throw err;
  }
}

/** Find a file by exact basename anywhere under dir. */
async function findFile(dir, name) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = await findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) return p;
  }
  return null;
}

async function install(pkg, label, key, opts, files) {
  const asset = pkg.assets[key];
  if (!asset) throw new Error(`${label}: no pinned build for ${key}`);
  const [name, pinned] = asset;
  const work = path.join(opts.dest, `.tmp-${label}-${randomBytes(4).toString('hex')}`);
  await fs.mkdir(work, { recursive: true });
  try {
    console.log(`${label} ${pkg.version}: downloading ${name}`);
    const archive = path.join(work, name);
    const [actual, listing] = await Promise.all([download(`${pkg.base}/${name}`, archive), fetchText(`${pkg.base}/checksums.sha256`)]);
    const published = checksumFor(listing, name);
    if (!published) throw new Error(`${label}: ${name} not listed in the release checksums.sha256`);
    if (actual !== pinned || actual !== published) {
      throw new Error(`${label}: SHA-256 mismatch for ${name}\n  got       ${actual}\n  pinned    ${pinned}\n  published ${published}`);
    }
    console.log(`${label}: checksum OK, extracting`);
    const out = path.join(work, 'x');
    await extract(archive, out);
    for (const file of files) {
      const src = await findFile(out, file);
      if (!src) throw new Error(`${label}: ${file} not found in ${name}`);
      const dst = path.join(opts.dest, file);
      await fs.rm(dst, { force: true });
      await fs.copyFile(src, dst);
      if (opts.os !== 'win32') await fs.chmod(dst, 0o755);
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.os === 'darwin') {
    console.log('macOS: no pinned static builds. Install the tools with Homebrew instead:\n  brew install ffmpeg mediamtx\nthen set MEDIAMTX_BIN / FFMPEG_BIN (or symlink them into ./tools).');
    return;
  }
  const key = `${opts.os}-${opts.arch}`;
  if (!MEDIAMTX.assets[key] || !FFMPEG.assets[key]) {
    throw new Error(`No pinned builds for ${key}. Supported: ${Object.keys(MEDIAMTX.assets).join(', ')}`);
  }
  const exe = opts.os === 'win32' ? '.exe' : '';
  const mediamtxFiles = [`mediamtx${exe}`];
  const ffmpegFiles = [`ffmpeg${exe}`, `ffprobe${exe}`];
  await fs.mkdir(opts.dest, { recursive: true });

  const versionsFile = path.join(opts.dest, 'versions.json');
  const want = { mediamtx: MEDIAMTX.version, ffmpeg: FFMPEG.version, os: opts.os, arch: opts.arch };
  let have = {};
  try {
    have = JSON.parse(await fs.readFile(versionsFile, 'utf8'));
  } catch {
    // first run
  }
  const present = async (files) => (await Promise.all(files.map((f) => exists(path.join(opts.dest, f))))).every(Boolean);
  const sameTarget = have.os === want.os && have.arch === want.arch;
  const needMediamtx = opts.force || !sameTarget || have.mediamtx !== want.mediamtx || !(await present(mediamtxFiles));
  const needFfmpeg = opts.force || !sameTarget || have.ffmpeg !== want.ffmpeg || !(await present(ffmpegFiles));

  // Record progress after each tool so a failed second download doesn't redo the first.
  const record = { os: want.os, arch: want.arch, mediamtx: sameTarget ? (have.mediamtx ?? null) : null, ffmpeg: sameTarget ? (have.ffmpeg ?? null) : null, srtla: sameTarget ? (have.srtla ?? null) : null };
  const save = () => fs.writeFile(versionsFile, `${JSON.stringify(record, null, 2)}\n`);

  if (needMediamtx) {
    await install(MEDIAMTX, 'mediamtx', key, opts, mediamtxFiles);
    record.mediamtx = MEDIAMTX.version;
    await save();
  } else console.log(`mediamtx ${MEDIAMTX.version}: up to date`);
  if (needFfmpeg) {
    await install(FFMPEG, 'ffmpeg', key, opts, ffmpegFiles);
    record.ffmpeg = FFMPEG.version;
    await save();
  } else console.log(`ffmpeg ${FFMPEG.version}: up to date`);

  if (!opts.skipSrtla) {
    const srtlaFiles = ['srtla_rec', 'srtla_send'];
    if (!opts.force && sameTarget && have.srtla === SRTLA.version && (await present(srtlaFiles))) {
      console.log(`srtla ${SRTLA.version.slice(0, 7)}: up to date`);
    } else {
      try {
        const skipped = await buildSrtla(opts);
        if (skipped) console.log(`srtla: skipped, ${skipped}. SRTLA (bonded SRT, docs/SRTLA.md) stays off; everything else works.`);
        else {
          record.srtla = SRTLA.version;
          await save();
        }
      } catch (err) {
        console.log(`srtla: build failed (${err instanceof Error ? err.message : String(err)}). SRTLA stays off; everything else works.`);
      }
    }
  }

  await save();
  console.log(`Tools ready in ${opts.dest}`);
}

main().catch((err) => {
  console.error(`setup-tools failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
