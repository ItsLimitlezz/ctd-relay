// Operator tools for the Instagram chat reader, shared by the web UI's routes
// (http/routes/platforms.ts, session cookie + admin) and the external API (api/v1-platforms.ts,
// system:admin token): the selector pack (read, override, revert) and the sanitised debug capture.

import { z } from 'zod';
import type { InstagramChatPackStatus } from '../../../../shared/api.js';
import { activeChatReaderCount, captureChatDebug, DEBUG_DEFAULTS, type ReaderDebug } from './chat.js';
import { CHAT_PACK_MAX_BYTES, chatPackStore, parseChatPackOverride, type ChatPackOverride } from './chat-pack.js';

/** Largest request body the selector-pack routes read (the pack itself is capped at CHAT_PACK_MAX_BYTES). */
export const CHAT_PACK_BODY_LIMIT = CHAT_PACK_MAX_BYTES * 2;
export const CHAT_DEBUG_BODY_LIMIT = 1024;

export function chatPackStatus(): InstagramChatPackStatus {
  const state = chatPackStore.state();
  return {
    source: state.source,
    version: state.pack.version,
    builtinVersion: state.builtinVersion,
    note: state.pack.note ?? null,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
    readers: activeChatReaderCount(),
    maxBytes: CHAT_PACK_MAX_BYTES,
    pack: state.pack as unknown as Record<string, unknown>,
    override: state.override as Record<string, unknown> | null,
  };
}

export type PutChatPackResult =
  | { ok: true; status: InstagramChatPackStatus; /** For the audit log: what was set, never the content. */ summary: string }
  | { ok: false; problems: string[] };

const sectionsOf = (override: ChatPackOverride): string[] => Object.keys(override).filter((k) => !['schema', 'version', 'note'].includes(k));

/** Validate and activate an override. `by`: who did it (a user name, or "token <name>"). */
export function putChatPack(body: unknown, by: string | null): PutChatPackResult {
  const parsed = parseChatPackOverride(body);
  if (!parsed.ok) return { ok: false, problems: parsed.problems };
  chatPackStore.setOverride(parsed.override, by);
  const sections = sectionsOf(parsed.override);
  const bytes = Buffer.byteLength(JSON.stringify(parsed.override), 'utf8');
  return {
    ok: true,
    status: chatPackStatus(),
    summary: `version ${JSON.stringify(parsed.override.version)} (${bytes} bytes; ${sections.length > 0 ? `changes ${sections.join(', ')}` : 'no changes to the built-in settings'})`,
  };
}

/** Back to the built-in pack. */
export function revertChatPack(): { reverted: boolean; status: InstagramChatPackStatus } {
  const reverted = chatPackStore.revert();
  return { reverted, status: chatPackStatus() };
}

const debugBody = z
  .object({
    scope: z.enum(['container', 'page']),
    up: z.number().int().min(0).max(6),
    decisions: z.number().int().min(0).max(200),
    maxNodes: z.number().int().min(20).max(1_500),
  })
  .partial()
  .strict();

export interface ChatDebugResponse {
  capturedAt: string;
  pack: { source: 'builtin' | 'override'; version: string; builtinVersion: string };
  /** One entry per Instagram live being read; empty when none is. */
  readers: ReaderDebug[];
}

export type ChatDebugResult = { ok: true; response: ChatDebugResponse } | { ok: false; problems: string[] };

/** The sanitised debug capture (docs/API.md): never user names, comment text, URLs or cookies. */
export async function chatDebug(body: unknown): Promise<ChatDebugResult> {
  const parsed = debugBody.safeParse(body ?? {});
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`) };
  const { scope, up, decisions, maxNodes } = parsed.data;
  const state = chatPackStore.state();
  const readers = await captureChatDebug({
    scope: scope ?? 'container',
    up: up ?? 0,
    decisions: decisions ?? DEBUG_DEFAULTS.decisions,
    maxNodes: maxNodes ?? DEBUG_DEFAULTS.maxNodes,
  });
  return {
    ok: true,
    response: { capturedAt: new Date().toISOString(), pack: { source: state.source, version: state.pack.version, builtinVersion: state.builtinVersion }, readers },
  };
}
