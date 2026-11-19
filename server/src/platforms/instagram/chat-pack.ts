// The Instagram chat reader's "selector pack": every selector, attribute name, label pattern and
// timing the comments reader uses, as plain JSON, so it can be changed on a running server when
// Instagram changes its page (docs/PLATFORMS.md → Instagram → "Tuning the chat reader live").
//
// A pack is data only. The reader's scripts (chat-scan.ts) are fixed; a pack can give them CSS
// selectors (used with querySelectorAll / matches / closest, or Playwright's css= engine),
// attribute names (getAttribute) and regular-expression sources (compiled with the `i` flag and
// only ever tested against short strings). Nothing in a pack is evaluated as code.
//
// The built-in pack is the default. An operator override (admin API, stored in the settings
// table) is a partial pack merged over the built-in one; the reader picks it up on its next poll.

import vm from 'node:vm';
import { z } from 'zod';
import type { SettingsRepo } from '../../services.js';

export const CHAT_PACK_SCHEMA = 1;
/** Settings key of the stored override: `{ override, updatedAt, updatedBy }`. */
export const CHAT_PACK_SETTING = 'instagram.chatPack';
/** Largest override accepted, as JSON. */
export const CHAT_PACK_MAX_BYTES = 16 * 1024;
export const SELECTOR_MAX = 200;
export const REGEX_MAX = 300;
export const LIST_MAX = 12;
export const REGEX_LIST_MAX = 24;
/** Longest string a pack regex is ever tested against in the page (chat-scan.ts cuts to this). */
export const REGEX_INPUT_MAX = 400;

export const TAB_ROLES = ['tab', 'button', 'link', 'menuitem'] as const;
export type TabRole = (typeof TAB_ROLES)[number];

export interface IgChatPack {
  schema: typeof CHAT_PACK_SCHEMA;
  /** Free label of this pack, shown in Settings → Advanced and in the debug capture. */
  version: string;
  note?: string;
  /** The "Comments" tab of the producer, clicked when the comments panel is not showing. */
  tab: {
    /** CSS selectors tried first. */
    css: string[];
    /** Else: an element with one of these roles whose accessible name matches `name`. */
    roles: TabRole[];
    name: string;
  };
  /** Where the comments are. The first strategy that finds a visible element wins. */
  container: {
    /** 1. An explicit selector. */
    css: string[];
    /** 2. A tabpanel, or any labelled element, whose label matches. */
    panelLabel: string;
    /** 3. The area around the comment box: one of these whose placeholder/label matches `composerHint`. */
    composerCss: string[];
    composerHint: string;
    /** 4. The area around a heading whose own text matches `panelLabel`. */
    headingCss: string[];
    /** Strategies 3 and 4 climb up to this many parents, stopping at one at least `climbMinHeight` px tall. */
    climbLevels: number;
    climbMinHeight: number;
    /**
     * Strategy 3 only: when the box the climb stopped at holds no comment rows, a parent further up
     * (still within `climbLevels`, in the same column) that holds at least two avatar rows is taken
     * instead. Keeps the comments readable when Instagram puts a tall box around the comment box.
     */
    climbPreferRows: boolean;
  };
  /** What one comment row is. */
  row: {
    /** Explicit row selectors (inside the container). When set, the avatar heuristic is not used. */
    css: string[];
    /** Else: the smallest ancestor of one avatar that also holds text besides the username. */
    avatarCss: string[];
    /** Avatar alt text; capture group 1 is the username. */
    avatarAlt: string;
    /** Rows without an avatar. */
    fallbackCss: string[];
    /** A row never contains one of these (the comment box). */
    excludeCss: string[];
    maxAvatars: number;
    /** Attributes (on the row or inside it) holding a stable comment id, best dedupe key when present. */
    idAttrs: string[];
  };
  /** How a row's text is read. */
  text: {
    /** Explicit comment-text selectors (inside the row). When set, only their text is the comment. */
    css: string[];
    /** Text inside these is never part of a comment. */
    skipCss: string[];
    /** Where the username is when the avatar alt does not give it. */
    authorCss: string[];
    /** Images read as text (their alt), e.g. emoji rendered as pictures. Never the avatar. */
    emojiCss: string[];
    /** Whole text nodes that are labels, not comment text ("Reply", "2m"). */
    meta: string[];
  };
  classify: {
    /** Text (after the username) of presence/system events shown in the chat as events. */
    event: string[];
    /**
     * The subset of events that are "<name> joined" lines (`join: true` in the API). Capture group 1,
     * when the pattern has one and it is a number ("and 3 others joined"), is how many others joined
     * with the named user (`othersCount` in the API).
     */
    join: string[];
    /** Rows without a user avatar whose text matches are Instagram's own notices: dropped. */
    system: string[];
    systemCss: string[];
    /** A label text node marking a pinned copy of a comment: dropped (the comment itself was read). */
    pinned: string[];
    pinnedCss: string[];
    verifiedCss: string[];
  };
  /** The producer's own comment box, used for the Practice test comment only. */
  composer: {
    css: string[];
    /** Accessible name of the button that posts the comment. */
    post: string;
  };
  timing: {
    /** How often the panel is read. */
    pollMs: number;
    /** How often the "Comments" tab is tried again while the panel is not showing. */
    tabRetryMs: number;
    /** Longest wait between reads while reads keep failing (page reloading). */
    backoffMaxMs: number;
    /**
     * The comments already on screen when the reader first gets to read them (it started during a
     * live, or a changed pack made the panel readable) are history: remembered, not delivered.
     * Off: they are delivered at once, as one burst (how 0.2.30 worked).
     */
    backlogAsHistory: boolean;
    /**
     * With `backlogAsHistory`: a live younger than this has no history yet, so what is on screen
     * are new comments and is delivered.
     */
    liveStartGraceMs: number;
  };
  limits: {
    /** Only the newest this-many rows are read. */
    maxRows: number;
    /** How many delivered comments are remembered to recognise re-rendered rows. */
    history: number;
  };
}

