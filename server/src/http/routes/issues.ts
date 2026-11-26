// Issues for the web UI (docs/API.md §17; shared/issues.ts). Session cookie like every /api route.
//   GET /api/profiles/:id/issues                       [user] the profile's open issues, oldest first
//   GET /api/issues/history?profile=<id>|*&limit=<n>   [user] the last 7 days, newest first
// Live changes arrive on the WebSocket ('issue-raised' / 'issue-cleared', routes/ws.ts).

import type { FastifyPluginAsync } from 'fastify';
import { ISSUE_HISTORY_DAYS, type IssueHistoryResponse, type OpenIssuesResponse } from '../../../../shared/issues.js';
import { DEFAULT_PROFILE_ID } from '../../../../shared/types.js';
import { eventHubFor } from '../../api/event-hub.js';
import { historyLimit, issueHistoryFor } from '../../api/issue-history.js';
import { ISSUE_HISTORY_LIST_MAX } from '../../db/issue-history-repo.js';
import { requireUser, sendError, type RouteOptions } from '../guards.js';

const PROFILE_ID_MAX = 128;
const ALL_PROFILES = new Set(['*', 'all']);

const issueRoutes: FastifyPluginAsync<RouteOptions> = async (app, { services }) => {
  const knownProfile = (id: unknown): id is string =>
    typeof id === 'string' && id.length > 0 && id.length <= PROFILE_ID_MAX && !!services.repos.profiles.get(id);

  app.get('/api/profiles/:id/issues', { preHandler: requireUser }, async (req, reply) => {
    const id = (req.params as Record<string, unknown>).id;
    if (!knownProfile(id)) return sendError(reply, 404, 'Profile not found', 'unknown_profile');
    const body: OpenIssuesResponse = { issues: eventHubFor(services).openIssues(id) };
    return reply.header('cache-control', 'no-store').send(body);
  });

  app.get('/api/issues/history', { preHandler: requireUser }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const raw = q.profile === undefined || q.profile === '' ? DEFAULT_PROFILE_ID : q.profile;
    const all = typeof raw === 'string' && ALL_PROFILES.has(raw);
    if (!all && !knownProfile(raw)) return sendError(reply, 404, 'Profile not found', 'unknown_profile');
    const limit = historyLimit(q.limit);
    if (limit === null) return sendError(reply, 400, `limit: 1–${ISSUE_HISTORY_LIST_MAX}`, 'invalid');
    const history = issueHistoryFor(services);
    const body: IssueHistoryResponse = {
      items: history ? history.list({ profileId: all ? null : (raw as string), limit }) : [],
      retentionDays: ISSUE_HISTORY_DAYS,
    };
    return reply.header('cache-control', 'no-store').send(body);
  });
};

export default issueRoutes;
