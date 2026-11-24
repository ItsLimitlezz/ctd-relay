// OpenAPI paths and schemas of the stream report routes (v1.13, reports/routes.ts), merged into openapi.ts.

import { LEADERBOARD_KINDS, REPORT_EXPORT_FORMATS } from '../../../shared/reports.js';
import { PLATFORM_IDS } from '../../../shared/types.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const problem = (description: string) => ({ description, content: { 'application/problem+json': { schema: ref('Problem') } } });
const q = (name: string, description: string, schema: object = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });

const common = [
  q('profile', 'A profile id, or `*` for every profile the token can see. Default: the token\'s profile, else every profile.'),
  q('from', 'A day (`YYYY-MM-DD`, in `tz`) or an ISO time: streams that started at or after it.'),
  q('to', 'A day (`YYYY-MM-DD`, in `tz`, that whole day included) or an ISO time: streams that started before it.'),
  q('tz', 'IANA time zone for days and exported times (default `UTC`), e.g. `America/New_York`.'),
  q('platform', 'Only this platform.', { type: 'string', enum: PLATFORM_IDS }),
  q('test', 'Test-mode streams: `include` or `exclude` (default `include` for lists, `exclude` for summaries, leaderboards and range exports).', { type: 'string', enum: ['include', 'exclude'] }),
];
const format = q('format', 'File type. Default `xlsx`.', { type: 'string', enum: REPORT_EXPORT_FORMATS });
const files = {
  description: 'The file (`Content-Disposition: attachment`)',
  content: {
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } },
    'application/zip': { schema: { type: 'string', format: 'binary' } },
    'application/json': { schema: { type: 'object' } },
  },
};

export function reportPaths(c: { errors: object }): Record<string, unknown> {
  const { errors } = c;
  const scope = 'Needs `reports:read`. A token limited to one profile sees that profile only.';
  const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
  const notFound = problem('No stream report with this id, or one of another profile (`not_found`)');
  const unavailable = problem('The report tables were made by a newer CTD Relay (`unavailable`)');
  return {
    '/reports/sessions': {
      get: {
        summary: 'Recorded streams, newest first (v1.13)',
        operationId: 'listReportSessions',
        tags: ['reports'],
        description: `${scope} One row per stream (a profile's go-live, start to end) with its headline numbers.`,
        parameters: [...common, q('limit', '1–1000, default 100.', { type: 'integer', minimum: 1, maximum: 1000 })],
        responses: { '200': { description: 'Streams', content: json({ type: 'object', properties: { sessions: { type: 'array', items: ref('ReportSessionSummary') } } }) }, ...errors, '503': unavailable },
      },
    },
    '/reports/sessions/{id}': {
      get: {
        summary: 'One stream in detail (v1.13)',
        operationId: 'getReportSession',
        tags: ['reports'],
        description: `${scope} Titles, destinations, per-platform and total numbers, viewers over time, chat per minute, feed stats per minute, events and the four leaderboards for this stream. Unknown numbers are null, never 0.`,
        parameters: [id, common[0]],
        responses: { '200': { description: 'The stream', content: json({ type: 'object' }) }, ...errors, '404': notFound, '503': unavailable },
      },
    },
    '/reports/sessions/{id}/export': {
      get: {
        summary: 'Export one stream as .xlsx, CSV (zip) or JSON (v1.13)',
        operationId: 'exportReportSession',
        tags: ['reports'],
        description: `${scope} Sheets: Summary, Per platform, Viewers, Chat per minute, Events, Top chatters, Audience, Anonymous joins, Feeds.`,
        parameters: [id, format, common[0], common[3]],
        responses: { '200': files, ...errors, '404': notFound, '503': unavailable },
      },
    },
    '/reports/summary': {
      get: {
        summary: 'Totals and leaderboards over a date range (v1.13)',
        operationId: 'getReportSummary',
        tags: ['reports'],
        description: `${scope}`,
        parameters: [...common, q('limit', 'Leaderboard rows, 1–500, default 25.', { type: 'integer', minimum: 1, maximum: 500 })],
        responses: { '200': { description: 'The summary', content: json({ type: 'object' }) }, ...errors, '503': unavailable },
      },
    },
    '/reports/export': {
      get: {
        summary: 'Export a date range as .xlsx, CSV (zip) or JSON (v1.13)',
        operationId: 'exportReports',
        tags: ['reports'],
        description: `${scope} The same sheets as one stream, with a Stream column and an "All streams" row.`,
        parameters: [...common, format],
        responses: { '200': files, ...errors, '503': unavailable },
      },
    },
    '/reports/audience': {
      get: {
        summary: 'A leaderboard (v1.13)',
        operationId: 'getReportLeaderboard',
        tags: ['reports'],
        description: `${scope} \`chatters\`: most messages. \`loyal\`: most streams attended (chatted, joined, or in a presence list). \`watch\`: longest watch time, only from platforms that say who is present (Twitch chatters list). \`newest\`: first stream in the range and at least two streams in it (for one stream: first-timers).`,
        parameters: [
          q('board', 'Default `chatters`.', { type: 'string', enum: LEADERBOARD_KINDS }),
          q('session', 'One stream id instead of a date range.'),
          q('limit', '1–500, default 25.', { type: 'integer', minimum: 1, maximum: 500 }),
          ...common,
        ],
        responses: { '200': { description: 'The leaderboard', content: json({ type: 'object' }) }, ...errors, '404': notFound, '503': unavailable },
      },
    },
    '/reports/audience/users/{userId}': {
      get: {
        summary: 'One viewer across streams (v1.13)',
        operationId: 'getReportAudienceUser',
        tags: ['reports'],
        description: `${scope} \`userId\` is the chat.message \`user.id\` form (\`<platform>:<id>\` or \`<platform>:name:<display name>\`), URL-encoded.`,
        parameters: [{ name: 'userId', in: 'path', required: true, schema: { type: 'string' } }, ...common],
        responses: { '200': { description: 'The viewer', content: json({ type: 'object' }) }, ...errors, '404': problem('Unknown (`not_found`)'), '503': unavailable },
      },
    },
  };
}

export function reportSchemas(): Record<string, unknown> {
  const n = (t = 'number') => ({ oneOf: [{ type: t }, { type: 'null' }] });
  return {
    ReportSessionSummary: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        profileId: { type: 'string' },
        profileName: n('string'),
        startedAt: { type: 'string', format: 'date-time' },
        endedAt: n('string'),
        endedByRestart: { type: 'boolean' },
        testMode: { type: 'boolean' },
        title: { type: 'string' },
        lastTitle: { type: 'string' },
        platforms: { type: 'array', items: { type: 'string', enum: PLATFORM_IDS } },
        durationSec: { type: 'integer' },
        peakViewers: n('integer'),
        viewerMinutes: { ...n(), description: 'Viewers × minutes (not unique viewers)' },
        chatMessages: { type: 'integer' },
        uniqueChatters: n('integer'),
      },
    },
  };
}
