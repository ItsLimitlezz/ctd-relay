import { useEffect, useRef, useState } from 'react';
import type HlsType from 'hls.js';
import type { Feed, FeedState } from '@shared/types';
import { feedLiveUrl } from '../api';
import {
  blockingProblem,
  formatDelay,
  loadVolume,
  MAX_PLAYER_RETRIES,
  meterDecay,
  meterLevel,
  playerError,
  saveVolume,
  type PlayerError,
} from '../state/feed-preview';
import { usePageVisible } from '../state/hooks';
import { Button } from './Button';
import { MuteIcon, VolumeIcon } from './icons';
import { Modal } from './Modal';
import { Spinner } from './Spinner';
import { cx } from './utils';

const FEED_LABEL: Record<Feed, string> = { landscape: 'Landscape', vertical: 'Vertical' };

export interface LivePlayerModalProps {
  open: boolean;
  onClose: () => void;
  profileId: string;
  feed: Feed;
  /** The feed's live state, when known (dashboard). Undefined on pages without feed states. */
  state?: FeedState | undefined;
  /** Shown in the title, e.g. the profile name. */
  context?: string;
}

/** "Watch": the feed live (LL-HLS through Relay, ~1–3 s behind), muted until you turn the sound on. */
export function LivePlayerModal({ open, onClose, profileId, feed, state, context }: LivePlayerModalProps) {
  return (
    <Modal open={open} onClose={onClose} size="lg" title={`${FEED_LABEL[feed]} feed · live${context ? ` · ${context}` : ''}`}>
      <LivePlayer profileId={profileId} feed={feed} state={state} />
    </Modal>
  );
}

type Phase = 'connecting' | 'playing' | 'buffering' | 'reconnecting' | 'suspended';

interface AudioGraph {
  ctx: AudioContext;
  gain: GainNode;
  analyser: AnalyserNode;
}

/** The status code hls.js saw for a failed load (undefined when there was no HTTP answer). */
function httpStatus(data: { response?: { code?: number } | undefined; networkDetails?: unknown }): number | undefined {
  const code = data.response?.code;
  if (typeof code === 'number' && code > 0) return code;
  const details = data.networkDetails as { status?: unknown } | null | undefined;
  return typeof details?.status === 'number' && details.status > 0 ? details.status : undefined;
}

