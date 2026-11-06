// Content-addressed file store for show-profile bundles and assets (LUTs, images, media).
// Files live at `<dataDir>/blobs/<first two hex chars>/<sha256>`. A write streams into
// `blobs/tmp/` while it is hashed and counted, and is renamed into place only when the hash
// matches, so a blob file is never half-written. Blobs are plain files (not secrets); the data
// folder is already protected (docs/SECURITY.md). The `blobs` table indexes them; a daily GC
// removes blobs no revision or library entry references once they are older than 7 days.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Logger } from 'pino';
import type { BlobRecord, BlobsRepo } from '../services.js';

export const SHA256_RE = /^[0-9a-f]{64}$/;

/** What a blob holds. Decides its size limit and the content sniffing on upload. */
export const BLOB_KINDS = ['lut', 'image', 'video', 'audio', 'font', 'html', 'bundle', 'other'] as const;
export type BlobKind = (typeof BLOB_KINDS)[number];

export function isBlobKind(v: unknown): v is BlobKind {
  return typeof v === 'string' && (BLOB_KINDS as readonly string[]).includes(v);
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

export interface BlobLimits {
  /** `.cube` / `.png` LUTs. */
  lutBytes: number;
  imageBytes: number;
  /** Video and audio. */
  mediaBytes: number;
  /** Fonts, HTML and anything else. */
  otherBytes: number;
  /** A revision's bundle (the tar of its JSON files). */
  bundleBytes: number;
  /** A revision's manifest JSON. */
  manifestBytes: number;
  /** Total size of every blob together. */
  quotaBytes: number;
  /** Revisions kept per show profile (pinned ones come on top). */
  maxRevisions: number;
}

export const DEFAULT_BLOB_LIMITS: Readonly<BlobLimits> = Object.freeze({
  lutBytes: 64 * MB,
  imageBytes: 50 * MB,
  mediaBytes: 2 * GB,
  otherBytes: 200 * MB,
  bundleBytes: 16 * MB,
  manifestBytes: 1 * MB,
  quotaBytes: 20 * GB,
  maxRevisions: 50,
});

/** Merge overrides (config, settings) onto the defaults, ignoring anything that isn't a positive integer. */
export function resolveBlobLimits(...overrides: ReadonlyArray<Partial<Record<keyof BlobLimits, unknown>> | null | undefined>): BlobLimits {
  const out: BlobLimits = { ...DEFAULT_BLOB_LIMITS };
  for (const o of overrides) {
    if (!o) continue;
    for (const key of Object.keys(DEFAULT_BLOB_LIMITS) as Array<keyof BlobLimits>) {
      const v = o[key];
      if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) out[key] = v;
    }
  }
  return out;
}

export function maxBytesForKind(kind: BlobKind, limits: BlobLimits): number {
  switch (kind) {
    case 'lut':
      return limits.lutBytes;
    case 'image':
      return limits.imageBytes;
    case 'video':
    case 'audio':
      return limits.mediaBytes;
    case 'bundle':
      return limits.bundleBytes;
    default:
      return limits.otherBytes;
  }
}

export type BlobErrorCode = 'invalid_hash' | 'hash_mismatch' | 'too_large' | 'quota_exceeded' | 'unsupported_type' | 'aborted';

/** Upload failures. `statusCode` + `code` map straight onto the API's problem answers. */
export class BlobError extends Error {
  readonly statusCode: number;
  constructor(
    readonly code: BlobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BlobError';
    this.statusCode = code === 'too_large' || code === 'quota_exceeded' ? 413 : code === 'aborted' ? 499 : 400;
  }
}

// ---- Content sniffing ----

/** Bytes looked at to sniff an upload. */
export const SNIFF_BYTES = 64 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Native executables and scripts that are never accepted, whatever the declared kind. */
export function looksExecutable(head: Buffer): boolean {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return true; // MZ: Windows PE
  if (head.length >= 4 && head.readUInt32BE(0) === 0x7f454c46) return true; // \x7fELF
  if (head.length >= 4) {
    const m = head.readUInt32BE(0);
    // Mach-O 32/64 (both byte orders) and universal binaries.
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m)) return true;
  }
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) return true; // #! script
  return false;
}

