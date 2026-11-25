// SRT status for API responses (docs/SRT.md): what the media server reports, or "off" when it has no SRT.

import { srtStatusOff, type SrtStatus } from '../../../shared/srt.js';
import type { MediaServer } from '../services.js';

export function srtStatusOf(media: Pick<MediaServer, 'srtStatus'>): SrtStatus {
  return media.srtStatus?.() ?? srtStatusOff('SRT is not available on this server.');
}