export function LivePlayer({ profileId, feed, state }: { profileId: string; feed: Feed; state?: FeedState | undefined }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  const audioRef = useRef<AudioGraph | null>(null);
  const attemptsRef = useRef(0);
  /**
   * Safari's own HLS player (no Media Source): WebKit hands a Web Audio graph silence for an HLS
   * <video>, so the meter's graph would mute the sound. Plain element volume there, no meter.
   */
  const nativeRef = useRef(false);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<PlayerError | null>(null);
  const [generation, setGeneration] = useState(0);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(loadVolume);
  const [hasMeter, setHasMeter] = useState(false);
  const [delay, setDelay] = useState<number | null>(null);
  const visible = usePageVisible();

  const problem = blockingProblem(state);
  const offline = state !== undefined && !state.online;
  // A hidden tab nobody listens to stops pulling the stream (its viewer slot frees after 15 s).
  const suspended = !visible && muted;
  const halted = problem !== null || offline || error !== null;

  // The feed came back: an "offline" stop clears by itself.
  useEffect(() => {
    if (state?.online && error?.kind === 'offline') {
      attemptsRef.current = 0;
      setError(null);
    }
  }, [state?.online, error?.kind]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || halted) return;
    if (suspended) {
      setPhase('suspended');
      return;
    }
    let disposed = false;
    let hls: HlsType | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let delayTimer: ReturnType<typeof setInterval> | undefined;
    const url = feedLiveUrl(profileId, feed);
    setPhase(attemptsRef.current > 0 ? 'reconnecting' : 'connecting');

    const retry = (e: PlayerError) => {
      if (attemptsRef.current >= MAX_PLAYER_RETRIES) {
        setError({ kind: 'stop', message: "The live preview keeps dropping. Check that Relay is running, then try again." });
        return;
      }
      attemptsRef.current += 1;
      setPhase('reconnecting');
      setNotice(e.message);
      retryTimer = setTimeout(() => setGeneration((g) => g + 1), e.retryMs ?? 1000);
    };

    /** The playlist failed: 410 (viewer ended) or no answer retries; anything else, ask Relay why. */
    const failed = async (status: number | undefined) => {
      if (disposed) return;
      if (status === 410 || (status === undefined && attemptsRef.current < 2)) {
        retry({ kind: 'retry', message: 'Reconnecting…', retryMs: 500 });
        return;
      }
      let code: string | undefined;
      let message: string | undefined;
      let retryAfter: number | undefined;
      let answer = 0;
      try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        answer = res.status;
        if (res.ok) {
          void res.body?.cancel();
        } else {
          const body = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
          code = body?.code;
          message = body?.error;
          retryAfter = Number(res.headers.get('retry-after')) || undefined;
        }
      } catch {
        answer = 0;
      }
      if (disposed) return;
      const e = answer === 200 ? ({ kind: 'retry', message: 'Reconnecting…', retryMs: 500 } as PlayerError) : playerError(answer, code, message, attemptsRef.current, retryAfter);
      if (e.kind === 'retry') retry(e);
      else setError(e);
    };

    const onPlaying = () => {
      attemptsRef.current = 0;
      setNotice(null);
      setPhase('playing');
    };
    const onWaiting = () => setPhase((p) => (p === 'playing' ? 'buffering' : p));
    const onNativeError = () => void failed(undefined);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);

    const start = async () => {
      const { default: Hls } = await import('hls.js');
      if (disposed) return;
      if (Hls.isSupported()) {
        nativeRef.current = false;
        let mediaRecovered = false;
        hls = new Hls({
          lowLatencyMode: true,
          // The CSP has no blob: workers; one stream demuxes fine on the main thread.
          enableWorker: false,
          backBufferLength: 4,
          maxLiveSyncPlaybackRate: 1.2,
          // About 2 s behind instead of MediaMTX's own target (0.5 s part hold-back, ~1 s behind): there
          // hls.js keeps under a second buffered and rebuffers at the first hiccup, then plays catch-up at
          // 1.2x into the next one (SR check: 3–6 frozen seconds a minute in 3 of 3 runs; at 2 s, none).
          liveSyncDuration: 2,
          liveDurationInfinity: true,
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          void video.play().catch(() => undefined);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || !hls) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
            mediaRecovered = true;
            hls.recoverMediaError();
            return;
          }
          hls.destroy();
          hls = null;
          void failed(httpStatus(data));
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari without Managed Media Source: its own HLS player (same-origin, the cookie goes along).
        nativeRef.current = true;
        video.addEventListener('error', onNativeError);
        video.src = url;
        void video.play().catch(() => undefined);
      } else {
        setError({ kind: 'stop', message: "This browser can't play the live preview (no HLS or Media Source support)." });
        return;
      }
      delayTimer = setInterval(() => {
        // Time behind Relay's ingest: MediaMTX stamps each part with when it received it
        // (EXT-X-PROGRAM-DATE-TIME). With a skewed clock, the distance to the live edge instead.
        const at = hls?.playingDate?.getTime();
        const behind = at ? (Date.now() - at) / 1000 : null;
        let d: number | null = behind !== null && behind > 0 && behind < 30 ? behind : (hls?.latency ?? null);
        if (!hls && video.seekable.length > 0) d = video.seekable.end(video.seekable.length - 1) - video.currentTime;
        setDelay(d !== null && Number.isFinite(d) && d > 0 ? d : null);
      }, 1000);
    };
    void start().catch(() => void failed(undefined));

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      clearInterval(delayTimer);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('error', onNativeError);
      hls?.destroy();
      video.removeAttribute('src');
      video.load();
    };
  }, [profileId, feed, halted, suspended, generation]);

  // Sound: element volume until the meter's audio graph exists, then the graph's gain (so the meter
  // still moves while muted).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const graph = audioRef.current;
    if (graph) {
      video.muted = false;
      video.volume = 1;
      graph.gain.gain.value = muted ? 0 : volume;
    } else {
      video.muted = muted;
      video.volume = volume;
    }
  }, [muted, volume, hasMeter]);

  // The meter: peak level, drawn straight into the bar (no React render per frame).
  useEffect(() => {
    const graph = audioRef.current;
    if (!graph || !visible) return;
    const buf = new Float32Array(graph.analyser.fftSize);
    let level = 0;
    let last = performance.now();
    let frame = 0;
    const draw = (t: number) => {
      graph.analyser.getFloatTimeDomainData(buf);
      level = meterDecay(level, meterLevel(buf), t - last);
      last = t;
      if (meterRef.current) meterRef.current.style.clipPath = `inset(0 ${((1 - level) * 100).toFixed(1)}% 0 0)`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [hasMeter, visible]);

  useEffect(
    () => () => {
      void audioRef.current?.ctx.close().catch(() => undefined);
      audioRef.current = null;
    },
    [],
  );

  const toggleSound = () => {
    const video = videoRef.current;
    const soundOn = muted; // the click turns the sound on when it is off
    // A click: browsers allow sound now, and an AudioContext may start.
    if (soundOn && video && !audioRef.current && !nativeRef.current) {
      try {
        const ctx = new AudioContext();
        const source = ctx.createMediaElementSource(video);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        const gain = ctx.createGain();
        source.connect(analyser);
        analyser.connect(gain);
        gain.connect(ctx.destination);
        audioRef.current = { ctx, gain, analyser };
        setHasMeter(true);
      } catch {
        audioRef.current = null; // no Web Audio: plain element volume, no meter
      }
    }
    void audioRef.current?.ctx.resume().catch(() => undefined);
    if (soundOn && video) void video.play().catch(() => undefined);
    setMuted(!soundOn);
  };

  const changeVolume = (v: number) => {
    setVolume(v);
    saveVolume(v);
    if (v > 0 && muted) toggleSound();
  };

  const tryAgain = () => {
    attemptsRef.current = 0;
    setError(null);
    setGeneration((g) => g + 1);
  };

  const shownError: PlayerError | null = problem ? { kind: 'codec', message: problem.message } : offline ? { kind: 'offline', message: 'The feed is offline. The player starts when OBS sends it.' } : error;
  const delayText = phase === 'playing' ? formatDelay(delay) : null;

  return (
    <div className="live-player">
      <div className={cx('live-frame', `is-${feed}`)}>
        <video ref={videoRef} muted playsInline autoPlay disablePictureInPicture aria-label={`${FEED_LABEL[feed]} feed, live`} hidden={shownError !== null} />
        {shownError ? (
          <div className={cx('live-overlay', shownError.kind === 'codec' ? 'is-danger' : undefined)} role="alert">
            <p>{shownError.message}</p>
            {shownError.kind === 'stop' && (
              <Button size="sm" onClick={tryAgain}>
                Try again
              </Button>
            )}
          </div>
        ) : phase !== 'playing' ? (
          <div className="live-overlay is-quiet" aria-live="polite">
            {phase === 'suspended' ? (
              <p>Paused while this tab is in the background.</p>
            ) : (
              <>
                <Spinner size="sm" label={null} />
                <p>{phase === 'connecting' ? 'Starting the live preview…' : phase === 'buffering' ? 'Buffering…' : (notice ?? 'Reconnecting…')}</p>
              </>
            )}
          </div>
        ) : null}
      </div>
      <div className="live-controls">
        <button
          type="button"
          className={cx('icon-btn', !muted && 'is-on')}
          onClick={toggleSound}
          aria-pressed={!muted}
          aria-label={muted ? 'Turn the sound on' : 'Mute'}
          title={muted ? 'Turn the sound on' : 'Mute'}
          disabled={shownError !== null}
        >
          {muted ? <MuteIcon /> : <VolumeIcon />}
        </button>
        <input
          type="range"
          className="live-volume"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => changeVolume(Number(e.currentTarget.value))}
          aria-label="Volume"
          disabled={shownError !== null}
        />
        <span
          className={cx('live-meter', !hasMeter && 'is-off')}
          title={hasMeter ? 'Audio level (peak)' : muted ? 'Turn the sound on once to see the audio level' : 'No audio level in this browser’s own player'}
          aria-hidden="true"
        >
          <span ref={meterRef} className="live-meter-bar" />
        </span>
        <span className="spacer" />
        <span className="live-status small muted" aria-live="polite">
          {shownError ? '' : phase === 'playing' ? (delayText ? `Live · ${delayText} behind` : 'Live') : ''}
        </span>
      </div>
      <p className="faint small live-note">
        What OBS sends to Relay, straight from the feed (not re-encoded). Muted until you turn the sound on. Closing this stops it.
      </p>
    </div>
  );
}
