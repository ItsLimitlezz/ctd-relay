// Minimal RTMP(S) publisher for the Twitch Dual Format relay (ivs-forwarder.ts). FFmpeg can't put
// Amazon IVS's broadcast performance metrics in front of every IDR, so Relay sends the stream itself:
// FFmpeg writes Enhanced FLV to a pipe, Relay adds the metrics and publishes the tags here.
//
// What it does (RTMP 1.0 spec + Enhanced RTMP v2):
// - simple handshake (C0/C1, S0/S1/S2, C2 = S1 echoed), as librtmp/OBS do;
// - Set Chunk Size 4096, connect (the same fields as OBS: app, type, flashVer, swfUrl, tcUrl; OBS sends
//   no fourCcList), releaseStream, FCPublish, createStream, publish(live), then @setDataFrame + audio/video messages
//   (every message with a full type-0 chunk header: simple, and the overhead is tiny at 4 KB chunks);
// - answers pings, acknowledges bytes when the server sets a window, follows the server's chunk size;
// - on close: FCUnpublish and deleteStream before ending the connection (IVS asks for FCUnpublish).

import { EventEmitter } from 'node:events';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { decodeAmf0All, encodeAmf0, encodeAmf0All, type Amf0Value } from './amf0.js';

export const RTMP_AUDIO = 8;
export const RTMP_VIDEO = 9;
export const RTMP_DATA = 18;
const SET_CHUNK_SIZE = 1;
const ACK = 3;
const USER_CONTROL = 4;
const WINDOW_ACK_SIZE = 5;
const SET_PEER_BANDWIDTH = 6;
const COMMAND_AMF3 = 17;
const COMMAND_AMF0 = 20;

const HANDSHAKE_SIZE = 1536;
const OUT_CHUNK_SIZE = 4096;
const CSID_CONTROL = 2;
const CSID_COMMAND = 3;
const CSID_AUDIO = 4;
const CSID_DATA = 5;
const CSID_VIDEO = 6;
const DEFAULT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;

export interface RtmpTarget {
  tls: boolean;
  host: string;
  port: number;
  app: string;
  /** The stream name (key) with its query string, as publish() sends it. */
  streamName: string;
  tcUrl: string;
}

