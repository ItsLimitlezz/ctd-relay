import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssetItem, AssetsResponse } from '@shared/api';
import type { ProfileSummary } from '@shared/types';
import { defaultAssetName, defaultKind, deleteBlockedReason, formatBytes, isAcceptedFile, storageLine, usageText, validateAssetName } from '../state/assets';
import { AssetsView } from './AssetsPage';

const noop = () => undefined;
const asyncNoop = async () => undefined;

const club = { id: 'club', name: 'DPRTMNT' } as ProfileSummary;
const main = { id: 'default', name: 'Miami or Bust' } as ProfileSummary;

const item = (over: Partial<AssetItem>): AssetItem => ({
  id: 'a1',
  sha256: 'a'.repeat(64),
  name: 'Warm Look',
  kind: 'lut',
  profileId: null,
  size: 2048,
  uploadedBy: 'admin',
  createdAt: '2026-11-05T10:00:00Z',
  usage: [],
  ...over,
});

const data = (items: AssetItem[]): AssetsResponse => ({ items, usedBytes: 5 * 1024 * 1024, quotaBytes: 2 * 1024 ** 3 });

const render = (isAdmin: boolean, d: AssetsResponse | null) =>
  renderToStaticMarkup(<AssetsView isAdmin={isAdmin} profiles={[main, club]} data={d} loadError={null} onReload={noop} onDelete={asyncNoop} />);

describe('AssetsView', () => {
  const list = data([item({}), item({ id: 'a2', name: 'Cold', profileId: 'club', size: 1536, usage: [{ profileId: 'club', revision: 3, isHead: true }] })]);

  it('shows admins the drop zone and delete buttons', () => {
    const html = render(true, list);
    expect(html).toContain('asset-dropzone');
    expect(html).toContain('Choose files');
    expect(html).toContain('aria-label="Delete Warm Look"');
    expect(html).toContain('accept=".cube,.png"');
  });

  it('shows operators the list only', () => {
    const html = render(false, list);
    expect(html).not.toContain('asset-dropzone');
    expect(html).not.toContain('Choose files');
    expect(html).not.toContain('Delete');
    expect(html).toContain('Warm Look');
    expect(html).toContain('Every profile');
    expect(html).toContain('DPRTMNT');
    expect(html).toContain('Used by DPRTMNT rev 3 (current)');
    expect(html).toContain('1.5 KB');
    expect(html).toContain('5 MB of 2 GB used');
  });

  it('disables delete with a reason while a head revision uses the asset', () => {
    const html = render(true, list);
    const cold = html.slice(html.indexOf('Cold'));
    expect(cold).toMatch(/disabled=""[^>]*title="In use by the current show set-up of DPRTMNT|title="In use by the current show set-up of DPRTMNT[^>]*disabled=""/);
    const warm = html.slice(html.indexOf('Warm Look'), html.indexOf('Cold'));
    expect(warm).not.toContain('disabled=""');
  });

  it('shows an empty state and a loading state', () => {
    expect(render(true, data([]))).toContain('No assets yet');
    expect(render(false, null)).toContain('Loading assets');
  });
});

describe('asset helpers', () => {
  it('maps files to a default name and kind', () => {
    expect(defaultAssetName('Warm Look.cube')).toBe('Warm Look');
    expect(defaultAssetName('a.b.PNG')).toBe('a.b');
    expect(defaultKind('x.cube')).toBe('lut');
    expect(defaultKind('x.png')).toBe('lut');
    expect(isAcceptedFile('x.CUBE')).toBe(true);
    expect(isAcceptedFile('x.exe')).toBe(false);
  });

  it('validates names', () => {
    expect(validateAssetName('  ')).not.toBeNull();
    expect(validateAssetName('x'.repeat(101))).not.toBeNull();
    expect(validateAssetName('a\u0007')).not.toBeNull();
    expect(validateAssetName('Warm')).toBeNull();
  });

  it('formats sizes and storage', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
    expect(storageLine(1024, 0)).toBe('1 KB used');
  });

  it('words usage and the delete block', () => {
    const name = (id: string) => (id === 'club' ? 'DPRTMNT' : id);
    expect(usageText([], name)).toBe('');
    expect(usageText([{ profileId: 'club', revision: 2, isHead: false }, { profileId: 'club', revision: 3, isHead: true }], name)).toBe(
      'Used by DPRTMNT rev 2, DPRTMNT rev 3 (current)',
    );
    expect(deleteBlockedReason({ usage: [{ profileId: 'club', revision: 2, isHead: false }] }, name)).toBeNull();
    expect(deleteBlockedReason({ usage: [{ profileId: 'club', revision: 3, isHead: true }] }, name)).toContain('DPRTMNT');
  });
});
