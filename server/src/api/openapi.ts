// Hand-written OpenAPI 3.1 description of /api/v1 (served at /api/v1/openapi.json, no auth).
// Keep in sync with docs/API.md.

import { API_SCOPES, PLATFORM_IDS } from '../../../shared/types.js';
import { CURRENCY_RE, DECIMAL_RE } from './alert-map.js';
import { APP_ID_RE, APP_KIND_RE, CAPABILITY_RE, MAX_CAPABILITIES, MAX_META_BYTES, MAX_RESOURCES, RESOURCE_TYPE_RE } from './hub.js';
import { PROBLEM_CODES, PROBLEM_TYPE } from './http.js';
import { MAX_PENDING_PAIRINGS, MAX_PENDING_PAIRINGS_INTERNET, MAX_PENDING_PAIRINGS_PER_ADDRESS, PAIRING_CODE_RE, PAIRING_POLL_INTERVAL_SEC, PAIRING_TTL_MS } from './pairing.js';
import { ALERT_COUNT_UNITS, ALERT_KINDS, API_ROLES, EVENT_TYPES } from './types.js';
import { CLAIMS_PER_MINUTE_PER_IP, MESSAGE_DATA_MAX_BYTES, MESSAGE_TYPE_RE, MESSAGES_PER_MINUTE, PAIRINGS_PER_MINUTE_PER_IP } from './v1-hub.js';
import { OBS_BODY_LIMIT, OBS_DATA_MAX_BYTES, OBS_EVENT_TYPES, OBS_MAX_EVENTS, OBS_POSTS_PER_MINUTE } from './obs.js';
import { PREVIEW_MAX_AGE_MS } from './previews.js';
import { CONNECT_OFFER_TTL_MS, DEVICE_NAME_MAX, MOBILE_SCOPES } from './connect.js';
import { MAX_SOCKETS_PER_TOKEN, OBS_SUBPROTOCOL } from './obs-relay.js';

