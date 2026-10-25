import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { IdParam } from '../../lib/zod.ts';
import { userGuard } from '../auth/guards.ts';
import { createOrder, getOrderByOutTradeNo } from './service.ts';

export const orderRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', userGuard(deps));

    app.post('/', { schema: { body: z.object({ packageId: IdParam }) } }, async (req, reply) => {
      const order = await createOrder(deps.db, deps.clock, {
        userId: req.userId,
        packageId: req.body.packageId,
        provider: deps.payment.name,
      });
      const payUrl = deps.payment.payUrl({
        outTradeNo: order.outTradeNo,
        amountCents: order.amountCents,
        subject: order.packageSnapshot.title,
      });
      return reply
        .status(201)
        .send({ outTradeNo: order.outTradeNo, amountCents: order.amountCents, payUrl, mock: deps.payment.isMock });
    });

    app.get(
      '/:outTradeNo',
      { schema: { params: z.object({ outTradeNo: z.string().min(1).max(64) }) } },
      async (req) => {
        const o = await getOrderByOutTradeNo(deps.db, req.params.outTradeNo);
        if (!o || o.userId !== req.userId) throw new HttpError(404, '订单不存在');
        return { outTradeNo: o.outTradeNo, status: o.status, paid: o.status === 'paid', amountCents: o.amountCents };
      },
    );
  };
