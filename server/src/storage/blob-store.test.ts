import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { createRepos } from '../db/repos.js';
import { createSecretBox } from '../security/secretbox.js';
import type { Repos } from '../services.js';
import {
  BlobError,
  DEFAULT_BLOB_LIMITS,
  createBlobStore,
  looksExecutable,
  resolveBlobLimits,
  sniffProblem,
  type BlobLimits,
  type BlobStore,
} from './blob-store.js';

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

const sha = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');
const CUBE = Buffer.from('TITLE "Warm"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');

let dataDir: string;
let repos: Repos;
let limits: BlobLimits;
let store: BlobStore;

/** Every file under blobs/ (the empty tmp/ folder doesn't count). */
function blobFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(store.dir, p));
    }
  };
  walk(store.dir);
  return out;
}

async function expectBlobError(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BlobError);
  expect((err as BlobError).code).toBe(code);
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctd-blobs-'));
  repos = createRepos(openDatabase(':memory:'), createSecretBox(crypto.randomBytes(32)));
  limits = { ...DEFAULT_BLOB_LIMITS };
  store = createBlobStore({ dataDir, repo: repos.blobs, limits: () => limits });
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('write', () => {
  it('stores a blob at blobs/<ab>/<sha256> and indexes it', async () => {
    const h = sha(CUBE);
    const res = await store.write(h, Readable.from([CUBE]), { kind: 'lut', expectedSize: CUBE.length });
    expect(res.created).toBe(true);
    expect(res.record).toMatchObject({ sha256: h, size: CUBE.length, kind: 'lut' });
    expect(blobFiles()).toEqual([path.join(h.slice(0, 2), h)]);
    expect(fs.readFileSync(store.pathFor(h))).toEqual(CUBE);
    expect(store.has(h)).toBe(true);
    expect(store.usedBytes()).toBe(CUBE.length);

    const again = await store.write(h, Readable.from([CUBE]), { kind: 'lut' });
    expect(again.created).toBe(false);
    expect(blobFiles()).toHaveLength(1);
  });

  it('streams 200 MB without buffering it and verifies the hash', async () => {
    const chunk = crypto.randomBytes(MB);
    const hash = crypto.createHash('sha256');
    for (let i = 0; i < 200; i++) hash.update(chunk);
    const h = hash.digest('hex');
    async function* source(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 200; i++) yield chunk;
    }
    const res = await store.write(h, Readable.from(source()), { kind: 'video', expectedSize: 200 * MB });
    expect(res.record.size).toBe(200 * MB);
    expect(fs.statSync(store.pathFor(h)).size).toBe(200 * MB);
  }, 60_000);

  it('rejects a malformed hash before reading anything', async () => {
    await expectBlobError(store.write('ABC', Readable.from([CUBE]), { kind: 'lut' }), 'invalid_hash');
    expect(() => store.pathFor('../../etc/passwd')).toThrow(BlobError);
  });

  it('hash mismatch leaves no file and no row', async () => {
    const wrong = sha(Buffer.from('something else'));
    await expectBlobError(store.write(wrong, Readable.from([CUBE]), { kind: 'lut' }), 'hash_mismatch');
    expect(blobFiles()).toEqual([]);
    expect(repos.blobs.get(wrong)).toBeNull();
  });

  it('a 200 MB upload that does not match its hash leaves nothing behind', async () => {
    const chunk = Buffer.alloc(MB, 7);
    async function* source(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 200; i++) yield chunk;
    }
    await expectBlobError(store.write('0'.repeat(64), Readable.from(source()), { kind: 'video' }), 'hash_mismatch');
    expect(blobFiles()).toEqual([]);
  }, 60_000);

  it('over the kind limit: refused up front from Content-Length, and while streaming without one', async () => {
    limits.lutBytes = 1000;
    const big = Buffer.concat([CUBE, Buffer.alloc(2000, 0x20)]);
    await expectBlobError(store.write(sha(big), Readable.from([big]), { kind: 'lut', expectedSize: big.length }), 'too_large');
    await expectBlobError(store.write(sha(big), Readable.from([big]), { kind: 'lut' }), 'too_large');
    expect(blobFiles()).toEqual([]);
  });

  it('more bytes than Content-Length is refused', async () => {
    await expectBlobError(store.write(sha(CUBE), Readable.from([CUBE]), { kind: 'lut', expectedSize: 10 }), 'too_large');
    expect(blobFiles()).toEqual([]);
  });

  it('quota: refused when full, counting uploads in flight, leaving nothing behind', async () => {
    limits.quotaBytes = 3 * MB;
    const a = crypto.randomBytes(2 * MB);
    await store.write(sha(a), Readable.from([a]), { kind: 'other' });

    const b = crypto.randomBytes(2 * MB);
    await expectBlobError(store.write(sha(b), Readable.from([b]), { kind: 'other', expectedSize: b.length }), 'quota_exceeded');
    await expectBlobError(store.write(sha(b), Readable.from([b]), { kind: 'other' }), 'quota_exceeded');
    expect(blobFiles()).toHaveLength(1);
    expect(store.usedBytes()).toBe(2 * MB);

    // An existing blob doesn't count against the quota again.
    await expect(store.write(sha(a), Readable.from([a]), { kind: 'other' })).resolves.toMatchObject({ created: false });
  });

  it('quota: two parallel uploads that only fit one at a time', async () => {
    limits.quotaBytes = 3 * MB;
    const a = crypto.randomBytes(2 * MB);
    const b = crypto.randomBytes(2 * MB);
    const pa = new PassThrough();
    const pb = new PassThrough();
    const wa = store.write(sha(a), pa, { kind: 'other' });
    const wb = store.write(sha(b), pb, { kind: 'other' });
    pa.write(a.subarray(0, MB));
    pb.write(b.subarray(0, MB));
    await new Promise((r) => setTimeout(r, 20));
    pa.end(a.subarray(MB));
    pb.end(b.subarray(MB));
    const results = await Promise.allSettled([wa, wb]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected');
    expect(((failed as PromiseRejectedResult).reason as BlobError).code).toBe('quota_exceeded');
    expect(blobFiles()).toHaveLength(1);
    expect(store.usedBytes()).toBe(2 * MB);
  });

  it('client abort mid-upload leaves no file behind', async () => {
    const data = crypto.randomBytes(4 * MB);
    const src = new PassThrough();
    const p = store.write(sha(data), src, { kind: 'video', expectedSize: data.length });
    src.write(data.subarray(0, MB));
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.readdirSync(path.join(store.dir, 'tmp'))).toHaveLength(1); // the partial file exists meanwhile
    src.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    await expectBlobError(p, 'aborted');
    expect(blobFiles()).toEqual([]);
    expect(store.usedBytes()).toBe(0);
  });

  it('a body that ends before Content-Length is treated as aborted', async () => {
    const short = CUBE.subarray(0, 20);
    await expectBlobError(store.write(sha(short), Readable.from([short]), { kind: 'other', expectedSize: CUBE.length }), 'aborted');
    expect(blobFiles()).toEqual([]);
  });

  it('sniffs the content: a binary .cube and executables are refused', async () => {
    const bin = Buffer.from([1, 2, 0, 4, 5]);
    await expectBlobError(store.write(sha(bin), Readable.from([bin]), { kind: 'lut' }), 'unsupported_type');
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(100)]);
    await expectBlobError(store.write(sha(exe), Readable.from([exe]), { kind: 'other' }), 'unsupported_type');
    expect(blobFiles()).toEqual([]);
  });
});

