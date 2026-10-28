import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  generateSettlements,
  getCommissionBps,
  listSettlements,
  paySettlement,
  setCommissionBps,
} from './settlements.ts';

afterEach(() => vi.unstubAllGlobals());

const stub = (body: unknown = {}) =>
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
const call = () => (fetch as ReturnType<typeof vi.fn>).mock.calls[0];

describe('settlements api', () => {
  test('生成结算单：POST 起止日期', async () => {
    stub([]);
    await generateSettlements({ periodStart: '2026-10-01', periodEnd: '2026-10-07' });
    expect(call()[0]).toBe('/api/admin/settlements/generate');
    expect(call()[1].method).toBe('POST');
    expect(call()[1].body).toBe('{"periodStart":"2026-10-01","periodEnd":"2026-10-07"}');
  });

  test('标记打款：POST 凭证（去首尾空白）', async () => {
    stub();
    await paySettlement(3, '  转账单号123  ');
    expect(call()[0]).toBe('/api/admin/settlements/3/pay');
    expect(call()[1].body).toBe('{"proof":"转账单号123"}');
  });

  test('佣金：GET 返回 bps 数字，PUT 提交 bps', async () => {
    stub({ bps: 1500 });
    expect(await getCommissionBps()).toBe(1500);
    expect(call()[0]).toBe('/api/admin/settings/commission-bps');
    stub({ bps: 2000 });
    await setCommissionBps(2000);
    expect(call()[1].method).toBe('PUT');
    expect(call()[1].body).toBe('{"bps":2000}');
  });

  test('结算单列表可按状态过滤', async () => {
    stub([]);
    await listSettlements('pending');
    expect(call()[0]).toBe('/api/admin/settlements?status=pending');
  });
});