/** Minor revision of the v1 contract (additive changes only; see the changelog in docs/API.md). */
export const API_REVISION = '1.6';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: object) => ({ oneOf: [schema, { type: 'null' }] });
const str = { type: 'string' };
const int = { type: 'integer' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const isoTime = { type: 'string', format: 'date-time' };
const epochMs = { type: 'integer', description: 'Epoch milliseconds' };
const json = (schema: object) => ({ 'application/json': { schema } });

const PHASES = ['idle', 'disabled', 'waiting-for-feed', 'preparing', 'connecting', 'confirming', 'live', 'retrying', 'recovering', 'ending', 'error'];

function problemResponse(description: string) {
  return { description, content: { 'application/problem+json': { schema: ref('Problem') } } };
}

const errors = {
  '401': problemResponse('No, unknown or revoked token (`unauthenticated`)'),
  '429': {
    ...problemResponse('Over 600 requests/minute for this token (`rate_limited`)'),
    headers: { 'Retry-After': { schema: int, description: 'Seconds to wait' } },
  },
};

const typesParam = {
  name: 'types',
  in: 'query',
  required: false,
  description: 'Comma-separated event types or globs (`chat.*`, `destination.down`). Default: everything the token\'s scopes allow.',
  schema: str,
};

function profileParam(defaultText: string, allowAll = false) {
  return {
    name: 'profile',
    in: 'query',
    required: false,
    description: `Profile id. Tokens limited to a profile: omit it or pass their own. Otherwise ${defaultText}.${
      allowAll ? ' `*` (or `all`): every profile the token can see (its own profile for a token limited to one).' : ''
    }`,
    schema: str,
  };
}

const profileErrors = {
  '403': problemResponse('Token lacks the scope (`missing_scope`), or is limited to another profile (`profile_forbidden`)'),
  '404': problemResponse('No such profile (`unknown_profile`)'),
};

const idPath = { name: 'id', in: 'path', required: true, description: 'Profile id', schema: str };
const appIdPath = { name: 'appId', in: 'path', required: true, schema: { type: 'string', pattern: APP_ID_RE.source } };

export function openApiDocument(version: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'CTD Relay external API',
      version: `${API_REVISION} (server ${version})`,
      description:
        'API for other apps (CTD Overlay, the CTD OBS plugin, bots): status, chat and events per profile, OBS ingest settings, and the hub where apps register what they offer and message each other. Create a token in Settings → API (or pair with POST /pairing) and send it as `Authorization: Bearer ctd_pat_…`. Full guide: docs/API.md.',
      license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearer: [] }],
    tags: [{ name: 'status' }, { name: 'chat' }, { name: 'events' }, { name: 'profiles' }, { name: 'apps' }, { name: 'pairing' }],
    paths: {
      '/': {
        get: {
          summary: 'Who am I',
          operationId: 'whoAmI',
          responses: { '200': { description: 'Server and token info', content: json(ref('WhoAmI')) }, ...errors },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'This document',
          operationId: 'openApi',
          security: [],
          responses: { '200': { description: 'OpenAPI 3.1 document', content: json({ type: 'object' }) } },
        },
      },
      '/status': {
        get: {
          summary: 'Session, feeds, destinations and per-platform rollup of one profile',
          operationId: 'getStatus',
          tags: ['status'],
          description: 'Needs `status:read`.',
          parameters: [profileParam('default: the default profile')],
          responses: {
            '200': { description: 'Current status', content: json(ref('Status')) },
            ...errors,
            ...profileErrors,
          },
        },
      },
      '/clock': {
        get: {
          summary: 'Shared timecode clock (v1.3): server time for NTP-style sync, run and time-of-day timecodes',
          operationId: 'getClock',
          tags: ['status'],
          description:
            'Needs `status:read`. Send your own send time as `t0`; with your receive time t3: offset = ((receivedAt − t0) + (sentAt − t3)) / 2, delay = (t3 − t0) − (sentAt − receivedAt). Take the sample with the smallest delay out of a few, then run the clock locally.',
          parameters: [
            profileParam('default: the default profile'),
            { name: 't0', in: 'query', required: false, description: 'Your send time, epoch milliseconds (fractions allowed)', schema: num },
          ],
          responses: {
            '200': { description: 'Clock', content: json(ref('Clock')) },
            '400': problemResponse('Bad t0 (`invalid`)'),
            ...errors,
            ...profileErrors,
          },
        },
      },
      '/chat': {
        get: {
          summary: 'Recent chat of one profile (after moderation), oldest first',
          operationId: 'getChat',
          tags: ['chat'],
          description: 'Needs `chat:read`. Session-scoped: the server keeps the last 500 messages per profile.',
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 200 } },
            { name: 'after', in: 'query', required: false, description: 'Only messages newer than this envelope id', schema: ref('Ulid') },
            profileParam('default: the default profile'),
          ],
          responses: {
            '200': { description: 'chat.message envelopes', content: json(ref('ChatResponse')) },
            '400': problemResponse('Bad limit or after (`invalid`)'),
            ...errors,
            ...profileErrors,
          },
        },
      },
      '/events': {
        get: {
          summary: 'Live events (Server-Sent Events)',
          operationId: 'streamEvents',
          tags: ['events'],
          description:
            'Every frame: `id: <envelope id>`, `event: <type>`, `data: <envelope JSON>`. Resume with `Last-Event-ID` (or `?cursor=`); when an event you would receive (by `types`, scopes and profile) after that cursor has left the buffer (2000 events / 15 minutes), or the cursor is from before a restart, the stream first sends `system.reset`. Without a cursor the stream starts with, per profile it covers, one `stream.status` and one `destination.status` per destination. Heartbeat `: ping` every 15 s. At most 5 concurrent streams per token. Browsers may pass the token as `?access_token=` (prefer the header).',
          parameters: [
            typesParam,
            profileParam('default: the default profile (as before profiles existed)', true),
            { name: 'cursor', in: 'query', required: false, schema: ref('Ulid') },
            { name: 'Last-Event-ID', in: 'header', required: false, schema: ref('Ulid') },
            { name: 'access_token', in: 'query', required: false, schema: str },
          ],
          responses: {
            '200': { description: 'text/event-stream of envelopes', content: { 'text/event-stream': { schema: ref('Envelope') } } },
            '400': problemResponse('Bad cursor or types (`invalid`)'),
            ...errors,
            '403': problemResponse('The requested types need a scope the token lacks (`missing_scope`), or the token is limited to another profile (`profile_forbidden`)'),
            '404': problemResponse('No such profile (`unknown_profile`)'),
          },
        },
      },
      '/events/poll': {
        get: {
          summary: 'Polling alternative to /events',
          operationId: 'pollEvents',
          tags: ['events'],
          description:
            'Same envelopes and buffer as /events. Without `after` it returns no items, only the current cursor (`next`). `next` moves past events the `types` filter skipped.',
          parameters: [typesParam, { name: 'after', in: 'query', required: false, schema: ref('Ulid') }, profileParam('default: the default profile', true)],
          responses: {
            '200': { description: 'Envelopes after the cursor', content: json(ref('PollResponse')) },
            '400': problemResponse('Bad after or types (`invalid`)'),
            ...errors,
            '403': problemResponse('The requested types need a scope the token lacks (`missing_scope`), or the token is limited to another profile (`profile_forbidden`)'),
            '404': problemResponse('No such profile (`unknown_profile`)'),
          },
        },
      },
      '/profiles': {
        get: {
          summary: 'Every profile with its live situation',
          operationId: 'listProfiles',
          tags: ['profiles'],
          description: 'Needs `status:read`. A token limited to a profile gets only that profile.',
          responses: {
            '200': { description: 'Profiles, oldest first', content: json(ref('ProfilesResponse')) },
            ...errors,
            '403': problemResponse('Token lacks status:read (`missing_scope`)'),
          },
        },
      },
      '/profiles/{id}': {
        get: {
          summary: 'One profile',
          operationId: 'getProfile',
          tags: ['profiles'],
          description: 'Needs `status:read`.',
          parameters: [idPath],
          responses: { '200': { description: 'The profile', content: json(ref('Profile')) }, ...errors, ...profileErrors },
        },
      },
      '/profiles/{id}/ingest': {
        get: {
          summary: 'OBS stream settings of a profile (server URL + stream keys)',
          operationId: 'getProfileIngest',
          tags: ['profiles'],
          description:
            'Needs `ingest:read`. The stream keys are secrets. The default profile keeps its pre-profiles keys (`landscape?key=…`); other profiles use `<slug>/landscape?key=…`. `serverUrl` uses the OBS host from Settings when set, else LAN_HTTP_HOST, else the host you called.',
          parameters: [idPath],
          responses: { '200': { description: 'Ingest settings', content: json(ref('Ingest')) }, ...errors, ...profileErrors },
        },
      },
      '/profiles/{id}/overlays': {
        get: {
          summary: 'Every overlay assigned to a profile, from every connected app',
          operationId: 'getProfileOverlays',
          tags: ['profiles', 'apps'],
          description: 'Needs `apps:read`.',
          parameters: [idPath],
          responses: { '200': { description: 'Overlays', content: json(ref('OverlaysResponse')) }, ...errors, ...profileErrors },
        },
      },
      '/profiles/{id}/obs': {
        get: {
          summary: 'Latest OBS state of a profile, per connected app (v1.4)',
          operationId: 'getProfileObs',
          tags: ['profiles', 'apps'],
          description: 'Needs `status:read`. Built from the obs.* events the CTD OBS plugin sends (POST /apps/{appId}/events). In memory: empty after a server restart until the plugin sends again.',
          parameters: [idPath],
          responses: { '200': { description: 'OBS state', content: json(ref('ObsStateResponse')) }, ...errors, ...profileErrors },
        },
      },
      '/profiles/{id}/previews/{feed}': {
        get: {
          summary: 'JPEG preview of what OBS sends on a feed (v1.4)',
          operationId: 'getFeedPreview',
          tags: ['profiles'],
          description: `Needs \`status:read\` (\`Authorization\`, or \`?access_token=\` for image loaders). One keyframe of the feed, 640 px wide, made on request and cached ${PREVIEW_MAX_AGE_MS / 1000} s (poll every 3–5 s). Header \`X-Preview-At\`: when the frame was taken.`,
          parameters: [idPath, { name: 'feed', in: 'path', required: true, schema: { enum: ['landscape', 'vertical'] } }, { name: 'access_token', in: 'query', required: false, schema: str }],
          responses: {
            '200': { description: 'The preview', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } },
            '404': problemResponse('Feed offline (`feed_offline`), no such feed (`not_found`) or profile (`unknown_profile`)'),
            '503': problemResponse('The preview could not be taken right now (`unavailable`, with Retry-After)'),
            '401': errors['401'],
            '429': errors['429'],
          },
        },
      },
      '/obs/socket': {
        get: {
          summary: 'OBS socket relay: obs-websocket 5 to OBS on the LAN, from anywhere (WebSocket, v1.6)',
          operationId: 'obsSocket',
          tags: ['status'],
          description: `Needs \`obs:control\`. A WebSocket upgrade (subprotocol \`${OBS_SUBPROTOCOL}\`, \`Authorization: Bearer\`). Relay opens OBS's WebSocket with the OBS password saved in Settings → API and passes obs-websocket 5 through unchanged; the Hello has no \`authentication\` (the token signed the phone in). At most ${MAX_SOCKETS_PER_TOKEN} sockets per token. Close codes: 4100 OBS not set up in Relay, 4101 OBS unreachable, 4102 OBS rejected Relay's OBS password, 4103 OBS went away, 4011 token revoked, 1001 Relay restarting; OBS's own 40xx codes pass through. The close reason is a sentence to show. See docs/API.md §12.`,
          responses: {
            '101': { description: 'Switching protocols: obs-websocket 5 follows' },
            '403': problemResponse('The token lacks `obs:control` (`missing_scope`)'),
            '401': errors['401'],
            '429': errors['429'],
          },
        },
      },
      '/apps': {
        get: {
          summary: 'Connected apps and their resources',
          operationId: 'listApps',
          tags: ['apps'],
          description:
            'Needs `apps:read`. With a profile (always, for tokens limited to one): apps connected for that profile or for every profile, with only the resources assigned to it or unassigned.',
          parameters: [profileParam('default: every app, every resource', true)],
          responses: { '200': { description: 'Apps', content: json(ref('AppsResponse')) }, ...errors, ...profileErrors },
        },
      },
      '/apps/{appId}': {
        put: {
          summary: 'Register or update this app (also a heartbeat)',
          operationId: 'registerApp',
          tags: ['apps'],
          description: `Needs \`apps:write\`. Call again (or POST …/heartbeat) at least every 60 s. Only the token that first registered an id may update or delete it. At most ${MAX_RESOURCES} resources, meta ≤ ${MAX_META_BYTES} bytes each, body ≤ 256 KB. A token limited to a profile may assign resources only to it (or null). Resources assigned to a profile that doesn't exist (e.g. one deleted since) are left out of the saved registration.`,
          parameters: [appIdPath],
          requestBody: { required: true, content: json(ref('AppRegistration')) },
          responses: {
            '200': { description: 'The registered app', content: json(ref('ConnectedApp')) },
            '400': problemResponse('Invalid registration (`invalid`)'),
            ...errors,
            '403': problemResponse('Token lacks apps:write (`missing_scope`), or assigns a resource to another profile (`profile_forbidden`)'),
            '409': problemResponse('Registered by another token (`app_owned`), or too many apps (`limit`)'),
            '413': problemResponse('Body over 256 KB (`invalid`)'),
          },
        },
        delete: {
          summary: 'Unregister this app',
          operationId: 'unregisterApp',
          tags: ['apps'],
          description: 'Needs `apps:write`; the registering token only.',
          parameters: [appIdPath],
          responses: {
            '204': { description: 'Removed' },
            ...errors,
            '403': problemResponse('Token lacks apps:write (`missing_scope`)'),
            '404': problemResponse('Not registered (`not_found`)'),
            '409': problemResponse('Registered by another token (`app_owned`)'),
          },
        },
      },
      '/apps/{appId}/heartbeat': {
        post: {
          summary: 'Keep this app online without re-sending its registration',
          operationId: 'appHeartbeat',
          tags: ['apps'],
          description: 'Needs `apps:write`; the registering token only. No body.',
          parameters: [appIdPath],
          responses: {
            '200': { description: 'The app', content: json(ref('ConnectedApp')) },
            ...errors,
            '403': problemResponse('Token lacks apps:write (`missing_scope`)'),
            '404': problemResponse('Not registered (`not_found`): register with PUT'),
            '409': problemResponse('Registered by another token (`app_owned`)'),
          },
        },
      },
      '/apps/{appId}/events': {
        post: {
          summary: 'Send OBS events into the hub (v1.4)',
          operationId: 'postObsEvents',
          tags: ['apps'],
          description: `Needs \`obs:write\`; only the token that registered \`appId\`. Body \`{ events: [{ id, type, ts, data }] }\`, at most ${OBS_MAX_EVENTS} events, data ≤ ${OBS_DATA_MAX_BYTES / 1024} KB each, body ≤ ${OBS_BODY_LIMIT / 1024} KB, ${OBS_POSTS_PER_MINUTE} requests/minute per token. Types: ${OBS_EVENT_TYPES.join(', ')}. Unknown types, malformed events and duplicate ids (10 min) are ignored, not refused. \`ts\`: epoch ms on the hub's clock (more than 5 min off → the server's time). The profile: the token's, else \`?profile=\`, else the default profile. Re-emitted on /events (status:read); obs.feed.stats at most every 5 s per source.`,
          parameters: [appIdPath, profileParam('default: the default profile')],
          responses: {
            '202': { description: 'Accepted', content: json({ type: 'object', properties: { accepted: int, ignored: int } }) },
            '400': problemResponse('Bad body (`invalid`)'),
            '409': problemResponse('Registered by another token (`app_owned`)'),
            ...errors,
            ...profileErrors,
            '404': problemResponse('No app registered under this id (`not_found`): register it first; or no such profile (`unknown_profile`)'),
          },
        },
      },
      '/apps/{appId}/obs-websocket': {
        put: {
          summary: "Report OBS's WebSocket settings for the OBS socket relay (v1.6)",
          operationId: 'putObsWebSocket',
          tags: ['apps'],
          description:
            "Needs `obs:write`; only the token that registered `appId` (the CTD OBS plugin). Body `{ enabled, port, authRequired, password?, addresses? }`: OBS's WebSocket server settings and the OBS machine's LAN addresses (best first). Relay stores the password encrypted, never logs it, and uses it to open OBS for phones on GET /obs/socket. `password` omitted = keep the saved one; `authRequired: false` removes it. An address set by hand in Settings → API wins over `addresses`. Send it on start, whenever the settings change, and every few minutes.",
          parameters: [appIdPath],
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['enabled', 'port', 'authRequired'],
              properties: { enabled: bool, port: int, authRequired: bool, password: nullable(str), addresses: { type: 'array', items: str, maxItems: 8 } },
            }),
          },
          responses: {
            '200': { description: 'Stored', content: json({ type: 'object', properties: { host: nullable(str), port: int, hasPassword: bool, manualHost: bool } }) },
            '400': problemResponse('Bad body (`invalid`)'),
            '404': problemResponse('No app registered under this id (`not_found`): register it first'),
            '409': problemResponse('Registered by another token (`app_owned`)'),
            ...errors,
          },
        },
      },
      '/messages': {
        post: {
          summary: 'Send a message to another app (or every app) through the hub',
          operationId: 'sendMessage',
          tags: ['apps'],
          description: `Needs \`apps:write\`. Delivered as an \`app.message\` event to tokens with \`apps:read\`: everyone for broadcasts (\`to: null\`), else only the token that registered \`to\`; never to tokens limited to another profile. ${MESSAGES_PER_MINUTE} messages/minute per token.`,
          requestBody: { required: true, content: json(ref('MessageRequest')) },
          responses: {
            '201': { description: 'Queued', content: json({ type: 'object', required: ['id'], properties: { id: ref('Ulid') } }) },
            '400': problemResponse('Invalid message (`invalid`)'),
            ...errors,
            '403': problemResponse('Token lacks apps:write (`missing_scope`), or names another profile (`profile_forbidden`)'),
            '404': problemResponse('No app registered as `to` (`not_found`), or no profile with that `profileId` (`unknown_profile`)'),
          },
        },
      },
      '/connect/claim': {
        post: {
          summary: 'Claim a phone token with the one-time code from a QR code (v1.5)',
          operationId: 'claimConnect',
          tags: ['pairing'],
          security: [],
          description: `No token. The QR code shown in Settings → API → Connect a phone holds \`ctdrelay://connect?v=1&api=<public API URL>&lan=<LAN API URL>&fp=<certificate SHA-256>&code=<one-time code>\`. Claim once within ${CONNECT_OFFER_TTL_MS / 60_000} minutes; the token gets ${MOBILE_SCOPES.join(', ')} (read status and chat, control OBS through GET /obs/socket). ${CLAIMS_PER_MINUTE_PER_IP} attempts/minute per address.`,
          requestBody: {
            required: true,
            content: json({
              type: 'object',
              required: ['code'],
              properties: { code: str, deviceName: { type: 'string', maxLength: DEVICE_NAME_MAX, description: 'Shown in Settings → API, e.g. "Juan\'s iPhone"' } },
            }),
          },
          responses: {
            '200': {
              description: 'The token (returned once)',
              content: json({
                type: 'object',
                properties: {
                  token: { type: 'string', description: 'ctd_pat_… — store it securely' },
                  tokenId: str,
                  name: str,
                  scopes: { type: 'array', items: ref('Scope') },
                  profileId: nullable(str),
                  server: { type: 'object', properties: { name: str, version: str, apiRevision: str } },
                },
              }),
            },
            '400': problemResponse('Bad body (`invalid`)'),
            '410': problemResponse('Unknown, used or expired code (`expired`): show a new QR code'),
            '429': errors['429'],
          },
        },
      },
      '/pairing': {
        post: {
          summary: 'Ask to connect (no token yet); an admin approves in Settings → API',
          operationId: 'startPairing',
          tags: ['pairing'],
          security: [],
          description: `No auth. ${PAIRINGS_PER_MINUTE_PER_IP} requests/minute per address (IPv6: per /64); at most ${MAX_PENDING_PAIRINGS} pending at once, ${MAX_PENDING_PAIRINGS_PER_ADDRESS} per address, and ${MAX_PENDING_PAIRINGS_INTERNET} from outside the LAN (the rest are kept for LAN apps). Scopes this server doesn't know are ignored. Show \`code\` (and \`approveUrl\`) to the user, then poll POST /pairing/{pairingId}/token every \`interval\` seconds.`,
          requestBody: { required: true, content: json(ref('PairingRequest')) },
          responses: {
            '201': { description: 'Pending', content: json(ref('PairingStarted')) },
            '400': problemResponse('Invalid request, or no scope this server knows (`invalid`)'),
            '404': problemResponse('No profile with that `profileId` (`unknown_profile`)'),
            '429': {
              ...problemResponse('Too many requests from this address, or too many pending (`rate_limited`)'),
              headers: { 'Retry-After': { schema: int, description: 'Seconds to wait' } },
            },
          },
        },
      },
      '/pairing/{pairingId}/token': {
        post: {
          summary: 'Poll a pairing request; returns the token once approved (once)',
          operationId: 'pollPairing',
          tags: ['pairing'],
          security: [],
          parameters: [{ name: 'pairingId', in: 'path', required: true, schema: str }],
          requestBody: { required: true, content: json({ type: 'object', required: ['pollSecret'], properties: { pollSecret: str } }) },
          responses: {
            '200': { description: 'Approved: the token (returned once)', content: json(ref('PairingApproved')) },
            '202': { description: 'Still waiting for the admin', content: json({ type: 'object', properties: { status: { const: 'pending' } } }) },
            '400': problemResponse('Missing pollSecret (`invalid`)'),
            '403': problemResponse('Denied by the admin (`denied`)'),
            '410': problemResponse('Expired, already collected, or unknown (`expired`): start over'),
            '429': problemResponse('Too many polls from this address (`rate_limited`)'),
          },
        },
      },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'ctd_pat_ token from Settings → API (or pairing)' } },
      schemas: {
        Ulid: { type: 'string', pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$', description: 'ULID: unique, sortable by time' },
        Problem: {
          type: 'object',
          required: ['type', 'title', 'status', 'detail', 'code'],
          properties: {
            type: { type: 'string', const: PROBLEM_TYPE },
            title: str,
            status: int,
            detail: str,
            code: { enum: [...PROBLEM_CODES] },
          },
        },
        Scope: { enum: [...API_SCOPES] },
        WhoAmI: {
          type: 'object',
          required: ['name', 'version', 'build', 'apiRevision', 'apiVersion', 'token'],
          properties: {
            name: { const: 'ctd-multi-stream' },
            version: str,
            build: {
              type: 'object',
              description: 'v1.3: the running image (null for a local build)',
              properties: { commit: nullable({ type: 'string', description: 'Short git commit' }), date: nullable(isoTime) },
            },
            apiRevision: { type: 'string', description: 'v1.3: API revision, e.g. "1.3"' },
            apiVersion: { const: 1 },
            token: {
              type: 'object',
              properties: {
                name: str,
                scopes: { type: 'array', items: ref('Scope') },
                profileId: { ...nullable(str), description: 'Profile the token is limited to; null = every profile' },
              },
            },
          },
        },
        Platform: { enum: [...PLATFORM_IDS] },
        Session: {
          type: 'object',
          required: ['status', 'startedAt', 'title', 'testMode', 'autoGoLive', 'viewers'],
          properties: {
            status: { enum: ['offline', 'starting', 'live', 'stopping'] },
            startedAt: nullable(isoTime),
            title: str,
            testMode: {
              type: 'boolean',
              description:
                'Test mode: every destination streams with its platform’s private/test setting; destinations without one are skipped (phase disabled, message "Skipped — <Platform> has no test mode"). Channel titles (Twitch, Kick) are never changed in test mode',
            },
            autoGoLive: bool,
            viewers: {
              oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
              description: 'v1.3: viewers across every platform of the profile (sum of the known counts); null when none is known',
            },
          },
        },
        Feed: {
          type: 'object',
          required: ['feed', 'online', 'since', 'video', 'audio', 'bitrateKbps'],
          properties: {
            feed: { enum: ['landscape', 'vertical'] },
            online: bool,
            since: nullable(isoTime),
            video: nullable({ type: 'object', properties: { codec: str, width: int, height: int, fps: num } }),
            audio: nullable({ type: 'object', properties: { codec: str, sampleRate: int, channels: int } }),
            bitrateKbps: nullable(num),
          },
        },
        Destination: {
          type: 'object',
          required: ['id', 'name', 'platform', 'feed', 'enabled', 'phase', 'live', 'down', 'message', 'stats', 'viewers', 'watchUrl', 'recoveries', 'lastRecovery', 'since'],
          properties: {
            id: str,
            name: str,
            platform: ref('Platform'),
            feed: { enum: ['landscape', 'vertical'] },
            enabled: bool,
            phase: { enum: PHASES },
            live: bool,
            down: { type: 'boolean', description: 'Session running, destination enabled (not skipped by test mode) and not reaching the platform (error, retrying, recovering, waiting-for-feed; also preparing/connecting/confirming during a retry, until live)' },
            message: nullable(str),
            stats: nullable({ type: 'object', properties: { bitrateKbps: num, fps: num, speed: num, uptimeSec: num } }),
            viewers: { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }], description: 'null when unknown' },
            watchUrl: nullable(str),
            recoveries: int,
            lastRecovery: nullable({ type: 'object', properties: { at: isoTime, reason: str } }),
            since: isoTime,
          },
        },
        PlatformRollup: {
          type: 'object',
          required: ['platform', 'destinations', 'live', 'title', 'startedAt', 'viewers', 'error'],
          properties: {
            platform: ref('Platform'),
            destinations: { type: 'array', items: str },
            live: bool,
            title: str,
            startedAt: nullable(epochMs),
            viewers: nullable(int),
            error: nullable(str),
          },
        },
        Status: {
          type: 'object',
          required: ['session', 'feeds', 'destinations', 'platforms'],
          properties: {
            session: ref('Session'),
            feeds: { type: 'array', items: ref('Feed') },
            destinations: { type: 'array', items: ref('Destination') },
            platforms: { type: 'array', items: ref('PlatformRollup') },
          },
        },
        Envelope: {
          type: 'object',
          required: ['id', 'type', 'ts', 'src', 'data'],
          properties: {
            id: ref('Ulid'),
            type: { enum: [...EVENT_TYPES] },
            ts: epochMs,
            src: {
              type: 'object',
              properties: {
                connector: { const: 'ctd-multi-stream' },
                connection: { type: 'string', description: 'Destination id, or core' },
                platform: { enum: [...PLATFORM_IDS, 'core'] },
                profile: { ...nullable(str), description: 'Profile the event belongs to; null for events about no single profile' },
              },
            },
            data: {
              description: 'Depends on type',
              oneOf: [
                ref('ChatMessage'),
                ref('ChatMessageDeleted'),
                ref('ChatUserCleared'),
                ref('ChatCleared'),
                ref('Alert'),
                ref('Session'),
                ref('Feed'),
                ref('Destination'),
                ref('DestinationDown'),
                ref('DestinationUp'),
                ref('Notice'),
                ref('Profile'),
                ref('AppsChanged'),
                ref('AppMessage'),
                { type: 'object', maxProperties: 0, description: 'system.reset, profiles.changed' },
              ],
            },
          },
        },
        ChatFragment: {
          type: 'object',
          required: ['type', 'text'],
          properties: {
            type: { enum: ['text', 'emote', 'mention', 'link', 'cheermote'], description: 'mention is reserved (not sent yet); treat unknown types as text' },
            text: str,
            image: str,
            animated: bool,
            url: str,
            userId: str,
            amount: { type: 'number', description: 'cheermote fragments (Twitch cheers): the bits it stands for' },
          },
        },
        ChatMessage: {
          type: 'object',
          required: ['id', 'platform', 'channel', 'destinationId', 'platformMessageId', 'user', 'text', 'fragments', 'reply', 'highlighted', 'action', 'kind', 'join', 'ts'],
          properties: {
            id: { type: 'string', description: 'Stable, platform-prefixed: use it to apply deletions' },
            platform: ref('Platform'),
            channel: { type: 'string', description: 'Destination name' },
            destinationId: str,
            platformMessageId: nullable(str),
            user: {
              type: 'object',
              required: ['id', 'login', 'name', 'color', 'avatar', 'badges', 'roles'],
              properties: {
                id: { type: 'string', description: '<platform>:<id>, or <platform>:name:<display name>' },
                login: nullable(str),
                name: str,
                color: nullable({ type: 'string', pattern: '^#[0-9A-F]{6}$' }),
                avatar: nullable({ type: 'string', description: 'https URL' }),
                badges: { type: 'array', items: { type: 'object', properties: { id: str, label: str } } },
                roles: { type: 'array', items: { enum: [...API_ROLES] } },
              },
            },
            text: str,
            fragments: { type: 'array', items: ref('ChatFragment'), description: 'Joining every text equals `text`' },
            reply: nullable({ type: 'object', properties: { messageId: nullable(str), userName: nullable(str), text: nullable(str) } }),
            highlighted: bool,
            action: bool,
            kind: { enum: ['message', 'event'] },
            join: { type: 'boolean', description: 'v1.3: a "<name> joined" presence line (Instagram, TikTok), not a comment; always with kind "event"' },
            ts: epochMs,
          },
        },
        ChatMessageDeleted: {
          type: 'object',
          properties: {
            messageId: { type: 'string', description: 'The deleted message’s `id` (platform-prefixed)' },
            platformMessageId: str,
            platform: ref('Platform'),
            destinationId: str,
          },
        },
        ChatUserCleared: {
          type: 'object',
          properties: { userId: nullable(str), userName: nullable(str), platform: ref('Platform'), destinationId: str },
        },
        ChatCleared: { type: 'object', properties: { platform: ref('Platform'), destinationId: str } },
        Alert: {
          type: 'object',
          description:
            'alert.<kind> data: the CTD Overlay alert payload plus its source. Fields that don’t apply are omitted. Also sent as a chat.message (kind "event") with messageId.',
          required: ['kind', 'user', 'platform', 'destinationId', 'messageId', 'ts'],
          properties: {
            kind: { enum: [...ALERT_KINDS] },
            user: {
              type: 'object',
              required: ['name'],
              properties: {
                id: { type: 'string', description: 'Same form as chat.message user.id; absent for anonymous users' },
                name: str,
                avatar: { type: 'string', description: 'https URL' },
                anonymous: { const: true },
              },
            },
            amount: {
              oneOf: [
                {
                  type: 'object',
                  required: ['unit', 'value'],
                  properties: { unit: { enum: [...ALERT_COUNT_UNITS] }, value: { type: 'integer', minimum: 0 } },
                },
                {
                  type: 'object',
                  required: ['unit', 'value', 'currency'],
                  properties: {
                    unit: { const: 'currency' },
                    value: { type: 'string', pattern: DECIMAL_RE.source, description: 'Decimal string, never a float' },
                    currency: { type: 'string', pattern: CURRENCY_RE.source, description: 'ISO 4217' },
                  },
                },
              ],
            },
            tier: str,
            message: { type: 'object', required: ['text'], properties: { text: str } },
            gift: nullable({ type: 'object', properties: { recipients: { type: 'array', items: str }, total: { type: 'integer', minimum: 0 } } }),
            platform: ref('Platform'),
            destinationId: str,
            messageId: { type: 'string', description: 'id of the chat.message that carried the alert' },
            ts: epochMs,
          },
        },
        DestinationDown: {
          type: 'object',
          properties: { destinationId: str, name: str, platform: ref('Platform'), phase: { enum: PHASES }, reason: nullable(str) },
        },
        DestinationUp: {
          type: 'object',
          properties: { destinationId: str, name: str, platform: ref('Platform'), downForSec: int, recoveries: int },
        },
        Notice: { type: 'object', properties: { level: { enum: ['info', 'warn', 'error'] }, message: str } },
        ChatResponse: {
          type: 'object',
          required: ['items', 'next'],
          properties: { items: { type: 'array', items: ref('Envelope') }, next: ref('Ulid') },
        },
        PollResponse: {
          type: 'object',
          required: ['items', 'next', 'reset'],
          properties: {
            items: { type: 'array', items: ref('Envelope') },
            next: ref('Ulid'),
            reset: {
              type: 'boolean',
              description: 'An event you would receive (by `types`, scopes and profile) after `after` has left the buffer, or `after` is from before a restart: refetch /status and /chat',
            },
          },
        },
        Profile: {
          type: 'object',
          description: 'A profile and its live situation (also the data of profile.status events)',
          required: ['id', 'name', 'slug', 'color', 'status', 'startedAt', 'testMode', 'destinations', 'live', 'down', 'createdAt', 'updatedAt'],
          properties: {
            id: str,
            name: str,
            slug: { type: 'string', description: 'Fixed at creation; OBS stream key prefix of non-default profiles' },
            color: nullable({ type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }),
            status: { enum: ['offline', 'starting', 'live', 'stopping'] },
            startedAt: nullable(isoTime),
            testMode: bool,
            destinations: { type: 'integer', description: 'Enabled destinations' },
            live: { type: 'integer', description: 'Destinations live right now' },
            down: { type: 'integer', description: 'Destinations down right now (see Destination.down)' },
            createdAt: isoTime,
            updatedAt: isoTime,
          },
        },
        ProfilesResponse: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('Profile') } } },
        ObsStateResponse: {
          type: 'object',
          required: ['apps'],
          properties: {
            apps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  appId: str,
                  online: bool,
                  updatedAt: { ...num, description: 'Epoch ms of the latest event' },
                  feeds: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        source: str,
                        state: { description: 'CONNECTING | LIVE | STALLED | RECONNECTING | NO_SIGNAL (as the plugin sent it)' },
                        previous: {},
                        gapMs: {},
                        stats: nullable({ type: 'object', description: 'Latest obs.feed.stats data' }),
                        info: nullable({ type: 'object', description: 'The source object as sent (name, path, server…)' }),
                        updatedAt: num,
                      },
                    },
                  },
                  outputs: { type: 'array', items: { type: 'object', description: 'Latest obs.output data per output, plus updatedAt' } },
                  scenes: { type: 'array', items: { type: 'object', properties: { canvas: str, scene: {}, updatedAt: num } } },
                  issues: {
                    type: 'array',
                    description: 'Open issues (obs.issue.raised not cleared yet)',
                    items: { type: 'object', properties: { id: str, rule: str, severity: { enum: ['info', 'warning', 'critical'] }, source: str, title: str, firstSeen: num, updatedAt: num } },
                  },
                },
              },
            },
          },
        },
        Clock: {
          type: 'object',
          required: ['t0', 'receivedAt', 'sentAt', 'iso', 'utcOffsetMinutes', 'profileId', 'session', 'fps', 'fpsSource', 'timecode'],
          properties: {
            t0: nullable({ ...num, description: 'Your t0 echoed back' }),
            receivedAt: { ...num, description: 'Server time the request arrived, epoch ms' },
            sentAt: { ...num, description: 'Server time the reply was built, epoch ms' },
            iso: isoTime,
            utcOffsetMinutes: { ...int, description: "Server's local time zone offset from UTC" },
            profileId: str,
            session: {
              type: 'object',
              properties: {
                status: { enum: ['offline', 'starting', 'live', 'stopping'] },
                startedAt: nullable(epochMs),
                elapsedMs: nullable({ ...num, description: 'Run time at sentAt' }),
              },
            },
            fps: { ...int, description: 'Nominal frame rate of the timecodes (non-drop-frame)' },
            fpsSource: { enum: ['landscape', 'vertical', 'default'] },
            timecode: {
              type: 'object',
              properties: {
                run: nullable({ type: 'string', description: 'Session run time HH:MM:SS:FF; null when offline' }),
                utc: { type: 'string', description: 'Time of day in UTC, HH:MM:SS:FF' },
                local: { type: 'string', description: "Time of day in the server's time zone, HH:MM:SS:FF" },
              },
            },
          },
        },
        Ingest: {
          type: 'object',
          required: ['profileId', 'serverUrl', 'feeds'],
          properties: {
            profileId: str,
            serverUrl: { type: 'string', description: 'OBS Settings → Stream → Server, e.g. rtmp://192.168.1.50:1936/live' },
            feeds: {
              type: 'array',
              items: {
                type: 'object',
                required: ['feed', 'streamKey', 'fullUrl'],
                properties: {
                  feed: { enum: ['landscape', 'vertical'] },
                  streamKey: { type: 'string', description: 'OBS Stream Key field (secret)' },
                  fullUrl: { type: 'string', description: 'serverUrl + "/" + streamKey (secret)' },
                },
              },
            },
          },
        },
        AppResource: {
          type: 'object',
          required: ['type', 'id', 'name', 'profileId'],
          properties: {
            type: { type: 'string', pattern: RESOURCE_TYPE_RE.source, description: '"overlay" (a browser-source URL) or an app-defined type' },
            id: { type: 'string', maxLength: 100, description: 'Unique within the app' },
            name: { type: 'string', maxLength: 120 },
            profileId: { ...nullable(str), description: 'Profile it is assigned to; null = not assigned / every profile' },
            url: { type: 'string', description: 'http(s); required for overlays' },
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
            meta: {
              type: 'object',
              description: `Free-form, ≤ ${MAX_META_BYTES} bytes of JSON. Overlays: canvas ("landscape" | "vertical"), fps (number), transparent (boolean), slot (stable role key shared by the equivalent overlay of every profile)`,
            },
          },
        },
        AppRegistration: {
          type: 'object',
          required: ['name', 'kind'],
          properties: {
            name: { type: 'string', maxLength: 80 },
            kind: { type: 'string', pattern: APP_KIND_RE.source, description: 'ctd-overlay, ctd-obs-plugin, custom…' },
            version: nullable({ type: 'string', maxLength: 40 }),
            baseUrl: nullable({ type: 'string', description: 'http(s) address of the app itself' }),
            capabilities: { type: 'array', maxItems: MAX_CAPABILITIES, items: { type: 'string', pattern: CAPABILITY_RE.source } },
            resources: { type: 'array', maxItems: MAX_RESOURCES, items: ref('AppResource') },
          },
        },
        ConnectedApp: {
          type: 'object',
          required: ['id', 'name', 'kind', 'version', 'baseUrl', 'capabilities', 'resources', 'profileId', 'registeredAt', 'lastSeenAt', 'online'],
          properties: {
            id: { type: 'string', pattern: APP_ID_RE.source },
            name: str,
            kind: str,
            version: nullable(str),
            baseUrl: nullable(str),
            capabilities: { type: 'array', items: str },
            resources: { type: 'array', items: ref('AppResource') },
            profileId: { ...nullable(str), description: 'Profile of the token that registered it; null = every profile' },
            registeredAt: isoTime,
            lastSeenAt: isoTime,
            online: { type: 'boolean', description: 'Seen in the last 90 s' },
          },
        },
        AppsResponse: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('ConnectedApp') } } },
        AppsChanged: { type: 'object', required: ['apps'], properties: { apps: { type: 'array', items: ref('ConnectedApp') } } },
        Overlay: {
          type: 'object',
          required: ['appId', 'appName', 'appOnline', 'id', 'name'],
          properties: {
            appId: str,
            appName: str,
            appOnline: bool,
            id: str,
            name: str,
            url: str,
            width: int,
            height: int,
            meta: { type: 'object', description: 'The resource’s meta (canvas, fps, transparent, slot…)' },
          },
        },
        OverlaysResponse: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('Overlay') } } },
        MessageRequest: {
          type: 'object',
          required: ['to', 'type'],
          properties: {
            to: { ...nullable({ type: 'string', pattern: APP_ID_RE.source }), description: 'Recipient app id; null = every app' },
            type: { type: 'string', pattern: MESSAGE_TYPE_RE.source },
            profileId: { ...nullable(str), description: 'Profile it concerns (default: the token’s profile, or null)' },
            replyTo: { ...nullable(ref('Ulid')), description: 'id of the message this answers' },
            data: { type: 'object', description: `≤ ${MESSAGE_DATA_MAX_BYTES / 1024} KB of JSON` },
            from: { ...nullable({ type: 'string', pattern: APP_ID_RE.source }), description: 'Which of your registered apps sends it (omitted or null: the one seen most recently)' },
          },
        },
        AppMessage: {
          type: 'object',
          description: 'app.message data',
          required: ['id', 'from', 'to', 'type', 'profileId', 'replyTo', 'data', 'ts'],
          properties: {
            id: ref('Ulid'),
            from: nullable(str),
            to: nullable(str),
            type: str,
            profileId: nullable(str),
            replyTo: nullable(ref('Ulid')),
            data: { type: 'object' },
            ts: epochMs,
          },
        },
        PairingRequest: {
          type: 'object',
          required: ['appName', 'kind', 'scopes'],
          properties: {
            appName: { type: 'string', maxLength: 60 },
            kind: { type: 'string', pattern: APP_KIND_RE.source },
            scopes: { type: 'array', minItems: 1, items: {}, description: 'Scopes it asks for (see Scope); entries this server does not know are ignored' },
            profileId: { ...nullable(str), description: 'Profile it asks for (the admin decides)' },
          },
        },
        PairingStarted: {
          type: 'object',
          required: ['pairingId', 'pollSecret', 'code', 'expiresIn', 'interval', 'approveUrl'],
          properties: {
            pairingId: str,
            pollSecret: { type: 'string', description: 'Secret: send it when polling, never show it' },
            code: { type: 'string', pattern: PAIRING_CODE_RE.source, description: 'Show it to the user' },
            expiresIn: { type: 'integer', description: `Seconds (${PAIRING_TTL_MS / 1000})` },
            interval: { type: 'integer', description: `Seconds between polls (${PAIRING_POLL_INTERVAL_SEC})` },
            approveUrl: { type: 'string', description: 'Where the admin approves it (Settings → API)' },
          },
        },
        PairingApproved: {
          type: 'object',
          required: ['status', 'token', 'profileId', 'scopes'],
          properties: {
            status: { const: 'approved' },
            token: { type: 'string', description: 'ctd_pat_… (returned once; store it)' },
            profileId: nullable(str),
            scopes: { type: 'array', items: ref('Scope') },
          },
        },
      },
    },
  };
}
