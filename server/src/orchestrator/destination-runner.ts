// One runner per destination per session: waits for its feed(s), prepares the live with the
// platform driver, starts the FFmpeg push, confirms ("Go Live"), attaches chat, watches the live's
// health, recovers from platform takedowns and ends the live.
//
// All state changes run on a per-runner serial queue, so feed events, push events, health events
// and timers never interleave. Long driver calls (prepare, confirm) run outside the queue and post
// their result back into it; stop() aborts them, so it never waits for a slow platform.
//
// Takedown recovery ("Stream Guard"), for lives whose driver sets PreparedLive.recovery (platforms
// that issue a new key per live, e.g. Instagram): the platform killed the live when
//   - the driver's health watcher yields `ended`, or
//   - after going live, the push to the platform stays down (supervisor `retrying`) for
//     `pushDownConfirmMs` while every required OBS feed is still online (feeds offline is the
//     ordinary OBS-disconnect grace logic instead).
// The runner then ends the killed live and builds a fresh one with the same prepare → push →
// confirm machinery, in phase 'recovering' throughout. Every attempt is bounded until it goes live:
//   - the new live never receives the video (confirm times out, or the push doesn't reach 'running'
//     within recoveryAttemptMs): the push is restarted once, then the attempt counts as failed;
//   - the platform showed the new live (confirm done) but the push to it stays down for
//     pushDownConfirmMs: the attempt counts as failed (like the push-down rule);
//   - OBS going offline mid-attempt is the ordinary feed grace logic, never a failure.
// Failed attempts back off (recoveryBackoffMs). After `maxAttempts` back-to-back failed attempts the
// destination goes to 'error' until Retry (a fresh runner). Any live that goes live resets the
// count, so a recovery that worked never counts as a failure, however soon the platform ends it.
// Separately, a create/kill loop guard: once the platform has ended recoveryLoopMax lives within
// recoveryLoopWindowMs (each new live notifies followers), the runner stops recovering → 'error'.
//
// The health watcher runs for every live whose driver has one (with or without a recovery policy):
// it also reports viewer counts (DestinationState.viewers).
//
// Session test mode: a destination whose platform has no private/test setting is skipped (phase
// 'disabled', never prepared); the others are prepared with ctx.testMode = true. A channel title
// (Twitch) is public even during a private test, so those destinations are prepared with an empty
// title and get no live title changes (see test-mode.ts).

import type { Logger } from 'pino';
import type {
  Account,
  Destination,
  DestinationPhase,
  DestinationState,
  Feed,
  TitleResult,
} from '../../../shared/types.js';
import type { PushEvent, PushStatus } from '../events.js';
import {
  DriverError,
  type LiveHealthEvent,
  type LiveRecoveryPolicy,
  type PlatformDriver,
  type PreparedLive,
  type PushPlan,
} from '../platforms/types.js';
import type { AppServices } from '../services.js';
import { awaitBounded, errorMessage, redactText, SerialQueue, sleep, TimeoutError } from './async-utils.js';
import { waitingForFeedMessage } from './feeds.js';
import { hasChannelTitle, supportsTestMode, TEST_MODE_CHANNEL_TITLE, testModeSkipMessage } from './test-mode.js';

export interface OrchestratorTimings {
  prepareTimeoutMs: number;
  confirmTimeoutMs: number;
  endTimeoutMs: number;
  /**
   * end() budget once the server is shutting down. Push stop (<= ~7 s) + this + the browser
   * session save must fit in main.ts's force-exit deadline (itself under Docker's 30 s stop grace).
   */
  shutdownEndTimeoutMs: number;
  titleTimeoutMs: number;
  /** Delays between prepare attempts for retryable errors; when exhausted → error. */
  prepareBackoffMs: readonly number[];
  /** Waits after a failed takedown-recovery attempt before the next one (the last value repeats). */
  recoveryBackoffMs: readonly number[];
  /**
   * While recovering: how long the push to the new live may take to reach 'running'. On expiry the
   * push is restarted once; if it still doesn't run by the next expiry the attempt counts as failed.
   */
  recoveryAttemptMs: number;
  /**
   * Create/kill loop guard: the platform ending this many lives within recoveryLoopWindowMs stops
   * auto-recovery (→ 'error'). Takedowns a few minutes apart (a flagged DJ set) stay well under it;
   * a new live killed within a minute or two, over and over, trips it.
   */
  recoveryLoopMax: number;
  recoveryLoopWindowMs: number;
}

export const DEFAULT_TIMINGS: OrchestratorTimings = {
  prepareTimeoutMs: 120_000,
  confirmTimeoutMs: 180_000,
  endTimeoutMs: 30_000,
  shutdownEndTimeoutMs: 15_000,
  titleTimeoutMs: 30_000,
  prepareBackoffMs: [5_000, 15_000, 30_000, 60_000, 60_000],
  recoveryBackoffMs: [5_000, 15_000],
  recoveryAttemptMs: 90_000,
  recoveryLoopMax: 10,
  recoveryLoopWindowMs: 20 * 60_000,
};