/** Regex matching any of `labels`, optionally repeated ("Comments Comments": an icon label + text). */
const namesSource = (...labels: string[]): string => {
  const alt = labels.join('|');
  return `^\\s*(?:${alt})(?:\\s*(?:${alt}))*\\s*$`;
};

export const BUILTIN_CHAT_PACK: IgChatPack = {
  schema: CHAT_PACK_SCHEMA,
  version: 'builtin-3',
  tab: { css: [], roles: ['tab', 'button'], name: namesSource('comments', 'comment') },
  container: {
    css: [],
    panelLabel: '^(live )?comments?$',
    composerCss: ['textarea', 'input[type="text"]', '[contenteditable="true"]'],
    composerHint: 'comment',
    headingCss: ['h1', 'h2', 'h3', 'h4', 'span', 'div'],
    // Live run, November 2026: the comment box sits in a 76 px footer more than four parents down
    // from the panel (a 600 px box holding the tabs, the comment rows and that footer).
    climbLevels: 10,
    climbMinHeight: 320,
    climbPreferRows: true,
  },
  row: {
    css: [],
    avatarCss: ['img[alt$="profile picture" i]'],
    avatarAlt: "^(.+?)['’]s profile picture$",
    fallbackCss: ['li', '[role="listitem"]', '[role="row"]'],
    excludeCss: ['input', 'textarea', '[contenteditable="true"]'],
    maxAvatars: 1,
    idAttrs: [],
  },
  text: {
    css: [],
    skipCss: ['button', 'time', 'svg'],
    authorCss: ['a[href^="/"]'],
    emojiCss: ['img[alt]'],
    meta: [
      '^(reply|replies|see translation|see original|pin|pin comment|unpin|report|like|liked|verified)$',
      '^(·|•)$',
      '^(now|just now)$',
      '^\\d+\\s?[smhdw]$',
      '^\\d+\\s?(sec|min|hr|hour|day|week)s?( ago)?$',
      '^(…|\\.\\.\\.)?\\s?(more|see more)$',
    ],
  },
  classify: {
    event: [
      '^(?:joined|joined the live video|joined the live|is watching|started watching|requested to join)\\.?$',
      '^and \\d[\\d,.]* (?:other|others|more) (?:joined|joined the live video|joined the live)\\.?$',
    ],
    // Capture group 1, when it is a number, is how many others joined with the named user
    // ("<name> and 3 others joined": `othersCount: 3` in the API).
    join: [
      '^(?:joined|joined the live video|joined the live|is watching|started watching)\\.?$',
      '^and (\\d[\\d,.]*) (?:other|others|more) (?:joined|joined the live video|joined the live)\\.?$',
    ],
    system: [
      "^we'?re telling (your )?followers",
      '^keep comments respectful',
      '^comments (are|have been|were) (turned off|limited|disabled)',
      '^(you|the host) (pinned|unpinned) a comment',
    ],
    systemCss: [],
    pinned: ['^pinned( comment)?$', '^pinned by .{1,60}$'],
    pinnedCss: [],
    verifiedCss: ['svg[aria-label="Verified" i]'],
  },
  composer: {
    css: ['[placeholder*="comment" i]', '[aria-label*="comment" i]'],
    post: namesSource('post', 'send'),
  },
  timing: { pollMs: 1_000, tabRetryMs: 15_000, backoffMaxMs: 10_000, backlogAsHistory: true, liveStartGraceMs: 60_000 },
  limits: { maxRows: 200, history: 500 },
};

