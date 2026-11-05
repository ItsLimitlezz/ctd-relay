// Broadcast performance metrics (BPM) for Amazon IVS multitrack video (Twitch Dual Format): three
// H.264 user_data_unregistered SEI messages that must precede every IDR on every track, or IVS
// disconnects the stream. Definitions:
// https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/multitrack-video-sw-integration.html
// ("Broadcast Performance Metrics (BPM) Message Definitions").
//
//   BPM TS  0aecffe7-5272-4e2f-a62f-d19cd61a93b5  timestamps
//   BPM SM  ca60e71c-6a8b-4388-a377-151df7bf8ac2  session frame counters (rendered, lagged, dropped, output)
//   BPM ERM f1fbc1d5-101e-4fb5-a61e-b8ce3c07b8c0  per-rendition frame counters (input, skipped, output)
//
// Each is its own SEI NAL unit. Timestamps are RFC 3339 strings. SM and ERM carry event 4 (packet
// interleave request), the only one IVS expects there. TS also carries event 1 (composition time)
// when it's known, like OBS (shared/bpm/bpm.c; OBS's frame encode events are optional and Relay can't
// measure them inside FFmpeg). Counters are differences since the previous IDR on that track; the
// first IDR carries zeros, as the guide asks.

const UUID_TS = Buffer.from('0aecffe752724e2fa62fd19cd61a93b5', 'hex');
const UUID_SM = Buffer.from('ca60e71c6a8b4388a377151df7bf8ac2', 'hex');
const UUID_ERM = Buffer.from('f1fbc1d5101e4fb5a61eb8ce3c07b8c0', 'hex');

const SEI_NAL_HEADER = 0x06; // forbidden_zero 0, nal_ref_idc 0, nal_unit_type 6
const USER_DATA_UNREGISTERED = 5;
const TS_TYPE_RFC3339 = 1;
const TS_EVENT_CTS = 1;
const TS_EVENT_PIR = 4;

export const SM_FRAMES_RENDERED = 1;
export const SM_FRAMES_LAGGED = 2;
export const SM_FRAMES_DROPPED = 3;
export const SM_FRAMES_OUTPUT = 4;
export const ERM_FRAMES_INPUT = 1;
export const ERM_FRAMES_SKIPPED = 2;
export const ERM_FRAMES_OUTPUT = 3;

/** "2024-03-25T15:10:34.489Z" */
export function rfc3339(ms: number): string {
  return new Date(ms).toISOString();
}

/** H.264 emulation prevention: 0x000000..03 gets a 0x03 inserted after every two zero bytes. */
export function emulationPrevent(rbsp: Buffer): Buffer {
  const out: number[] = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

/** A complete SEI NAL unit (no start code / length prefix) carrying one user_data_unregistered message. */
export function seiNal(uuid: Buffer, body: Buffer): Buffer {
  const payload = Buffer.concat([uuid, body]);
  const size: number[] = [];
  let n = payload.length;
  while (n >= 255) {
    size.push(255);
    n -= 255;
  }
  size.push(n);
  const rbsp = Buffer.concat([Buffer.from([USER_DATA_UNREGISTERED, ...size]), payload, Buffer.from([0x80])]);
  return Buffer.concat([Buffer.from([SEI_NAL_HEADER]), emulationPrevent(rbsp)]);
}

function timestampEntry(event: number, ms: number): Buffer {
  return Buffer.concat([Buffer.from([TS_TYPE_RFC3339, event]), Buffer.from(rfc3339(ms), 'ascii'), Buffer.from([0])]);
}

/** reserved(4) = 0, num_timestamps_minus1(4) = 0, then one RFC 3339 timestamp (st(v): NUL-terminated). */
function timestampBlock(ms: number): Buffer {
  return Buffer.concat([Buffer.from([0x00]), timestampEntry(TS_EVENT_PIR, ms)]);
}

/** The TS message's timestamps: composition time (when known) and packet interleave request, in OBS's order. */
function tsMessageBlock(ms: number, compositionMs: number | undefined): Buffer {
  if (compositionMs === undefined) return timestampBlock(ms);
  return Buffer.concat([Buffer.from([0x01]), timestampEntry(TS_EVENT_CTS, compositionMs), timestampEntry(TS_EVENT_PIR, ms)]);
}

function counterBlock(counters: readonly (readonly [tag: number, value: number])[]): Buffer {
  const out = Buffer.alloc(1 + counters.length * 5);
  out[0] = (counters.length - 1) & 0x0f;
  counters.forEach(([tag, value], i) => {
    out[1 + i * 5] = tag;
    out.writeUInt32BE(Math.max(0, Math.min(0xffffffff, Math.round(value))) >>> 0, 2 + i * 5);
  });
  return out;
}

export interface SessionCounters {
  rendered: number;
  lagged: number;
  dropped: number;
  output: number;
}

export interface RenditionCounters {
  input: number;
  skipped: number;
  output: number;
}

/** The three BPM SEI NAL units to put in front of an IDR. `compositionMs`: when the frame was composed, if known. */
export function bpmNals(ms: number, session: SessionCounters, rendition: RenditionCounters, compositionMs?: number): Buffer[] {
  const ts = timestampBlock(ms);
  return [
    seiNal(UUID_TS, tsMessageBlock(ms, compositionMs)),
    seiNal(
      UUID_SM,
      Buffer.concat([
        ts,
        counterBlock([
          [SM_FRAMES_RENDERED, session.rendered],
          [SM_FRAMES_LAGGED, session.lagged],
          [SM_FRAMES_DROPPED, session.dropped],
          [SM_FRAMES_OUTPUT, session.output],
        ]),
      ]),
    ),
    seiNal(
      UUID_ERM,
      Buffer.concat([
        ts,
        counterBlock([
          [ERM_FRAMES_INPUT, rendition.input],
          [ERM_FRAMES_SKIPPED, rendition.skipped],
          [ERM_FRAMES_OUTPUT, rendition.output],
        ]),
      ]),
    ),
  ];
}

/**
 * Frame counting for the BPM counters. Relay encodes every frame it gets (nothing skipped or
 * lagged at this stage), so input = output per rendition; the session's "rendered" frames are the
 * primary track's, "output" the sum over all tracks. Each IDR reports what happened since the
 * previous one on the same track.
 */
export class BpmCounters {
  private readonly total = new Map<number, number>();
  private readonly reported = new Map<number, { own: number; primary: number; all: number }>();

  /** Count one encoded frame of `track`. */
  frame(track: number): void {
    this.total.set(track, (this.total.get(track) ?? 0) + 1);
  }

  /** Counters for the IDR now arriving on `track` (call before counting that IDR's frame). */
  atIdr(track: number): { session: SessionCounters; rendition: RenditionCounters } {
    const own = this.total.get(track) ?? 0;
    const primary = this.total.get(0) ?? 0;
    let all = 0;
    for (const n of this.total.values()) all += n;
    const last = this.reported.get(track);
    this.reported.set(track, { own, primary, all });
    if (!last) {
      return { session: { rendered: 0, lagged: 0, dropped: 0, output: 0 }, rendition: { input: 0, skipped: 0, output: 0 } };
    }
    return {
      session: { rendered: primary - last.primary, lagged: 0, dropped: 0, output: all - last.all },
      rendition: { input: own - last.own, skipped: 0, output: own - last.own },
    };
  }
}