/** Why an upload's first bytes don't fit its kind, or null when they do. `head` is up to SNIFF_BYTES. */
export function sniffProblem(kind: BlobKind, head: Buffer): string | null {
  if (looksExecutable(head)) return 'Executables are not accepted';
  if (kind === 'lut') {
    if (head.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null; // a PNG (HaldCLUT) LUT
    if (head.includes(0)) return 'A .cube LUT must be text';
    if (!/^\s*LUT_(1D|3D)_SIZE\s+\d+/m.test(head.toString('latin1'))) return 'Not a .cube LUT (no LUT_3D_SIZE / LUT_1D_SIZE line)';
    return null;
  }
  if (kind === 'image' && head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return null;
}

// ---- The store ----

export interface BlobWriteOptions {
  kind: BlobKind;
  /** Content-Length when the client sent one: checked against the limit up front and against the bytes received. */
  expectedSize?: number;
  /** Lower the kind's limit further (e.g. a route-specific cap). */
  maxBytes?: number;
}

export interface BlobWriteResult {
  record: BlobRecord;
  /** False when the blob was already stored (the upload was verified and replaced the old copy). */
  created: boolean;
}

export interface BlobGcResult {
  removed: number;
  bytes: number;
  /** Files on disk without a `blobs` row, and stale temp files, that were removed. */
  orphans: number;
}

export interface BlobStore {
  /** `<dataDir>/blobs`. */
  readonly dir: string;
  limits(): BlobLimits;
  /** Absolute path of a blob's file (whether or not it exists). Throws for a malformed hash. */
  pathFor(sha256: string): string;
  /** True when both the index row and the file exist. */
  has(sha256: string): boolean;
  /** Size of the stored file, or null. */
  stat(sha256: string): { size: number } | null;
  /**
   * Stream `source` into the store under `sha256`. Rejects with BlobError (hash_mismatch, too_large,
   * quota_exceeded, unsupported_type, aborted) and leaves no file behind in that case.
   */
  write(sha256: string, source: Readable | AsyncIterable<Buffer | Uint8Array>, opts: BlobWriteOptions): Promise<BlobWriteResult>;
  /** Read a stored blob (optionally a byte range, inclusive end like HTTP Range). */
  open(sha256: string, range?: { start: number; end: number }): fs.ReadStream;
  /** Remove a blob's file and row. The caller makes sure nothing references it. */
  remove(sha256: string): void;
  /** Bytes in use plus bytes currently being uploaded. */
  usedBytes(): number;
  /** Remove unreferenced blobs older than `minAgeMs` (default 7 days), orphan files and stale temp files. */
  gc(now?: Date, minAgeMs?: number): BlobGcResult;
  /** Run gc() now and then every `intervalMs` (default daily). Returns a stop function. */
  startGc(intervalMs?: number): () => void;
}

export const GC_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Temp files older than this are left over from a crash and removed by gc(). */
const STALE_TMP_MS = 24 * 60 * 60 * 1000;

export function createBlobStore(opts: {
  dataDir: string;
  repo: BlobsRepo;
  limits?: () => BlobLimits;
  log?: Logger;
}): BlobStore {
  const dir = path.join(opts.dataDir, 'blobs');
  const tmpDir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const limits = opts.limits ?? (() => ({ ...DEFAULT_BLOB_LIMITS }));
  const { repo, log } = opts;

  /** Bytes reserved by uploads in flight, so parallel uploads can't overrun the quota together. */
  let inFlight = 0;

  const pathFor = (sha256: string): string => {
    if (!SHA256_RE.test(sha256)) throw new BlobError('invalid_hash', 'Not a lowercase hex SHA-256');
    return path.join(dir, sha256.slice(0, 2), sha256);
  };

  const stat = (sha256: string): { size: number } | null => {
    try {
      const st = fs.statSync(pathFor(sha256));
      return st.isFile() ? { size: st.size } : null;
    } catch {
      return null;
    }
  };

  const usedBytes = (): number => repo.totalSize() + inFlight;

  async function write(
    sha256: string,
    source: Readable | AsyncIterable<Buffer | Uint8Array>,
    wopts: BlobWriteOptions,
  ): Promise<BlobWriteResult> {
    if (!SHA256_RE.test(sha256)) throw new BlobError('invalid_hash', 'Not a lowercase hex SHA-256');
    const lim = limits();
    const maxBytes = Math.min(maxBytesForKind(wopts.kind, lim), wopts.maxBytes ?? Number.POSITIVE_INFINITY);
    const expected = wopts.expectedSize;
    if (expected !== undefined && expected > maxBytes) throw new BlobError('too_large', `Larger than the ${wopts.kind} limit (${maxBytes} bytes)`);

    const already = repo.get(sha256) !== null && stat(sha256) !== null;
    // Quota: an existing blob costs nothing; otherwise check up front when the size is known, and while counting.
    const quotaLeft = (): number => lim.quotaBytes - usedBytes();
    if (!already && expected !== undefined && expected > quotaLeft()) throw new BlobError('quota_exceeded', 'The asset storage quota is full');

    const tmp = path.join(tmpDir, `${sha256}.${crypto.randomBytes(6).toString('hex')}.part`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let reserved = 0;
    let head = Buffer.alloc(0);
    let sniffed = false;

    const sniff = (): void => {
      sniffed = true;
      const problem = sniffProblem(wopts.kind, head);
      if (problem) throw new BlobError('unsupported_type', problem);
    };

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb: TransformCallback) {
        try {
          size += chunk.length;
          if (size > maxBytes) throw new BlobError('too_large', `Larger than the ${wopts.kind} limit (${maxBytes} bytes)`);
          if (expected !== undefined && size > expected) throw new BlobError('too_large', 'More bytes than Content-Length');
          if (!already) {
            // Reserve as we go so a concurrent upload sees these bytes as used.
            const need = size - reserved;
            if (need > quotaLeft()) throw new BlobError('quota_exceeded', 'The asset storage quota is full');
            inFlight += need;
            reserved += need;
          }
          if (!sniffed) {
            head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)]);
            if (head.length >= SNIFF_BYTES) sniff();
          }
          hash.update(chunk);
          cb(null, chunk);
        } catch (err) {
          cb(err as Error);
        }
      },
      flush(cb: TransformCallback) {
        try {
          if (!sniffed) sniff();
          cb();
        } catch (err) {
          cb(err as Error);
        }
      },
    });

    try {
      try {
        await pipeline(source, counter, fs.createWriteStream(tmp, { flags: 'wx', flush: true }));
      } catch (err) {
        if (err instanceof BlobError) throw err;
        // A disk problem (ENOSPC, EACCES…) is ours; anything else came from the source: the client went away.
        const e = err as NodeJS.ErrnoException | null;
        if (e?.syscall && e.code !== 'ECONNRESET' && e.code !== 'EPIPE') throw err;
        throw new BlobError('aborted', 'The upload was interrupted');
      }
      if (expected !== undefined && size !== expected) throw new BlobError('aborted', 'The upload ended before Content-Length bytes arrived');
      const actual = hash.digest('hex');
      if (actual !== sha256) throw new BlobError('hash_mismatch', 'The content does not match its SHA-256');

      // Rename over any existing file: atomic, and it repairs a damaged copy with verified bytes.
      const final = pathFor(sha256);
      fs.mkdirSync(path.dirname(final), { recursive: true });
      fs.renameSync(tmp, final);
      const record = repo.upsert({ sha256, size, kind: wopts.kind });
      if (!already) log?.info({ sha256, size, kind: wopts.kind }, 'blob stored');
      return { record, created: !already };
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    } finally {
      inFlight -= reserved;
    }
  }

  function open(sha256: string, range?: { start: number; end: number }): fs.ReadStream {
    return fs.createReadStream(pathFor(sha256), range ? { start: range.start, end: range.end } : undefined);
  }

  function remove(sha256: string): void {
    fs.rmSync(pathFor(sha256), { force: true });
    repo.delete(sha256);
  }

  function gc(now: Date = new Date(), minAgeMs: number = GC_MIN_AGE_MS): BlobGcResult {
    const result: BlobGcResult = { removed: 0, bytes: 0, orphans: 0 };
    // Synchronous from the query to the last delete, so no save can reference a blob in between.
    const before = new Date(now.getTime() - minAgeMs).toISOString();
    for (const b of repo.listUnreferenced(before)) {
      try {
        remove(b.sha256);
        result.removed++;
        result.bytes += b.size;
      } catch (err) {
        log?.warn({ sha256: b.sha256, error: err instanceof Error ? err.message : String(err) }, 'blob gc: remove failed');
      }
    }
    // Files without an index row (crash between rename and insert) once they are old enough,
    // and temp files left over from a crash.
    const cutoff = now.getTime() - minAgeMs;
    for (const entry of safeReaddir(dir)) {
      if (entry === 'tmp' || !/^[0-9a-f]{2}$/.test(entry)) continue;
      for (const name of safeReaddir(path.join(dir, entry))) {
        const file = path.join(dir, entry, name);
        if (SHA256_RE.test(name) && repo.get(name)) continue;
        if (mtimeMs(file) < cutoff) {
          fs.rmSync(file, { force: true });
          result.orphans++;
        }
      }
    }
    for (const name of safeReaddir(tmpDir)) {
      const file = path.join(tmpDir, name);
      if (mtimeMs(file) < now.getTime() - STALE_TMP_MS) {
        fs.rmSync(file, { force: true });
        result.orphans++;
      }
    }
    if (result.removed || result.orphans) log?.info(result, 'blob gc');
    return result;
  }

  function startGc(intervalMs: number = GC_INTERVAL_MS): () => void {
    const run = (): void => {
      try {
        gc();
      } catch (err) {
        log?.warn({ error: err instanceof Error ? err.message : String(err) }, 'blob gc failed');
      }
    };
    const first = setTimeout(run, 60_000);
    const timer = setInterval(run, intervalMs);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  return {
    dir,
    limits,
    pathFor,
    has: (sha256) => SHA256_RE.test(sha256) && repo.get(sha256) !== null && stat(sha256) !== null,
    stat,
    write,
    open,
    remove,
    usedBytes,
    gc,
    startGc,
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function mtimeMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
