// Pure helpers for the Assets page (pages/AssetsPage.tsx).

import type { AssetItem, AssetKind, AssetUsage } from '@shared/api';

/** What the drop zone and file picker accept in this first version. */
export const ACCEPTED_EXTENSIONS: readonly string[] = ['.cube', '.png'];
export const ASSET_NAME_MAX = 100;

export const KIND_LABEL: Record<AssetKind, string> = {
  lut: 'LUT',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  font: 'Font',
  html: 'HTML',
  other: 'Other',
};

export function fileExtension(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i <= 0 ? '' : fileName.slice(i).toLowerCase();
}

export function isAcceptedFile(fileName: string): boolean {
  return ACCEPTED_EXTENSIONS.includes(fileExtension(fileName));
}

/** `.cube` and `.png` are LUTs by default (a PNG can also be filed as an image). */
export function defaultKind(fileName: string): AssetKind {
  return isAcceptedFile(fileName) ? 'lut' : 'other';
}

/** "Warm Look.cube" -> "Warm Look" (capped to the server's limit). */
export function defaultAssetName(fileName: string): string {
  const ext = fileExtension(fileName);
  const base = ext ? fileName.slice(0, fileName.length - ext.length) : fileName;
  return base.trim().slice(0, ASSET_NAME_MAX);
}

export function validateAssetName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give it a name';
  if (n.length > ASSET_NAME_MAX) return `At most ${ASSET_NAME_MAX} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(n)) return 'No control characters';
  return null;
}

/** 0 -> "0 B", 1536 -> "1.5 KB", 5_242_880 -> "5 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : Number(v.toFixed(v >= 10 ? 0 : 1))} ${units[i]}`;
}

/** "Used by Club night rev 3 (current), Main rev 1" ('' when unused). */
export function usageText(usage: readonly AssetUsage[], profileName: (id: string) => string): string {
  if (usage.length === 0) return '';
  const parts = usage.map((u) => `${profileName(u.profileId)} rev ${u.revision}${u.isHead ? ' (current)' : ''}`);
  return `Used by ${parts.join(', ')}`;
}

/** Why an asset can't be deleted, or null. */
export function deleteBlockedReason(asset: Pick<AssetItem, 'usage'>, profileName: (id: string) => string): string | null {
  const heads = asset.usage.filter((u) => u.isHead);
  if (heads.length === 0) return null;
  const names = [...new Set(heads.map((u) => profileName(u.profileId)))].join(', ');
  return `In use by the current show set-up of ${names}. Save a new revision without it first.`;
}

/** Used of quota as a short line, "12 MB of 2 GB used". */
export function storageLine(usedBytes: number, quotaBytes: number): string {
  return quotaBytes > 0 ? `${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used` : `${formatBytes(usedBytes)} used`;
}
