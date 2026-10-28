import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { orderStatus } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { toCsv } from '../../lib/csv.ts';
import { formatDateTimeCN } from '../../lib/dates.ts';
import { centsToYuan } from '../../lib/money.ts';
import { DateStr, IdParam } from '../../lib/zod.ts';
import { adminGuard } from '../admin/guard.ts';
import { countOrders, orderSummary, queryOrders } from './service.ts';

const OrderQuerySchema = z.object({
  userId: IdParam.optional(),
  teacherId: IdParam.optional(),
  status: z.enum(orderStatus.enumValues).optional(),
  from: DateStr.optional(),
  to: DateStr.optional(),
});

const PageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const CSV_HEADER = ['订单号', '用户ID', '用户昵称', '老师ID', '老师', '套餐', '金额(元)', '状态', '支付时间'];

export const adminOrderRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const anyAdmin = adminGuard(deps);

    app.get(
      '/orders',
      { onRequest: anyAdmin, schema: { querystring: OrderQuerySchema.extend(PageSchema.shape) } },
      async (req) => queryOrders(deps.db, req.query),
    );

    app.get('/orders/summary', { onRequest: anyAdmin, schema: { querystring: OrderQuerySchema } }, async (req) =>
      orderSummary(deps.db, req.query),
    );

    app.get('/orders/count', { onRequest: anyAdmin, schema: { querystring: OrderQuerySchema } }, async (req) => ({
      total: await countOrders(deps.db, req.query),
    }));

    app.get(
      '/orders.csv',
      { onRequest: adminGuard(deps, 'finance'), schema: { querystring: OrderQuerySchema } },
      async (req, reply) => {
        const rows = await queryOrders(deps.db, req.query);
        await audit(deps.db, {
          adminId: req.adminId,
          action: 'orders.export',
          target: 'orders',
          detail: { ...req.query, count: rows.length },
        });
        const csv = toCsv(
          CSV_HEADER,
          rows.map((o) => [
            o.outTradeNo,
            o.userId,
            o.userNickname,
            o.teacherId,
            o.teacherName,
            o.packageTitle,
            centsToYuan(o.amountCents),
            o.status,
            o.paidAt ? formatDateTimeCN(o.paidAt) : '',
          ]),
        );
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="orders.csv"')
          .send(csv);
      },
    );
  };
