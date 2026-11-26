import { useState } from 'react';
import type { IngestInfo } from '@shared/api';
import type { Feed, Profile } from '@shared/types';
import { DEFAULT_PROFILE_ID } from '@shared/types';
import { api } from '../../api';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmButton } from '../../components/ConfirmButton';
import { CopyField } from '../../components/CopyField';
import { EmptyState } from '../../components/EmptyState';
import { ProfileTag } from '../../components/ProfileBadge';
import { Spinner } from '../../components/Spinner';
import { SrtLatencyNote, SrtUnavailable } from '../../components/SrtInfo';
import { SrtlaFields, SrtlaSteps, SrtlaUnavailable } from '../../components/SrtlaInfo';
import { toast } from '../../components/Toast';
import { errorMessage } from '../../state/errors';
import { useApi } from '../../state/hooks';
import { useProfileContext } from '../../state/profile';
import { FEED_LABEL } from '../destinations/destination-form';

/** Recommended OBS encoder settings per feed (the app relays without re-encoding). */
export const ENCODER_ROWS: { setting: string; landscape: string; vertical: string }[] = [
  { setting: 'Resolution', landscape: '1920×1080 or 1280×720', vertical: '1080×1920 or 720×1280' },
  { setting: 'Frame rate', landscape: '60 or 30 fps', vertical: '30 fps' },
  { setting: 'Video', landscape: 'H.264, CBR, 6000 kbps or less', vertical: 'H.264, CBR, about 4000 kbps' },
  { setting: 'Keyframe interval', landscape: '2 s', vertical: '2 s' },
  { setting: 'Audio', landscape: 'AAC 160 kbps, 48 kHz', vertical: 'AAC 160 kbps, 48 kHz' },
];

