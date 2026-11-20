// Writes a sample stream report (.xlsx, CSV zip and JSON) from a simulated stream, using the
// report test rig (server/src/reports/test-helpers.ts): an in-memory database, the real recorder,
// report math and export, a hand-driven clock. Every name is synthetic. No network, no platforms.
//
//   npx tsx scripts/report-sample.ts [out-dir]      (default: ./report-sample)
//
// The stream: 90 minutes on Twitch (Dual Format), YouTube (landscape + vertical), Kick, Instagram
// and TikTok; a title change, a Twitch takedown recovery, a YouTube vertical retry (with a key in the
// error, which must not reach the report), a short landscape feed drop, an HEVC block on TikTok,
// Kick viewers unknown for 5 minutes, Instagram joins with "and N others", Twitch presence.

import fs from 'node:fs';
import path from 'node:path';
import type { PlatformId } from '../shared/types.js';
import { normalizeChatMessage } from '../server/src/chat/normalize.js';
import { collect, exportBaseName, renderExport } from '../server/src/reports/export.js';
import { createRig } from '../server/src/reports/test-helpers.js';

const out = path.resolve(process.argv[2] ?? 'report-sample');
fs.mkdirSync(out, { recursive: true });

// Deterministic noise.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

const chatters: Record<PlatformId, string[]> = {
  twitch: Array.from({ length: 24 }, (_, i) => `tw_viewer_${i + 1}`),
  youtube: Array.from({ length: 12 }, (_, i) => `YT Viewer ${i + 1}`),
  kick: Array.from({ length: 8 }, (_, i) => `kick_fan_${i + 1}`),
  instagram: Array.from({ length: 10 }, (_, i) => `ig_fan_${i + 1}`),
  tiktok: Array.from({ length: 6 }, (_, i) => `tt_fan_${i + 1}`),
  facebook: [],
  x: [],
  custom: [],
};

const twitchPresent = new Set<string>();
const rig = createRig({
  presence: async (dest) =>
    dest.platform === 'twitch'
      ? { ok: true, users: [...twitchPresent].map((n) => ({ id: String(chatters.twitch.indexOf(n) + 1001), login: n, name: n })) }
      : { ok: false, reason: 'unsupported' },
});

const tw = rig.destination('twitch', { name: 'Twitch', options: { dualFormat: 'relay-multitrack' } });
const yt = rig.destination('youtube', { name: 'YouTube', feed: 'landscape' });
const ytv = rig.destination('youtube', { name: 'YouTube Shorts', feed: 'vertical' });
const kick = rig.destination('kick', { name: 'Kick' });
const ig = rig.destination('instagram', { name: 'Instagram', feed: 'vertical' });
const tt = rig.destination('tiktok', { name: 'TikTok', feed: 'vertical' });
const all = [tw, yt, ytv, kick, ig, tt];
const platformOf: Record<string, PlatformId> = { [tw]: 'twitch', [yt]: 'youtube', [ytv]: 'youtube', [kick]: 'kick', [ig]: 'instagram', [tt]: 'tiktok' };

const MIN = 60_000;
const session = rig.startSession('sample-1', { title: 'Sample stream: day 1', testMode: false });
void session;
rig.feed('landscape', true);
rig.feed('vertical', true, { video: { codec: 'h264', width: 1080, height: 1920, fps: 30, keyframeSec: 2 }, bitrateKbps: 4000 });
for (const d of all) rig.dest(d, 'preparing');
rig.clock.advance(15_000);
for (const d of all) if (d !== tt) rig.dest(d, 'live', { viewers: null });
// TikTok: the vertical feed briefly arrives as HEVC (0.2.40 codec guard blocks it).
rig.dest(tt, 'waiting-for-feed', {
  message: 'Vertical feed is HEVC. TikTok gets the stream unchanged and needs H.264.',
  blocked: { reason: 'feed-video-codec', feed: 'vertical', codec: 'hevc' },
});

const base: Record<string, number> = { [tw]: 140, [yt]: 60, [ytv]: 35, [kick]: 25, [ig]: 80, [tt]: 50 };
const viewersAt = (d: string, minute: number): number | null => {
  if (d === kick && minute >= 20 && minute < 25) return null; // Kick stops reporting for 5 minutes
  if (d === tt && minute < 3) return null;
  const growth = Math.min(1, 0.4 + minute / 40) * (minute > 75 ? 1 - (minute - 75) / 30 : 1);
  return Math.max(0, Math.round(base[d]! * growth * (0.9 + rnd() * 0.2)));
};
const recoveries: Record<string, number> = {};

const presence = async () => rig.reports.recorder.presenceTick();
await presence();

