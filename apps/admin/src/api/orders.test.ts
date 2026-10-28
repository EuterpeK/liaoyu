import { afterEach, describe, expect, test, vi } from 'vitest';
import { countOrders, exportUrl, listOrders } from './orders.ts';

afterEach(() => vi.unstubAllGlobals());

const stub = (body: unknown) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
const lastUrl = () => (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;

describe('orders api', () => {
  test('exportUrl 只带非空筛选', () => {
    expect(exportUrl({ status: 'paid', userId: undefined, from: '' })).toBe('/api/admin/orders.csv?status=paid');
    expect(exportUrl({})).toBe('/api/admin/orders.csv');
  });

  test('listOrders 把页码换算成 limit/offset 并带上筛选', async () => {
    stub([]);
    await listOrders({ status: 'paid', teacherId: 3 }, { page: 3, pageSize: 20 });
    expect(lastUrl()).toBe('/api/admin/orders?status=paid&teacherId=3&limit=20&offset=40');
  });

  test('countOrders 返回 total 数字', async () => {
    stub({ total: 42 });
    expect(await countOrders({ from: '2026-11-01' })).toBe(42);
    expect(lastUrl()).toBe('/api/admin/orders/count?from=2026-11-01');
  });
});
