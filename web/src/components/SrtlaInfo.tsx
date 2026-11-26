import type { SrtlaEndpoint, SrtlaStatus } from '@shared/srtla';
import { DEFAULT_SRTLA_PORT } from '@shared/srtla';
import { CopyField } from './CopyField';

/** "SRTLA is off here: <reason>": said plainly wherever an SRTLA address would be (docs/SRTLA.md). */
export function SrtlaUnavailable({ status }: { status: SrtlaStatus | undefined }) {
  return (
    <p className="small muted srt-off" role="note">
      <strong>Bonded SRT (SRTLA) isn't available on this server.</strong> {status?.reason ?? 'This server did not report SRTLA support.'} SRT and RTMP work
      as usual.
    </p>
  );
}

/** One feed's SRTLA fields: BELABOX takes host + port + streamid, Moblin the one srtla:// URL. Secrets stay hidden until revealed. */
export function SrtlaFields({ label, endpoint }: { label: string; endpoint: SrtlaEndpoint }) {
  return (
    <div className="stack-sm srtla-feed" role="group" aria-label={`SRTLA ${label}`}>
      <CopyField label={`SRTLA URL, Moblin (${label})`} value={endpoint.url} secret />
      <CopyField label={`SRT streamid, BELABOX (${label})`} value={endpoint.streamId} secret />
    </div>
  );
}

/** BELABOX + Moblin steps and the UDP port to map and forward. Placeholders only, never a real address. */
export function SrtlaSteps({ status, host }: { status: SrtlaStatus | undefined; host?: string }) {
  const port = status?.port ?? DEFAULT_SRTLA_PORT;
  const h = host ?? 'relay.example.com';
  return (
    <div className="small muted srtla-steps">
      <p>
        Bonded cellular + Wi-Fi from an IRL encoder or phone. Map UDP port <code>{port}</code> in the app's ports (TrueNAS/Docker) and forward UDP{' '}
        <code>{port}</code> on your router to this server. SRTLA rides on SRT, so SRT stays on, but its own port only needs forwarding if you also
        send plain SRT from outside.
      </p>
      <ul>
        <li>
          <strong>BELABOX:</strong> in its web UI, set the relay server to manual: SRTLA receiver address <code>{h}</code>, SRTLA receiver port{' '}
          <code>{port}</code>, SRT streamid = the <em>SRT streamid</em> above. Pick the SRT latency there (cellular: 1500–2000 ms).
        </li>
        <li>
          <strong>Moblin:</strong> Settings → Streams → your stream → URL = the <em>SRTLA URL</em> above (
          <code>srtla://{h}:{port}?streamid=publish:…:key=…</code>; the <code>srtla://</code> scheme is what makes it bond), video H.264, audio AAC.
        </li>
      </ul>
      <p>
        The key is inside the streamid, as with SRT: treat it like a password. At most {status?.maxGroups ?? 4} bonded senders at once. Relay can't
        show how many links a sender bonds (the receiver doesn't report it); the feed goes online like any other.
      </p>
    </div>
  );
}
