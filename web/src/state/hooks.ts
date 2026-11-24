// Small shared hooks: data fetching, clock, destinations list.

import { useCallback, useEffect, useRef, useState, type DependencyList, type Dispatch, type SetStateAction } from 'react';
import type { Destination } from '@shared/types';
import { api } from '../api';
import { errorMessage } from './errors';
import { useDestinationsVersion } from './live';
import { useProfileId } from './profile';

export interface ApiResource<T> {
  data: T | undefined;
  /** User-facing error message from the last load, if it failed. */
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: Dispatch<SetStateAction<T | undefined>>;
}

/**
 * Load data with `fetcher` and reload whenever `deps` change. Stale responses (from a
 * previous deps value or after unmount) are ignored. Keeps the old data while reloading.
 */
export function useApi<T>(fetcher: () => Promise<T>, deps: DependencyList): ApiResource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  // Declared before the load effect so it runs first and the load uses the latest fetcher.
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetcherRef.current().then(
      (d) => {
        if (!active) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!active) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

/**
 * The current profile's destinations; refetches when the server reports destination changes, after
 * a reconnect and when the profile changes.
 */
export function useDestinations(): ApiResource<Destination[]> {
  const version = useDestinationsVersion();
  const profileId = useProfileId();
  return useApi(() => api.destinations(profileId), [version, profileId]);
}

/** Current time in ms, updated every `intervalMs` (null pauses the clock). */
export function useNow(intervalMs: number | null = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Is the page on screen (document.visibilityState === 'visible')? True outside a browser. */
export function usePageVisible(): boolean {
  const read = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const [visible, setVisible] = useState(read);
  useEffect(() => {
    const update = () => setVisible(read());
    document.addEventListener('visibilitychange', update);
    update();
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}