describe('sniffing', () => {
  it('accepts .cube text and PNG LUTs', () => {
    expect(sniffProblem('lut', CUBE)).toBeNull();
    expect(sniffProblem('lut', Buffer.from('# comment\nLUT_1D_SIZE 1024\n'))).toBeNull();
    expect(sniffProblem('lut', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]))).toBeNull();
    expect(sniffProblem('lut', Buffer.from('hello world'))).toMatch(/not a \.cube/i);
  });

  it('recognises executables', () => {
    expect(looksExecutable(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]))).toBe(true);
    expect(looksExecutable(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))).toBe(true);
    expect(looksExecutable(Buffer.from('#!/bin/sh\n'))).toBe(true);
    expect(looksExecutable(Buffer.from('{"schema":1}'))).toBe(false);
  });
});

describe('gc', () => {
  async function put(buf: Buffer, kind: 'lut' | 'other' = 'other'): Promise<string> {
    const h = sha(buf);
    await store.write(h, Readable.from([buf]), { kind });
    return h;
  }

  it('removes unreferenced blobs older than 7 days and keeps the rest', async () => {
    const old = await put(Buffer.from('old and unreferenced'));
    const lib = await put(CUBE, 'lut');
    repos.assetLibrary.create({ sha256: lib, name: 'Warm', kind: 'lut', profileId: null, uploadedBy: null });
    const bundle = await put(Buffer.from('bundle tar'));
    repos.showProfiles.addRevision({
      profileId: 'default',
      name: 'Main',
      parentRevision: 0,
      manifest: '{"schema":1}',
      bundleSha256: bundle,
      size: 10,
      blobs: [bundle],
      savedByApp: null,
      savedByToken: null,
      note: null,
    });

    // Too young to collect.
    expect(store.gc(new Date(Date.now() + 6 * DAY))).toMatchObject({ removed: 0 });

    const res = store.gc(new Date(Date.now() + 8 * DAY));
    expect(res).toMatchObject({ removed: 1, bytes: 'old and unreferenced'.length });
    expect(store.has(old)).toBe(false);
    expect(fs.existsSync(store.pathFor(old))).toBe(false);
    expect(store.has(lib)).toBe(true);
    expect(store.has(bundle)).toBe(true);
  });

  it('removes orphan files and stale temp files', async () => {
    const orphan = sha(Buffer.from('orphan'));
    fs.mkdirSync(path.dirname(store.pathFor(orphan)), { recursive: true });
    fs.writeFileSync(store.pathFor(orphan), 'orphan');
    fs.writeFileSync(path.join(store.dir, 'tmp', 'x.part'), 'partial');
    const kept = await put(Buffer.from('indexed'));

    expect(store.gc(new Date()).orphans).toBe(0);
    expect(store.gc(new Date(Date.now() + 8 * DAY)).orphans).toBe(2);
    expect(blobFiles()).toEqual([]); // the indexed one went too: unreferenced and old
    expect(repos.blobs.get(kept)).toBeNull();
  });

  it('startGc returns a stop function', () => {
    const stop = store.startGc(1000);
    expect(typeof stop).toBe('function');
    stop();
  });
});

describe('limits', () => {
  it('merges overrides onto the defaults, ignoring bad values', () => {
    expect(resolveBlobLimits()).toEqual(DEFAULT_BLOB_LIMITS);
    expect(DEFAULT_BLOB_LIMITS.quotaBytes).toBe(20 * 1024 * MB);
    const l = resolveBlobLimits({ quotaBytes: 1000 }, { lutBytes: -1, imageBytes: 'x' }, null, { imageBytes: 5 });
    expect(l.quotaBytes).toBe(1000);
    expect(l.lutBytes).toBe(DEFAULT_BLOB_LIMITS.lutBytes);
    expect(l.imageBytes).toBe(5);
  });
});
