// Issues (docs/API.md §15, v1.11): the CTD suite's one alert contract. The event hub feeds this
// tracker what it already sees — sessions, ingest feeds, destinations, OBS events from the CTD OBS
// plugin, connected apps — and the tracker decides which problems are open:
//
//   feed.offline      a running session's ingest feed went offline (and OBS didn't stop on purpose)
//   destination.down  a destination's `down` flag held 5 s (critical once Relay gave up)
//   stream.down       every counted destination of a running session is down
//   obs.output.down   an OBS output reconnecting (when no Relay feed already tells the story)
//   obs.issue         the plugin's obs.issue.raised / obs.issue.cleared, as they are
//
// Each open issue has one stable id (`<kind>|<subject key>`); hold times keep blips from becoming
// alerts; a raise of an open id is an update; clears carry a resolution. Pure logic plus timers:
// the hub turns raised()/cleared() into issue.raised / issue.cleared envelopes.

import { FEEDS, type Feed, type PlatformId } from '../../../shared/types.js';
import type {
  ApiDestination,
  ApiIssue,
  ApiIssueCleared,
  ApiIssueRaised,
  ApiIssueSubject,
  IssueKind,
  IssueResolution,
  IssueSeverity,
} from './types.js';

export const ISSUE_HOLDS = {
  /** feed.offline: long enough for the plugin's clean-stop report to arrive first. */
  feed: 5_000,
  destination: 5_000,
  stream: 5_000,
  output: 3_000,
};
export type IssueHolds = typeof ISSUE_HOLDS;

/** A clean OBS stop (obs.output stopped, no error) this close to a feed going offline = on purpose. */
export const CLEAN_STOP_WINDOW_MS = 15_000;
/** An OBS app that sent events for a profile this recently is watching it (the plugin resends every 60 s). */
export const OBS_APP_RECENT_MS = 90_000;
/** A plugin issue's firstSeen is kept when it is at most this far ahead of, or behind, Relay's clock. */
const FIRST_SEEN_AHEAD_MS = 5 * 60_000;
const FIRST_SEEN_MAX_AGE_MS = 7 * 24 * 3600_000;
const TITLE_MAX = 120;
const MESSAGE_MAX = 300;

export interface IssueSource {
  connection: string;
  platform: PlatformId | 'core' | 'obs';
}

/** What is wrong right now, without its times. */
export interface IssueDraft {
  id: string;
  kind: IssueKind;
  rule: string | null;
  severity: IssueSeverity;
  title: string;
  message: string | null;
  subject: ApiIssueSubject;
  onProgram: boolean | null;
  scene: string | null;
  src: IssueSource;
  /** When the problem started, if the reporter says (the plugin's firstSeen); default: now. */
  firstSeen?: number;
}

export interface IssueTrackerDeps {
  now(): number;
  raised(profileId: string, src: IssueSource, data: ApiIssueRaised): void;
  cleared(profileId: string, src: IssueSource, data: ApiIssueCleared): void;
  /** Runs timer callbacks (the hub's guard: nothing may throw out of a timer). */
  run(fn: () => void): void;
  /** The plugin's open issues as Relay last stored them (re-raised when a stale app returns). */
  obsIssues?(profileId: string, appId: string): Record<string, unknown>[];
  holds?: Partial<IssueHolds>;
}

/** Just what the tracker needs of a connected app. */
export interface IssueApp {
  id: string;
  online: boolean;
}

interface OpenIssue {
  issue: ApiIssue;
  src: IssueSource;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  compute: () => IssueDraft | null;
}

interface Reconnecting {
  appId: string;
  output: string;
  feed: Feed | null;
  error: string | null;
}

/** What the tracker knows of one profile. */
interface ProfileState {
  running: boolean;
  feeds: Map<Feed, boolean>;
  /** Feeds that were online in this session and went offline (until they return or it ends). */
  lostFeeds: Set<Feed>;
  /** Latest destination item per id (from the hub's refreshes). */
  destinations: Map<string, ApiDestination>;
  /** Canvas → when OBS last stopped that stream cleanly. */
  cleanStop: Map<Feed, number>;
  /** obs.output.down id → the output that is reconnecting. */
  reconnecting: Map<string, Reconnecting>;
  /** OBS app id → when it last sent an event for this profile. */
  obsApps: Map<string, number>;
  /** OBS apps whose issues were cleared as stale (re-raised from the store when they return). */
  staleApps: Set<string>;
  open: Map<string, OpenIssue>;
  pending: Map<string, Pending>;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '') return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function severityOf(v: unknown): IssueSeverity {
  if (v === 'critical' || v === 'error') return 'critical';
  if (v === 'info') return 'info';
  return 'warning';
}

