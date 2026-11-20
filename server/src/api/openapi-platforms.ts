// OpenAPI paths and schemas of the operator routes (v1.11, v1-platforms.ts), merged into openapi.ts.

import { CHAT_PACK_MAX_BYTES, CHAT_PACK_SCHEMA, LIST_MAX, REGEX_LIST_MAX, REGEX_MAX, SELECTOR_MAX, TAB_ROLES } from '../platforms/instagram/chat-pack.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: object) => ({ oneOf: [schema, { type: 'null' }] });
const json = (schema: object) => ({ 'application/json': { schema } });
const problem = (description: string) => ({ description, content: { 'application/problem+json': { schema: ref('Problem') } } });

export function platformPaths(common: { errors: object }): Record<string, unknown> {
  const { errors } = common;
  const forbidden = problem('Token lacks `system:admin` (`missing_scope`), or is limited to one profile (`profile_forbidden`)');
  const status = { description: 'The active pack', content: json(ref('InstagramChatPackStatus')) };
  return {
    '/platforms/instagram/chat/selector-pack': {
      get: {
        summary: "The Instagram chat reader's active selector pack (v1.11)",
        operationId: 'getInstagramChatPack',
        tags: ['operator'],
        description: 'Needs `system:admin`. Server-wide (no profile). `pack` is what the reader runs with: the built-in pack with the stored override on top.',
        responses: { '200': status, ...errors, '403': forbidden },
      },
      put: {
        summary: 'Store a selector pack override (v1.11)',
        operationId: 'putInstagramChatPack',
        tags: ['operator'],
        description: `Needs \`system:admin\`. Audited. The body is a partial pack: only the settings to change (lists replace the built-in lists whole); unknown keys are refused. At most ${CHAT_PACK_MAX_BYTES} bytes of JSON. A pack is data only: CSS selectors (at most ${SELECTOR_MAX} characters, plain CSS), attribute names and regular-expression sources (at most ${REGEX_MAX} characters, compiled with the \`i\` flag, no backreferences, refused when slow on long input). The running reader uses the new pack on its next poll and it is kept across restarts.`,
        requestBody: { required: true, content: json(ref('InstagramChatPackOverride')) },
        responses: { '200': status, '400': problem('Not a valid pack (`invalid`): the detail lists each problem with its path'), '413': problem('Body too large'), ...errors, '403': forbidden },
      },
      delete: {
        summary: 'Revert to the built-in selector pack (v1.11)',
        operationId: 'deleteInstagramChatPack',
        tags: ['operator'],
        description: 'Needs `system:admin`. Audited when an override was active. Idempotent.',
        responses: { '200': status, ...errors, '403': forbidden },
      },
    },
    '/platforms/instagram/chat/debug': {
      post: {
        summary: 'Sanitised capture of what the Instagram chat reader sees (v1.11)',
        operationId: 'postInstagramChatDebug',
        tags: ['operator'],
        description:
          'Needs `system:admin`. Audited. For each Instagram live being read: the structure of the comments panel (tags, class names, structural attributes, attribute names; text replaced by its length), how many elements each pack selector matches, and the last parse decisions (kept or dropped and why, lengths only). Never user names, comment text, URLs or cookies. `readers` is empty when no Instagram live is being read.',
        requestBody: {
          required: false,
          content: json({
            type: 'object',
            additionalProperties: false,
            properties: {
              scope: { enum: ['container', 'page'], default: 'container', description: '`page`: the whole page, for when no comments panel is found' },
              up: { type: 'integer', minimum: 0, maximum: 6, default: 0, description: 'Start this many parents above the comments container' },
              decisions: { type: 'integer', minimum: 0, maximum: 200, default: 50 },
              maxNodes: { type: 'integer', minimum: 20, maximum: 1500, default: 400 },
            },
          }),
        },
        responses: { '200': { description: 'The capture', content: json(ref('InstagramChatDebug')) }, '400': problem('Bad option (`invalid`)'), ...errors, '403': forbidden },
      },
    },
  };
}

