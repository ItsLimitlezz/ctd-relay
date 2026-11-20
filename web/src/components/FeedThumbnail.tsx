import { useEffect, useRef, useState } from 'react';
import { codecLabel } from '@shared/feed-codec';
import type { Feed, FeedState } from '@shared/types';
import { feedPreviewUrl } from '../api';
import { blockingProblem, nextThumbDelay, thumbMode } from '../state/feed-preview';
import { usePageVisible } from '../state/hooks';
import { LandscapeIcon, PlayIcon, VerticalIcon } from './icons';
import { Spinner } from './Spinner';
import { cx } from './utils';

const FEED_LABEL: Record<Feed, string> = { landscape: 'Landscape', vertical: 'Vertical' };

export interface FeedThumbnailProps {
  profileId: string;
  feed: Feed;
  /** The feed's state; undefined when not known here (it is probed every few seconds). */
  state: FeedState | undefined;
  /** Shows a "Watch" button (the live player). */
  onWatch?: () => void;
  /** Smaller frame (Profiles page rows). */
  compact?: boolean;
}

/**
 * A feed's JPEG preview in its own aspect (16:9 landscape, 9:16 vertical), refreshed every 3 s only
 * while the page is on screen and the feed is online. Offline: a placeholder; HEVC/AV1: the codec
 * warning (Relay can't take a frame of it, and the live player can't play it).
 */
export function FeedThumbnail({ profileId, feed, state, onWatch, compact = false }: FeedThumbnailProps) {
  const visible = usePageVisible();
  const mode = thumbMode(state, visible);
  const [src, setSrc] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  /** The last grab failed (503: e.g. an HEVC feed, which Relay can't take a frame of). */
  const [failed, setFailed] = useState(false);
  const srcRef = useRef<string | null>(null);
  const url = feedPreviewUrl(profileId, feed);

  const show = (next: string | null) => {
    if (srcRef.current) URL.revokeObjectURL(srcRef.current);
    srcRef.current = next;
    setSrc(next);
  };

  useEffect(() => {
    if (mode === 'offline' || mode === 'codec') show(null);
    if (mode !== 'live' && mode !== 'probe') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();
    const tick = async () => {
      let status = 0;
      try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: ac.signal });
        status = res.status;
        if (res.ok) {
          const blob = await res.blob();
          if (stopped) return;
          show(URL.createObjectURL(blob));
          setOffline(false);
          setFailed(false);
        } else {
          void res.body?.cancel();
          if (stopped) return;
          if (status === 404) {
            show(null);
            setOffline(true);
          } else {
            setFailed(true);
          }
        }
      } catch {
        if (stopped) return;
      }
      const delay = nextThumbDelay(mode, status);
      if (!stopped && delay !== null) timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      stopped = true;
      ac.abort();
      clearTimeout(timer);
    };
  }, [url, mode]);

  useEffect(() => () => show(null), []);

  const problem = blockingProblem(state);
  const isOffline = mode === 'offline' || (mode === 'probe' && offline);
  const Icon = feed === 'landscape' ? LandscapeIcon : VerticalIcon;
  const label = `${FEED_LABEL[feed]} feed`;

  let body;
  if (problem) {
    body = (
      <div className="feed-thumb-msg is-danger" title={problem.message}>
        <strong>{codecLabel(problem.codec)} ⚠</strong>
        <span>No preview: Relay needs H.264</span>
      </div>
    );
  } else if (isOffline) {
    body = (
      <div className="feed-thumb-msg">
        <Icon />
        <span>Offline</span>
      </div>
    );
  } else if (src) {
    body = <img src={src} alt={`${label} preview`} draggable={false} />;
  } else if (failed) {
    body = (
      <div className="feed-thumb-msg">
        <Icon />
        <span>No preview right now</span>
      </div>
    );
  } else {
    body = (
      <div className="feed-thumb-msg">
        <Spinner size="sm" label={null} />
        <span>Loading preview…</span>
      </div>
    );
  }

  return (
    <div
      className={cx('feed-thumb', `is-${feed}`, compact && 'is-compact')}
      data-mode={isOffline ? 'offline' : mode}
    >
      {body}
      {onWatch && !isOffline && !problem && (
        <button type="button" className="feed-thumb-watch" onClick={onWatch} aria-label={`Watch the ${label.toLowerCase()} live`}>
          <PlayIcon width={14} height={14} />
          <span>Watch</span>
        </button>
      )}
    </div>
  );
}
