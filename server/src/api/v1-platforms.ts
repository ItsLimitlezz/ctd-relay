// Operator tools for one platform (v1.11, docs/API.md §15), behind the system:admin scope: the
// Instagram chat reader's selector pack and its sanitised debug capture. They let an operator (or
// a remote agent holding such a token) fix the comments reader when Instagram changes its page,
// without a new release. Every change and every capture is audited.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiTokenInfo } from '../../../shared/types.js';
import { CHAT_DEBUG_BODY_LIMIT, CHAT_PACK_BODY_LIMIT, chatDebug, chatPackStatus, putChatPack, revertChatPack } from '../platforms/instagram/chat-admin.js';
import { sendProblem } from './http.js';
import type { V1Context } from './v1.js';

const PACK_PATH = '/platforms/instagram/chat/selector-pack';
const DEBUG_PATH = '/platforms/instagram/chat/debug';

export function registerPlatformRoutes(app: FastifyInstance, ctx: V1Context): void {
  const { services, requireToken, authOf } = ctx;
  const admin = requireToken('system:admin');

  /** system:admin acts on the whole server: a token limited to one profile cannot use it. */
  const serverWide = (req: FastifyRequest, reply: FastifyReply): ApiTokenInfo | null => {
    const { token } = authOf(req);
    if (token.profileId === null || token.profileId === undefined) return token;
    void sendProblem(reply, 403, 'profile_forbidden', 'system:admin routes need a token that is not limited to one profile.');
    return null;
  };
  const tokenLabel = (token: ApiTokenInfo): string => `token ${JSON.stringify(token.name)} (${token.prefix}…)`;
  const audit = (req: FastifyRequest, token: ApiTokenInfo, action: string, detail: string): void => {
    services.repos.audit.log({ userId: null, username: null, action, detail: `${detail}, by API ${tokenLabel(token)}`, ip: req.ip ?? null });
  };

  app.get(PACK_PATH, { preHandler: admin }, async (req, reply) => {
    if (!serverWide(req, reply)) return reply;
    return reply.header('cache-control', 'no-store').send(chatPackStatus());
  });

  app.put(PACK_PATH, { preHandler: admin, bodyLimit: CHAT_PACK_BODY_LIMIT }, async (req, reply) => {
    const token = serverWide(req, reply);
    if (!token) return reply;
    const result = putChatPack(req.body, `token ${token.name}`);
    if (!result.ok) return sendProblem(reply, 400, 'invalid', result.problems.join('; '));
    audit(req, token, 'instagram.chat_pack.update', result.summary);
    services.log.info({ version: result.status.version }, 'Instagram chat selector pack replaced through the API');
    return reply.header('cache-control', 'no-store').send(result.status);
  });

  app.delete(PACK_PATH, { preHandler: admin }, async (req, reply) => {
    const token = serverWide(req, reply);
    if (!token) return reply;
    const { reverted, status } = revertChatPack();
    if (reverted) {
      audit(req, token, 'instagram.chat_pack.revert', `back to the built-in pack ${status.builtinVersion}`);
      services.log.info('Instagram chat selector pack reverted to the built-in one through the API');
    }
    return reply.header('cache-control', 'no-store').send(status);
  });

  app.post(DEBUG_PATH, { preHandler: admin, bodyLimit: CHAT_DEBUG_BODY_LIMIT }, async (req, reply) => {
    const token = serverWide(req, reply);
    if (!token) return reply;
    const result = await chatDebug(req.body);
    if (!result.ok) return sendProblem(reply, 400, 'invalid', result.problems.join('; '));
    audit(req, token, 'instagram.chat_debug', `sanitised capture of ${result.response.readers.length} live comment reader(s)`);
    return reply.header('cache-control', 'no-store').send(result.response);
  });
}