/** Driver error codes the user has to fix: no automatic retry. */
const FATAL_CODES = new Set<string>(['needs-login', 'not-connected', 'misconfigured', 'not-eligible']);

/** Restart delays for a health watcher that throws or ends early (doubles up to the max). */
const HEALTH_RESTART_MIN_MS = 1_000;
const HEALTH_RESTART_MAX_MS = 30_000;
/** A watcher that ran at least this long before failing restarts at the minimum delay again. */
const HEALTH_HEALTHY_MS = 60_000;

const DEFAULT_PUSH_DOWN_MS = 5_000;
const MIN_PUSH_DOWN_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export type StatePatch = Partial<Omit<DestinationState, 'destinationId' | 'since'>>;

/** What a runner needs from the orchestrator. */
export interface RunnerHost {
  services: AppServices;
  log: Logger;
  timings: OrchestratorTimings;
  /** Profile of the orchestrator (stamped on the destination's chat). */
  profileId: string;
  title(): string;
  /** Session test mode (constant while a session runs). */
  testMode(): boolean;
  feedOnline(feed: Feed): boolean;
  graceMs(): number;
  /** Current end() budget (shorter while the server shuts down). */
  endTimeoutMs(): number;
  /** Current published state of a destination (e.g. to count recoveries across runner restarts). */
  state(id: string): DestinationState | null;
  update(id: string, patch: StatePatch): void;
  notice(level: 'info' | 'warn' | 'error', message: string): void;
}

/** A takedown recovery in progress: from the takedown until the new live is up (or we give up). */
interface Recovery {
  reason: string;
  policy: LiveRecoveryPolicy;
  /** The live the platform killed (setTitle must not touch it). */
  killed: PreparedLive;
  /** The push was already restarted once in this attempt because the video never arrived. */
  kicked: boolean;
}

function isFatal(err: unknown): boolean {
  if (err instanceof DriverError) return FATAL_CODES.has(err.code);
  // Tolerate a DriverError from a duplicated module instance.
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && e.name === 'DriverError' && typeof e.code === 'string' && FATAL_CODES.has(e.code);
}

/** Confirm gave up waiting (e.g. the platform never received the video). */
function isTimeoutish(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  const e = err as { name?: unknown; code?: unknown } | null;
  return !!e && (e.name === 'TimeoutError' || (e.name === 'DriverError' && e.code === 'timeout'));
}

/** Sanitized recovery policy, or null when the live has none. */
function recoveryPolicy(policy: LiveRecoveryPolicy | undefined): LiveRecoveryPolicy | null {
  if (!policy) return null;
  const down = Number(policy.pushDownConfirmMs);
  const max = Number(policy.maxAttempts);
  return {
    pushDownConfirmMs: Number.isFinite(down) ? Math.max(MIN_PUSH_DOWN_MS, down) : DEFAULT_PUSH_DOWN_MS,
    maxAttempts: Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_MAX_ATTEMPTS,
  };
}