const RANK: Record<IssueSeverity, number> = { info: 0, warning: 1, critical: 2 };

const FEED_NAME: Record<Feed, string> = { landscape: 'Landscape', vertical: 'Vertical' };

/** The Relay feed an OBS output streams, or null (recordings, replay buffer, unknown outputs). */
export function outputFeed(data: Record<string, unknown>): Feed | null {
  const output = text(data.output, TITLE_MAX);
  if (!output || /record|replay|virtual/i.test(output)) return null;
  const canvas = text(data.canvas, TITLE_MAX);
  if (canvas === 'landscape' || canvas === 'vertical') return canvas;
  if (output === 'main') return 'landscape';
  if (output === 'vertical') return 'vertical';
  return null;
}

function sameContent(a: ApiIssue, d: IssueDraft): boolean {
  return (
    a.severity === d.severity &&
    a.title === d.title &&
    a.message === d.message &&
    a.onProgram === d.onProgram &&
    a.scene === d.scene &&
    a.rule === d.rule &&
    JSON.stringify(a.subject) === JSON.stringify(d.subject)
  );
}

export class IssueTracker {
  private readonly deps: IssueTrackerDeps;
  private readonly holds: IssueHolds;
  private readonly profiles = new Map<string, ProfileState>();
  private closed = false;

  constructor(deps: IssueTrackerDeps) {
    this.deps = deps;
    this.holds = { ...ISSUE_HOLDS, ...deps.holds };
  }

