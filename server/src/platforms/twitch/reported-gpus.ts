// The GPU "Relay both feeds" describes to Twitch's Enhanced Broadcasting config service. Twitch only
// hands a configuration to clients with a supported encoding GPU. Relay always encodes on the CPU
// (x264), whichever GPU it reports.
//
// Probed live on 2026-11-04 (fake key, 4 tracks, 1080p60 + 1080x1920@60). Every accepted GPU got the same
// four tracks. The encoder type differs (Relay maps them all to x264), and so do the B-frames Relay
// follows: 3 for the NVIDIA cards checked, 2 for the AMD and Intel ones.
//   NVIDIA RTX 5090, 5080, 4090, 4080 SUPER, 4070, 4060, 3080, 3070   accepted (obs_nvenc_h264_tex)
//   NVIDIA RTX 3060                                                   accepted with a "not optimal" warning
//   AMD RX 9070 XT, 7900 XTX, 6800 XT                                 accepted (h264_texture_amf)
//   Intel Arc B580, A770, A380                                        accepted (obs_qsv11_v2)
//   NVIDIA RTX 2060, GTX 1660 SUPER, GTX 1060 6GB                     refused: "too few encodes (3)"
//   AMD RX 580                                                        refused: "not currently supported"
//   no GPU at all                                                     refused: "did not send GPU Information"
// PCI ids are from https://pci-ids.ucw.cz (2026-11-05). Models are named as Windows reports them,
// which is what OBS sends (frontend/utility/system-info-windows.cpp).

export interface ReportedGpu {
  model: string;
  vendor_id: number;
  device_id: number;
  dedicated_video_memory: number;
  shared_system_memory: number;
  driver_version: string;
}

export interface ReportedGpuPreset {
  id: string;
  label: string;
  gpu: ReportedGpu;
}

const GiB = 1024 ** 3;
const SHARED_MEMORY = 16 * GiB;
const NVIDIA = 0x10de;
const AMD = 0x1002;
const INTEL = 0x8086;
const NVIDIA_DRIVER = '32.0.15.7270';
const AMD_DRIVER = '32.0.21025.1024';
const INTEL_DRIVER = '32.0.101.6881';

function preset(id: string, label: string, model: string, vendorId: number, deviceId: number, vramGb: number, driver: string): ReportedGpuPreset {
  return {
    id,
    label,
    gpu: {
      model,
      vendor_id: vendorId,
      device_id: deviceId,
      dedicated_video_memory: vramGb * GiB,
      shared_system_memory: SHARED_MEMORY,
      driver_version: driver,
    },
  };
}

function nvidia(id: string, name: string, deviceId: number, vramGb: number, note = ''): ReportedGpuPreset {
  return preset(id, `NVIDIA ${name}${note}`, `NVIDIA GeForce ${name}`, NVIDIA, deviceId, vramGb, NVIDIA_DRIVER);
}

function radeon(id: string, name: string, deviceId: number, vramGb: number): ReportedGpuPreset {
  return preset(id, `AMD ${name}`, `AMD Radeon ${name}`, AMD, deviceId, vramGb, AMD_DRIVER);
}

function arc(id: string, name: string, deviceId: number, vramGb: number): ReportedGpuPreset {
  return preset(id, `Intel Arc ${name}`, `Intel(R) Arc(TM) ${name} Graphics`, INTEL, deviceId, vramGb, INTEL_DRIVER);
}

/** Only GPUs Twitch accepted in the probe above. Others can still be tried as a custom GPU. */
export const REPORTED_GPU_PRESETS: readonly ReportedGpuPreset[] = [
  nvidia('rtx-5090', 'RTX 5090', 0x2b85, 32),
  nvidia('rtx-5080', 'RTX 5080', 0x2c02, 16),
  nvidia('rtx-4090', 'RTX 4090', 0x2684, 24),
  nvidia('rtx-4080-super', 'RTX 4080 SUPER', 0x2702, 16),
  nvidia('rtx-4070', 'RTX 4070', 0x2786, 12),
  nvidia('rtx-4060', 'RTX 4060', 0x2882, 8),
  nvidia('rtx-3080', 'RTX 3080', 0x2206, 10),
  nvidia('rtx-3070', 'RTX 3070', 0x2484, 8),
  nvidia('rtx-3060', 'RTX 3060', 0x2503, 12, ' (Twitch warns it is not optimal)'),
  radeon('rx-9070-xt', 'RX 9070 XT', 0x7550, 16),
  radeon('rx-7900-xtx', 'RX 7900 XTX', 0x744c, 24),
  radeon('rx-6800-xt', 'RX 6800 XT', 0x73bf, 16),
  arc('arc-b580', 'B580', 0xe20b, 12),
  arc('arc-a770', 'A770', 0x56a0, 16),
  arc('arc-a380', 'A380', 0x56a5, 6),
];

export const DEFAULT_REPORTED_GPU_ID = 'rtx-5090';
export const CUSTOM_GPU_ID = 'custom';
export const CUSTOM_GPU_EXAMPLE = 'NVIDIA GeForce RTX 4090 | 10de | 2684 | 32.0.15.7270 | 24';

export function reportedGpuPreset(id: string): ReportedGpu | null {
  return REPORTED_GPU_PRESETS.find((p) => p.id === id)?.gpu ?? null;
}

/** The GPU reported unless the destination picks another one. */
export const DEFAULT_REPORTED_GPU: ReportedGpu = reportedGpuPreset(DEFAULT_REPORTED_GPU_ID)!;

const MODEL_RE = /^[\p{L}\p{N} ()._+/-]{1,100}$/u;
const PCI_ID_RE = /^(?:0x)?[0-9a-f]{1,4}$/i;
const DRIVER_RE = /^\d{1,6}(?:\.\d{1,6}){1,4}$/;
const DEFAULT_CUSTOM_VRAM_GB = 8;

/** `model | vendor id | device id | driver version | VRAM in GB (optional)`, ids in hex. */
export function parseCustomGpu(value: string): ReportedGpu | null {
  const parts = value.split('|').map((p) => p.trim());
  if (parts.length < 4 || parts.length > 5) return null;
  const [model, vendor, device, driver, vram] = parts as [string, string, string, string, string | undefined];
  if (!MODEL_RE.test(model) || !PCI_ID_RE.test(vendor) || !PCI_ID_RE.test(device) || !DRIVER_RE.test(driver)) return null;
  const vramGb = vram ? Number(vram) : DEFAULT_CUSTOM_VRAM_GB;
  if (!Number.isFinite(vramGb) || vramGb <= 0 || vramGb > 256) return null;
  return {
    model,
    vendor_id: Number.parseInt(vendor.replace(/^0x/i, ''), 16),
    device_id: Number.parseInt(device.replace(/^0x/i, ''), 16),
    dedicated_video_memory: Math.round(vramGb * GiB),
    shared_system_memory: SHARED_MEMORY,
    driver_version: driver,
  };
}
