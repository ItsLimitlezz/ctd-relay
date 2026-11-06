// OpenAPI paths and schemas of the show-profile routes (v1.9, v1-show.ts), merged into openapi.ts.

import { BLOB_KINDS, DEFAULT_BLOB_LIMITS } from '../storage/blob-store.js';
import { MAX_CHECK_ITEMS, MAX_SECRETS, MAX_UPLOADS_PER_TOKEN, NOTE_MAX, SHOW_MANIFEST_SCHEMAS } from './v1-show.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema: object) => ({ oneOf: [schema, { type: 'null' }] });
const str = { type: 'string' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const isoTime = { type: 'string', format: 'date-time' };
const sha256 = { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Lowercase hex SHA-256' };
const json = (schema: object) => ({ 'application/json': { schema } });
const problem = (description: string) => ({ description, content: { 'application/problem+json': { schema: ref('Problem') } } });

const MB = 1024 * 1024;
const L = DEFAULT_BLOB_LIMITS;
const LIMITS_TEXT = `Default limits: LUT ${L.lutBytes / MB} MB, image ${L.imageBytes / MB} MB, video/audio ${L.mediaBytes / MB / 1024} GB, other ${L.otherBytes / MB} MB, bundle ${L.bundleBytes / MB} MB, manifest ${L.manifestBytes / MB} MB, total quota ${L.quotaBytes / MB / 1024} GB, ${L.maxRevisions} revisions per show profile (plus pinned ones).`;

export function showPaths(common: { errors: object; profileErrors: object; idPath: object }): Record<string, unknown> {
  const { errors, profileErrors, idPath } = common;
  const revPath = { name: 'rev', in: 'path', required: true, description: 'Revision number', schema: { type: 'integer', minimum: 1 } };
  const shaPath = { name: 'sha256', in: 'path', required: true, schema: sha256 };
  const notFound = problem('No show profile yet, or no such revision (`not_found`)');
  const download = {
    description: 'The bytes (`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `ETag` = the hash)',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
  };
  return {
    '/profiles/{id}/show': {
      get: {
        summary: 'The show profile of a Relay profile (v1.9)',
        operationId: 'getShowProfile',
        tags: ['show'],
        description: 'Needs `show:read`. Each Relay profile has at most one show profile; 404 `not_found` before the first save.',
        parameters: [idPath],
        responses: { '200': { description: 'Show profile', content: json(ref('ShowProfile')) }, ...errors, ...profileErrors, '404': notFound },
      },
    },
    '/profiles/{id}/show/revisions': {
      get: {
        summary: 'Revision history, newest first (v1.9)',
        operationId: 'listShowRevisions',
        tags: ['show'],
        description: `Needs \`show:read\`. ${LIMITS_TEXT}`,
        parameters: [idPath],
        responses: {
          '200': {
            description: 'Revisions',
            content: json({ type: 'object', required: ['items', 'head'], properties: { items: { type: 'array', items: ref('ShowRevision') }, head: int } }),
          },
          ...errors,
          ...profileErrors,
          '404': notFound,
        },
      },
      post: {
        summary: 'Save a new revision (v1.9)',
        operationId: 'saveShowRevision',
        tags: ['show'],
        description: `Needs \`show:write\`. Upload the bundle and every asset first (POST /blobs/check, PUT /blobs/{sha256}). \`parentRevision\` is the head you built on: 0 for the first save (creates the show profile). Manifest schemas read: ${SHOW_MANIFEST_SCHEMAS.join(', ')}. \`secrets\` (at most ${MAX_SECRETS}) are the values behind the manifest's \`secrets[]\`, stored encrypted and returned only to \`show:secrets\` tokens. Emits \`show.changed\`.`,
        parameters: [idPath],
        requestBody: { required: true, content: json(ref('ShowSave')) },
        responses: {
          '201': { description: 'Saved', content: json(ref('ShowRevision')) },
          '400': problem('Invalid body or manifest (`invalid`), or blobs not uploaded yet (`missing_blobs`, with `missing: [sha256]`)'),
          '409': problem('`parentRevision` is not the head (`revision_conflict`, with `head`): load the head, merge, save again'),
          '413': problem('Manifest or bundle over its limit (`limit`)'),
          ...errors,
          ...profileErrors,
        },
      },
    },
    '/profiles/{id}/show/revisions/{rev}': {
      get: {
        summary: 'One revision with its manifest (v1.9)',
        operationId: 'getShowRevision',
        tags: ['show'],
        description: 'Needs `show:read`.',
        parameters: [idPath, revPath],
        responses: { '200': { description: 'Revision', content: json(ref('ShowRevisionWithManifest')) }, ...errors, ...profileErrors, '404': notFound },
      },
    },
    '/profiles/{id}/show/revisions/{rev}/bundle': {
      get: {
        summary: "A revision's bundle: its JSON files as one tar (v1.9)",
        operationId: 'getShowBundle',
        tags: ['show'],
        description: 'Needs `show:read`. Byte-identical to `bundleSha256`: secrets stay placeholders (`${ctd-secret}`); fetch them from …/secrets. Supports `Range`.',
        parameters: [idPath, revPath],
        responses: { '200': download, '206': download, '416': { description: 'Range not satisfiable' }, ...errors, ...profileErrors, '404': notFound },
      },
    },
    '/profiles/{id}/show/revisions/{rev}/secrets': {
      get: {
        summary: "A revision's secrets (v1.9)",
        operationId: 'getShowSecrets',
        tags: ['show'],
        description: 'Needs `show:secrets` (granted per machine by the admin). Audited. Without the scope, the dock lists the sources as "needs re-entry".',
        parameters: [idPath, revPath],
        responses: {
          '200': { description: 'Secrets', content: json({ type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('ShowSecret') } } }) },
          ...errors,
          ...profileErrors,
          '404': notFound,
        },
      },
    },
    '/blobs/check': {
      post: {
        summary: 'Which blobs still need uploading (v1.9)',
        operationId: 'checkBlobs',
        tags: ['show'],
        description: `Needs \`show:write\`. At most ${MAX_CHECK_ITEMS} items. A profile-limited token is told "missing" for blobs it can't see, so the answer never reveals what other profiles hold; the upload then deduplicates on the server.`,
        requestBody: {
          required: true,
          content: json({
            type: 'object',
            required: ['items'],
            properties: { items: { type: 'array', maxItems: MAX_CHECK_ITEMS, items: { type: 'object', required: ['sha256', 'size'], properties: { sha256, size: int } } } },
          }),
        },
        responses: {
          '200': { description: 'Missing hashes', content: json({ type: 'object', required: ['missing'], properties: { missing: { type: 'array', items: sha256 } } }) },
          '400': problem('Invalid body (`invalid`)'),
          '403': problem('Token lacks `show:write` (`missing_scope`)'),
          ...errors,
        },
      },
    },
    '/blobs/{sha256}': {
      put: {
        summary: 'Upload a blob (v1.9)',
        operationId: 'putBlob',
        tags: ['show'],
        description: `Needs \`show:write\`. Raw body (\`application/octet-stream\`), streamed to disk; the path is its SHA-256. \`?kind=\` sets the limit and the content check (\`.cube\` must be a text LUT, \`.png\` must be a PNG; executables are refused). At most ${MAX_UPLOADS_PER_TOKEN} uploads per token at once. ${LIMITS_TEXT}`,
        parameters: [shaPath, { name: 'kind', in: 'query', schema: { enum: [...BLOB_KINDS], default: 'other' } }],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: {
          '200': { description: 'Already stored (the upload was verified)', content: json(ref('BlobStored')) },
          '201': { description: 'Stored', content: json(ref('BlobStored')) },
          '400': problem('The body does not match the hash (`hash_mismatch`), or a bad hash/kind (`invalid`)'),
          '403': problem('Token lacks `show:write` (`missing_scope`)'),
          '413': problem('Over the kind limit (`limit`) or the storage quota (`quota_exceeded`)'),
          '415': problem('The content does not fit the kind (`invalid`)'),
          ...errors,
        },
      },
      get: {
        summary: 'Download a blob (v1.9)',
        operationId: 'getBlob',
        tags: ['show'],
        description:
          'Needs `show:read`. Only when a revision or library entry visible to the token references the blob (or the token uploaded it); otherwise 404, the same as for a hash that does not exist. Supports `Range` (one range).',
        parameters: [shaPath],
        responses: { '200': download, '206': download, '304': { description: 'Not modified (If-None-Match)' }, '404': problem('No such blob (`not_found`)'), '416': { description: 'Range not satisfiable' }, ...errors },
      },
    },
    '/library': {
      get: {
        summary: 'Asset library entries (uploaded on the web Assets page; v1.9)',
        operationId: 'listLibrary',
        tags: ['show'],
        description:
          'Needs `show:read`. Entries for every profile plus those assigned to `?profile=` (a profile-limited token: its own profile). Without `?profile=`, an every-profile token gets every entry. Download with GET /blobs/{sha256}. Changes emit `library.changed`.',
        parameters: [
          { name: 'profile', in: 'query', schema: str },
          { name: 'kind', in: 'query', schema: { enum: [...BLOB_KINDS] } },
        ],
        responses: {
          '200': { description: 'Entries', content: json({ type: 'object', required: ['items'], properties: { items: { type: 'array', items: ref('LibraryAsset') } } }) },
          ...errors,
          ...profileErrors,
        },
      },
    },
  };
}