/** rtmp(s)://host[:port]/app/<stream key>[?query] */
export function parseRtmpUrl(url: string): RtmpTarget {
  const m = /^(rtmps?):\/\/([^/?#]+)\/([^/?#]+)\/(.+)$/i.exec(url.trim());
  if (!m) throw new Error('Not an rtmp(s)://host/app/key URL');
  const secure = m[1]!.toLowerCase() === 'rtmps';
  const hostPort = m[2]!;
  const portMatch = /^(.*):(\d+)$/.exec(hostPort);
  const host = (portMatch ? portMatch[1]! : hostPort).replace(/^\[|\]$/g, '');
  const port = portMatch ? Number(portMatch[2]) : secure ? 443 : 1935;
  return { tls: secure, host, port, app: m[3]!, streamName: m[4]!, tcUrl: `${m[1]!.toLowerCase()}://${hostPort}/${m[3]!}` };
}

export interface RtmpPublisherOptions {
  timeoutMs?: number;
  /** Test seam: open the transport (default: TCP or TLS to the target). */
  connect?: (target: RtmpTarget) => Duplex;
}

interface InChunkState {
  timestamp: number;
  delta: number;
  length: number;
  type: number;
  streamId: number;
  extended: boolean;
  parts: Buffer[];
  received: number;
}

export class RtmpError extends Error {
  constructor(
    message: string,
    /** The server's onStatus code, e.g. NetStream.Publish.BadName. */
    readonly statusCode: string | null = null,
  ) {
    super(message);
    this.name = 'RtmpError';
  }
}

function socketFor(target: RtmpTarget): Duplex {
  return target.tls ? tls.connect({ host: target.host, port: target.port, servername: net.isIP(target.host) ? undefined : target.host }) : net.connect({ host: target.host, port: target.port });
}

/**
 * One publishing connection. Use RtmpPublisher.open(); then send() tags, close() when done.
 * Emits 'drain' (writable again after send() returned false), 'error' (connection lost or the
 * server refused the stream) and 'close'.
 */
export class RtmpPublisher extends EventEmitter {
  private socket: Duplex;
  private readonly target: RtmpTarget;
  private readonly timeoutMs: number;
  private inBuf: Buffer = Buffer.alloc(0);
  private inChunkSize = 128;
  private readonly inChunks = new Map<number, InChunkState>();
  private ackWindow = 0;
  private bytesIn = 0;
  private lastAck = 0;
  private handshaken = false;
  private readonly pending = new Map<number, { resolve: (args: Amf0Value[]) => void; reject: (err: Error) => void }>();
  private statusWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private nextTxn = 1;
  private streamId = 0;
  private closing = false;
  private closed = false;
  bytesSent = 0;

  private constructor(target: RtmpTarget, socket: Duplex, timeoutMs: number) {
    super();
    this.target = target;
    this.socket = socket;
    this.timeoutMs = timeoutMs;
  }

  static async open(url: string, opts: RtmpPublisherOptions = {}): Promise<RtmpPublisher> {
    const target = parseRtmpUrl(url);
    const socket = (opts.connect ?? socketFor)(target);
    const pub = new RtmpPublisher(target, socket, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      await pub.start();
      return pub;
    } catch (err) {
      pub.destroy();
      throw err;
    }
  }

  private timeout<T>(p: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new RtmpError(`Timed out waiting for ${what}`)), this.timeoutMs);
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(t);
          reject(e instanceof Error ? e : new Error(String(e)));
        },
      );
    });
  }

  private async start(): Promise<void> {
    const failed = new Promise<never>((_, reject) => {
      this.socket.once('error', (err: Error) => reject(new RtmpError(`Connection failed: ${err.message}`)));
      this.socket.once('close', () => reject(new RtmpError('The server closed the connection')));
    });
    failed.catch(() => {});
    const handshake = new Promise<void>((resolve, reject) => {
      const c1 = Buffer.alloc(HANDSHAKE_SIZE);
      c1.writeUInt32BE(0, 0);
      c1.writeUInt32BE(0, 4);
      for (let i = 8; i < HANDSHAKE_SIZE; i++) c1[i] = (Math.random() * 256) | 0;
      this.socket.write(Buffer.concat([Buffer.from([3]), c1]));
      const onData = (chunk: Buffer) => {
        this.inBuf = Buffer.concat([this.inBuf, chunk]);
        if (this.inBuf.length < 1 + 2 * HANDSHAKE_SIZE) return;
        this.socket.off('data', onData);
        if (this.inBuf[0] !== 3) {
          reject(new RtmpError(`Unsupported RTMP version ${this.inBuf[0]}`));
          return;
        }
        const s1 = this.inBuf.subarray(1, 1 + HANDSHAKE_SIZE);
        this.socket.write(Buffer.from(s1)); // C2
        const rest = this.inBuf.subarray(1 + 2 * HANDSHAKE_SIZE);
        this.inBuf = Buffer.alloc(0);
        this.handshaken = true;
        this.socket.on('data', (d: Buffer) => this.onData(d));
        if (rest.length > 0) this.onData(rest);
        resolve();
      };
      this.socket.on('data', onData);
    });
    await this.timeout(Promise.race([handshake, failed]), 'the RTMP handshake');

    this.socket.on('error', (err: Error) => this.fail(new RtmpError(`Connection lost: ${err.message}`)));
    this.socket.on('close', () => this.onClose());
    this.socket.on('drain', () => this.emit('drain'));

    const chunkSize = Buffer.alloc(4);
    chunkSize.writeUInt32BE(OUT_CHUNK_SIZE);
    this.writeMessage(CSID_CONTROL, SET_CHUNK_SIZE, 0, 0, chunkSize, 128);
    this.outChunkSize = OUT_CHUNK_SIZE;

    const t = this.target;
    await this.timeout(
      this.call('connect', [
        {
          app: t.app,
          type: 'nonprivate',
          flashVer: 'FMLE/3.0 (compatible; FMSc/1.0)',
          swfUrl: t.tcUrl,
          tcUrl: t.tcUrl,
        },
      ]),
      'the server to accept the connection',
    );
    this.command('releaseStream', [null, t.streamName]);
    this.command('FCPublish', [null, t.streamName]);
    const created = await this.timeout(this.call('createStream', [null]), 'createStream');
    this.streamId = typeof created[3] === 'number' ? created[3] : 1;
    const started = new Promise<void>((resolve, reject) => {
      this.statusWaiter = { resolve, reject };
    });
    this.writeMessage(CSID_COMMAND, COMMAND_AMF0, this.streamId, 0, encodeAmf0All(['publish', 0, null, t.streamName, 'live']));
    await this.timeout(started, 'the server to start publishing');
  }

  private outChunkSize = 128;

  /** Write one message as chunks. Returns false when the socket's buffer is full (wait for 'drain'). */
  private writeMessage(csid: number, type: number, streamId: number, timestamp: number, payload: Buffer, chunkSize = this.outChunkSize): boolean {
    const extended = timestamp >= 0xffffff;
    const header = Buffer.alloc(12 + (extended ? 4 : 0));
    header[0] = csid & 0x3f; // fmt 0
    header.writeUIntBE(extended ? 0xffffff : timestamp, 1, 3);
    header.writeUIntBE(payload.length, 4, 3);
    header[7] = type;
    header.writeUInt32LE(streamId, 8);
    if (extended) header.writeUInt32BE(timestamp >>> 0, 12);
    const parts: Buffer[] = [header];
    const cont = Buffer.alloc(1 + (extended ? 4 : 0));
    cont[0] = 0xc0 | (csid & 0x3f); // fmt 3
    if (extended) cont.writeUInt32BE(timestamp >>> 0, 1);
    for (let off = 0; off < payload.length; off += chunkSize) {
      if (off > 0) parts.push(cont);
      parts.push(payload.subarray(off, Math.min(payload.length, off + chunkSize)));
    }
    const buf = Buffer.concat(parts);
    this.bytesSent += buf.length;
    return this.socket.write(buf);
  }

  private command(name: string, args: Amf0Value[], txn = 0): void {
    this.writeMessage(CSID_COMMAND, COMMAND_AMF0, 0, 0, encodeAmf0All([name, txn, ...args]));
  }

  private call(name: string, args: Amf0Value[]): Promise<Amf0Value[]> {
    const txn = this.nextTxn++;
    return new Promise((resolve, reject) => {
      this.pending.set(txn, { resolve, reject });
      this.command(name, args, txn);
    });
  }

  /** Send one FLV tag body as an RTMP message. False = the network is behind: wait for 'drain'. */
  send(type: number, timestamp: number, body: Buffer): boolean {
    if (this.closed || this.closing) return true;
    if (type === RTMP_DATA) {
      return this.writeMessage(CSID_DATA, RTMP_DATA, this.streamId, timestamp, Buffer.concat([encodeAmf0('@setDataFrame'), body]));
    }
    return this.writeMessage(type === RTMP_AUDIO ? CSID_AUDIO : CSID_VIDEO, type, this.streamId, timestamp, body);
  }

  /** End the stream properly (FCUnpublish, deleteStream) and close the connection. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.closing && this.handshaken) {
      this.closing = true;
      try {
        this.command('FCUnpublish', [null, this.target.streamName]);
        this.command('deleteStream', [null, this.streamId]);
        this.socket.end();
      } catch {
        // already broken
      }
    }
    this.closing = true;
    await new Promise<void>((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        this.destroy();
        resolve();
      }, CLOSE_TIMEOUT_MS);
      this.once('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.closing) this.fail(new RtmpError('The server closed the connection'));
    for (const p of this.pending.values()) p.reject(new RtmpError('The server closed the connection'));
    this.pending.clear();
    this.emit('close');
  }

  private fail(err: RtmpError): void {
    if (this.statusWaiter) {
      this.statusWaiter.reject(err);
      this.statusWaiter = null;
    }
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    if (!this.closing && this.listenerCount('error') > 0) this.emit('error', err);
  }

  // ---- incoming chunks ----

  private onData(chunk: Buffer): void {
    this.bytesIn += chunk.length;
    if (this.ackWindow > 0 && this.bytesIn - this.lastAck >= this.ackWindow) {
      this.lastAck = this.bytesIn;
      const b = Buffer.alloc(4);
      b.writeUInt32BE(this.bytesIn >>> 0);
      this.writeMessage(CSID_CONTROL, ACK, 0, 0, b);
    }
    this.inBuf = this.inBuf.length ? Buffer.concat([this.inBuf, chunk]) : chunk;
    try {
      while (this.readChunk());
    } catch (err) {
      this.fail(new RtmpError(`Bad data from the server: ${err instanceof Error ? err.message : String(err)}`));
      this.destroy();
    }
  }

  /** Parse one chunk from inBuf; false when more bytes are needed. */
  private readChunk(): boolean {
    const buf = this.inBuf;
    if (buf.length < 1) return false;
    const fmt = buf[0]! >> 6;
    let csid = buf[0]! & 0x3f;
    let off = 1;
    if (csid === 0) {
      if (buf.length < 2) return false;
      csid = buf[1]! + 64;
      off = 2;
    } else if (csid === 1) {
      if (buf.length < 3) return false;
      csid = buf[1]! + buf[2]! * 256 + 64;
      off = 3;
    }
    const headerLen = [11, 7, 3, 0][fmt]!;
    if (buf.length < off + headerLen) return false;
    const prev = this.inChunks.get(csid);
    const st: InChunkState = prev ?? { timestamp: 0, delta: 0, length: 0, type: 0, streamId: 0, extended: false, parts: [], received: 0 };
    let tsField = 0;
    let length = st.length;
    let type = st.type;
    let streamId = st.streamId;
    if (fmt <= 2) tsField = buf.readUIntBE(off, 3);
    if (fmt <= 1) {
      length = buf.readUIntBE(off + 3, 3);
      type = buf[off + 6]!;
    }
    if (fmt === 0) streamId = buf.readUInt32LE(off + 7);
    off += headerLen;
    const extended = fmt <= 2 ? tsField === 0xffffff : st.extended;
    if (extended) {
      if (buf.length < off + 4) return false;
      tsField = buf.readUInt32BE(off);
      off += 4;
    }
    const starting = fmt !== 3 || st.received === 0;
    const remaining = (fmt <= 1 ? length : st.length) - (starting ? 0 : st.received);
    const take = Math.min(this.inChunkSize, remaining);
    if (buf.length < off + take) return false;

    if (fmt === 0) st.timestamp = tsField;
    else if (fmt === 1 || fmt === 2) {
      st.delta = tsField;
      st.timestamp += tsField;
    } else if (starting) st.timestamp += st.delta;
    st.length = length;
    st.type = type;
    st.streamId = streamId;
    st.extended = extended;
    if (starting) {
      st.parts = [];
      st.received = 0;
    }
    st.parts.push(Buffer.from(buf.subarray(off, off + take)));
    st.received += take;
    this.inChunks.set(csid, st);
    this.inBuf = buf.subarray(off + take);
    if (st.received >= st.length) {
      const payload = Buffer.concat(st.parts);
      st.parts = [];
      st.received = 0;
      this.onMessage(st.type, payload);
    }
    return true;
  }

  private onMessage(type: number, payload: Buffer): void {
    switch (type) {
      case SET_CHUNK_SIZE:
        if (payload.length >= 4) this.inChunkSize = Math.max(1, payload.readUInt32BE(0) & 0x7fffffff);
        return;
      case WINDOW_ACK_SIZE:
        if (payload.length >= 4) this.ackWindow = payload.readUInt32BE(0);
        return;
      case SET_PEER_BANDWIDTH: {
        const b = Buffer.alloc(4);
        b.writeUInt32BE(payload.length >= 4 ? payload.readUInt32BE(0) : 2_500_000);
        this.writeMessage(CSID_CONTROL, WINDOW_ACK_SIZE, 0, 0, b);
        return;
      }
      case USER_CONTROL:
        if (payload.length >= 6 && payload.readUInt16BE(0) === 6) {
          const pong = Buffer.alloc(6);
          pong.writeUInt16BE(7, 0);
          payload.copy(pong, 2, 2, 6);
          this.writeMessage(CSID_CONTROL, USER_CONTROL, 0, 0, pong);
        }
        return;
      case COMMAND_AMF3:
        this.onCommand(payload.subarray(1));
        return;
      case COMMAND_AMF0:
        this.onCommand(payload);
        return;
      default:
    }
  }

  private onCommand(payload: Buffer): void {
    const values = decodeAmf0All(payload);
    const [name, txn] = values;
    if ((name === '_result' || name === '_error') && typeof txn === 'number') {
      const p = this.pending.get(txn);
      if (!p) return;
      this.pending.delete(txn);
      if (name === '_result') p.resolve(values);
      else p.reject(new RtmpError(describe(values[3]) ?? 'The server refused the request', statusCode(values[3])));
      return;
    }
    if (name === 'onStatus') {
      const info = values[3];
      const code = statusCode(info) ?? '';
      const level = info && typeof info === 'object' && !Array.isArray(info) ? info.level : null;
      if (code === 'NetStream.Publish.Start') {
        this.statusWaiter?.resolve();
        this.statusWaiter = null;
      } else if (level === 'error' || /Failed|Rejected|BadName|Denied/i.test(code)) {
        this.fail(new RtmpError(describe(info) ?? code, code || null));
        this.destroy();
      }
    }
  }
}

function statusCode(info: Amf0Value): string | null {
  return info && typeof info === 'object' && !Array.isArray(info) && typeof info.code === 'string' ? info.code : null;
}

function describe(info: Amf0Value): string | null {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const parts = [info.code, info.description].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.length ? parts.join(': ') : null;
}
