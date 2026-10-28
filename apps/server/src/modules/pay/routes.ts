import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { HttpError } from '../../lib/errors.ts';
import { centsToYuan } from '../../lib/money.ts';
import { fulfillOrder, getOrderByOutTradeNo } from '../orders/service.ts';

const HTML = 'text/html; charset=utf-8';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (body: string): string => `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LiaoYu 支付</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
min-height:100vh;margin:0;background:#f5f6f8}.c{background:#fff;padding:32px;border-radius:16px;text-align:center;
max-width:340px;width:90%}button{width:100%;padding:14px;border:0;border-radius:10px;background:#1677ff;color:#fff;
font-size:16px}</style></head><body><div class="c">${body}</div></body></html>`;

const OutTradeNoQuery = z.object({ out_trade_no: z.string().min(1).max(64) });

export const payRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    /** 模拟收银台仅限非生产且未配置真实支付；双重保险，防止误配后被免费置为已支付 */
    function assertMockAllowed(): void {
      if (!deps.payment.isMock || deps.config.nodeEnv === 'production') throw new HttpError(404, 'Not Found');
    }

    async function handleNotify(params: unknown, log: FastifyBaseLogger): Promise<'success' | 'fail'> {
      const r = deps.payment.parseNotify((params ?? {}) as Record<string, unknown>);
      if (r.kind === 'invalid') {
        log.warn('支付回调验签失败');
        return 'fail';
      }
      if (r.kind === 'ignored') return 'success';
      const f = await fulfillOrder(deps.db, deps.clock, r.outTradeNo, { tradeNo: r.tradeNo, paidCents: r.paidCents });
      if (!f.ok) {
        log.error({ outTradeNo: r.outTradeNo, reason: f.reason, paidCents: r.paidCents }, '支付回调履约失败');
        return 'fail';
      }
      return 'success';
    }

    app.get('/zpay/notify', { schema: { hide: true } }, async (req, reply) =>
      reply.type('text/plain').send(await handleNotify(req.query, req.log)),
    );
    app.post('/zpay/notify', { schema: { hide: true } }, async (req, reply) =>
      reply.type('text/plain').send(await handleNotify(req.body, req.log)),
    );

    app.get('/return', { schema: { hide: true } }, async (_req, reply) =>
      reply.type(HTML).send(page('<h3>支付已提交</h3><p>请返回微信小程序查看服务是否已开通。</p>')),
    );

    app.get('/mock', { schema: { querystring: OutTradeNoQuery, hide: true } }, async (req, reply) => {
      assertMockAllowed();
      const o = await getOrderByOutTradeNo(deps.db, req.query.out_trade_no);
      if (!o) throw new HttpError(404, '订单不存在');
      const action = `/api/pay/mock/confirm?out_trade_no=${encodeURIComponent(o.outTradeNo)}`;
      return reply.type(HTML).send(
        page(`<p>开发模拟收银台（不会真实扣款）</p><h3>${esc(o.packageSnapshot.title)}</h3>
<h2>¥${centsToYuan(o.amountCents)}</h2><form method="post" action="${esc(action)}"><button>确认支付</button></form>`),
      );
    });

    app.post('/mock/confirm', { schema: { querystring: OutTradeNoQuery, hide: true } }, async (req, reply) => {
      assertMockAllowed();
      const o = await getOrderByOutTradeNo(deps.db, req.query.out_trade_no);
      if (!o) throw new HttpError(404, '订单不存在');
      await fulfillOrder(deps.db, deps.clock, o.outTradeNo, {
        tradeNo: `MOCK_${o.outTradeNo}`,
        paidCents: o.amountCents,
      });
      return reply.type(HTML).send(page('<h3>模拟支付成功</h3><p>请返回微信小程序。</p>'));
    });
  };
