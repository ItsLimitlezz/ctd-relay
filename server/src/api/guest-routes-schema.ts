// Request bodies of the guest route endpoints (web UI and external API share them).

import { z } from 'zod';

export const CreateRouteBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rtmp'),
    name: z.string().max(200).optional(),
    url: z.string().max(2048),
    streamKey: z.string().max(2048).nullish(),
    auto: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('profile'),
    name: z.string().max(200).optional(),
    profileId: z.string().min(1).max(128),
    feed: z.enum(['landscape', 'vertical']),
    auto: z.boolean().optional(),
  }),
]);

export const UpdateRouteBody = z.object({
  name: z.string().max(200).optional(),
  url: z.string().max(2048).optional(),
  streamKey: z.string().max(2048).nullish(),
  auto: z.boolean().optional(),
});

export const RouteSettingsBody = z.object({ allowLan: z.boolean() });

/** First zod issue as a sentence (never echoes values). */
export function zodMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  return issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid request';
}
