// /api/v1 since v1.12: issues (docs/API.md §16) through the real routes.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE_ID } from '../../../shared/types.js';
import { API_REVISION, openApiDocument } from './openapi.js';
import { createTestApi, type TestApi } from './test-helpers.js';
import { EVENT_SCOPES, type ApiIssueRaised, type Envelope } from './types.js';

const APP = 'ctd-obs-plugin-studio';

let t: TestApi;
let obs: string;
let reader: string;
let chatOnly: string;

beforeEach(async () => {
  t = await createTestApi();
  obs = t.token(['apps:read', 'apps:write', 'obs:write', 'status:read'], 'obs plugin');
  reader = t.token(['status:read'], 'ctd live mobile');
  chatOnly = t.token(['chat:read'], 'overlay');
});
afterEach(async () => {
  await t.close();
});

type Body = Record<string, unknown>;
const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, body?: Body) =>
  t.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
const ev = (id: string, type: string, data: Body) => ({ id, type, ts: Date.now(), data });
const register = () => call('PUT', `/api/v1/apps/${APP}`, obs, { name: 'CTD OBS plugin', kind: 'ctd-obs-plugin' });
const post = (events: unknown[]) => call('POST', `/api/v1/apps/${APP}/events`, obs, { events });
const poll = async (token: string, after: string, types: string) => (await call('GET', `/api/v1/events/poll?after=${after}&types=${types}`, token)).json().items as Envelope[];

describe('issues (v1.12)', () => {
  it("the plugin's issue reaches /events as issue.raised and GET /status → issues; clearing it removes it", async () => {
    await register();
    const start = t.hub.cursor();
    const issue = { id: 'camera-offline|Club cam', rule: 'camera-offline', severity: 'critical', source: 'Club cam', path: 'live/club', title: 'Camera offline', onProgram: true, scene: 'Club' };
    expect((await post([ev('i1', 'obs.issue.raised', issue)])).json()).toEqual({ accepted: 1, ignored: 0 });
    await post([ev('i2', 'obs.issue.raised', issue)]); // the 60 s resend: no second issue.raised

    const items = await poll(reader, start, 'issue.*');
    expect(items.map((e) => e.type)).toEqual(['issue.raised']);
    const raised = items[0] as Envelope<ApiIssueRaised>;
    expect(raised.src).toMatchObject({ connection: APP, platform: 'obs', profile: DEFAULT_PROFILE_ID });
    expect(raised.data).toMatchObject({
      id: `obs.issue|${APP}|camera-offline|Club cam`,
      kind: 'obs.issue',
      rule: 'camera-offline',
      severity: 'critical',
      title: 'Camera offline',
      subject: { type: 'obs.source', appId: APP, source: 'Club cam', path: 'live/club' },
      onProgram: true,
      scene: 'Club',
      update: false,
    });

    const status = (await call('GET', '/api/v1/status', reader)).json();
    expect(status.issues).toEqual([{ ...raised.data, update: undefined }].map(({ update: _u, ...rest }) => rest));

    await post([ev('i3', 'obs.issue.cleared', { id: issue.id })]);
    const after = await poll(reader, raised.id, 'issue.*');
    expect(after.map((e) => `${e.type}:${(e.data as { resolution: string }).resolution}`)).toEqual(['issue.cleared:recovered']);
    expect((await call('GET', '/api/v1/status', reader)).json().issues).toEqual([]);
  });

  it('obs.failover is accepted, re-emitted on /events and keeps no state; a malformed one is ignored', async () => {
    await register();
    const start = t.hub.cursor();
    const failover = { canvas: 'landscape', from: 'Club cam', to: 'BRB', reason: 'camera-offline', issueId: 'camera-offline|Club cam', source: 'Club cam', mode: 'target', title: 'Switched to BRB: Club cam lost its signal' };
    expect((await post([ev('f1', 'obs.failover', failover), ev('f2', 'obs.failover', { canvas: 'landscape', to: 'BRB' })])).json()).toEqual({ accepted: 1, ignored: 1 });
    const items = await poll(reader, start, 'obs.failover,issue.*');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'obs.failover', src: { connection: APP, platform: 'obs' }, data: { ...failover, appId: APP, eventId: 'f1' } });
    const apps = (await call('GET', `/api/v1/profiles/${DEFAULT_PROFILE_ID}/obs`, reader)).json().apps;
    expect(apps[0]).toMatchObject({ feeds: [], outputs: [], scenes: [], issues: [] });
  });

  it('issue.* needs status:read, like the rest of the status events', async () => {
    expect(EVENT_SCOPES['issue.raised']).toBe('status:read');
    expect(EVENT_SCOPES['issue.cleared']).toBe('status:read');
    expect(EVENT_SCOPES['obs.failover']).toBe('status:read');
    await register();
    const start = t.hub.cursor();
    await post([ev('i1', 'obs.issue.raised', { id: 'av-drift|Cam', severity: 'warning', title: 'A/V drift' })]);
    // A token without status:read: asking for them is refused, and an unfiltered poll leaves them out.
    const refused = await call('GET', `/api/v1/events/poll?after=${start}&types=issue.*`, chatOnly);
    expect([refused.statusCode, refused.json().code]).toEqual([403, 'missing_scope']);
    const unfiltered = (await call('GET', `/api/v1/events/poll?after=${start}`, chatOnly)).json().items as Envelope[];
    expect(unfiltered.filter((e) => e.type.startsWith('issue.') || e.type.startsWith('obs.'))).toEqual([]);
    expect(await poll(reader, start, 'issue.*')).toHaveLength(1);
  });

  it('the OpenAPI document describes them at revision 1.12', () => {
    expect(API_REVISION).toBe('1.12');
    const doc = openApiDocument('9.9.9') as { components: { schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }> } };
    const { Issue, IssueRaised, IssueCleared, Status, Envelope: Env } = doc.components.schemas;
    expect(Issue!.required).toEqual(['id', 'kind', 'rule', 'severity', 'title', 'message', 'subject', 'onProgram', 'scene', 'firstSeen', 'updatedAt']);
    expect(IssueRaised!.required).toContain('update');
    expect(IssueCleared!.required).toContain('resolution');
    expect(Status!.required).toContain('issues');
    expect(JSON.stringify(Env)).toContain('issue.raised');
  });
});
