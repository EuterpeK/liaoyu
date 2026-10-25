import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { todayCN } from '../../lib/dates.ts';
import { imCredential, parseImId } from '../../providers/tencent.ts';
import { verifyImSign } from '../../providers/tencent-callback.ts';
import { userGuard } from '../auth/guards.ts';
import { contactsOf, handleAfterSend, resolvePair, textOf } from '../chat/service.ts';

const IM_OK = { ActionStatus: 'OK', ErrorCode: 0, ErrorInfo: '' };
const IM_NO_SERVICE = { ActionStatus: 'OK', ErrorCode: 120001, ErrorInfo: '当前没有进行中的服务，无法发送消息' };
const IM_BAD_SIGN = { ActionStatus: 'FAIL', ErrorCode: 1, ErrorInfo: 'invalid sign' };

const CallbackQuery = z.object({ RequestTime: z.string().optional(), Sign: z.string().optional() });
const CallbackBody = z.object({
  CallbackCommand: z.string().optional(),
  From_Account: z.string().optional(),
  To_Account: z.string().optional(),
  MsgBody: z.unknown().optional(),
});

export const imRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.post(
      '/callback',
      { schema: { querystring: CallbackQuery, body: CallbackBody, hide: true } },
      async (req, reply) => {
        const now = deps.clock.now();
        if (!verifyImSign(deps.config.tencent.imCallbackToken, req.query, now)) {
          return reply.status(403).send(IM_BAD_SIGN);
        }
        const from = parseImId(req.body.From_Account);
        const to = parseImId(req.body.To_Account);
        if (from && to && req.body.CallbackCommand === 'C2C.CallbackBeforeSendMsg') {
          if (!(await resolvePair(deps.db, from, to, todayCN(now)))) return IM_NO_SERVICE;
        }
        if (from && to && req.body.CallbackCommand === 'C2C.CallbackAfterSendMsg') {
          try {
            await handleAfterSend(deps.db, {
              from,
              to,
              text: textOf(req.body.MsgBody),
              now,
              hotline: deps.config.crisisHotline,
            });
          } catch (err) {
            req.log.error({ err, from, to }, 'IM 发送后处理失败');
          }
        }
        return IM_OK;
      },
    );

    await app.register(async (authed) => {
      authed.addHook('preHandler', userGuard(deps));

      authed.get('/usersig', async (req) => imCredential(deps.config.tencent, req.userId, deps.clock.now()));

      authed.get('/contacts', async (req) => contactsOf(deps.db, req.userId, todayCN(deps.clock.now())));
    });
  };
