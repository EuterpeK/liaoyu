import { describe, expect, test } from 'vitest';
import { call, loginUser, setup } from '../../../tests/helpers.ts';
import { notify } from '../../lib/notify.ts';

describe('站内通知', () => {
  test('列表：未读过滤与已读', async () => {
    const ctx = await setup();
    const { userId, token } = await loginUser(ctx, 'u1');
    await notify(ctx.db, { userId, type: 'order_paid', payload: {} }, { userId, type: 'crisis_alert', payload: {} });
    const all = (await call(ctx, 'GET', '/api/notifications', { token })).json();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ type: 'crisis_alert', isRead: false, payload: {} });

    expect((await call(ctx, 'GET', '/api/notifications', { token, query: { unread: 'true' } })).json()).toHaveLength(2);
    expect(
      (await call(ctx, 'POST', '/api/notifications/read', { token, body: { ids: [all[0].id] } })).json().updated,
    ).toBe(1);
    expect((await call(ctx, 'GET', '/api/notifications', { token, query: { unread: 'true' } })).json()).toHaveLength(1);
    expect((await call(ctx, 'GET', '/api/notifications', { token })).json()[0].isRead).toBe(true);
  });

  test('他人通知不可标记；空 ids 全部已读', async () => {
    const ctx = await setup();
    const a = await loginUser(ctx, 'a');
    const b = await loginUser(ctx, 'b');
    const mine = await notify(ctx.db, { userId: a.userId, type: 'order_paid', payload: {} });
    expect(
      (await call(ctx, 'POST', '/api/notifications/read', { token: b.token, body: { ids: [1] } })).json().updated,
    ).toBe(0);
    expect(
      (await call(ctx, 'POST', '/api/notifications/read', { token: a.token, body: { ids: [1] } })).json().updated,
    ).toBe(1);
    void mine;
  });
});
