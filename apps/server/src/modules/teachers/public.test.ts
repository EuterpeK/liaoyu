import { describe, expect, test } from 'vitest';
import { call, insertPackage, insertTeacher, setup } from '../../../tests/helpers.ts';

describe('公开老师列表与详情', () => {
  test('只返回已认证老师，含最低在售价，可按方向/等级筛选', async () => {
    const ctx = await setup();
    const a = await insertTeacher(ctx.db, 'a', { level: 3, directions: ['情感', '职业'] });
    const b = await insertTeacher(ctx.db, 'b', { level: 1, directions: ['健身'] });
    await insertTeacher(ctx.db, 'c', { status: 'pending' });
    await insertPackage(ctx.db, a, { priceCents: 3000 });
    await insertPackage(ctx.db, a, { type: 'single', days: 0, priceCents: 500 });
    await insertPackage(ctx.db, a, { type: 'single', days: 0, priceCents: 100, onSale: false });

    const all = (await call(ctx, 'GET', '/api/teachers')).json();
    expect(all.map((t: { id: number }) => t.id)).toEqual([a, b]);
    expect(all[0].minPriceCents).toBe(500);
    expect(all[0].directions).toEqual(['情感', '职业']);
    expect(all[0].realName).toBeUndefined();
    expect(all[0].realNameEnc).toBeUndefined();
    expect(all[1].minPriceCents).toBeNull();

    const byDir = (await call(ctx, 'GET', '/api/teachers', { query: { direction: '健身' } })).json();
    expect(byDir.map((t: { id: number }) => t.id)).toEqual([b]);

    const byLevel = (await call(ctx, 'GET', '/api/teachers', { query: { level: 3 } })).json();
    expect(byLevel.map((t: { id: number }) => t.id)).toEqual([a]);
  });

  test('详情只含在售套餐；未认证老师 404', async () => {
    const ctx = await setup();
    const a = await insertTeacher(ctx.db, 'a');
    const pending = await insertTeacher(ctx.db, 'p', { status: 'pending' });
    await insertPackage(ctx.db, a);
    await insertPackage(ctx.db, a, { onSale: false });

    const res = await call(ctx, 'GET', `/api/teachers/${a}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().packages).toHaveLength(1);
    expect((await call(ctx, 'GET', `/api/teachers/${pending}`)).statusCode).toBe(404);
  });
});
