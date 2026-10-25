import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { call, FIXED_NOW, loginUser, setup, TENCENT } from '../../tests/helpers.ts';
import { decodeUserSig, genUserSig, imIdOf, parseImId, SIG_EXPIRE_SEC } from './tencent.ts';

describe('腾讯云 UserSig', () => {
  test('IM 账号映射', () => {
    expect(imIdOf(12)).toBe('u12');
    expect(parseImId('u12')).toBe(12);
    expect(parseImId('u012')).toBeNull();
    expect(parseImId('administrator')).toBeNull();
    expect(parseImId(undefined)).toBeNull();
    expect(parseImId(12)).toBeNull();
  });

  test('UserSig 可解出字段，签名为 HMAC-SHA256', () => {
    const sig = genUserSig(TENCENT, 'u12', 600, 1_700_000_000);
    expect(sig).toMatch(/^[A-Za-z0-9*\-_]+$/);
    const doc = decodeUserSig(sig);
    expect(doc).toMatchObject({
      'TLS.ver': '2.0',
      'TLS.identifier': 'u12',
      'TLS.sdkappid': 1400000001,
      'TLS.time': 1_700_000_000,
      'TLS.expire': 600,
    });
    const content = 'TLS.identifier:u12\nTLS.sdkappid:1400000001\nTLS.time:1700000000\nTLS.expire:600\n';
    expect(doc['TLS.sig']).toBe(createHmac('sha256', 'sk-test').update(content).digest('base64'));
  });

  test('GET /api/im/usersig：MOCK 与真实模式', async () => {
    const mock = await setup();
    const u1 = await loginUser(mock, 'u');
    expect((await call(mock, 'GET', '/api/im/usersig', { token: u1.token })).json()).toEqual({
      mock: true,
      sdkAppId: 0,
      imId: `u${u1.userId}`,
      userSig: 'mock',
      expireSec: SIG_EXPIRE_SEC,
    });

    const real = await setup({ config: { tencent: TENCENT } });
    const u2 = await loginUser(real, 'u');
    const body = (await call(real, 'GET', '/api/im/usersig', { token: u2.token })).json();
    expect(body).toMatchObject({ mock: false, sdkAppId: 1400000001, imId: `u${u2.userId}` });
    expect(decodeUserSig(body.userSig)).toMatchObject({
      'TLS.identifier': `u${u2.userId}`,
      'TLS.time': Date.parse(FIXED_NOW) / 1000,
      'TLS.expire': SIG_EXPIRE_SEC,
    });
    expect((await call(real, 'GET', '/api/im/usersig')).statusCode).toBe(401);
  });
});
