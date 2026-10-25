import { describe, expect, test } from 'vitest';
import { type Ctx, call, loginTeacher, loginUser, setup } from '../../../tests/helpers.ts';

const URL = '/api/teacher/schedule';
const put = (ctx: Ctx, token: string, items: unknown) => call(ctx, 'PUT', URL, { token, body: { items } });

describe('老师周排班', () => {
  test('设置并读取周排班；重新设置会整体覆盖', async () => {
    const ctx = await setup();
    const t = await loginTeacher(ctx, 't1');
    const items = [
      { weekday: 1, start: '14:00', end: '16:30' },
      { weekday: 1, start: '09:00', end: '12:00' },
    ];
    const saved = await put(ctx, t.token, items);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual([items[1], items[0]]);
    expect((await call(ctx, 'GET', URL, { token: t.token })).json()).toEqual([items[1], items[0]]);

    await put(ctx, t.token, [{ weekday: 3, start: '19:00', end: '24:00' }]);
    expect((await call(ctx, 'GET', URL, { token: t.token })).json()).toEqual([
      { weekday: 3, start: '19:00', end: '24:00' },
    ]);
  });

  test('时段非法或重叠返回 400', async () => {
    const ctx = await setup();
    const t = await loginTeacher(ctx, 't1');
    const bad = [
      [{ weekday: 7, start: '09:00', end: '10:00' }],
      [{ weekday: 1, start: '10:00', end: '09:00' }],
      [{ weekday: 1, start: '9:00', end: '10:00' }],
      [
        { weekday: 1, start: '09:00', end: '11:00' },
        { weekday: 1, start: '10:00', end: '12:00' },
      ],
    ];
    for (const items of bad) expect((await put(ctx, t.token, items)).statusCode).toBe(400);
    expect((await call(ctx, 'PUT', URL, { token: t.token, body: {} })).statusCode).toBe(400);
  });

  test('非老师 403', async () => {
    const ctx = await setup();
    const u = await loginUser(ctx, 'u1');
    expect((await put(ctx, u.token, [])).statusCode).toBe(403);
  });
});