export function ObsTab() {
  const { profileId, current, profiles } = useProfileContext();
  const ingest = useApi(() => api.ingest(profileId), [profileId]);
  const [rotating, setRotating] = useState<Feed | null>(null);

  const rotate = async (feed: Feed) => {
    setRotating(feed);
    try {
      ingest.setData(await api.rotateIngestKey(feed, profileId));
      toast.warn(`New ${FEED_LABEL[feed].toLowerCase()} stream key. Paste it into OBS before you stream again.`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setRotating(null);
    }
  };

  if (!ingest.data) {
    return (
      <Card>
        {ingest.error ? (
          <EmptyState
            title="Couldn't load the OBS settings"
            description={ingest.error}
            action={
              <Button onClick={ingest.reload} loading={ingest.loading}>
                Try again
              </Button>
            }
          />
        ) : (
          <div className="row muted">
            <Spinner size="sm" /> Loading…
          </div>
        )}
      </Card>
    );
  }

  return (
    <>
      <IngestCard
        info={ingest.data}
        profile={current}
        profileCount={profiles?.length ?? 1}
        rotating={rotating}
        onRotate={rotate}
      />
      <div className="settings-grid">
        <Card title="Main output (landscape)" subtitle="OBS → Settings → Stream">
          <ol className="steps">
            <li>
              Service: <strong>Custom…</strong>
            </li>
            <li>Server: the server URL above.</li>
            <li>
              Stream Key: the <strong>landscape</strong> key above. Leave "Use authentication" off.
            </li>
            <li>
              Settings → Output (Advanced) → Streaming: H.264 encoder, <strong>CBR</strong>, keyframe interval <strong>2 s</strong>.
            </li>
          </ol>
        </Card>
        <Card title="Vertical (Aitum Vertical)" subtitle="The free Aitum Vertical plugin for OBS">
          <ol className="steps">
            <li>Install Aitum Vertical and restart OBS. It adds a vertical canvas with its own docks.</li>
            <li>Open the Vertical dock's settings (gear icon) and add a stream output.</li>
            <li>
              Server: the server URL above. Stream key: the <strong>vertical</strong> key above.
            </li>
            <li>Start it with the Vertical dock's stream button (or let it start with the main output).</li>
          </ol>
        </Card>
      </div>
      <Card title="Recommended encoder settings" subtitle="Video and audio are relayed as-is, so each output must suit every platform on that feed." flush>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">Landscape (main output)</th>
                <th scope="col">Vertical (Aitum)</th>
              </tr>
            </thead>
            <tbody>
              {ENCODER_ROWS.map((r) => (
                <tr key={r.setting}>
                  <th scope="row">{r.setting}</th>
                  <td>{r.landscape}</td>
                  <td>{r.vertical}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

export interface IngestCardProps {
  info: IngestInfo;
  /** The profile these keys belong to (null while the profile list is loading). */
  profile: Pick<Profile, 'id' | 'name' | 'color'> | null;
  /** How many profiles exist (with one, the per-profile notes are left out). */
  profileCount: number;
  rotating: Feed | null;
  onRotate: (feed: Feed) => Promise<void>;
}

export function IngestCard({ info, profile, profileCount, rotating, onRotate }: IngestCardProps) {
  const isDefault = (profile?.id ?? info.profileId) === DEFAULT_PROFILE_ID;
  return (
    <Card
      title={profile ? `Stream to ${profile.name}` : 'Stream to this server'}
      subtitle="Copy these into OBS. Each feed has its own key; treat the keys like passwords."
      actions={<ProfileTag profile={profile} />}
    >
      <div className="stack">
        {profileCount > 1 && (
          <div className="alert">
            <strong>Each profile has its own stream keys.</strong> OBS streams into the profile whose key it uses, so two
            profiles can be live at once: give each its own OBS (or a second OBS stream output) with that profile's server
            and keys.
            {isDefault && ' These are your original keys: OBS set up before profiles keeps working unchanged.'}
          </div>
        )}
        <CopyField label="Server" value={info.serverUrl} help="Use the server's LAN address. If it shows your public address, set Settings → General → Ingest host." />
        {info.feeds.map((f) => (
          <div key={f.feed} className="stack-sm">
            <CopyField label={`Stream key (${FEED_LABEL[f.feed].toLowerCase()})`} value={f.streamKey} secret />
            <div>
              <ConfirmButton
                size="sm"
                variant="ghost"
                confirmLabel="Rotate? OBS must be updated"
                loading={rotating === f.feed}
                onConfirm={() => onRotate(f.feed)}
              >
                Rotate {FEED_LABEL[f.feed].toLowerCase()} key
              </ConfirmButton>
            </div>
          </div>
        ))}
        <div className="stack-sm srt-ingest" role="group" aria-label="Low delay: SRT">
          <strong>Low delay: SRT (optional)</strong>
          {info.srt?.enabled ? (
            <>
              <p className="small muted">
                Instead of RTMP, OBS can send over SRT for less delay: Settings → Stream → Service <em>Custom…</em> → Server = the SRT address
                below, and leave <em>Stream Key</em> empty (the key is inside the address).
              </p>
              {info.feeds.map((f) =>
                f.srtUrl ? <CopyField key={f.feed} label={`SRT server (${FEED_LABEL[f.feed].toLowerCase()})`} value={f.srtUrl} secret /> : null,
              )}
              <SrtLatencyNote srt={info.srt} />
            </>
          ) : (
            <SrtUnavailable srt={info.srt} />
          )}
        </div>
        <div className="stack-sm srtla-ingest" role="group" aria-label="Bonded: SRTLA">
          <strong>Bonded cellular: SRTLA (BELABOX, Moblin; optional)</strong>
          {info.srtlaStatus?.enabled ? (
            <>
              {info.feeds.map((f) => (f.srtla ? <SrtlaFields key={f.feed} label={FEED_LABEL[f.feed].toLowerCase()} endpoint={f.srtla} /> : null))}
              <SrtlaSteps status={info.srtlaStatus} />
            </>
          ) : (
            <SrtlaUnavailable status={info.srtlaStatus} />
          )}
        </div>
        <p className="muted small">
          Using the CTD OBS plugin? Connect it in Settings → API and pick this profile in the plugin: it fills in the server and
          keys (main output and Aitum Vertical) for you.
        </p>
        <div className="alert alert-warn">
          <strong>Never port-forward 1935.</strong> RTMP from OBS is meant for your local network only (or a VPN). Only the web
          port belongs on the internet.
        </div>
      </div>
    </Card>
  );
}