// ---- validation ----

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Why `selector` is not accepted, or null. A syntax check only (the page validates the rest and
 * reports selectors it could not use): plain CSS, no Playwright engine prefixes or chains, no
 * rule/declaration syntax, balanced brackets and quotes.
 */
export function selectorProblem(selector: string): string | null {
  if (selector.trim() !== selector || selector.length === 0) return 'must not be empty or padded with spaces';
  if (selector.length > SELECTOR_MAX) return `longer than ${SELECTOR_MAX} characters`;
  if (CONTROL_RE.test(selector)) return 'control characters are not allowed';
  if (selector.includes('>>')) return 'selector chains (>>) are not allowed';
  if (/^[a-z][a-z0-9:_-]*=/i.test(selector)) return 'selector engine prefixes are not allowed; plain CSS only';
  if (/[{};@<]|\/\*|\\[\r\n]/.test(selector)) return 'only a CSS selector is allowed (no { } ; @ < or comments)';
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '=' && !stack.includes('[')) return 'only a CSS selector is allowed ("=" belongs inside [attribute] brackets)';
    else if (ch === '(' || ch === '[') stack.push(ch);
    else if (ch === ')' || ch === ']') {
      const open = stack.pop();
      if ((ch === ')' && open !== '(') || (ch === ']' && open !== '[')) return 'unbalanced brackets';
    }
  }
  if (quote || stack.length > 0) return 'unbalanced brackets or quotes';
  return null;
}

/**
 * `source` with its character escapes (\x62, \u0062, \cJ, \041) written out as the characters
 * they stand for, so a pattern cannot hide what it repeats from the probes.
 */
function writtenOut(source: string): string {
  return source.replace(/\\(?:x([0-9a-f]{2})|u([0-9a-f]{4})|c([a-z])|(0[0-7]{0,2}))/gi, (_m, x?: string, u?: string, c?: string, o?: string) => {
    if (x ?? u) return String.fromCharCode(parseInt((x ?? u)!, 16));
    if (c) return String.fromCharCode(c.toUpperCase().charCodeAt(0) ^ 64);
    return String.fromCharCode(parseInt(o!, 8));
  });
}

/** What follows a run in a probe: nothing, or one character of each kind a pattern may stop at. */
const PROBE_TAILS = ['', '\u0000', '!', ' ', 'a', '0', '\n'];
const PROBE_MAX = 600;

/**
 * Strings a pack regex must get through quickly: long runs of what it is made of (and of every
 * common kind of character), each ending in a mismatch of every kind, also after the pattern's
 * literal start ("^pinned by ..." only backtracks on input that starts with "pinned by ").
 */
