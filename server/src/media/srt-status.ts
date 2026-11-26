// SRT status for API responses (docs/SRT.md): what the media server reports, or "off" when it has no SRT.

import { srtStatusOff, type SrtStatus } from '../../../shared/srt.js';
import { srtlaStatusOff, type SrtlaStatus } from '../../../shared/srtla.js';
import type { MediaServer } from '../services.js';

export function srtStatusOf(media: Pick<MediaServer, 'srtStatus'> | undefined): SrtStatus {
  return media?.srtStatus?.() ?? srtStatusOff('SRT is not available on this server.');
}

/** SRTLA status (docs/SRTLA.md): what the media server reports, or "off" when it has no SRTLA. */
export function srtlaStatusOf(media: Pick<MediaServer, 'srtlaStatus'> | undefined): SrtlaStatus {
  return media?.srtlaStatus?.() ?? srtlaStatusOff('SRTLA is not available on this server.');
}
