// Pure helpers for the destination form: defaults, validation and request building.
// Everything platform-specific comes from PlatformInfo (fields, feeds, connect method).

import type { CreateDestinationRequest, TranscodeCapabilities, UpdateDestinationRequest } from '@shared/api';
import { isTranscoding, validateTranscodeProfile } from '@shared/transcode';
import type { Account, AccountStatus, Destination, Feed, FieldSpec, PlatformInfo, TranscodeProfile } from '@shared/types';
import { FEEDS, PLATFORM_IDS } from '@shared/types';
import {
  cleanValues,
  destinationFormValues,
  destinationSecretsSet,
  initialValues,
  isEmptyValue,
  validateValues,
  type FormErrors,
  type FormValues,
} from '../../components/dynamic-form';
import type { SelectOption } from '../../components/Select';
import { fieldForMessage } from '../settings/settings-helpers';
import { orientFor, transcodeChanged } from './transcode-form';

export const FEED_LABEL: Record<Feed, string> = { landscape: 'Landscape', vertical: 'Vertical' };
export const FEED_SOURCE: Record<Feed, string> = {
  landscape: 'OBS main output',
  vertical: 'Aitum Vertical plugin',
};

/** Same limit as the server. */
export const MAX_DESTINATION_NAME = 100;

export const ACCOUNT_STATUS_TEXT: Record<AccountStatus, string> = {
  connected: 'Connected',
  pending: 'Not connected',
  'needs-login': 'Needs login',
  error: 'Error',
};

export interface DestinationDraft {
  name: string;
  feed: Feed;
  /** '' = no account. */
  accountId: string;
  /** DynamicForm values for info.destinationFields. */
  values: FormValues;
  /** Remove the stored stream key on save (only when no new key was typed). */
  clearStreamKey: boolean;
  /** Transcoding profile (null = never set: the platform gets the feed as OBS sends it). */
  transcode: TranscodeProfile | null;
}

/** Position of a platform in the standard order (Twitch, YouTube, …, custom); unknown ids last. */
export function platformRank(id: string): number {
  const i = (PLATFORM_IDS as readonly string[]).indexOf(id);
  return i === -1 ? PLATFORM_IDS.length : i;
}

export function sortPlatforms<T extends { id: string }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => platformRank(a.id) - platformRank(b.id));
}

/** Accounts by platform order, then by label. */
export function sortAccounts(list: readonly Account[]): Account[] {
  return [...list].sort((a, b) => platformRank(a.platform) - platformRank(b.platform) || a.label.localeCompare(b.label));
}

export function groupByFeed(dests: readonly Destination[]): Record<Feed, Destination[]> {
  const out = Object.fromEntries(FEEDS.map((f) => [f, [] as Destination[]])) as Record<Feed, Destination[]>;
  for (const d of dests) (out[d.feed] ?? out.landscape).push(d);
  return out;
}

export function feedOptions(info: PlatformInfo): SelectOption[] {
  return FEEDS.filter((f) => info.feeds.includes(f)).map((f) => ({ value: f, label: `${FEED_LABEL[f]} (${FEED_SOURCE[f]})` }));
}

export function defaultFeed(info: PlatformInfo): Feed {
  if (info.feeds.includes(info.defaultFeed)) return info.defaultFeed;
  return info.feeds[0] ?? 'landscape';
}

/** "Vertical only" style hint when a platform accepts a single feed. */
export function feedRestriction(info: PlatformInfo): string | null {
  if (info.feeds.length !== 1) return null;
  const only = info.feeds[0];
  return only ? `${info.name} only accepts the ${FEED_LABEL[only].toLowerCase()} feed.` : null;
}

export const usesAccounts = (info: PlatformInfo): boolean => info.connectMethod !== 'none';

export function platformAccounts(accounts: readonly Account[], platform: string): Account[] {
  return accounts.filter((a) => a.platform === platform);
}

export function accountOptions(accounts: readonly Account[], platform: string): SelectOption[] {
  return platformAccounts(accounts, platform).map((a) => ({
    value: a.id,
    label: a.status === 'connected' ? a.label : `${a.label} (${ACCOUNT_STATUS_TEXT[a.status].toLowerCase()})`,
  }));
}