/** Driver-supplied text for the UI: secret-free, one line, bounded. */
function cleanText(value: unknown, max = 200): string {
  const s = typeof value === 'string' ? redactText(value).replace(/\s+/g, ' ').trim() : '';
  const chars = Array.from(s);
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('')}…`;
}

/** A driver-reported viewer count: a non-negative integer, or null when unknown. */
export function viewerCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function secs(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

function mins(ms: number): string {
  return `${Math.round(ms / 60_000)} min`;
}

export class DestinationRunner {
  readonly id: string;
  private readonly ctl = new AbortController();
  private readonly queue: SerialQueue;
  private driver: PlatformDriver | null = null;
  private required: Feed[] = [];
  private phase: DestinationPhase | null = null;

  private prepared: PreparedLive | null = null;
  private preparing = false;
  private prepareTask: Promise<void> = Promise.resolve();
  private attempts = 0;

  private pushActive = false;
  private pushStatus: PushStatus | null = null;
  private lastPushError: string | null = null;

  private confirmState: 'none' | 'running' | 'done' = 'none';
  private confirmCtl: AbortController | null = null;
  private confirmTask: Promise<void> = Promise.resolve();

  /** The current live reached 'live' (after confirm). Reset when it ends. */
  private wentLive = false;
  private chatCtl: AbortController | null = null;
  private healthCtl: AbortController | null = null;
  private healthWarning: string | null = null;
  /** A running push's own warning (e.g. Twitch Dual Format encoding slower than real time). */
  private pushWarning: string | null = null;

  private recovery: Recovery | null = null;
  /** Back-to-back failed recovery attempts; reset whenever a live goes live. */
  private recoveryFailures = 0;
  /** When the platform ended lives that we then recovered (loop guard), within recoveryLoopWindowMs. */
  private takedownTimes: number[] = [];

  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private pushDownTimer: ReturnType<typeof setTimeout> | null = null;
  /** While recovering: the current attempt's deadline (see onAttemptDeadline). */
  private attemptTimer: ReturnType<typeof setTimeout> | null = null;
  private failed = false;
  /** Skipped by session test mode: the platform has no private/test setting. Nothing ever runs. */
  private skipped = false;
  private halted = false;
  private finished = false;
  private stopping: Promise<void> | null = null;

  /**
   * @param fingerprint config fingerprint, compared by the orchestrator to detect edits.
   * @param after a previous runner's cleanup for the same destination; nothing runs before it settles
   *              (the push supervisor is keyed by destination id).
   */
  constructor(
    private readonly host: RunnerHost,
    readonly dest: Destination,
    readonly fingerprint: Promise<string>,
    after: Promise<void> = Promise.resolve(),
  ) {
    this.id = dest.id;
    this.queue = new SerialQueue(after);
  }

  // ---------------------------------------------------------------------------
  // Inputs
  // ---------------------------------------------------------------------------

  start(): void {
    void this.enqueue(() => {
      if (this.halted) return;
      try {
        this.driver = this.host.services.platforms.get(this.dest.platform);
        this.required = this.driver.requiredFeeds?.(this.dest) ?? [this.dest.feed];
      } catch (err) {
        this.fail(errorMessage(err));
        return;
      }
      const skip = this.host.testMode() ? this.testModeSkip(this.driver) : null;
      if (skip) {
        this.skipped = true;
        this.host.log.info({ destinationId: this.id, platform: this.dest.platform }, 'skipped: test mode is on and the platform has none');
        this.set({ phase: 'disabled', message: skip, stats: null, watchUrl: null, retries: 0, viewers: null });
        return;
      }
      this.set({ message: null, stats: null, watchUrl: null, retries: 0, viewers: null });
      return this.evaluate();
    });
  }

  /** Test mode leaves this platform's (public) channel title alone. */
  private keepsChannelTitle(driver: PlatformDriver | null | undefined): boolean {
    return this.host.testMode() && !!driver && hasChannelTitle(driver);
  }

  /** The title a prepare uses: the session title, or '' (leave it as it is) for a channel title in test mode. */
  private prepareTitle(driver: PlatformDriver): string {
    return this.keepsChannelTitle(driver) ? '' : this.host.title();
  }

  /** Skip message when test mode is on and this destination can't stream privately, else null. */
  private testModeSkip(driver: PlatformDriver): string | null {
    let supported: boolean;
    try {
      const account = this.dest.accountId ? this.host.services.repos.accounts.get(this.dest.accountId) : null;
      supported = supportsTestMode(driver, this.dest, account);
    } catch (err) {
      // Can't tell: skip it (test mode must never stream publicly).
      this.host.log.warn({ destinationId: this.id, error: errorMessage(err) }, 'checking test mode support failed; skipping');
      supported = false;
    }
    return supported ? null : testModeSkipMessage(driver.info.name);
  }

  feedsChanged(): void {
    void this.enqueue(() => this.evaluate());
  }

  pushEvent(ev: PushEvent): void {
    void this.enqueue(() => this.onPush(ev));
  }

  /** Abort everything, stop the push and end the live. Idempotent; never rejects. */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.halted = true;
    this.clearTimers();
    this.ctl.abort();
    this.confirmCtl?.abort();
    this.healthCtl?.abort();
    this.stopping = (async () => {
      await this.enqueue(() => this.cleanup());
      // Aborted prepare/confirm settle right away; wait for their (no-op or orphan-ending) handlers.
      await Promise.all([this.prepareTask, this.confirmTask]);
      this.finished = true;
    })();
    return this.stopping;
  }

  /** Live title change. Not prepared yet (or recovering) → skipped (the next prepare uses the new title). */
  async setTitle(title: string): Promise<TitleResult> {
    if (this.skipped) {
      return { destinationId: this.id, ok: true, skipped: true, error: 'Skipped in test mode' };
    }
    if (this.keepsChannelTitle(this.driver)) {
      return { destinationId: this.id, ok: true, skipped: true, error: TEST_MODE_CHANNEL_TITLE };
    }
    const prepared = this.prepared;
    if (this.halted || !prepared || prepared === this.recovery?.killed) {
      return { destinationId: this.id, ok: true, skipped: true, error: 'Not live yet; the new title is used when it goes live' };
    }
    if (!prepared.setTitle) {
      return { destinationId: this.id, ok: true, skipped: true, error: "This platform can't change the title while live" };
    }
    try {
      await awaitBounded((signal) => prepared.setTitle!(title, signal), {
        ms: this.host.timings.titleTimeoutMs,
        signal: this.ctl.signal,
        what: 'Updating the title',
      });
      return { destinationId: this.id, ok: true };
    } catch (err) {
      return { destinationId: this.id, ok: false, error: errorMessage(err) };
    }
  }

  // ---------------------------------------------------------------------------
  // State machine (runs on the queue)
  // ---------------------------------------------------------------------------

  private async evaluate(): Promise<void> {
    if (this.halted || this.failed || this.skipped || !this.driver) return;
    if (this.requiredOnline()) {
      this.clearGrace();
      if (this.prepared) await this.resume(this.prepared);
      else if (!this.preparing && !this.retryTimer) this.launchPrepare(this.driver);
      return;
    }
    // A required feed is offline.
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.prepared) await this.pause();
    else if (!this.preparing) this.set({ phase: 'waiting-for-feed', message: this.waitingMessage(), waitingFor: this.missingFeeds(), stats: null });
  }

  /** Feed(s) online with a prepared live: (re)start the push, or go live when there is none. */
  private async resume(prepared: PreparedLive): Promise<void> {
    if (!prepared.push) {
      this.goLive(prepared);
      return;
    }
    if (!this.pushActive) await this.startPush(prepared.push);
  }

  /** Feed went offline: stop the push, keep the prepared live for the grace period. */
  private async pause(): Promise<void> {
    if (this.pushActive) await this.stopPush();
    const graceMs = this.host.graceMs();
    if (!this.graceTimer) {
      this.graceTimer = setTimeout(() => {
        this.graceTimer = null;
        void this.enqueue(() => this.expireGrace());
      }, graceMs);
    }
    this.set({
      phase: 'waiting-for-feed',
      message: `${this.waitingMessage()}: waiting up to ${secs(graceMs)} for it to return`,
      waitingFor: this.missingFeeds(),
      stats: null,
    });
  }

  /** The feed did not come back in time: end this live; a fresh prepare happens when it returns. */
  private async expireGrace(): Promise<void> {
    if (this.halted || this.failed || !this.prepared) return;
    if (this.requiredOnline()) return this.evaluate();
    this.host.log.info({ destinationId: this.id }, 'feed did not return in time; ending live');
    // Not the platform's doing: an interrupted recovery attempt just becomes a normal prepare later.
    this.recovery = null;
    this.set({ phase: 'ending', message: null });
    await this.endLive();
    if (this.halted) return;
    this.set({
      phase: 'waiting-for-feed',
      message: `${this.waitingMessage()}; a new live will be prepared when it returns`,
      waitingFor: this.missingFeeds(),
      watchUrl: null,
      stats: null,
    });
  }

  private launchPrepare(driver: PlatformDriver): void {
    this.preparing = true;
    const title = this.prepareTitle(driver);
    if (this.recovery) {
      this.recovery.kicked = false;
      this.setRecovering('Starting a new one…', { stats: null, watchUrl: null });
    } else {
      this.set({ phase: 'preparing', message: null, stats: null });
    }
    this.prepareTask = awaitBounded((signal) => this.prepareOnce(driver, title, signal), {
      ms: this.host.timings.prepareTimeoutMs,
      signal: this.ctl.signal,
      what: 'Preparing the live',
      onLate: (late) => void this.callEnd(late, 'late prepare result'),
    }).then(
      (prepared) => this.enqueue(() => this.onPrepared(prepared, title)),
      (err: unknown) => this.enqueue(() => this.onPrepareFailed(err)),
    );
  }

  private async prepareOnce(driver: PlatformDriver, title: string, signal: AbortSignal): Promise<PreparedLive> {
    const { services } = this.host;
    const dest = services.repos.destinations.get(this.id) ?? this.dest;
    const ctx = await services.driverContext({
      platform: dest.platform,
      accountId: dest.accountId,
      destinationId: dest.id,
      signal,
    });
    const account = dest.accountId ? services.repos.accounts.get(dest.accountId) : null;
    if (this.host.testMode()) {
      // Re-checked with the current destination/account (e.g. a Facebook account switched to
      // profile mode mid-session): test mode must never fall back to a public live.
      let supported: boolean;
      try {
        supported = supportsTestMode(driver, dest, account);
      } catch {
        supported = false;
      }
      if (!supported) throw new DriverError(`${testModeSkipMessage(driver.info.name)}: not streaming while test mode is on`, 'not-eligible');
      ctx.testMode = true;
    }
    if (driver.validateDestination) {
      const problems = await driver.validateDestination(dest, account, ctx);
      if (problems.length > 0) throw new DriverError(problems.join('; '), 'misconfigured');
    }
    signal.throwIfAborted();
    return driver.prepare(dest, account, title, ctx);
  }

  private async onPrepared(prepared: PreparedLive, usedTitle: string): Promise<void> {
    this.preparing = false;
    if (this.halted) {
      // stop() raced with a just-finished prepare: the live exists on the platform, end it.
      await this.callEnd(prepared, 'prepared after stop');
      return;
    }
    this.prepared = prepared;
    this.attempts = 0;
    this.confirmState = 'none';
    // While recovering, keep the recovery message until the next step replaces it. `retries` stays
    // until the live is reached (goLive): a retry isn't "back" before that (api/status.ts isDown).
    this.set({ watchUrl: prepared.watchUrl ?? null, ...(this.recovery ? {} : { message: null }) });

    // The title changed while preparing: apply the current one.
    const current = this.driver ? this.prepareTitle(this.driver) : this.host.title();
    if (current !== usedTitle && prepared.setTitle) {
      void this.setTitle(current).then((r) => {
        if (!r.ok) this.host.log.warn({ destinationId: this.id, error: r.error }, 'title update after prepare failed');
      });
    }

    if (this.requiredOnline()) await this.resume(prepared);
    else await this.pause();
  }

  private async onPrepareFailed(err: unknown): Promise<void> {
    this.preparing = false;
    if (this.halted) return;
    const message = errorMessage(err);
    if (this.recovery && !isFatal(err)) {
      await this.recoveryAttemptFailed(message);
      return;
    }
    const backoff = this.host.timings.prepareBackoffMs;
    if (isFatal(err) || this.attempts >= backoff.length) {
      this.host.log.warn({ destinationId: this.id, attempts: this.attempts + 1, error: message }, 'prepare failed');
      this.fail(message);
      return;
    }
    const delay = backoff[this.attempts] ?? 60_000;
    this.attempts += 1;
    this.host.log.warn({ destinationId: this.id, attempt: this.attempts, error: message }, 'prepare failed; retrying');
    this.set({ phase: 'retrying', message: `${message} (retrying in ${secs(delay)})`, retries: this.attempts, stats: null });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(() => this.evaluate());
    }, delay);
  }

  private async startPush(plan: PushPlan): Promise<void> {
    this.pushStatus = null;
    this.lastPushError = null;
    this.pushActive = true;
    if (this.recovery) {
      this.setRecovering('Sending the video to the new live…', { stats: null });
      this.armAttempt(this.host.timings.recoveryAttemptMs);
    } else {
      this.set({ phase: 'connecting', message: null, stats: null });
    }
    try {
      this.host.services.pushes.start(this.id, plan);
    } catch (err) {
      await this.failLive(`Couldn't start the relay: ${errorMessage(err)}`);
    }
  }

  private async onPush(ev: PushEvent): Promise<void> {
    const prepared = this.prepared;
    if (this.halted || this.failed || !this.pushActive || !prepared) return;
    switch (ev.status) {
      case 'running': {
        this.pushStatus = 'running';
        this.lastPushError = null;
        const pushWarning = cleanText(ev.message ?? '') || null;
        if (pushWarning !== this.pushWarning) {
          this.pushWarning = pushWarning;
          if (this.phase === 'live') this.set({ message: this.liveWarning() });
        }
        this.clearPushDown();
        // The video reaches the platform: from here confirm's own timeout (or goLive) owns the attempt.
        this.clearAttempt();
        if (this.confirmState === 'none' && prepared.confirm) this.launchConfirm(prepared);
        if (this.confirmState === 'running') {
          const stats = ev.stats ? { stats: ev.stats } : {};
          if (this.recovery) this.setRecovering('Going live…', stats);
          else this.set({ phase: 'confirming', message: null, ...stats });
        } else {
          this.goLive(prepared, ev.stats);
        }
        return;
      }
      case 'retrying':
        this.pushStatus = 'retrying';
        this.lastPushError = ev.message;
        if (this.recovery) {
          this.setRecovering(`Relay reconnecting${ev.message ? `: ${ev.message}` : ''}`, { retries: ev.attempt, stats: null });
        } else {
          this.set({ phase: 'retrying', message: ev.message ?? 'Relay reconnecting', retries: ev.attempt, stats: null });
        }
        this.armPushDown(prepared);
        return;
      case 'failed':
        this.pushStatus = 'failed';
        await this.failLive(ev.message ? `Relay failed: ${ev.message}` : 'Relay failed');
        return;
      default:
        // 'starting' / 'stopped' carry no new information for us.
        return;
    }
  }

  private launchConfirm(prepared: PreparedLive): void {
    const ctl = new AbortController();
    this.confirmState = 'running';
    this.confirmCtl = ctl;
    this.confirmTask = awaitBounded((signal) => prepared.confirm!(signal), {
      ms: this.host.timings.confirmTimeoutMs,
      signal: ctl.signal,
      what: 'Going live',
    }).then(
      () => this.enqueue(() => this.onConfirmed(ctl, prepared)),
      (err: unknown) => this.enqueue(() => this.onConfirmFailed(ctl, err)),
    );
  }

  private onConfirmed(ctl: AbortController, prepared: PreparedLive): void {
    if (this.confirmCtl !== ctl) return; // superseded (live ended or runner stopped)
    this.confirmCtl = null;
    this.confirmState = 'done';
    if (this.halted) return;
    if (this.pushActive && this.pushStatus === 'running') {
      this.goLive(prepared);
    } else if (this.recovery && this.pushActive) {
      // Recovering, and the platform shows the new live but the push to it is down: bounded like the
      // push-down rule (a 'running' event still goes live; otherwise the attempt fails).
      this.armAttempt(this.recovery.policy.pushDownConfirmMs);
    }
  }

  private async onConfirmFailed(ctl: AbortController, err: unknown): Promise<void> {
    if (this.confirmCtl !== ctl) return;
    this.confirmCtl = null;
    this.confirmState = 'none';
    if (this.halted) return;
    const message = `Couldn't go live: ${errorMessage(err)}`;
    const recovery = this.recovery;
    const plan = this.prepared?.push;
    if (recovery && plan && this.pushActive && !recovery.kicked && isTimeoutish(err)) {
      // Stream Guard: the new live never got the video. Restart the push once and confirm again.
      recovery.kicked = true;
      await this.kickPush(plan, message);
      return;
    }
    if (recovery) await this.recoveryAttemptFailed(message);
    else await this.failLive(message);
  }

  /** Stop and restart the push; the next 'running' launches confirm again. */
  private async kickPush(plan: PushPlan, why: string): Promise<void> {
    this.host.log.info({ destinationId: this.id, why }, 'video did not reach the new live; restarting the relay');
    this.setRecovering(`${this.platformName()} didn't receive the video yet; restarting the relay…`, { stats: null });
    await this.stopPush();
    if (this.halted || this.failed) return;
    if (this.requiredOnline()) await this.startPush(plan);
    else await this.pause();
  }

  /** The card's message while live: the platform's warning, else the push's. */
  private liveWarning(): string | null {
    return this.healthWarning ?? this.pushWarning;
  }

  private goLive(prepared: PreparedLive, stats?: DestinationState['stats']): void {
    const firstTime = !this.wentLive;
    this.wentLive = true;
    const recovered = this.recovery;
    this.recovery = null;
    this.clearAttempt();
    const patch: StatePatch = {
      phase: 'live',
      message: this.liveWarning(),
      watchUrl: prepared.watchUrl ?? null,
      retries: 0,
      ...(stats ? { stats } : {}),
    };
    const count = recovered ? (this.host.state(this.id)?.recoveries ?? 0) + 1 : 0;
    if (recovered) patch.recoveries = count;
    this.set(patch);

    if (recovered) {
      this.host.log.info({ destinationId: this.id, recoveries: count }, 'live again after a takedown');
      this.host.notice('info', `${this.dest.name}: ${this.platformName()} is live again (recovery #${count})`);
    }
    // Live again: failed recovery attempts are no longer back-to-back.
    if (firstTime) this.recoveryFailures = 0;

    if (prepared.chat && !this.chatCtl) {
      const chatCtl = new AbortController();
      this.chatCtl = chatCtl;
      try {
        this.host.services.chat.attach(this.id, this.dest.platform, (s) => prepared.chat!(s), chatCtl.signal, this.host.profileId);
      } catch (err) {
        this.host.log.warn({ destinationId: this.id, error: errorMessage(err) }, 'chat attach failed');
      }
    }
    if (prepared.health && !this.healthCtl) this.startHealth(prepared);
  }

  /** Stop the push, end the live, mark the destination as failed (no automatic retry). */
  private async failLive(message: string): Promise<void> {
    await this.endLive();
    if (this.halted) return;
    this.fail(message);
  }

  private fail(message: string): void {
    this.failed = true;
    this.recovery = null;
    this.clearTimers();
    this.set({ phase: 'error', message, stats: null });
    this.host.notice('error', `${this.dest.name}: ${message}`);
  }

  // ---------------------------------------------------------------------------
  // Live health + takedown recovery (runs on the queue, except the watcher loop)
  // ---------------------------------------------------------------------------

  private startHealth(prepared: PreparedLive): void {
    const ctl = new AbortController();
    this.healthCtl = ctl;
    void this.watchHealth(prepared, ctl);
  }

  /** Runs the driver's health watcher until `ctl` aborts, restarting it with backoff when it fails. */
  private async watchHealth(prepared: PreparedLive, ctl: AbortController): Promise<void> {
    const { signal } = ctl;
    let delay = HEALTH_RESTART_MIN_MS;
    while (!signal.aborted) {
      const startedAt = Date.now();
      try {
        for await (const ev of prepared.health!(signal)) {
          if (signal.aborted) return;
          void this.enqueue(() => this.onHealth(ctl, prepared, ev));
          if (ev?.type === 'ended') return; // the takedown handling takes over (or the event is stale)
        }
        if (signal.aborted) return;
        this.host.log.warn({ destinationId: this.id }, 'live health watcher ended early; restarting it');
      } catch (err) {
        if (signal.aborted) return;
        this.host.log.warn({ destinationId: this.id, error: errorMessage(err) }, 'live health watcher failed; restarting it');
      }
      if (Date.now() - startedAt >= HEALTH_HEALTHY_MS) delay = HEALTH_RESTART_MIN_MS;
      await sleep(delay, signal);
      delay = Math.min(delay * 2, HEALTH_RESTART_MAX_MS);
    }
  }

  private async onHealth(ctl: AbortController, prepared: PreparedLive, ev: LiveHealthEvent): Promise<void> {
    if (this.healthCtl !== ctl || this.prepared !== prepared || this.halted || this.failed) return;
    switch (ev?.type) {
      case 'warning':
        this.healthWarning = cleanText(ev.message) || null;
        if (this.phase === 'live') this.set({ message: this.liveWarning() });
        return;
      case 'ok':
        if (this.healthWarning === null) return;
        this.healthWarning = null;
        if (this.phase === 'live') this.set({ message: this.liveWarning() });
        return;
      case 'ended':
        await this.takedown(cleanText(ev.reason) || 'ended by the platform');
        return;
      case 'viewers':
        // Unchanged counts emit nothing (the orchestrator drops no-op updates).
        this.set({ viewers: viewerCount(ev.count) });
        return;
      default:
        return;
    }
  }

  /** Push-down rule: arm on a push failure after going live, while the OBS feed(s) are still up. */
  private armPushDown(prepared: PreparedLive): void {
    const policy = recoveryPolicy(prepared.recovery);
    if (!policy || !this.wentLive || this.recovery || this.pushDownTimer || !this.requiredOnline()) return;
    this.pushDownTimer = setTimeout(() => {
      this.pushDownTimer = null;
      void this.enqueue(() => this.onPushDown(prepared, policy));
    }, policy.pushDownConfirmMs);
  }

  private async onPushDown(prepared: PreparedLive, policy: LiveRecoveryPolicy): Promise<void> {
    if (this.halted || this.failed || this.recovery || this.prepared !== prepared || !this.wentLive) return;
    if (!this.pushActive || this.pushStatus === 'running' || !this.requiredOnline()) return;
    const detail = this.lastPushError ? `: ${cleanText(this.lastPushError, 120)}` : '';
    await this.takedown(`relay down for ${secs(policy.pushDownConfirmMs)} while OBS is live${detail}`);
  }

  /** The platform ended the live: recover with a fresh one (or fail, without a recovery policy). */
  private async takedown(reason: string): Promise<void> {
    const prepared = this.prepared;
    const driver = this.driver;
    if (this.halted || this.failed || this.recovery || !prepared || !driver) return;
    const name = driver.info.name;
    const policy = recoveryPolicy(prepared.recovery);
    if (!policy) {
      this.host.log.warn({ destinationId: this.id, reason }, 'the platform ended the live (no auto-recovery)');
      await this.failLive(`${name} ended the live (${reason})`);
      return;
    }

    if (!this.requiredOnline()) {
      // OBS isn't sending either: just drop the live, like when the feed grace period expires.
      this.host.log.info({ destinationId: this.id, reason }, 'the platform ended the live while the feed is offline');
      this.set({ phase: 'ending', message: null });
      await this.endLive();
      if (this.halted) return;
      this.set({
        phase: 'waiting-for-feed',
        message: `${name} ended the live (${reason}); a new live will be prepared when the feed returns`,
        watchUrl: null,
        stats: null,
      });
      return;
    }

    // Create/kill loop guard: a takedown is not a failed attempt (that recovery worked), but every new
    // live notifies followers, so lives ended over and over within minutes stop the recovery.
    const now = Date.now();
    const { recoveryLoopMax, recoveryLoopWindowMs } = this.host.timings;
    this.takedownTimes = this.takedownTimes.filter((t) => now - t < recoveryLoopWindowMs);
    this.takedownTimes.push(now);
    const takedowns = this.takedownTimes.length;
    const lastRecovery = { at: new Date(now).toISOString(), reason };
    if (takedowns >= recoveryLoopMax) {
      this.host.log.warn({ destinationId: this.id, reason, takedowns }, 'the platform keeps ending new lives; stopping auto-recovery');
      this.set({ lastRecovery });
      await this.failLive(
        `${name} ended the live ${takedowns} times within ${mins(recoveryLoopWindowMs)} (latest: ${reason}) — ` +
          'stopped starting new ones. Check it and press Retry.',
      );
      return;
    }

    this.recovery = { reason, policy, killed: prepared, kicked: false };
    const message = `${name} ended the live (${reason}). Starting a new one…`;
    this.set({ phase: 'recovering', message, stats: null, watchUrl: null, lastRecovery });
    this.host.notice('warn', `${this.dest.name}: ${message}`);
    this.host.log.warn({ destinationId: this.id, reason, takedowns }, 'the platform ended the live; recovering');

    // Chat, health, confirm and push stop; the old end() is best-effort (the platform already ended it).
    await this.endLive();
    if (this.halted) return;
    await this.evaluate(); // → launchPrepare (feed online), in phase 'recovering'
  }

  /** Arms the current recovery attempt's deadline (replacing any earlier one). */
  private armAttempt(ms: number): void {
    this.clearAttempt();
    const prepared = this.prepared;
    const recovery = this.recovery;
    if (!prepared || !recovery) return;
    this.attemptTimer = setTimeout(() => {
      this.attemptTimer = null;
      void this.enqueue(() => this.onAttemptDeadline(prepared, recovery));
    }, ms);
  }

  /**
   * A recovery attempt that has not gone live in time. Before confirm, the push never reached
   * 'running': restart it once, then the attempt fails. After confirm (the platform shows the new
   * live) the push to it stayed down: the attempt fails. While confirm runs, its own timeout decides.
   */
  private async onAttemptDeadline(prepared: PreparedLive, recovery: Recovery): Promise<void> {
    if (this.halted || this.failed || this.recovery !== recovery || this.prepared !== prepared) return;
    // Paused for the feed (grace logic), video flowing, or confirm in charge: not this timer's call.
    if (!this.pushActive || this.pushStatus === 'running' || this.confirmState === 'running' || !this.requiredOnline()) return;
    const detail = this.lastPushError ? `: ${cleanText(this.lastPushError, 120)}` : '';
    if (this.confirmState === 'done') {
      await this.recoveryAttemptFailed(`the relay to the new live stayed down${detail}`);
      return;
    }
    const why = `${this.platformName()} never received the video${detail}`;
    if (!recovery.kicked && prepared.push) {
      recovery.kicked = true;
      await this.kickPush(prepared.push, why);
      return;
    }
    await this.recoveryAttemptFailed(why);
  }

  /** A recovery attempt failed: tear down what it built, then back off or give up. */
  private async recoveryAttemptFailed(message: string): Promise<void> {
    const recovery = this.recovery;
    if (!recovery) return;
    await this.endLive();
    if (this.halted || this.failed) return;
    this.recoveryFailures += 1;
    this.host.log.warn(
      { destinationId: this.id, failures: this.recoveryFailures, error: message },
      'takedown recovery attempt failed',
    );
    if (this.recoveryFailures >= recovery.policy.maxAttempts) {
      this.giveUp();
      return;
    }
    const backoff = this.host.timings.recoveryBackoffMs;
    const delay = backoff[Math.min(this.recoveryFailures - 1, backoff.length - 1)] ?? 5_000;
    this.setRecovering(`The new live failed (${message}); trying again in ${secs(delay)}`, { stats: null, watchUrl: null });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.enqueue(() => this.evaluate());
    }, delay);
  }

  private giveUp(): void {
    const attempts = this.recoveryFailures;
    this.host.log.warn({ destinationId: this.id, attempts }, 'giving up on takedown recovery');
    this.fail(`Couldn't get ${this.platformName()} live again — gave up after ${attempts} failed attempts. Check it and press Retry.`);
  }

  /** Phase 'recovering' with "<Platform> ended the live (<reason>). <step>". */
  private setRecovering(step: string, extra: StatePatch = {}): void {
    const recovery = this.recovery;
    if (!recovery) return;
    this.set({ ...extra, phase: 'recovering', message: `${this.platformName()} ended the live (${recovery.reason}). ${step}` });
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  private async cleanup(): Promise<void> {
    this.clearTimers();
    this.recovery = null;
    if (this.pushActive || this.prepared) this.set({ phase: 'ending', message: null });
    await this.endLive();
  }

  /** Detach chat and health, abort confirm, stop the push and call prepared.end(). Idempotent. */
  private async endLive(): Promise<void> {
    this.clearGrace();
    this.clearPushDown();
    this.clearAttempt();
    this.wentLive = false;
    this.chatCtl?.abort();
    this.chatCtl = null;
    this.healthCtl?.abort();
    this.healthCtl = null;
    this.healthWarning = null;
    this.pushWarning = null;
    this.set({ viewers: null }); // nobody watches a live that is gone (no-op when already unknown)
    this.confirmCtl?.abort();
    this.confirmCtl = null;
    this.confirmState = 'none';
    if (this.pushActive) await this.stopPush();
    const prepared = this.prepared;
    this.prepared = null;
    if (prepared) await this.callEnd(prepared, 'end');
  }

  private async stopPush(): Promise<void> {
    this.pushActive = false;
    this.pushStatus = null;
    this.clearPushDown();
    // A restarted push (kick, feed back after a pause) re-arms the attempt deadline in startPush.
    this.clearAttempt();
    try {
      await this.host.services.pushes.stop(this.id);
    } catch (err) {
      this.host.log.warn({ destinationId: this.id, error: errorMessage(err) }, 'stopping the relay failed');
    }
  }

  /** Call prepared.end() with a timeout; errors are logged, never thrown. */
  private async callEnd(prepared: PreparedLive, why: string): Promise<void> {
    if (!prepared.end) return;
    try {
      await awaitBounded((signal) => prepared.end!(signal), { ms: this.host.endTimeoutMs(), what: 'Ending the live' });
    } catch (err) {
      this.host.log.warn({ destinationId: this.id, why, error: errorMessage(err) }, 'ending the live failed');
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private enqueue(task: () => void | Promise<void>): Promise<void> {
    return this.queue.run(task).catch((err: unknown) => {
      this.host.log.error({ destinationId: this.id, error: errorMessage(err) }, 'destination runner step failed');
    });
  }

  private platformName(): string {
    return this.driver?.info.name ?? this.dest.platform;
  }

  private requiredOnline(): boolean {
    return this.required.every((f) => this.host.feedOnline(f));
  }

  /** Required feeds that are offline (all required ones when none is, e.g. a feed just came back). */
  private missingFeeds(): Feed[] {
    const missing = this.required.filter((f) => !this.host.feedOnline(f));
    return missing.length > 0 ? missing : [...this.required];
  }

  private waitingMessage(): string {
    return waitingForFeedMessage(this.missingFeeds());
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private clearPushDown(): void {
    if (this.pushDownTimer) clearTimeout(this.pushDownTimer);
    this.pushDownTimer = null;
  }

  private clearAttempt(): void {
    if (this.attemptTimer) clearTimeout(this.attemptTimer);
    this.attemptTimer = null;
  }

  private clearTimers(): void {
    this.clearGrace();
    this.clearPushDown();
    this.clearAttempt();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private set(patch: StatePatch): void {
    if (this.finished) return;
    if (patch.phase) this.phase = patch.phase;
    // waitingFor only means something in the waiting phase: clear it whenever the phase moves on.
    if (patch.phase && patch.phase !== 'waiting-for-feed' && patch.waitingFor === undefined) patch = { ...patch, waitingFor: [] };
    this.host.update(this.id, patch);
  }
}