function regexProbes(source: string): string[] {
  const n = REGEX_INPUT_MAX * 4;
  const plain = writtenOut(source);
  const units = new Set<string>(['a', ' ', '0', 'a ', 'a0', '_', '!', '.', '-', '\u00e9', '\u{1F600}']);
  for (const text of plain === source ? [source] : [plain, source]) {
    for (const word of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
      units.add(word);
      units.add(`${word} `);
    }
    for (const ch of new Set(text.replace(/[\\^$.*+?()[\]{}|]/g, ''))) units.add(ch);
  }
  const head = /^\^?([^\\^$.*+?()[\]{}|]+)/.exec(plain)?.[1] ?? '';
  const starts = head ? ['', head] : [''];
  const probes = new Set<string>();
  for (const unit of units) {
    if (!unit) continue;
    const run = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    for (const start of starts) {
      for (const tail of PROBE_TAILS) probes.add(start + run + tail);
    }
    if (probes.size >= PROBE_MAX) break;
  }
  return [...probes].slice(0, PROBE_MAX);
}

const PROBE_SCRIPT = new vm.Script('for (const p of probes) re.test(p);');
/** Time one regex may take over all its probes. */
const PROBE_BUDGET_MS = 150;
/**
 * Time all the regexes of one pack may take together. The probes run on the server's event loop,
 * so a pack full of slow patterns must not be able to stall it for long.
 */
const PACK_PROBE_BUDGET_MS = 1_500;
/** When the pack being validated runs out of probe time (set by parseChatPackOverride). */
let probeDeadline: number | null = null;
/** Multiplies both budgets for the pack being validated (set by parseChatPackOverride). */
let probePatience = 1;

/**
 * Why `source` is not accepted as a pack regex, or null: it must compile (flag `i`), must not use
 * backreferences, and must stay fast on adversarial input (a runaway pattern would freeze the
 * producer page's main thread, which no timeout on our side can interrupt).
 */
export function regexProblem(source: string): string | null {
  if (source.length === 0) return 'must not be empty';
  if (source.length > REGEX_MAX) return `longer than ${REGEX_MAX} characters`;
  if (CONTROL_RE.test(source)) return 'control characters are not allowed';
  let re: RegExp;
  try {
    re = new RegExp(source, 'i');
  } catch (err) {
    return `not a valid regular expression (${err instanceof Error ? err.message : String(err)})`.slice(0, 200);
  }
  if (/\\(?:[1-9]|k<)/.test(source.replace(/\\\\/g, ''))) return 'backreferences are not allowed';
  const budget = PROBE_BUDGET_MS * probePatience;
  const left = probeDeadline === null ? budget : Math.min(budget, probeDeadline - Date.now());
  if (left < 1) return 'not checked: the patterns before it used up the time allowed for checking a pack';
  try {
    PROBE_SCRIPT.runInNewContext({ re, probes: regexProbes(source) }, { timeout: Math.ceil(left) });
  } catch {
    return 'too slow on long input (catastrophic backtracking); simplify nested repetitions';
  }
  return null;
}

const selector = z.string().superRefine((s, ctx) => {
  const problem = selectorProblem(s);
  if (problem) ctx.addIssue({ code: 'custom', message: `CSS selector: ${problem}` });
});
const regex = z.string().superRefine((s, ctx) => {
  const problem = regexProblem(s);
  if (problem) ctx.addIssue({ code: 'custom', message: `regular expression: ${problem}` });
});
const attrName = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.:-]{0,63}$/, 'must be an attribute name');
const selectors = z.array(selector).max(LIST_MAX);
const regexes = z.array(regex).max(REGEX_LIST_MAX);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const label = (max: number) => z.string().min(1).max(max).refine((s) => !CONTROL_RE.test(s), 'control characters are not allowed');

