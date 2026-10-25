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
import { queryOrders } from './service.ts';

const OrderQuerySchema = z.object({
  userId: IdParam.optional(),
  teacherId: IdParam.optional(),
  status: z.enum(orderStatus.enumValues).optional(),
  from: DateStr.optional(),
  to: DateStr.optional(),
});

const CSV_HEADER = ['订单号', '用户ID', '用户昵称', '老师ID', '老师', '套餐', '金额(元)', '状态', '支付时间'];

export const adminOrderRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', adminGuard(deps));

    app.get('/orders', { schema: { querystring: OrderQuerySchema } }, async (req) => queryOrders(deps.db, req.query));

    app.get('/orders.csv', { schema: { querystring: OrderQuerySchema } }, async (req, reply) => {
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
    });
  };
