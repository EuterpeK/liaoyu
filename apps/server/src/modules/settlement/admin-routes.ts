import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { settlementStatus } from '../../db/schema.ts';
import type { Deps } from '../../deps.ts';
import { audit } from '../../lib/audit.ts';
import { DateStr, IdParam } from '../../lib/zod.ts';
import { adminGuard } from '../admin/guard.ts';
import {
  generateSettlements,
  getCommissionBps,
  listSettlements,
  markSettlementPaid,
  setCommissionBps,
} from './service.ts';

export const adminSettlementRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.addHook('preHandler', adminGuard(deps));

    app.get('/settings/commission-bps', async () => ({ bps: await getCommissionBps(deps.db) }));

    app.put(
      '/settings/commission-bps',
      { schema: { body: z.object({ bps: z.number().int().min(0).max(9999) }) } },
      async (req) =>
        deps.db.transaction(async (tx) => {
          await setCommissionBps(tx, req.body.bps);
          await audit(tx, {
            adminId: req.adminId,
            action: 'settings.commission_bps',
            target: 'settings',
            detail: { bps: req.body.bps },
          });
          return { bps: req.body.bps };
        }),
    );

    app.post(
      '/settlements/generate',
      { schema: { body: z.object({ periodStart: DateStr, periodEnd: DateStr }) } },
      async (req, reply) => {
        const rows = await deps.db.transaction(async (tx) => {
          const created = await generateSettlements(tx, req.body);
          await audit(tx, {
            adminId: req.adminId,
            action: 'settlement.generate',
            target: `period:${req.body.periodStart}~${req.body.periodEnd}`,
            detail: { ids: created.map((s) => s.id) },
          });
          return created;
        });
        return reply.status(201).send(rows);
      },
    );

    app.get(
      '/settlements',
      { schema: { querystring: z.object({ status: z.enum(settlementStatus.enumValues).optional() }) } },
      async (req) => listSettlements(deps.db, req.query.status),
    );

    app.post(
      '/settlements/:id/pay',
      {
        schema: {
          params: z.object({ id: IdParam }),
          body: z.object({ proof: z.string().trim().min(1).max(200) }),
        },
      },
      async (req) =>
        deps.db.transaction(async (tx) => {
          const s = await markSettlementPaid(tx, deps.clock, req.params.id, {
            proof: req.body.proof,
            adminId: req.adminId,
          });
          await audit(tx, {
            adminId: req.adminId,
            action: 'settlement.pay',
            target: `settlement:${s.id}`,
            detail: { netCents: s.netCents, proof: s.proof },
          });
          return s;
        }),
    );
  };
