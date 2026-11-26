// The web UI's issue routes (docs/API.md §17): open issues of a profile, and the 7-day history.

import crypto from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { User } from '../../../../shared/types.js';
import { EventHub, setEventHubFor } from '../../api/event-hub.js';
import { IssueHistory, setIssueHistoryFor } from '../../api/issue-history.js';
import { dest, dstate, platformInfo, session, silentLog } from '../../api/test-helpers.js';
import { openDatabase } from '../../db/database.js';
import { createIssueHistoryRepo } from '../../db/issue-history-repo.js';
import { createRepos } from '../../db/repos.js';
import { EventBus } from '../../events.js';
import { createSecretBox } from '../../security/secretbox.js';
import type { AppServices } from '../../services.js';
import issueRoutes from './issues.js';

const user: User = { id: 'u1', username: 'op', role: 'operator', totpEnabled: false, createdAt: '', lastLoginAt: null };

describe('GET /api/profiles/:id/issues and /api/issues/history', () => {
  it('answers the open set and the history to a signed-in user', async () => {
    const db = openDatabase(':memory:');
    const repos = createRepos(db, createSecretBox(crypto.randomBytes(32)));
    const bus = new EventBus();
    const d1 = dest('d1', { name: 'Twitch main' });
    let current = session({ destinations: [dstate('d1', 'live')] });
    const hub = new EventHub({ bus, log: silentLog, state: () => current, destinations: () => [d1], destination: () => d1, platformInfo, issueHolds: { destination: 0, stream: 3600_000 } });
    const services = { repos, log: silentLog } as unknown as AppServices;
    setEventHubFor(services, hub);
    const history = new IssueHistory({ repo: createIssueHistoryRepo(db), events: hub, log: silentLog, timers: false });
    setIssueHistoryFor(services, history);
    history.start();

    let signedIn = true;
    const app = Fastify();
    app.decorateRequest('user', null);
    app.addHook('onRequest', async (req) => {
      req.user = signedIn ? user : null;
    });
    await app.register(issueRoutes, { services });

    current = { ...current, destinations: [dstate('d1', 'error')] };
    bus.emit('destination', dstate('d1', 'error'));
    const open = (await app.inject('/api/profiles/default/issues')).json();
    expect(open.issues).toHaveLength(1);
    expect(open.issues[0]).toMatchObject({ kind: 'destination.down', subject: { type: 'destination', destinationId: 'd1', name: 'Twitch main' } });
    expect((await app.inject('/api/issues/history')).json()).toMatchObject({ retentionDays: 7, items: [{ kind: 'destination.down', clearedAt: null }] });
    expect((await app.inject('/api/issues/history?profile=*&limit=5')).json().items).toHaveLength(1);

    expect((await app.inject('/api/profiles/nope/issues')).statusCode).toBe(404);
    expect((await app.inject('/api/issues/history?profile=nope')).statusCode).toBe(404);
    expect((await app.inject('/api/issues/history?limit=abc')).statusCode).toBe(400);
    signedIn = false;
    expect((await app.inject('/api/profiles/default/issues')).statusCode).toBe(401);
    expect((await app.inject('/api/issues/history')).statusCode).toBe(401);

    await app.close();
    history.close();
    hub.close();
    db.close();
  });
});