/** Preselect the first connected account of the platform (else the first one, else none). */
export function defaultAccountId(accounts: readonly Account[], platform: string): string {
  const mine = platformAccounts(accounts, platform);
  return (mine.find((a) => a.status === 'connected') ?? mine[0])?.id ?? '';
}

export function streamKeyField(info: PlatformInfo): FieldSpec | undefined {
  return info.destinationFields.find((f) => f.target === 'streamKey');
}

export function initialDraft(info: PlatformInfo, accounts: readonly Account[], existing: Destination | null): DestinationDraft {
  if (existing) {
    return {
      name: existing.name,
      feed: existing.feed,
      accountId: existing.accountId ?? '',
      values: destinationFormValues(info.destinationFields, existing),
      clearStreamKey: false,
      transcode: existing.transcode ?? null,
    };
  }
  return {
    name: info.name,
    feed: defaultFeed(info),
    accountId: usesAccounts(info) ? defaultAccountId(accounts, info.id) : '',
    values: initialValues(info.destinationFields),
    clearStreamKey: false,
    transcode: null,
  };
}

/** Secret fields that count as "set" (the stored key, unless the user asked to remove it). */
export function draftSecretsSet(info: PlatformInfo, existing: Destination | null, draft: DestinationDraft): Record<string, boolean> {
  const set = destinationSecretsSet(info.destinationFields, existing);
  if (draft.clearStreamKey) for (const k of Object.keys(set)) set[k] = false;
  return set;
}

/** Form error key of the Transcoding section. */
export const TRANSCODE_ERROR_KEY = 'transcode';

/** The profile as it will be saved: its frame turned to match the chosen feed. */
export function draftTranscode(draft: DestinationDraft): TranscodeProfile | null {
  return draft.transcode ? orientFor(draft.transcode, draft.feed) : null;
}

export function validateDraft(
  info: PlatformInfo,
  draft: DestinationDraft,
  secretsSet: Readonly<Record<string, boolean>>,
  caps: TranscodeCapabilities | null = null,
  feedFps: number | null = null,
): FormErrors {
  const errors: FormErrors = { ...validateValues(info.destinationFields, draft.values, secretsSet) };
  // Same checks as the server (platform limits; while it is switched on, a working encoder and the CPU guard).
  const transcode = draftTranscode(draft);
  if (transcode) {
    const problem = validateTranscodeProfile(transcode, info.id, info.name, isTranscoding(transcode) ? caps : null, feedFps)[0];
    if (problem) errors[TRANSCODE_ERROR_KEY] = problem;
  }
  // The server only accepts RTMP(S) server URLs (any URL is fine for plain 'url' option fields).
  for (const f of info.destinationFields) {
    const v = draft.values[f.key];
    if (f.target === 'ingestUrl' && !errors[f.key] && typeof v === 'string' && v.trim() && !/^rtmps?:\/\//i.test(v.trim())) {
      errors[f.key] = `${f.label} must start with rtmp:// or rtmps://`;
    }
  }
  const name = draft.name.trim();
  if (!name) errors.name = 'Give this destination a name.';
  else if (name.length > MAX_DESTINATION_NAME) errors.name = `Use at most ${MAX_DESTINATION_NAME} characters.`;
  if (!info.feeds.includes(draft.feed)) errors.feed = feedRestriction(info) ?? 'Choose a feed.';
  return errors;
}

/** Options, ingest URL and stream key from the form values (by each field's target). */
function splitValues(info: PlatformInfo, draft: DestinationDraft, forUpdate: boolean) {
  const fields = info.destinationFields;
  const clean = cleanValues(fields, draft.values);
  const options: Record<string, unknown> = {};
  let ingestUrl: string | null | undefined;
  let streamKey: string | undefined;
  for (const f of fields) {
    const v = clean[f.key];
    switch (f.target ?? 'option') {
      case 'option':
        if (v !== undefined) options[f.key] = v;
        // PATCH merges options with the stored ones: send null to clear a value.
        else if (forUpdate) options[f.key] = null;
        break;
      case 'ingestUrl':
        ingestUrl = typeof v === 'string' ? v : null;
        break;
      case 'streamKey':
        if (typeof v === 'string' && v) streamKey = v;
        break;
    }
  }
  return { options, ingestUrl, streamKey };
}

