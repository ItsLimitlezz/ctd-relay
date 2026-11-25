import type { SrtStatus } from '@shared/srt';
import { SRT_LATENCY_INTERNET_MS, SRT_LATENCY_LAN_MS, srtLatencyParam } from '@shared/srt';

/** "SRT is off here: <reason>" — said plainly wherever an SRT address would be (docs/SRT.md). */
export function SrtUnavailable({ srt }: { srt: SrtStatus | undefined }) {
  return (
    <p className="small muted srt-off" role="note">
      <strong>SRT isn't available on this server.</strong> {srt?.reason ?? 'This server did not report SRT support.'} RTMP works as usual.
    </p>
  );
}

/** What `latency=` means, and the internet value (OBS/FFmpeg read it in microseconds). */
export function SrtLatencyNote({ srt }: { srt: SrtStatus | undefined }) {
  const lan = srt?.latencyMs ?? SRT_LATENCY_LAN_MS;
  const net = srt?.internetLatencyMs ?? SRT_LATENCY_INTERNET_MS;
  return (
    <p className="small muted">
      <code>{srtLatencyParam(lan)}</code> is SRT's buffer in microseconds ({lan} ms): enough on a LAN, and the lowest delay. If the sender or the
      player is on the internet, change it to <code>{srtLatencyParam(net)}</code> ({net} ms) to ride out lost packets. The UDP port
      {srt?.port ? ` ${srt.port}` : ''} must be mapped in the app's ports (and forwarded on the router only for someone outside your LAN).
    </p>
  );
}
