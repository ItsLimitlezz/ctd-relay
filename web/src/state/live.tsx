// Live store React bindings: one WebSocket to /api/ws?profile=<current profile> while logged in
// (switching profile reconnects it). Hooks: useSession, useChat, useLiveStatus, useLiveSocketReady, useLiveConnections,
// useAccountUpdates, useAccountsVersion, useDestinationsVersion, usePairings, useScopeUpgrades, useOpenIssues, useConnectedApps,
// useLiveEvent, useLiveActions.

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { WsServerMessage } from '@shared/api';
import type { ApiIssue } from '@shared/issues';
import type { Account, ChatMessage, ConnectedApp, PairingRequest, ProfileSummary, ScopeUpgradeRequest, SessionState } from '@shared/types';
import { api, wsUrl } from '../api';
import { alertForNotice, installAlerts } from './alerts';
import { useAuth } from './auth';
import { isApiError } from './errors';
import { LiveConnection, LiveStore, type LiveState } from './live-store';
import { useProfileContext } from './profile';
import { profileAlerts, withProfileQuery } from './profiles';
import { toast } from './toast';

const LiveContext = createContext<LiveStore | null>(null);

/** Resolves false only when the server says we're logged out. */
async function stillLoggedIn(): Promise<boolean> {
  try {
    await api.me();
    return true;
  } catch (err) {
    return !isApiError(err, 401);
  }
}

/** A server notice for another profile within this window replaces the summary-based alert. */
const NOTICE_DEDUPE_MS = 15_000;

/** The profile a notice is about, when the server says (newer servers may stamp it). */
export function noticeProfileId(msg: WsServerMessage): string | null {
  const id = (msg as { profileId?: unknown }).profileId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** The live socket's path for a profile. */
export function liveSocketPath(profileId: string): string {
  return withProfileQuery('/api/ws', profileId);
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const { user, isAdmin } = useAuth();
  const { profileId, ready, apply, refresh } = useProfileContext();
  const [store] = useState(() => new LiveStore());
  const userId = user?.id ?? null;
  // Latest values for the socket callbacks (they must not reconnect the socket when they change).
  const latest = useRef({ apply, refresh, isAdmin });
  useEffect(() => {
    latest.current = { apply, refresh, isAdmin };
  });

  useEffect(() => {
    if (!userId || !ready) return;
    store.startProfile(profileId);
    // Other profiles' alerts come from comparing successive 'profiles' pushes (see profileAlerts).
    // The baseline is reset on every 'hello' (connect, reconnect; a profile switch reconnects), so
    // a reconnect never replays stale alerts.
    let lastProfiles: ProfileSummary[] | null = null;
    // Profiles whose own notice already reached this socket recently (a server that sends
    // other profiles' notices too): the summary-based alert would only repeat it.
    const noticed = new Map<string, number>();
    const conn = new LiveConnection({
      url: () => wsUrl(liveSocketPath(profileId)),
      onMessage: (msg) => {
        store.dispatch(msg);
        if (msg.type === 'hello') {
          lastProfiles = Array.isArray(msg.profiles) ? msg.profiles : null;
          if (Array.isArray(msg.profiles)) latest.current.apply(msg.profiles);
          // Pending app pairings aren't in the hello: admins load them on every (re)connect.
          if (latest.current.isAdmin) {
            void store.loadPairings(api.pairings).catch(() => undefined);
            void store.loadScopeUpgrades(api.scopeUpgrades).catch(() => undefined);
          }
        } else if (msg.type === 'profiles') {
          const now = Date.now();
          for (const a of profileAlerts(lastProfiles, msg.profiles, profileId)) {
            if (a.alert && now - (noticed.get(a.profileId) ?? -Infinity) < NOTICE_DEDUPE_MS) continue;
            toast(a.message, { tone: a.level });
            if (a.alert) alertForNotice(a.level, a.message);
          }
          lastProfiles = msg.profiles;
          latest.current.apply(msg.profiles);
        } else if (msg.type === 'notice') {
          const from = noticeProfileId(msg);
          if (from && from !== profileId) noticed.set(from, Date.now());
          toast(msg.message, { tone: msg.level });
          // Opt-in sound + browser notification (Profile → Alerts / dashboard "Alert me").
          alertForNotice(msg.level, msg.message);
        }
      },
      onConnectedChange: (connected) => store.setConnected(connected),
      checkAuth: async () => {
        // A refused socket can also mean the profile is gone (deleted elsewhere): re-check the list
        // too, which moves the app to the default profile.
        void latest.current.refresh().catch(() => undefined);
        return stillLoggedIn();
      },
    });
    const uninstallAlerts = installAlerts();
    conn.start();
    const kick = () => conn.kick();
    const onVisible = () => {
      if (document.visibilityState === 'visible') conn.kick();
    };
    window.addEventListener('online', kick);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', kick);
      document.removeEventListener('visibilitychange', onVisible);
      uninstallAlerts();
      conn.stop();
    };
  }, [userId, ready, profileId, store]);

  // Logged out (or another user): forget everything, including pairings and apps.
  useEffect(() => {
    if (!userId) store.reset();
    return () => store.reset();
  }, [userId, store]);

  return <LiveContext.Provider value={store}>{children}</LiveContext.Provider>;
}