export function buildCreateRequest(info: PlatformInfo, draft: DestinationDraft): CreateDestinationRequest {
  const { options, ingestUrl, streamKey } = splitValues(info, draft, false);
  const req: CreateDestinationRequest = {
    platform: info.id,
    name: draft.name.trim(),
    feed: draft.feed,
    accountId: usesAccounts(info) && draft.accountId ? draft.accountId : null,
    enabled: true,
    options,
  };
  if (ingestUrl !== undefined) req.ingestUrl = ingestUrl;
  if (streamKey !== undefined) req.streamKey = streamKey;
  const transcode = draftTranscode(draft);
  if (transcode) req.transcode = transcode;
  return req;
}

/**
 * PATCH body. streamKey: absent = keep, new value = replace, '' = remove the stored key.
 * transcode: only sent when it differs from the stored profile (`existing`).
 */
export function buildUpdateRequest(info: PlatformInfo, draft: DestinationDraft, existing: Pick<Destination, 'transcode'> | null = null): UpdateDestinationRequest {
  const { options, ingestUrl, streamKey } = splitValues(info, draft, true);
  const req: UpdateDestinationRequest = {
    name: draft.name.trim(),
    feed: draft.feed,
    accountId: usesAccounts(info) && draft.accountId ? draft.accountId : null,
    options,
  };
  if (ingestUrl !== undefined) req.ingestUrl = ingestUrl;
  if (streamKey !== undefined) req.streamKey = streamKey;
  else if (draft.clearStreamKey) req.streamKey = '';
  const transcode = draftTranscode(draft);
  if (transcodeChanged(transcode, existing?.transcode)) req.transcode = transcode;
  return req;
}

/** Which form field a server validation message is about ('name', 'feed', 'accountId' or a field key). */
export function destinationErrorField(info: PlatformInfo, message: string): string | null {
  const labels: Record<string, string> = { name: 'Name', accountId: 'Account' };
  for (const f of info.destinationFields) labels[f.key] = f.label;
  if (/^Transcoding: /.test(message)) return TRANSCODE_ERROR_KEY;
  const byLabel = fieldForMessage(message, labels);
  if (byLabel) return byLabel;
  if (/does not accept the \w+ feed/i.test(message)) return 'feed';
  if (/account/i.test(message) && /not found|not a /i.test(message)) return 'accountId';
  if (/server url/i.test(message)) return info.destinationFields.find((f) => f.target === 'ingestUrl')?.key ?? null;
  if (/stream key/i.test(message)) return streamKeyField(info)?.key ?? null;
  return null;
}

/** Host of a non-secret RTMP server URL, for list display ("live.example.com"). */
export function ingestHostLabel(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** True when the destination is missing something it needs to go live (shown as a warning). */
export function destinationProblems(info: PlatformInfo | undefined, dest: Destination, account: Account | undefined): string[] {
  if (!info) return ['This platform is not available on this server.'];
  const problems: string[] = [];
  if (usesAccounts(info)) {
    if (!dest.accountId || !account) problems.push('No account linked');
    else if (account.status !== 'connected') problems.push(`Account ${ACCOUNT_STATUS_TEXT[account.status].toLowerCase()}`);
  }
  const keyField = streamKeyField(info);
  if (keyField?.required && !dest.hasStreamKey) problems.push('No stream key');
  for (const f of info.destinationFields) {
    if (!f.required || (f.target ?? 'option') !== 'option' || f.type === 'boolean') continue;
    if (isEmptyValue(dest.options[f.key])) problems.push(`${f.label} missing`);
  }
  const urlField = info.destinationFields.find((f) => f.target === 'ingestUrl');
  if (urlField?.required && !dest.ingestUrl) problems.push(`${urlField.label} missing`);
  return problems;
}