/** An override: any subset of the pack's settings (lists replace the built-in lists whole). */
export const chatPackOverrideSchema = z
  .object({
    schema: z.literal(CHAT_PACK_SCHEMA),
    version: label(40).regex(/^[A-Za-z0-9][A-Za-z0-9._ -]*$/, 'letters, digits, dot, dash, underscore and spaces only'),
    note: label(300).optional(),
    tab: z.object({ css: selectors, roles: z.array(z.enum(TAB_ROLES)).min(1).max(TAB_ROLES.length), name: regex }).partial().strict().optional(),
    container: z
      .object({
        css: selectors,
        panelLabel: regex,
        composerCss: selectors,
        composerHint: regex,
        headingCss: selectors,
        climbLevels: int(0, 12),
        climbMinHeight: int(0, 2_000),
        climbPreferRows: z.boolean(),
      })
      .partial()
      .strict()
      .optional(),
    row: z
      .object({
        css: selectors,
        avatarCss: selectors,
        avatarAlt: regex,
        fallbackCss: selectors,
        excludeCss: selectors,
        maxAvatars: int(1, 4),
        idAttrs: z.array(attrName).max(LIST_MAX),
      })
      .partial()
      .strict()
      .optional(),
    text: z.object({ css: selectors, skipCss: selectors, authorCss: selectors, emojiCss: selectors, meta: regexes }).partial().strict().optional(),
    classify: z
      .object({ event: regexes, join: regexes, system: regexes, systemCss: selectors, pinned: regexes, pinnedCss: selectors, verifiedCss: selectors })
      .partial()
      .strict()
      .optional(),
    composer: z.object({ css: selectors, post: regex }).partial().strict().optional(),
    timing: z
      .object({
        pollMs: int(500, 10_000),
        tabRetryMs: int(3_000, 120_000),
        backoffMaxMs: int(1_000, 60_000),
        backlogAsHistory: z.boolean(),
        liveStartGraceMs: int(0, 600_000),
      })
      .partial()
      .strict()
      .optional(),
    limits: z.object({ maxRows: int(20, 500), history: int(50, 2_000) }).partial().strict().optional(),
  })
  .strict();

export type ChatPackOverride = z.infer<typeof chatPackOverrideSchema>;

export type ParsedOverride = { ok: true; override: ChatPackOverride } | { ok: false; problems: string[] };

/**
 * Validate an override as received (any JSON value). Never throws. `patience` multiplies the time
 * allowed for the speed check: a pack that was accepted on an idle server is checked again when the
 * server starts (attach), which is its busiest moment, and must not be dropped for being slow then.
 */
export function parseChatPackOverride(value: unknown, patience = 1): ParsedOverride {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return { ok: false, problems: ['body: not JSON'] };
  }
  if (bytes > CHAT_PACK_MAX_BYTES) return { ok: false, problems: [`body: larger than ${CHAT_PACK_MAX_BYTES} bytes`] };
  probePatience = Math.max(1, patience);
  probeDeadline = Date.now() + PACK_PROBE_BUDGET_MS * probePatience;
  let parsed: ReturnType<typeof chatPackOverrideSchema.safeParse>;
  try {
    parsed = chatPackOverrideSchema.safeParse(value);
  } finally {
    probeDeadline = null;
    probePatience = 1;
  }
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) };
  }
  // Without undefined-valued keys, so the stored JSON equals what was sent.
  return { ok: true, override: JSON.parse(JSON.stringify(parsed.data)) as ChatPackOverride };
}

const SECTIONS = ['tab', 'container', 'row', 'text', 'classify', 'composer', 'timing', 'limits'] as const;

/** The pack the reader runs with: the built-in one with the override's settings on top. */
export function mergeChatPack(override: ChatPackOverride | null, base: IgChatPack = BUILTIN_CHAT_PACK): IgChatPack {
  const pack = structuredClone(base);
  if (!override) return pack;
  pack.version = override.version;
  if (override.note !== undefined) pack.note = override.note;
  else delete pack.note;
  for (const section of SECTIONS) {
    const patch = override[section];
    if (!patch) continue;
    const target = pack[section] as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) target[key] = structuredClone(value);
    }
  }
  return pack;
}