export function showSchemas(): Record<string, unknown> {
  const savedBy = { type: 'object', required: ['appId'], properties: { appId: nullable(str) } };
  const revision = {
    profileId: str,
    revision: int,
    parentRevision: nullable(int),
    bundleSha256: sha256,
    size: { type: 'integer', description: 'Bundle plus every asset it references, in bytes' },
    savedBy,
    note: nullable(str),
    pinned: bool,
    savedAt: isoTime,
  };
  const revisionRequired = ['profileId', 'revision', 'parentRevision', 'bundleSha256', 'size', 'savedBy', 'note', 'pinned', 'savedAt'];
  return {
    ShowSummary: {
      type: 'object',
      description: 'Profile.show (GET /profiles, /profiles/{id}; v1.9)',
      required: ['headRevision', 'updatedAt', 'savedBy'],
      properties: { headRevision: int, updatedAt: isoTime, savedBy },
    },
    ShowProfile: {
      type: 'object',
      required: ['id', 'profileId', 'name', 'headRevision', 'createdAt', 'updatedAt', 'savedBy'],
      properties: { id: str, profileId: str, name: str, headRevision: int, createdAt: isoTime, updatedAt: isoTime, savedBy },
    },
    ShowRevision: { type: 'object', required: revisionRequired, properties: revision },
    ShowRevisionWithManifest: {
      type: 'object',
      required: [...revisionRequired, 'manifest'],
      properties: { ...revision, manifest: { type: 'object', description: 'The manifest as saved (schema 1, see docs/API.md §14)' } },
    },
    ShowSave: {
      type: 'object',
      required: ['parentRevision', 'manifest', 'bundleSha256'],
      properties: {
        parentRevision: { type: 'integer', minimum: 0 },
        manifest: { type: 'object', required: ['schema', 'name'], properties: { schema: { enum: [...SHOW_MANIFEST_SCHEMAS] }, name: str } },
        bundleSha256: sha256,
        note: { ...nullable({ type: 'string', maxLength: NOTE_MAX }) },
        secrets: { type: 'array', maxItems: MAX_SECRETS, items: ref('ShowSecret') },
      },
    },
    ShowSecret: { type: 'object', required: ['source', 'key', 'value'], properties: { source: str, key: str, value: str } },
    ShowChanged: {
      type: 'object',
      description: 'show.changed data (v1.9)',
      required: ['profileId', 'revision', 'parentRevision', 'byAppId'],
      properties: { profileId: str, revision: int, parentRevision: nullable(int), byAppId: nullable(str) },
    },
    BlobStored: {
      type: 'object',
      required: ['sha256', 'size', 'kind', 'created'],
      properties: { sha256, size: int, kind: { enum: [...BLOB_KINDS] }, created: bool },
    },
    LibraryAsset: {
      type: 'object',
      required: ['id', 'sha256', 'name', 'kind', 'profileId', 'size', 'createdAt'],
      properties: { id: str, sha256, name: str, kind: str, profileId: { ...nullable(str), description: 'null = every profile' }, size: int, createdAt: isoTime },
    },
  };
}
