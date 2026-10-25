import { jwtVerify, SignJWT } from 'jose';
import type { Config } from '../../config.ts';
import type { Clock } from '../../lib/clock.ts';

const USER_TTL_SEC = 30 * 86_400;
const keyOf = (config: Config) => new TextEncoder().encode(config.jwtSecret);

export async function signUserToken(config: Config, clock: Clock, userId: number): Promise<string> {
  const iat = Math.floor(clock.now().getTime() / 1000);
  return new SignJWT({ typ: 'user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(userId))
    .setIssuedAt(iat)
    .setExpirationTime(iat + USER_TTL_SEC)
    .sign(keyOf(config));
}

export async function verifyUserToken(config: Config, clock: Clock, token: string): Promise<number> {
  const { payload } = await jwtVerify(token, keyOf(config), { algorithms: ['HS256'], currentDate: clock.now() });
  if (payload.typ !== 'user' || !payload.sub) throw new Error('token 类型错误');
  return Number(payload.sub);
}