/**
 * True when every setting of `override` equals the built-in one: it changes nothing but the
 * version label. What a live-tuning override becomes once a release ships its values (it keeps
 * working, and can be deleted).
 */
export function overrideIsRedundant(override: ChatPackOverride, base: IgChatPack = BUILTIN_CHAT_PACK): boolean {
  for (const section of SECTIONS) {
    const patch = override[section];
    if (!patch) continue;
    const target = base[section] as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && JSON.stringify(value) !== JSON.stringify(target[key])) return false;
    }
  }
  return true;
}

// ---- the active pack ----

export interface ChatPackState {
  source: 'builtin' | 'override';
  /** The effective pack. */
  pack: IgChatPack;
  /** The stored override as the operator sent it, or null. */
  override: ChatPackOverride | null;
  builtinVersion: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Goes up on every change; the reader compares it to notice a new pack. */
  revision: number;
}

/** The stored override passed the speed check when it was set: give it this many times longer at start-up. */
const STARTUP_PATIENCE = 4;

interface StoredPack {
  override?: unknown;
  updatedAt?: unknown;
  updatedBy?: unknown;
}

/**
 * Holds the active pack for this process. Drivers are stateless singletons without access to the
 * database, so the store is a module-level object: main.ts attaches the settings repo at start-up,
 * the admin routes change it, and the reader asks for `active()` on every poll.
 */
export class ChatPackStore {
  private settings: SettingsRepo | null = null;
  private current: ChatPackState = this.builtin(0);

  private builtin(revision: number): ChatPackState {
    return {
      source: 'builtin',
      pack: mergeChatPack(null),
      override: null,
      builtinVersion: BUILTIN_CHAT_PACK.version,
      updatedAt: null,
      updatedBy: null,
      revision,
    };
  }

  /**
   * Use `settings` for persistence and load the stored override. A stored override that no longer
   * validates (older schema, edited by hand) is ignored, not deleted: the built-in pack runs.
   * Returns the problems found, for the caller's log.
   */
  attach(settings: SettingsRepo | null): string[] {
    this.settings = settings;
    const revision = this.current.revision + 1;
    this.current = this.builtin(revision);
    if (!settings) return [];
    let stored: StoredPack | null;
    try {
      stored = settings.get<StoredPack | null>(CHAT_PACK_SETTING, null);
    } catch {
      return ['stored selector pack could not be read'];
    }
    if (!stored || typeof stored !== 'object' || stored.override === undefined || stored.override === null) return [];
    const parsed = parseChatPackOverride(stored.override, STARTUP_PATIENCE);
    if (!parsed.ok) return parsed.problems;
    this.current = {
      source: 'override',
      pack: mergeChatPack(parsed.override),
      override: parsed.override,
      builtinVersion: BUILTIN_CHAT_PACK.version,
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
      updatedBy: typeof stored.updatedBy === 'string' ? stored.updatedBy.slice(0, 100) : null,
      revision,
    };
    return [];
  }

  state(): ChatPackState {
    return this.current;
  }

  active(): IgChatPack {
    return this.current.pack;
  }

  revision(): number {
    return this.current.revision;
  }

  /** Store a validated override (see parseChatPackOverride) and make it active. */
  setOverride(override: ChatPackOverride, by: string | null, now: Date = new Date()): ChatPackState {
    const updatedAt = now.toISOString();
    const updatedBy = by ? by.slice(0, 100) : null;
    this.settings?.set(CHAT_PACK_SETTING, { override, updatedAt, updatedBy });
    this.current = {
      source: 'override',
      pack: mergeChatPack(override),
      override: structuredClone(override),
      builtinVersion: BUILTIN_CHAT_PACK.version,
      updatedAt,
      updatedBy,
      revision: this.current.revision + 1,
    };
    return this.current;
  }

  /** Back to the built-in pack. False when no override was active. */
  revert(): boolean {
    const had = this.current.source === 'override';
    this.settings?.delete(CHAT_PACK_SETTING);
    this.current = this.builtin(this.current.revision + 1);
    return had;
  }
}

export const chatPackStore = new ChatPackStore();