function useStore(): LiveStore {
  const store = useContext(LiveContext);
  if (!store) throw new Error('Live hooks must be used inside <LiveProvider>');
  return store;
}

/** Subscribe to a slice of the live state. The selector must return a stable reference. */
export function useLiveState<T>(selector: (s: LiveState) => T): T {
  const store = useStore();
  const get = () => selector(store.getState());
  return useSyncExternalStore(store.subscribe, get, get);
}

const NO_CHAT: ChatMessage[] = [];

/**
 * Whether the store holds the profile on screen. Right after a profile switch the pages render once
 * before LiveProvider's effect resets the store, so its session and chat are still the previous
 * profile's: hide them (and let REST fallbacks run) until the store follows.
 */
export function storeShowsProfile(state: Pick<LiveState, 'profileId'>, profileId: string): boolean {
  return state.profileId === null || state.profileId === profileId;
}

/** Current session (null until the first snapshot for the profile on screen arrives). */
export function useSession(): SessionState | null {
  const { profileId } = useProfileContext();
  return useLiveState((s) => (storeShowsProfile(s, profileId) ? s.session : null));
}
/** Combined chat, oldest first (last 500), of the profile on screen. */
export function useChat(): ChatMessage[] {
  const { profileId } = useProfileContext();
  return useLiveState((s) => (storeShowsProfile(s, profileId) ? s.chat : NO_CHAT));
}
/** True while the live socket for the profile on screen is connected. */
export function useLiveSocketReady(): boolean {
  const { profileId } = useProfileContext();
  return useLiveState((s) => s.connected && s.profileId === profileId);
}
/** True while the live WebSocket is connected. */
export const useLiveStatus = (): boolean => useLiveState((s) => s.connected);
/** How many times the socket has connected (0 = still connecting for the first time). */
export const useLiveConnections = (): number => useLiveState((s) => s.connections);
/** Latest Account objects pushed by the server (by id). */
export const useAccountUpdates = (): Readonly<Record<string, Account>> => useLiveState((s) => s.accounts);
/** Changes whenever an account changes (or after a reconnect): use as a refetch dependency. */
export const useAccountsVersion = (): number => useLiveState((s) => s.accountsVersion);
/** Changes whenever destinations change (or after a reconnect): use as a refetch dependency. */
export const useDestinationsVersion = (): number => useLiveState((s) => s.destinationsVersion);
/** Pending app pairings (admins), every profile; null until loaded. */
export const usePairings = (): PairingRequest[] | null => useLiveState((s) => s.pairings);
/** Pending scope upgrades (admins), every profile; null until loaded. */
export const useScopeUpgrades = (): ScopeUpgradeRequest[] | null => useLiveState((s) => s.scopeUpgrades);

const NO_ISSUES: ApiIssue[] = [];

/** The on-screen profile's open issues, oldest first (docs/API.md §17), live. */
export function useOpenIssues(): ApiIssue[] {
  const { profileId } = useProfileContext();
  return useLiveState((s) => (storeShowsProfile(s, profileId) ? s.issues : NO_ISSUES));
}
/** Connected apps, every profile; null until loaded. */
export const useConnectedApps = (): ConnectedApp[] | null => useLiveState((s) => s.apps);

/** Run `handler` for every server message of `type` (latest handler is always used). */
export function useLiveEvent<K extends WsServerMessage['type']>(
  type: K,
  handler: (msg: Extract<WsServerMessage, { type: K }>) => void,
): void {
  const store = useStore();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(
    () =>
      store.onEvent((msg) => {
        if (msg.type === type) ref.current(msg as Extract<WsServerMessage, { type: K }>);
      }),
    [store, type],
  );
}

export interface LiveActions {
  /** Apply a SessionState returned by a REST call (start/stop/auto). */
  applySession: (session: SessionState) => void;
  /** Use a REST session snapshot only if the socket hasn't delivered one yet. */
  seedSession: (session: SessionState) => void;
  /** Merge fields into the current session (e.g. { title } after api.setTitle). */
  patchSession: (patch: Partial<SessionState>) => void;
  /** Merge chat messages fetched over REST. */
  mergeChat: (messages: ChatMessage[]) => void;
  /** (Re)load pending pairings over REST [admin]. Rejects with the request's error. */
  loadPairings: () => Promise<void>;
  /** (Re)load pending scope upgrades over REST [admin]. Rejects with the request's error. */
  loadScopeUpgrades: () => Promise<void>;
  /** (Re)load connected apps over REST [admin]. Rejects with the request's error. */
  loadApps: () => Promise<void>;
}

/**
 * Push REST results into the live store. Bound to the profile on screen when the hook ran: an
 * answer that arrives after switching to another profile is dropped instead of mixing profiles.
 */
export function useLiveActions(): LiveActions {
  const store = useStore();
  const { profileId } = useProfileContext();
  return useMemo(
    () => ({
      applySession: (s) => store.applySession(s, profileId),
      seedSession: (s) => store.seedSession(s, profileId),
      patchSession: (p) => store.patchSession(p, profileId),
      mergeChat: (m) => store.mergeChat(m, profileId),
      loadPairings: () => store.loadPairings(api.pairings),
      loadScopeUpgrades: () => store.loadScopeUpgrades(api.scopeUpgrades),
      loadApps: () => store.loadApps(api.apps),
    }),
    [store, profileId],
  );
}