export function platformSchemas(): Record<string, unknown> {
  const selectors = { type: 'array', maxItems: LIST_MAX, items: { type: 'string', maxLength: SELECTOR_MAX, description: 'CSS selector' } };
  const regex = { type: 'string', maxLength: REGEX_MAX, description: 'Regular-expression source (flag i)' };
  const regexes = { type: 'array', maxItems: REGEX_LIST_MAX, items: regex };
  const section = (properties: Record<string, object>) => ({ type: 'object', additionalProperties: false, properties });
  const packProperties = {
    schema: { const: CHAT_PACK_SCHEMA },
    version: { type: 'string', maxLength: 40, description: 'Your label for this pack' },
    note: { type: 'string', maxLength: 300 },
    tab: section({ css: selectors, roles: { type: 'array', items: { enum: [...TAB_ROLES] } }, name: regex }),
    container: section({
      css: selectors,
      panelLabel: regex,
      composerCss: selectors,
      composerHint: regex,
      headingCss: selectors,
      climbLevels: { type: 'integer', minimum: 0, maximum: 12 },
      climbMinHeight: { type: 'integer', minimum: 0, maximum: 2000 },
    }),
    row: section({
      css: selectors,
      avatarCss: selectors,
      avatarAlt: { ...regex, description: 'Avatar alt text; capture group 1 is the user name' },
      fallbackCss: selectors,
      excludeCss: selectors,
      maxAvatars: { type: 'integer', minimum: 1, maximum: 4 },
      idAttrs: { type: 'array', maxItems: LIST_MAX, items: { type: 'string', description: 'Attribute name holding a stable comment id' } },
    }),
    text: section({ css: selectors, skipCss: selectors, authorCss: selectors, emojiCss: selectors, meta: regexes }),
    classify: section({ event: regexes, join: regexes, system: regexes, systemCss: selectors, pinned: regexes, pinnedCss: selectors, verifiedCss: selectors }),
    composer: section({ css: selectors, post: regex }),
    timing: section({
      pollMs: { type: 'integer', minimum: 500, maximum: 10000 },
      tabRetryMs: { type: 'integer', minimum: 3000, maximum: 120000 },
      backoffMaxMs: { type: 'integer', minimum: 1000, maximum: 60000 },
    }),
    limits: section({ maxRows: { type: 'integer', minimum: 20, maximum: 500 }, history: { type: 'integer', minimum: 50, maximum: 2000 } }),
  };
  return {
    InstagramChatPackOverride: {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'version'],
      description: 'Any subset of the pack settings. See docs/PLATFORMS.md → Instagram for what each one does.',
      properties: packProperties,
    },
    InstagramChatPackStatus: {
      type: 'object',
      required: ['source', 'version', 'builtinVersion', 'note', 'updatedAt', 'updatedBy', 'readers', 'maxBytes', 'pack', 'override'],
      properties: {
        source: { enum: ['builtin', 'override'] },
        version: { type: 'string' },
        builtinVersion: { type: 'string' },
        note: nullable({ type: 'string' }),
        updatedAt: nullable({ type: 'string', format: 'date-time' }),
        updatedBy: nullable({ type: 'string' }),
        readers: { type: 'integer', description: 'Instagram lives being read right now' },
        maxBytes: { type: 'integer' },
        pack: { type: 'object', description: 'The effective pack: every setting' },
        override: nullable(ref('InstagramChatPackOverride')),
      },
    },
    InstagramChatDebug: {
      type: 'object',
      required: ['capturedAt', 'pack', 'readers'],
      properties: {
        capturedAt: { type: 'string', format: 'date-time' },
        pack: { type: 'object', properties: { source: { enum: ['builtin', 'override'] }, version: { type: 'string' }, builtinVersion: { type: 'string' } } },
        readers: {
          type: 'array',
          items: {
            type: 'object',
            required: ['reader', 'snapshot', 'tab', 'composer', 'decisions'],
            properties: {
              reader: { type: 'object', description: 'Reader state: pack version, container strategy, row count, tab outcome, kept/dropped counters, unusable pack entries' },
              snapshot: nullable({
                type: 'object',
                description: 'page (host, path depth), container, tree (sanitised DOM), selectors (matches per pack selector), patterns (matches per label pattern)',
              }),
              tab: nullable({ type: 'object', properties: { matches: { type: 'integer' }, visible: { type: 'boolean' }, ariaSelected: nullable({ type: 'string' }) } }),
              composer: nullable({ type: 'object', properties: { matches: { type: 'integer' } } }),
              decisions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    at: { type: 'string', format: 'date-time' },
                    row: { type: 'integer' },
                    verdict: { enum: ['kept', 'dropped'] },
                    reason: { enum: ['new', 'late', 'baseline', 'pack-changed', 'rerender', 'duplicate-id', 'pinned', 'system'] },
                    kind: { enum: ['message', 'event'] },
                    join: { type: 'boolean' },
                    authorLength: { type: 'integer' },
                    textLength: { type: 'integer' },
                    hasAvatar: { type: 'boolean' },
                    hasId: { type: 'boolean' },
                    restored: { type: 'boolean' },
                  },
                },
              },
              error: { type: 'string' },
            },
          },
        },
      },
    },
  };
}