  /** Open issues of a profile, oldest first. */
  list(profileId: string): ApiIssue[] {
    const st = this.profiles.get(profileId);
    if (!st) return [];
    return [...st.open.values()].map((o) => o.issue).sort((a, b) => a.firstSeen - b.firstSeen || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  close(): void {
    this.closed = true;
    for (const st of this.profiles.values()) {
      for (const p of st.pending.values()) clearTimeout(p.timer);
      st.pending.clear();
    }
  }

  // -------------------------------------------------------------------------
  // Inputs (called by the event hub)
  // -------------------------------------------------------------------------

  /** The session started or stopped. Stopping ends every feed, destination and stream issue. */
  session(profileId: string, running: boolean): void {
    const st = this.state(profileId);
    const was = st.running;
    st.running = running;
    if (was !== running) st.lostFeeds.clear();
    if (was && !running) {
      this.dropWhere(st, profileId, (i) => i.subject.type === 'feed' || i.subject.type === 'destination' || i.subject.type === 'stream', 'ended');
    }
  }

  /** An ingest feed's online flag (repeats are fine). */
  feed(profileId: string, feed: Feed, online: boolean): void {
    const st = this.state(profileId);
    const was = st.feeds.get(feed);
    st.feeds.set(feed, online);
    if (was === online) return;
    const id = `feed.offline|${feed}`;
    if (online) {
      st.lostFeeds.delete(feed);
      st.cleanStop.delete(feed); // a new stream: an old clean stop says nothing about its next loss
      this.drop(st, profileId, id, 'recovered');
    } else if (was === true && st.running) {
      st.lostFeeds.add(feed);
      this.want(st, profileId, id, this.holds.feed, () => this.feedDraft(profileId, feed));
    }
    this.refreshFeeds(st, profileId);
  }

  /** A destination's current API item (every refresh of it). */
  destination(profileId: string, item: ApiDestination): void {
    const st = this.state(profileId);
    st.destinations.set(item.id, item);
    const id = `destination.down|${item.id}`;
    if (item.down && st.running) this.want(st, profileId, id, this.holds.destination, () => this.destinationDraft(profileId, item.id));
    else this.drop(st, profileId, id, 'recovered');
    this.checkStream(st, profileId);
  }

  destinationRemoved(profileId: string, destinationId: string): void {
    const st = this.profiles.get(profileId);
    if (!st) return;
    st.destinations.delete(destinationId);
    this.drop(st, profileId, `destination.down|${destinationId}`, 'removed');
    this.checkStream(st, profileId);
  }

  /** An OBS event the hub re-emitted (only changes reach it: the store drops unchanged resends). */
  obsEvent(profileId: string, appId: string, type: string, data: Record<string, unknown>): void {
    const st = this.state(profileId);
    st.obsApps.set(appId, this.deps.now());
    st.staleApps.delete(appId);
    switch (type) {
      case 'obs.issue.raised':
        this.obsIssueRaised(st, profileId, appId, data);
        break;
      case 'obs.issue.cleared': {
        const pid = text(data.id, 200);
        if (pid) this.drop(st, profileId, `obs.issue|${appId}|${pid}`, 'recovered');
        break;
      }
      case 'obs.output':
        this.obsOutput(st, profileId, appId, data);
        break;
    }
  }

  /** The connected apps changed: issues of apps that left are removed, of apps gone quiet stale. */
  apps(list: readonly IssueApp[]): void {
    const byId = new Map(list.map((a) => [a.id, a]));
    for (const [profileId, st] of this.profiles) {
      const appIds = new Set<string>([...st.obsApps.keys(), ...st.staleApps]);
      for (const o of st.open.values()) {
        const s = o.issue.subject;
        if (s.type === 'obs.output' || s.type === 'obs.source') appIds.add(s.appId);
      }
      for (const appId of appIds) {
        const app = byId.get(appId);
        if (!app) {
          this.forgetApp(st, profileId, appId, 'removed');
          st.staleApps.delete(appId);
        } else if (!app.online) {
          if (this.forgetApp(st, profileId, appId, 'stale')) st.staleApps.add(appId);
        } else if (st.staleApps.has(appId)) {
          // Back: the store still has what it reported last; raise it again.
          st.staleApps.delete(appId);
          st.obsApps.set(appId, this.deps.now());
          for (const data of this.deps.obsIssues?.(profileId, appId) ?? []) this.obsIssueRaised(st, profileId, appId, data);
        }
      }
    }
  }

  /** A profile was deleted. */
  forgetProfile(profileId: string): void {
    const st = this.profiles.get(profileId);
    if (!st) return;
    this.dropWhere(st, profileId, () => true, 'removed');
    this.profiles.delete(profileId);
  }

  // -------------------------------------------------------------------------
  // Drafts: what each kind says right now (null = nothing wrong)
  // -------------------------------------------------------------------------

  private feedDraft(profileId: string, feed: Feed): IssueDraft | null {
    const st = this.profiles.get(profileId);
    if (!st || !st.running || st.feeds.get(feed) !== false) return null;
    const now = this.deps.now();
    const clean = st.cleanStop.get(feed);
    if (clean !== undefined && now - clean <= CLEAN_STOP_WINDOW_MS) return null; // OBS stopped on purpose
    const other = FEEDS.find((f) => f !== feed && st.feeds.get(f) === true);
    const rec = [...st.reconnecting.values()].find((r) => r.feed === feed);
    const watched = [...st.obsApps.values()].some((at) => now - at <= OBS_APP_RECENT_MS);
    let severity: IssueSeverity = 'critical';
    let message: string;
    if (rec) message = `OBS is reconnecting to Relay${rec.error ? `: ${rec.error}` : '.'}`;
    else if (other) message = `OBS stopped sending the ${feed} feed; the ${other} feed is still live.`;
    else if (watched) message = 'OBS stopped sending without stopping its stream: check OBS and its network.';
    else {
      severity = 'warning';
      message = "OBS stopped sending to Relay. If that wasn't on purpose, check OBS: the session ends soon unless the feed returns.";
    }
    return {
      id: `feed.offline|${feed}`,
      kind: 'feed.offline',
      rule: null,
      severity,
      title: `${FEED_NAME[feed]} feed lost`,
      message: text(message, MESSAGE_MAX),
      subject: { type: 'feed', feed },
      onProgram: null,
      scene: null,
      src: { connection: 'core', platform: 'core' },
    };
  }

  /**
   * A destination that only waits for a feed this session lost adds nothing: feed.offline is the
   * alert for it — or, when OBS stopped on purpose, there is deliberately none. (Waiting for a feed
   * that never came is the destination's own problem and is raised.)
   */
  private coveredByFeed(st: ProfileState, item: ApiDestination): boolean {
    return item.phase === 'waiting-for-feed' && item.waitingFor.some((f) => st.lostFeeds.has(f));
  }

  private destinationDraft(profileId: string, destinationId: string): IssueDraft | null {
    const st = this.profiles.get(profileId);
    const item = st?.destinations.get(destinationId);
    if (!st || !item || !item.down || !st.running) return null;
    const id = `destination.down|${item.id}`;
    if (!st.open.has(id) && this.coveredByFeed(st, item)) return null;
    return {
      id,
      kind: 'destination.down',
      rule: null,
      severity: item.phase === 'error' ? 'critical' : 'warning',
      title: text(`${item.name} is down`, TITLE_MAX) ?? 'A destination is down',
      message: text(item.message, MESSAGE_MAX),
      subject: { type: 'destination', destinationId: item.id, platform: item.platform, name: item.name },
      onProgram: null,
      scene: null,
      src: { connection: item.id, platform: item.platform },
    };
  }

  /** Counted destinations: enabled and not skipped (test mode marks skipped ones disabled). */
  private counted(st: ProfileState): ApiDestination[] {
    return [...st.destinations.values()].filter((d) => d.enabled && d.phase !== 'disabled');
  }

  private checkStream(st: ProfileState, profileId: string): void {
    const counted = this.counted(st);
    if (st.running && counted.length > 0 && counted.every((d) => d.down)) this.want(st, profileId, 'stream.down', this.holds.stream, () => this.streamDraft(profileId));
    else this.drop(st, profileId, 'stream.down', 'recovered');
  }

  private streamDraft(profileId: string): IssueDraft | null {
    const st = this.profiles.get(profileId);
    if (!st || !st.running) return null;
    const counted = this.counted(st);
    if (counted.length === 0 || !counted.every((d) => d.down)) return null;
    // Every one only waits for a lost feed: the feed issue is the alert.
    if (!st.open.has('stream.down') && counted.every((d) => this.coveredByFeed(st, d))) return null;
    const only = counted.length === 1 ? counted[0] : undefined;
    return {
      id: 'stream.down',
      kind: 'stream.down',
      rule: null,
      severity: 'critical',
      title: 'Stream down on every platform',
      message: text(only ? `${only.name} is the only destination and it is down.` : `None of the ${counted.length} destinations is reaching its platform.`, MESSAGE_MAX),
      subject: { type: 'stream' },
      onProgram: null,
      scene: null,
      src: { connection: 'core', platform: 'core' },
    };
  }

  private outputDraft(profileId: string, id: string): IssueDraft | null {
    const st = this.profiles.get(profileId);
    const rec = st?.reconnecting.get(id);
    if (!st || !rec) return null;
    // OBS streams this to Relay and Relay is live: feed.offline already tells it (and says "reconnecting").
    if (!st.open.has(id) && rec.feed && st.running && st.feeds.get(rec.feed) !== true) return null;
    return {
      id,
      kind: 'obs.output.down',
      rule: null,
      severity: 'warning',
      title: text(rec.feed ? `OBS ${rec.feed} stream reconnecting` : `OBS output "${rec.output}" reconnecting`, TITLE_MAX) ?? 'OBS output reconnecting',
      message: rec.error,
      subject: { type: 'obs.output', appId: rec.appId, output: rec.output, canvas: rec.feed },
      onProgram: null,
      scene: null,
      src: { connection: rec.appId, platform: 'obs' },
    };
  }

  // -------------------------------------------------------------------------
  // OBS
  // -------------------------------------------------------------------------

  private obsIssueRaised(st: ProfileState, profileId: string, appId: string, data: Record<string, unknown>): void {
    const pid = text(data.id, 200);
    if (!pid) return;
    const rule = text(data.rule, 64) ?? pid.split('|')[0] ?? null;
    const path = text(data.path, 200);
    const source = text(data.source, TITLE_MAX) ?? path ?? pid.split('|').slice(1).join('|');
    // The plugin's own start time, unless it is from the future or implausibly old (a wrong clock).
    const now = this.deps.now();
    const firstSeen = typeof data.firstSeen === 'number' && Number.isFinite(data.firstSeen) && data.firstSeen <= now + FIRST_SEEN_AHEAD_MS && data.firstSeen >= now - FIRST_SEEN_MAX_AGE_MS ? data.firstSeen : undefined;
    const onProgram = typeof data.onProgram === 'boolean' ? data.onProgram : null;
    const draft: IssueDraft = {
      id: `obs.issue|${appId}|${pid}`,
      kind: 'obs.issue',
      rule,
      severity: severityOf(data.severity),
      title: text(data.title, TITLE_MAX) ?? (source ? `${rule}: ${source}` : (rule ?? 'OBS issue')),
      message: text(data.cause, MESSAGE_MAX),
      subject: { type: 'obs.source', appId, source, path },
      onProgram,
      scene: onProgram ? text(data.scene, TITLE_MAX) : null,
      src: { connection: appId, platform: 'obs' },
      ...(firstSeen !== undefined ? { firstSeen } : {}),
    };
    this.want(st, profileId, draft.id, 0, () => draft);
  }

  private obsOutput(st: ProfileState, profileId: string, appId: string, data: Record<string, unknown>): void {
    const output = text(data.output, TITLE_MAX);
    if (!output) return;
    const id = `obs.output.down|${appId}|${output}`;
    const feed = outputFeed(data);
    const state = data.state;
    const error = text(data.error, MESSAGE_MAX);
    if (state === 'reconnecting') {
      st.reconnecting.set(id, { appId, output, feed, error });
      this.want(st, profileId, id, this.holds.output, () => this.outputDraft(profileId, id));
    } else {
      st.reconnecting.delete(id);
      if (feed && state === 'stopped' && !error) {
        // OBS stopped this stream on purpose: its feed going offline is no alert.
        st.cleanStop.set(feed, this.deps.now());
        this.drop(st, profileId, `feed.offline|${feed}`, 'ended');
      }
      if (state === 'live' || state === 'stopped') this.drop(st, profileId, id, state === 'live' ? 'recovered' : 'ended');
    }
    this.refreshFeeds(st, profileId);
  }

  /** Clear an app's OBS issues (it left or went quiet); true if it had any open or pending. */
  private forgetApp(st: ProfileState, profileId: string, appId: string, resolution: IssueResolution): boolean {
    st.obsApps.delete(appId);
    for (const [id, r] of st.reconnecting) if (r.appId === appId) st.reconnecting.delete(id);
    const prefixes = [`obs.issue|${appId}|`, `obs.output.down|${appId}|`];
    const mine = (id: string) => prefixes.some((p) => id.startsWith(p));
    let had = false;
    for (const [id, p] of [...st.pending]) {
      if (!mine(id)) continue;
      clearTimeout(p.timer);
      st.pending.delete(id);
      had = true;
    }
    for (const id of [...st.open.keys()]) {
      if (!mine(id)) continue;
      this.drop(st, profileId, id, resolution);
      had = true;
    }
    this.refreshFeeds(st, profileId);
    return had;
  }

  // -------------------------------------------------------------------------
  // Core: want / drop
  // -------------------------------------------------------------------------

  private state(profileId: string): ProfileState {
    let st = this.profiles.get(profileId);
    if (!st) {
      st = {
        running: false,
        feeds: new Map(),
        lostFeeds: new Set(),
        destinations: new Map(),
        cleanStop: new Map(),
        reconnecting: new Map(),
        obsApps: new Map(),
        staleApps: new Set(),
        open: new Map(),
        pending: new Map(),
      };
      this.profiles.set(profileId, st);
    }
    return st;
  }

  private hasIssue(st: ProfileState, id: string): boolean {
    return st.open.has(id) || st.pending.has(id);
  }

  /** Feed issues' text depends on the other feed and on OBS's reports: re-evaluate the open/pending ones. */
  private refreshFeeds(st: ProfileState, profileId: string): void {
    for (const feed of FEEDS) {
      const id = `feed.offline|${feed}`;
      if (this.hasIssue(st, id)) this.want(st, profileId, id, this.holds.feed, () => this.feedDraft(profileId, feed));
    }
  }

  /**
   * The condition holds: raise `id` once it has held `holdMs` (compute() re-checks at that moment;
   * null = it went away). An open issue is updated at once when compute() says something else.
   */
  private want(st: ProfileState, profileId: string, id: string, holdMs: number, compute: () => IssueDraft | null): void {
    if (this.closed) return;
    const open = st.open.get(id);
    if (open) {
      const draft = compute();
      if (draft && !sameContent(open.issue, draft)) this.update(profileId, open, draft);
      return;
    }
    const pending = st.pending.get(id);
    if (pending) {
      pending.compute = compute; // keep the original hold
      return;
    }
    if (holdMs <= 0) {
      const draft = compute();
      if (draft) this.raise(st, profileId, draft);
      return;
    }
    const timer = setTimeout(() => {
      this.deps.run(() => {
        const p = st.pending.get(id);
        if (!p || p.timer !== timer) return;
        st.pending.delete(id);
        if (this.profiles.get(profileId) !== st) return; // profile deleted meanwhile
        const draft = p.compute();
        if (draft) this.raise(st, profileId, draft);
      });
    }, holdMs);
    timer.unref?.();
    st.pending.set(id, { timer, compute });
  }

  private raise(st: ProfileState, profileId: string, draft: IssueDraft): void {
    const now = this.deps.now();
    const { src, firstSeen, ...fields } = draft;
    const issue: ApiIssue = { ...fields, firstSeen: firstSeen ?? now, updatedAt: now };
    st.open.set(issue.id, { issue, src });
    this.deps.raised(profileId, src, { ...issue, update: false });
  }

  private update(profileId: string, open: OpenIssue, draft: IssueDraft): void {
    const { src, firstSeen: _f, ...fields } = draft;
    const issue: ApiIssue = { ...fields, firstSeen: open.issue.firstSeen, updatedAt: this.deps.now() };
    open.issue = issue;
    open.src = src;
    this.deps.raised(profileId, src, { ...issue, update: true });
  }

  private drop(st: ProfileState, profileId: string, id: string, resolution: IssueResolution): void {
    const pending = st.pending.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      st.pending.delete(id);
    }
    const open = st.open.get(id);
    if (!open) return;
    st.open.delete(id);
    const { issue } = open;
    this.deps.cleared(profileId, open.src, {
      id: issue.id,
      kind: issue.kind,
      rule: issue.rule,
      subject: issue.subject,
      title: issue.title,
      firstSeen: issue.firstSeen,
      durationMs: Math.max(0, this.deps.now() - issue.firstSeen),
      resolution,
    });
  }

  private dropWhere(st: ProfileState, profileId: string, match: (issue: Pick<ApiIssue, 'id' | 'subject'>) => boolean, resolution: IssueResolution): void {
    for (const [id, p] of [...st.pending]) {
      const subject = this.pendingSubject(id);
      if (subject && !match({ id, subject })) continue;
      clearTimeout(p.timer);
      st.pending.delete(id);
    }
    for (const o of [...st.open.values()]) if (match(o.issue)) this.drop(st, profileId, o.issue.id, resolution);
  }

  /** The subject type a pending id will have (from its kind prefix); null = unknown, match it. */
  private pendingSubject(id: string): ApiIssueSubject | null {
    const kind = id.split('|')[0];
    switch (kind) {
      case 'feed.offline':
        return { type: 'feed', feed: (id.split('|')[1] as Feed) ?? 'landscape' };
      case 'destination.down':
        return { type: 'destination', destinationId: id.slice('destination.down|'.length), platform: 'custom', name: '' };
      case 'stream.down':
        return { type: 'stream' };
      case 'obs.output.down':
        return { type: 'obs.output', appId: id.split('|')[1] ?? '', output: '', canvas: null };
      case 'obs.issue':
        return { type: 'obs.source', appId: id.split('|')[1] ?? '', source: '', path: null };
      default:
        return null;
    }
  }
}
