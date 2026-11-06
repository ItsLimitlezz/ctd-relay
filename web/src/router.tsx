// Tiny pushState router (no dependency): navigate(), useRoute(), useQuery(), <Link>.

import { useMemo, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

export type RouteName =
  | 'dashboard'
  | 'chat'
  | 'destinations'
  | 'accounts'
  | 'assets'
  | 'settings'
  | 'profiles'
  | 'profile'
  | 'login'
  | 'setup';

export interface RouteDef {
  name: RouteName;
  path: string;
  label: string;
  adminOnly: boolean;
  /** Shown in the main navigation. */
  nav: boolean;
}

export const ROUTES: readonly RouteDef[] = [
  { name: 'dashboard', path: '/', label: 'Dashboard', adminOnly: false, nav: true },
  { name: 'chat', path: '/chat', label: 'Chat', adminOnly: false, nav: true },
  { name: 'destinations', path: '/destinations', label: 'Destinations', adminOnly: true, nav: true },
  { name: 'accounts', path: '/accounts', label: 'Accounts', adminOnly: true, nav: true },
  { name: 'assets', path: '/assets', label: 'Assets', adminOnly: false, nav: true },
  { name: 'settings', path: '/settings', label: 'Settings', adminOnly: true, nav: true },
  // Streaming profiles (reached from the profile switcher and Settings, not the main nav).
  { name: 'profiles', path: '/profiles', label: 'Profiles', adminOnly: true, nav: false },
  { name: 'profile', path: '/profile', label: 'Profile', adminOnly: false, nav: true },
  { name: 'login', path: '/login', label: 'Sign in', adminOnly: false, nav: false },
  { name: 'setup', path: '/setup', label: 'Setup', adminOnly: false, nav: false },
];

const BY_PATH = new Map(ROUTES.map((r) => [r.path, r]));
const BY_NAME = new Map(ROUTES.map((r) => [r.name, r]));

/** Normalize a pathname: collapse duplicate slashes, drop a trailing slash. */
export function normalizePath(pathname: string): string {
  const p = ('/' + pathname).replace(/\/{2,}/g, '/');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

/** Route for a pathname. Unknown paths fall back to the dashboard. */
export function matchRoute(pathname: string): RouteDef {
  return BY_PATH.get(normalizePath(pathname).toLowerCase()) ?? (BY_NAME.get('dashboard') as RouteDef);
}

export function routeDef(name: RouteName): RouteDef {
  return BY_NAME.get(name) as RouteDef;
}

/**
 * Accept only same-origin app paths for post-login redirects ("/chat?x=1").
 * Rejects absolute URLs, protocol-relative ("//evil"), backslash tricks and the auth pages.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2048 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  if (/[\u0000-\u001f]/.test(raw)) return null;
  const name = matchRoute(raw.split(/[?#]/)[0] ?? '/').name;
  return name === 'login' || name === 'setup' ? null : raw;
}

/**
 * Query parameters that follow the user around the app: an in-app link or navigate() without them
 * keeps the current value (the current streaming profile, `?profile=`).
 */
export const STICKY_PARAMS: readonly string[] = ['profile'];

/**
 * `to` with the sticky parameters of `currentSearch` added when `to` doesn't set them itself.
 * Only for same-app paths ("/chat", "/settings?tab=api#x"); anything else is returned unchanged.
 */
export function withStickyParams(to: string, currentSearch: string): string {
  if (!to.startsWith('/') || to.startsWith('//') || to.includes('\\')) return to;
  const current = new URLSearchParams(currentSearch);
  const carried = STICKY_PARAMS.filter((k) => current.get(k));
  if (carried.length === 0) return to;
  const hashAt = to.indexOf('#');
  const hash = hashAt === -1 ? '' : to.slice(hashAt);
  const beforeHash = hashAt === -1 ? to : to.slice(0, hashAt);
  const qAt = beforeHash.indexOf('?');
  const pathname = qAt === -1 ? beforeHash : beforeHash.slice(0, qAt);
  const sp = new URLSearchParams(qAt === -1 ? '' : beforeHash.slice(qAt + 1));
  let changed = false;
  for (const k of carried) {
    if (sp.has(k)) continue;
    sp.set(k, current.get(k) as string);
    changed = true;
  }
  return changed ? `${pathname}?${sp.toString()}${hash}` : to;
}

/** Build "?a=1&b=2" from a record (null/undefined/'' values are dropped). */
export function buildSearch(params: Record<string, string | number | boolean | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------------------
// Location store
// ---------------------------------------------------------------------------

const hasWindow = typeof window !== 'undefined';
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

if (hasWindow) window.addEventListener('popstate', notify);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentHref(): string {
  return hasWindow ? location.pathname + location.search : '/';
}

export interface NavigateOptions {
  replace?: boolean;
  /** Keep the current sticky parameters when `to` doesn't set them (default true). */
  sticky?: boolean;
}

/**
 * Navigate within the app. External URLs fall back to a full page load. Sticky query parameters
 * (the current profile) are kept unless `to` sets them.
 */
export function navigate(to: string, opts: NavigateOptions = {}): void {
  if (!hasWindow) return;
  const url = new URL(opts.sticky === false ? to : withStickyParams(to, location.search), location.href);
  if (url.origin !== location.origin) {
    location.assign(url.href);
    return;
  }
  const next = url.pathname + url.search + url.hash;
  const prevPath = location.pathname;
  if (next === prevPath + location.search + location.hash && !opts.replace) return;
  if (opts.replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
  if (!opts.replace && url.pathname !== prevPath) window.scrollTo(0, 0);
  notify();
}

/** Merge query params into the current URL (null removes a key). Replaces history by default. */
export function setQuery(params: Record<string, string | null>, opts: NavigateOptions = { replace: true }): void {
  if (!hasWindow) return;
  const sp = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === '') sp.delete(k);
    else sp.set(k, v);
  }
  const s = sp.toString();
  // Built from the current query, so sticky parameters stay unless removed here on purpose.
  navigate(location.pathname + (s ? `?${s}` : '') + location.hash, { ...opts, sticky: false });
}

export interface Route extends RouteDef {
  /** Actual pathname (normalized). */
  pathname: string;
  /** Raw search string including "?" (or ''). */
  search: string;
}

/** Current route; re-renders on navigation. */
export function useRoute(): Route {
  const href = useSyncExternalStore(subscribe, currentHref, () => '/');
  return useMemo(() => {
    const qi = href.indexOf('?');
    const pathname = normalizePath(qi === -1 ? href : href.slice(0, qi));
    const search = qi === -1 ? '' : href.slice(qi);
    return { ...matchRoute(pathname), pathname, search };
  }, [href]);
}

/** Current query string as URLSearchParams (stable until the query changes). */
export function useQuery(): URLSearchParams {
  const { search } = useRoute();
  return useMemo(() => new URLSearchParams(search), [search]);
}

// ---------------------------------------------------------------------------
// <Link>
// ---------------------------------------------------------------------------

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: string;
  replace?: boolean;
}

function isModifiedClick(e: MouseEvent): boolean {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

export function Link({ to, replace, onClick, target, children, ...rest }: LinkProps) {
  // The href carries the sticky parameters too, so "open in new tab" keeps the profile.
  const { search } = useRoute();
  const href = withStickyParams(to, search);
  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || isModifiedClick(e) || (target && target !== '_self')) return;
    e.preventDefault();
    navigate(to, { replace });
  };
  return (
    <a href={href} target={target} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
