import { useEffect, useState } from 'react';
import type { TranscodeCapabilities, TranscodeSettings, TranscodeSettingsResponse } from '@shared/api';
import { MAX_WORKERS_LIMIT } from '@shared/transcode';
import { api } from '../../api';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { toast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { useAuth } from '../../state/auth';
import { errorMessage } from '../../state/errors';
import { useApi, useNow } from '../../state/hooks';
import { encoderRows, relativeTime, workingCodecs } from './settings-helpers';

/** While the startup probe runs, ask again this often. */
const PROBING_POLL_MS = 3000;

const WORKER_OPTIONS = Array.from({ length: MAX_WORKERS_LIMIT }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));

/**
 * Settings → Transcoding: the server-wide switch (off by default), how many destinations may
 * transcode at once, and which encoders work on this machine (with "check again").
 */
export function TranscodingTab() {
  const { isAdmin } = useAuth();
  const res = useApi(() => api.transcodeSettings(), []);
  const { data, reload, setData } = res;
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const probing = data?.capabilities.state === 'probing';

  useEffect(() => {
    if (!probing || checking) return;
    const timer = setTimeout(reload, PROBING_POLL_MS);
    return () => clearTimeout(timer);
  }, [probing, checking, data, reload]);

  if (!data) {
    return (
      <Card title="Transcoding">
        {res.error ? (
          <div className="alert alert-danger" role="alert">
            {res.error}
          </div>
        ) : (
          <Spinner label="Loading…" />
        )}
      </Card>
    );
  }

  const save = async (patch: Partial<TranscodeSettings>, done: string) => {
    setSaving(true);
    try {
      setData(await api.putTranscodeSettings(patch));
      toast.success(done);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const recheck = async () => {
    setChecking(true);
    try {
      const capabilities = await api.recheckTranscodeCapabilities();
      setData({ ...data, capabilities });
      toast.success('Encoders checked again.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="stack">
      <SwitchCard data={data} isAdmin={isAdmin} saving={saving} onSave={save} />
      <EncodersCard caps={data.capabilities} isAdmin={isAdmin} checking={checking} onRecheck={() => void recheck()} />
    </div>
  );
}

export function SwitchCard({
  data,
  isAdmin,
  saving,
  onSave,
}: {
  data: TranscodeSettingsResponse;
  isAdmin: boolean;
  saving: boolean;
  onSave: (patch: Partial<TranscodeSettings>, done: string) => Promise<void>;
}) {
  const { settings, capabilities: caps } = data;
  const codecs = caps.state === 'ready' ? workingCodecs(caps) : null;
  const cantEncode = caps.state === 'unavailable' || (caps.state === 'ready' && codecs === null);
  return (
    <Card
      title="Transcoding"
      subtitle="Send one high-quality feed from OBS and let this server make a version each platform accepts. Off by default: every destination gets the feed exactly as OBS sends it."
    >
      <div className="stack">
        <Toggle
          checked={settings.enabled}
          busy={saving}
          disabled={!isAdmin || (cantEncode && !settings.enabled)}
          label="Allow transcoding on this server"
          onChange={(enabled) => void onSave({ enabled }, enabled ? 'Transcoding is allowed. Turn it on per destination.' : 'Transcoding is off. Every destination gets the original feed.')}
        />
        {cpuOnly(caps) && (
          <p className="small item-warn transcode-cpu-warning" role="note">
            <strong>CPU only:</strong> no GPU encoder works on this server, so every transcode runs on its CPU, next to Twitch Dual Format through Relay and
            everything else the server does. One 1080p60 encode can take a home server&apos;s whole CPU. Relay refuses a destination setting the CPU test says
            can&apos;t keep real time, and sends the original feed instead of starting an encode while the CPU is already behind. Start with 1280×720 at 30 fps and
            try it in test mode.
          </p>
        )}
        {cantEncode ? (
          <p className="small item-warn">No video encoder works on this server, so there is nothing to turn on. See the table below.</p>
        ) : settings.enabled ? (
          <p className="muted small">
            On. Turn it on for a destination under Destinations → Edit → Transcoding{codecs ? ` (this server can encode ${codecs})` : ''}. Destinations without
            it are not affected.
          </p>
        ) : (
          <p className="muted small">
            Off. Destinations keep any transcoding settings you saved, but nothing is re-encoded until this is on.
          </p>
        )}
        <Field
          label="Destinations transcoding at once"
          help="Each one is a live video encode on this server. When the limit is reached, the next destination sends the original feed (or stops, as set on the destination)."
        >
          <Select
            options={WORKER_OPTIONS}
            value={String(settings.maxWorkers)}
            disabled={!isAdmin || saving}
            onValueChange={(v) => void onSave({ maxWorkers: Number(v) }, `Up to ${v} at once.`)}
          />
        </Field>
        <p className="muted small">
          Both apply to streams that start afterwards; a running stream is never interrupted. If an encode can't keep up, the dashboard warns and the
          destination falls back to the original feed where the platform accepts it.
        </p>
        {!isAdmin && <p className="muted small">Only an admin can change these.</p>}
      </div>
    </Card>
  );
}

/** Encoders checked, some work, and none of the working ones is on a GPU (the prod server). */
export function cpuOnly(caps: TranscodeCapabilities): boolean {
  if (caps.state !== 'ready') return false;
  const working = caps.encoders.filter((e) => e.ok);
  return working.length > 0 && working.every((e) => e.backend === 'software');
}

export function EncodersCard({ caps, isAdmin, checking, onRecheck }: { caps: TranscodeCapabilities; isAdmin: boolean; checking: boolean; onRecheck: () => void }) {
  const rows = encoderRows(caps);
  const now = useNow(30_000);
  return (
    <Card
      title="Encoders on this server"
      subtitle="Each encoder this FFmpeg build has, tested with one second of 720p video. Only encoders that work are offered."
    >
      <div className="stack">
        {caps.state === 'probing' ? (
          <div className="row muted small">
            <Spinner size="sm" label={null} /> Checking which encoders work…
          </div>
        ) : caps.state === 'unavailable' ? (
          <div className="alert alert-warn">This server can't transcode: {caps.error ?? "FFmpeg isn't available"}.</div>
        ) : rows.length === 0 ? (
          <div className="alert alert-warn">This FFmpeg build has none of the encoders Relay uses.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Encoder</th>
                  <th scope="col">Codec</th>
                  <th scope="col">Runs on</th>
                  <th scope="col">Test</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.encoder}>
                    <th scope="row" className="cell-mono">
                      {r.encoder}
                    </th>
                    <td>{r.codec}</td>
                    <td>{r.runsOn}</td>
                    <td className="cell-wrap">
                      <Badge tone={r.ok ? 'success' : 'neutral'}>{r.ok ? 'Works' : 'Not available'}</Badge>{' '}
                      <span className={r.ok ? undefined : 'muted'}>{r.ok ? r.result.replace(/^Works(?: · )?/, '') : r.result}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          The speed is a rough guide from a short test: 1080p at 60 fps needs about 4.5 times the work of the test, so a CPU encoder at 3× may or may
          not hold it. Try a destination in test mode to see. GPU encoders need the GPU passed into the container (docs/TRANSCODING.md).
        </p>
        <div className="row">
          <Button size="sm" loading={checking} disabled={!isAdmin || caps.state === 'probing'} onClick={onRecheck}>
            Check again
          </Button>
          <span className="muted small">
            {caps.probedAt ? `Checked ${relativeTime(caps.probedAt, now)}` : 'Not checked yet'}
            {caps.state === 'ready' ? ` · ${caps.cpu.cores} CPU threads` : ''}
            {caps.ffmpegVersion ? ` · ${caps.ffmpegVersion.replace(/^ffmpeg version\s+/i, 'FFmpeg ').split(' Copyright')[0]}` : ''}
          </span>
        </div>
      </div>
    </Card>
  );
}
