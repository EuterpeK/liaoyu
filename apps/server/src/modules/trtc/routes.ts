import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { parseImId } from '../../providers/tencent.ts';
import { verifyTrtcSign } from '../../providers/tencent-callback.ts';
import { onRoomDismissed, recordEnter } from '../appointments/calls.ts';

const ROOM_EVENTS = 1;
const DISMISS_ROOM = 102;
const ENTER_ROOM = 103;

const TrtcEvent = z.object({
  EventGroupId: z.number(),
  EventType: z.number(),
  EventInfo: z.object({
    RoomId: z.coerce.number().int().positive(),
    EventTs: z.number().optional(),
    EventMsTs: z.number().optional(),
    UserId: z.string().optional(),
  }),
});

export const trtcRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    // 仅在本插件作用域内保留原始请求体用于验签
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    app.post('/callback', async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sign = typeof req.headers.sign === 'string' ? req.headers.sign : undefined;
      if (!verifyTrtcSign(deps.config.tencent.trtcCallbackKey, raw, sign)) return reply.status(401).send({ code: 1 });

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        return reply.status(400).send({ code: 1 });
      }
      const ev = TrtcEvent.safeParse(parsed);
      if (ev.success && ev.data.EventGroupId === ROOM_EVENTS) {
        const info = ev.data.EventInfo;
        const at = new Date(info.EventMsTs ?? (info.EventTs ? info.EventTs * 1000 : deps.clock.now().getTime()));
        if (ev.data.EventType === ENTER_ROOM) {
          const uid = parseImId(info.UserId);
          if (uid) await recordEnter(deps.db, info.RoomId, uid, at);
        } else if (ev.data.EventType === DISMISS_ROOM) {
          await onRoomDismissed(deps.db, info.RoomId, at);
        }
      }
      return { code: 0 };
    });
  };
