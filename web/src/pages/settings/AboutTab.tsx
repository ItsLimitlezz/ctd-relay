import { useEffect } from 'react';
import type { TranscodeCapabilities } from '@shared/api';
import { api } from '../../api';
import { Card } from '../../components/Card';
import { useApi } from '../../state/hooks';
import { transcodeSummary } from './settings-helpers';

/** Docs in the repository (shown as plain paths: the app has no fixed public docs URL). */
export const DOC_LINKS: { path: string; label: string }[] = [
  { path: 'README.md', label: 'Overview and quick start' },
  { path: 'docs/INSTALL-TRUENAS.md', label: 'Installing on TrueNAS' },
  { path: 'docs/OBS-SETUP.md', label: 'OBS setup (landscape + Aitum Vertical)' },
  { path: 'docs/PLATFORMS.md', label: 'Platform notes and developer apps' },
  { path: 'docs/SECURITY.md', label: 'Security, HTTPS and port forwarding' },
  { path: 'docs/ARCHITECTURE.md', label: 'How it works' },
];

/** While the startup probe runs, ask again this often. */
const PROBING_POLL_MS = 3000;

export function AboutTab({ version }: { version: string | null }) {
  return (
    <Card title="CTD Relay" subtitle="Self-hosted multistreaming: one OBS, every platform.">
      <div className="stack">
        <dl className="kv kv-start">
          <dt>Version</dt>
          <dd className="mono">{version ?? '—'}</dd>
          <dt>License</dt>
          <dd>AGPL-3.0</dd>
          <dt>Transcoding</dt>
          <dd>
            <TranscodeCapabilitiesLine />
          </dd>
        </dl>
        <div className="stack-sm">
          <h3>Documentation</h3>
          <p className="muted small">In the project's repository:</p>
          <ul className="steps">
            {DOC_LINKS.map((d) => (
              <li key={d.path}>
                <code>{d.path}</code> <span className="muted">— {d.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/** Loads the capability probe result (polling while it is still running) and shows it. */
function TranscodeCapabilitiesLine() {
  const caps = useApi(() => api.transcodeCapabilities(), []);
  const probing = caps.data?.state === 'probing';
  const { reload } = caps;
  useEffect(() => {
    if (!probing) return;
    const timer = setTimeout(reload, PROBING_POLL_MS);
    return () => clearTimeout(timer);
  }, [probing, caps.data, reload]);
  return <TranscodeCapabilitiesView caps={caps.data ?? null} error={caps.error} />;
}

/** Read-only: "Supported encoders — H.264: … · HEVC: … · AV1: …" (Relay doesn't transcode yet). */
export function TranscodeCapabilitiesView({ caps, error }: { caps: TranscodeCapabilities | null; error: string | null }) {
  const text = caps ? transcodeSummary(caps) : error ? `Couldn't check: ${error}` : 'Checking which encoders work…';
  return (
    <div className="stack-sm">
      <span>
        Supported encoders — <span className="mono">{text}</span>
      </span>
      {caps?.state === 'ready' && (
        <span className="muted small">
          Tested on this machine at startup ({caps.cpu.cores} CPU threads). Read-only for now: every destination still gets the stream as OBS sends it.
        </span>
      )}
    </div>
  );
}
