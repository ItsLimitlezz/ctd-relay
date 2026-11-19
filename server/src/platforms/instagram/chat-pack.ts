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
    /** The subset of events that are "<name> joined" lines (`join: true` in the API). */
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
  version: 'builtin-2',
  tab: { css: [], roles: ['tab', 'button'], name: namesSource('comments', 'comment') },
  container: {
    css: [],
    panelLabel: '^(live )?comments?$',
    composerCss: ['textarea', 'input[type="text"]', '[contenteditable="true"]'],
    composerHint: 'comment',
    headingCss: ['h1', 'h2', 'h3', 'h4', 'span', 'div'],
    climbLevels: 4,
    climbMinHeight: 200,
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
      '^(joined|joined the live video|joined the live|is watching|started watching|requested to join)\\.?$',
      '^and \\d+ (other|others|more) (joined|joined the live video|joined the live)\\.?$',
    ],
    join: [
      '^(joined|joined the live video|joined the live|is watching|started watching)\\.?$',
      '^and \\d+ (other|others|more) (joined|joined the live video|joined the live)\\.?$',
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
  timing: { pollMs: 1_000, tabRetryMs: 15_000, backoffMaxMs: 10_000 },
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

/** Strings a pack regex must get through quickly: long runs of what it is made of, ending in a mismatch. */
function regexProbes(source: string): string[] {
  const n = REGEX_INPUT_MAX * 4;
  const probes = new Set<string>();
  const add = (unit: string): void => {
    if (!unit) return;
    const run = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    probes.add(run);
    probes.add(`${run}\u0000`);
    probes.add(`${run}!`);
  };
  for (const unit of ['a', ' ', '0', 'a ', 'a0', '\u{1F600}']) add(unit);
  for (const word of source.match(/[\p{L}\p{N}]+/gu) ?? []) {
    add(word);
    add(`${word} `);
  }
  for (const ch of new Set(source.replace(/[\\^$.*+?()[\]{}|]/g, ''))) add(ch);
  return [...probes].slice(0, 400);
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
  const left = probeDeadline === null ? PROBE_BUDGET_MS : Math.min(PROBE_BUDGET_MS, probeDeadline - Date.now());
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
    timing: z.object({ pollMs: int(500, 10_000), tabRetryMs: int(3_000, 120_000), backoffMaxMs: int(1_000, 60_000) }).partial().strict().optional(),
    limits: z.object({ maxRows: int(20, 500), history: int(50, 2_000) }).partial().strict().optional(),
  })
  .strict();

export type ChatPackOverride = z.infer<typeof chatPackOverrideSchema>;

export type ParsedOverride = { ok: true; override: ChatPackOverride } | { ok: false; problems: string[] };

/** Validate an override as received (any JSON value). Never throws. */
export function parseChatPackOverride(value: unknown): ParsedOverride {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return { ok: false, problems: ['body: not JSON'] };
  }
  if (bytes > CHAT_PACK_MAX_BYTES) return { ok: false, problems: [`body: larger than ${CHAT_PACK_MAX_BYTES} bytes`] };
  probeDeadline = Date.now() + PACK_PROBE_BUDGET_MS;
  let parsed: ReturnType<typeof chatPackOverrideSchema.safeParse>;
  try {
    parsed = chatPackOverrideSchema.safeParse(value);
  } finally {
    probeDeadline = null;
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
    const parsed = parseChatPackOverride(stored.override);
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
