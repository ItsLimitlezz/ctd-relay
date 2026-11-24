import { useEffect, useState } from 'react';
import { CODEC_LABELS, isTranscoding, transcodeLimits } from '@shared/transcode';
import type { Feed, PlatformInfo, TranscodeProfile } from '@shared/types';
import { Field } from '../../components/Field';
import { Select } from '../../components/Select';
import { Spinner } from '../../components/Spinner';
import { TextInput } from '../../components/TextInput';
import { Toggle } from '../../components/Toggle';
import { Link } from '../../router';
import {
  audioSelectOptions,
  audioValue,
  codecSelectOptions,
  CPU_WARNING,
  encodesOnCpu,
  encoderSelectOptions,
  FALLBACK_OPTIONS,
  fpsSelectOptions,
  loadHint,
  parseAudio,
  parseSize,
  sizeSelectOptions,
  sizeValue,
  SOURCE_FPS,
  transcodeBlocked,
  turnOff,
  turnOn,
  type FeedVideo,
  type TranscodeContext,
} from './transcode-form';

export interface TranscodeSectionProps {
  info: PlatformInfo;
  feed: Feed;
  /** The destination's profile as edited (null = never set). */
  value: TranscodeProfile | null;
  onChange: (value: TranscodeProfile | null) => void;
  /** This server's switch and encoders (null fields while loading). */
  context: TranscodeContext;
  /** The feed OBS is sending right now, when it is (for defaults and the load hint). */
  feedVideo: FeedVideo;
  error?: string | undefined;
  disabled?: boolean;
}

/**
 * "Transcoding" part of the destination form: off by default (the platform gets the feed exactly as
 * OBS sends it). Options are limited to what the platform takes and what this server can encode.
 */
export function TranscodeSection({ info, feed, value, onChange, context, feedVideo, error, disabled = false }: TranscodeSectionProps) {
  const on = isTranscoding(value);
  const blocked = transcodeBlocked(info, context);
  const loading = !context.settings || !context.caps;
  const limits = transcodeLimits(info.id);
  // The bitrate is typed: keep the text so a half-typed number isn't rewritten under the cursor.
  const [bitrateText, setBitrateText] = useState(() => (value ? String(value.video.bitrateKbps) : ''));
  const bitrate = value?.video.bitrateKbps;
  useEffect(() => {
    if (bitrate !== undefined && Number(bitrateText) !== bitrate) setBitrateText(String(bitrate));
    // Only when the profile's number changes from outside (switching on, another codec).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bitrate]);

  const video = (patch: Partial<TranscodeProfile['video']>) => {
    if (value) onChange({ ...value, video: { ...value.video, ...patch } });
  };
  const toggle = (next: boolean) => onChange(next ? turnOn(value, info, feed, feedVideo, context.caps) : turnOff(value));
  const hint = on && value ? loadHint(value, info, context.caps, feedVideo) : null;

  return (
    <fieldset className="transcode-section stack" disabled={disabled}>
      <legend className="section-legend">Transcoding</legend>
      <Toggle
        checked={on}
        onChange={toggle}
        disabled={disabled || loading || (!on && blocked !== null)}
        label={`Re-encode the ${feed} feed for this destination`}
      />
      {loading ? (
        <div className="row muted small">
          <Spinner size="sm" label={null} /> Checking what this server can encode…
        </div>
      ) : blocked ? (
        <p className="small item-warn">
          {blocked}{' '}
          {on && 'Until then this destination gets the feed as OBS sends it. '}
          <Link to="/settings?tab=transcoding">Open Transcoding settings</Link>
        </p>
      ) : !on ? (
        <p className="muted small">
          Off: {info.name} gets the feed exactly as OBS sends it. Turn this on to send one high-quality feed from OBS and let this server make a
          version {info.name} accepts (up to {limits.maxLongEdge}×{limits.maxShortEdge}, {limits.maxFps} fps,{' '}
          {limits.codecs.map((c) => CODEC_LABELS[c]).join(' / ')}).
        </p>
      ) : null}

      {on && value && (
        <>
          <div className="transcode-grid">
            <Field label="Video codec">
              <Select
                options={codecSelectOptions(info, context.caps, value.video.codec)}
                value={value.video.codec}
                onValueChange={(codec) => video({ codec: codec as TranscodeProfile['video']['codec'], encoder: 'auto' })}
              />
            </Field>
            <Field label="Frame size" help="The feed is scaled to fit and padded with bars, never stretched.">
              <Select
                options={sizeSelectOptions(info, feed, value.video)}
                value={sizeValue(value.video)}
                onValueChange={(v) => {
                  const size = parseSize(v);
                  if (size) video(size);
                }}
              />
            </Field>
            <Field label="Frame rate">
              <Select
                options={fpsSelectOptions(info, feedVideo, value.video.fps)}
                value={value.video.fps === null ? SOURCE_FPS : String(value.video.fps)}
                onValueChange={(v) => video({ fps: v === SOURCE_FPS ? null : Number(v) })}
              />
            </Field>
            <Field label="Video bitrate (kbps)" help={`Constant bitrate. ${info.name}: ${limits.recommendedKbps} recommended, ${limits.maxKbps} at most.`}>
              <TextInput
                inputMode="numeric"
                value={bitrateText}
                maxLength={6}
                onValueChange={(text) => {
                  const digits = text.replace(/[^\d]/g, '');
                  setBitrateText(digits);
                  video({ bitrateKbps: digits ? Number(digits) : 0 });
                }}
              />
            </Field>
            <Field label="Encoder" help="Automatic uses a GPU encoder when one works on this server, otherwise the CPU.">
              <Select
                options={encoderSelectOptions(value.video.codec, context.caps, value.video.encoder)}
                value={value.video.encoder}
                onValueChange={(encoder) => video({ encoder })}
              />
            </Field>
            <Field label="Audio">
              <Select options={audioSelectOptions(value.audio)} value={audioValue(value.audio)} onValueChange={(v) => onChange({ ...value, audio: parseAudio(v) })} />
            </Field>
          </div>
          <Field
            label="If this server can't keep up"
            help="Applies when the encode runs slower than real time for 30 seconds, or the encoder keeps failing. Other destinations are never affected."
          >
            <Select
              options={FALLBACK_OPTIONS}
              value={value.fallback}
              onValueChange={(v) => onChange({ ...value, fallback: v === 'stop' ? 'stop' : 'copy' })}
            />
          </Field>
          {encodesOnCpu(value, context.caps) && (
            <p className="small item-warn transcode-cpu-warning" role="note">
              <strong>CPU:</strong> {CPU_WARNING}
            </p>
          )}
          {hint && (
            <p className={hint.tone === 'error' ? 'small field-error' : hint.tone === 'warn' ? 'small item-warn' : 'muted small'} role={hint.tone === 'error' ? 'alert' : undefined}>
              {hint.text}
            </p>
          )}
          <p className="muted small">Keyframes every {value.video.keyframeSec} s. Changes apply the next time this destination starts streaming; a running stream is never interrupted.</p>
        </>
      )}
      {error && (
        <p className="small field-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
