import type { SrtStatus } from '@shared/srt';
import { SRT_LATENCY_DEFAULT_MS, SRT_LATENCY_LAN_MS, srtLatencyParam } from '@shared/srt';

/** "SRT is off here: <reason>" — said plainly wherever an SRT address would be (docs/SRT.md). */
export function SrtUnavailable({ srt }: { srt: SrtStatus | undefined }) {
  return (
    <p className="small muted srt-off" role="note">
      <strong>SRT isn't available on this server.</strong> {srt?.reason ?? 'This server did not report SRT support.'} RTMP works as usual.
    </p>
  );
}

/** What `latency=` means: the internet value in the links, how to go lower, and the LAN value (microseconds). */
export function SrtLatencyNote({ srt }: { srt: SrtStatus | undefined }) {
  const net = srt?.latencyMs ?? SRT_LATENCY_DEFAULT_MS;
  const lan = srt?.lanLatencyMs ?? SRT_LATENCY_LAN_MS;
  return (
    <p className="small muted">
      <code>{srtLatencyParam(net)}</code> is SRT's buffer in microseconds ({net} ms), set for the internet: it rides out lost packets. On a good
      link you can lower it (e.g. <code>{srtLatencyParam(Math.round(net * 0.6))}</code>) for less delay; raise it if the picture breaks up. Sender
      and Relay on the same LAN: <code>{srtLatencyParam(lan)}</code> ({lan} ms). The UDP port{srt?.port ? ` ${srt.port}` : ''} must be mapped in
      the app's ports, and forwarded on the router for a sender or player outside your LAN.
    </p>
  );
}