for (let step = 1; step <= 180; step++) {
  const minute = step / 2;
  rig.clock.advance(30_000);
  if (minute === 3) rig.dest(tt, 'live', { blocked: null, viewers: null });
  if (minute === 30) rig.session({ title: 'Sample stream: day 1, Q&A' });
  if (minute === 45) {
    recoveries[tw] = 1;
    rig.dest(tw, 'recovering', { recoveries: 1, lastRecovery: { at: new Date(rig.clock.now).toISOString(), reason: 'ended by the platform' }, viewers: null });
  }
  if (minute === 46) rig.dest(tw, 'live', { recoveries: 1, viewers: null });
  if (minute === 60) rig.dest(ytv, 'retrying', { message: 'Error opening output rtmp://a.rtmp.youtube.example/live2/abcd-efgh-ijkl-mnop (retrying in 5 s)', retries: 1 });
  if (minute === 61) rig.dest(ytv, 'live', { viewers: null });
  if (minute === 70) rig.feed('landscape', false);
  if (minute === 70.5) rig.feed('landscape', true);
  // Viewer counts as the platforms would report them (changes only).
  for (const d of all) {
    if ((d === tw && minute >= 45 && minute < 46) || (d === ytv && minute >= 60 && minute < 61) || (d === tt && minute < 3)) continue;
    rig.dest(d, 'live', { viewers: viewersAt(d, Math.floor(minute)), recoveries: recoveries[d] ?? 0 });
  }
  // Feed stats every 30 s.
  rig.feed('vertical', true, { video: { codec: 'h264', width: 1080, height: 1920, fps: 30, keyframeSec: 2 }, bitrateKbps: 3900 + Math.round(rnd() * 200) });
  if (!(minute === 70)) rig.feed('landscape', true, { bitrateKbps: 5900 + Math.round(rnd() * 200) });
  // Chat.
  const say = (platform: PlatformId, dest: string, n: number) => {
    for (let i = 0; i < n; i++) {
      const names = chatters[platform];
      // Regulars chat more: the first names are picked more often.
      const who = names[Math.floor(rnd() ** 2 * names.length)]!;
      const id = platform === 'instagram' || platform === 'tiktok' ? undefined : String(names.indexOf(who) + (platform === 'twitch' ? 1001 : 2001));
      rig.chat(platform, dest, { name: who, ...(id ? { id } : {}) });
      if (platform === 'twitch') twitchPresent.add(who);
    }
  };
  say('twitch', tw, Math.round(rnd() * 6));
  say('youtube', yt, Math.round(rnd() * 3));
  say('kick', kick, Math.round(rnd() * 2));
  say('instagram', ig, Math.round(rnd() * 2));
  say('tiktok', tt, Math.round(rnd() * 1.5));
  // Instagram presence lines, through the chat normaliser like the real reader.
  if (step % 4 === 0) {
    const who = chatters.instagram[Math.floor(rnd() * chatters.instagram.length)]!;
    const others = step % 8 === 0 ? 1 + Math.floor(rnd() * 12) : 0;
    const text = others > 0 ? `${who} and ${others} other${others === 1 ? '' : 's'} joined` : `${who} joined`;
    const line = normalizeChatMessage({ author: { name: who }, text, kind: 'event', join: true, ...(others > 0 ? { othersCount: others } : {}) }, 'instagram', ig);
    if (line) {
      rig.bus.emit('chat', { ...line, profileId: 'default' });
      rig.reports.recorder.drain();
    }
  }
  if (step % 20 === 0) rig.chat('twitch', tw, { name: 'tw_viewer_3', id: '1003' }, { kind: 'event', text: 'tw_viewer_3 subscribed' });
  rig.reports.recorder.tick();
  if (step % 10 === 0) await presence();
}
rig.stopSession();

const bundle = collect(rig.reports.context(), { sessionId: 'sample-1' }, 'America/New_York')!;
const name = exportBaseName(bundle);
for (const format of ['xlsx', 'csv', 'json'] as const) {
  const file = renderExport(bundle, format, name);
  fs.writeFileSync(path.join(out, file.fileName), file.body);
  console.log(`${format}: ${path.join(out, file.fileName)} (${file.body.length} bytes)`);
}
const total = bundle.sessions[0]!.stats;
console.log(JSON.stringify(total.map((s) => ({ platform: s.platform, peak: s.peakViewers, avg: s.avgViewers, viewerMinutes: s.viewerMinutes, messages: s.chatMessages, joins: s.joins, anonymousJoins: s.anonymousJoins, uniques: s.uniqueChatters, uptime: s.uptime, recoveries: s.recoveries, errors: s.errors }))));
rig.reports.close();
