// Issue history (docs/API.md §17.7, v1.18): records the event hub's issue.raised / issue.cleared in
// app.db (db/issue-history-repo.ts, its own table track) so the web UI can show the last 7 days and
// the Stream Report can list what went wrong during a stream. One per AppServices, like reportsFor():
// main.ts binds the database (bindIssueHistoryDatabase) and starts it right after the event hub.
//
// Never in the go-live path: a failed write is logged and dropped. Bounded: pruned at start-up and
// every hour (7 days after clearing, 5,000 rows at most).

import type { Logger } from 'pino';
import type { IssueHistoryEntry } from '../../../shared/issues.js';
import type { Db } from '../db/database.js';
import { createIssueHistoryRepo, ISSUE_HISTORY_LIST_MAX, ISSUE_HISTORY_RETENTION, type IssueHistoryQuery, type IssueHistoryRepo, type IssueHistoryRetention } from '../db/issue-history-repo.js';
import type { AppServices } from '../services.js';
import { eventHubFor, type EnvelopeListener } from './event-hub.js';
import type { ApiIssueCleared, ApiIssueRaised } from './types.js';

export const ISSUE_HISTORY_PRUNE_MS = 3600_000;

/** `?limit=`: 1..1000, default 200; null = not a number in range. */
export function historyLimit(raw: unknown): number | null {
  if (raw === undefined || raw === '') return 200;
  if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= ISSUE_HISTORY_LIST_MAX ? n : null;
}

export interface IssueHistoryDeps {
  repo: IssueHistoryRepo;
  /** The API event hub (or anything that hands out its envelopes). */
  events: { subscribe(listener: EnvelopeListener): () => void };
  log: Pick<Logger, 'warn' | 'info'>;
  now?: () => number;
  retention?: IssueHistoryRetention;
  /** false: no prune timer (tests). */
  timers?: boolean;
}

export class IssueHistory {
  private readonly now: () => number;
  private readonly retention: IssueHistoryRetention;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: IssueHistoryDeps) {
    this.now = deps.now ?? Date.now;
    this.retention = deps.retention ?? ISSUE_HISTORY_RETENTION;
  }

  /** Close what the last run left open (restarted), prune, then record every issue event. */
  start(): void {
    if (this.unsubscribe) return;
    this.guard('closing the issues of the last run', () => {
      const n = this.deps.repo.closeOpen(this.now());
      if (n > 0) this.deps.log.info({ issues: n }, 'issue history: issues open at the last shutdown closed as "restarted"');
    });
    this.prune();
    this.unsubscribe = this.deps.events.subscribe((env) => {
      const profile = env.src.profile;
      if (!profile) return;
      if (env.type === 'issue.raised') this.guard('recording an issue', () => this.deps.repo.raised(profile, env.data as ApiIssueRaised));
      else if (env.type === 'issue.cleared') this.guard('recording a cleared issue', () => this.deps.repo.cleared(profile, env.data as ApiIssueCleared, env.ts));
    });
    if (this.deps.timers !== false) {
      this.timer = setInterval(() => this.prune(), ISSUE_HISTORY_PRUNE_MS);
      this.timer.unref?.();
    }
  }

  prune(): number {
    return this.guard('pruning', () => this.deps.repo.prune(this.now(), this.retention)) ?? 0;
  }

  /** Newest first. */
  list(q: IssueHistoryQuery = {}): IssueHistoryEntry[] {
    return this.deps.repo.list({ since: this.now() - this.retention.maxAgeMs, ...q });
  }

  /** A profile's issues open at any time in [from, to] (a stream's time range), oldest first. */
  between(profileId: string, from: number, to: number): IssueHistoryEntry[] {
    return this.deps.repo.list({ profileId, since: from, until: to, limit: 1000 }).reverse();
  }

  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private guard<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.deps.log.warn({ error: err instanceof Error ? err.message : String(err) }, `issue history: ${what} failed`);
      return undefined;
    }
  }
}

const databases = new WeakMap<AppServices, Db>();
const instances = new WeakMap<AppServices, IssueHistory | null>();

export function bindIssueHistoryDatabase(services: AppServices, db: Db): void {
  databases.set(services, db);
}

/** Tests: use this history for these services. */
export function setIssueHistoryFor(services: AppServices, history: IssueHistory | null): void {
  instances.set(services, history);
}

/**
 * The issue history of these services (created on first use), or null when no database is bound or
 * its table can't be used (made by a newer Relay): then there is no history, and nothing else changes.
 */
export function issueHistoryFor(services: AppServices): IssueHistory | null {
  if (instances.has(services)) return instances.get(services) ?? null;
  const db = databases.get(services);
  if (!db) return null;
  let history: IssueHistory | null = null;
  const log = services.log.child({ mod: 'issue-history' });
  try {
    history = new IssueHistory({ repo: createIssueHistoryRepo(db), events: eventHubFor(services), log });
  } catch (err) {
    log.error({ error: err instanceof Error ? err.message : String(err) }, 'issue history: the table cannot be used; no issue history');
  }
  instances.set(services, history);
  return history;
}
