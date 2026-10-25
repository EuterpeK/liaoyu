import { createHmac } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Config } from '../config.ts';

export type TencentConfig = Config['tencent'];

export const SIG_EXPIRE_SEC = 7 * 86_400;

export const imIdOf = (userId: number): string => `u${userId}`;

/** `u{正整数}` → 用户 ID；系统账号（如 administrator）等其他格式返回 null */
export function parseImId(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^u([1-9]\d{0,9})$/.exec(s);
  return m ? Number(m[1]) : null;
}

export const isTencentMock = (tc: TencentConfig): boolean => !tc.sdkAppId || !tc.secretKey;

function hmacSig(key: string, identifier: string, sdkAppId: number, time: number, expire: number): string {
  const content = `TLS.identifier:${identifier}\nTLS.sdkappid:${sdkAppId}\nTLS.time:${time}\nTLS.expire:${expire}\n`;
  return createHmac('sha256', key).update(content).digest('base64');
}

const escapeSig = (b64: string): string => b64.replaceAll('+', '*').replaceAll('/', '-').replaceAll('=', '_');
const unescapeSig = (s: string): string => s.replaceAll('*', '+').replaceAll('-', '/').replaceAll('_', '=');

export function genUserSig(
  tc: Pick<TencentConfig, 'sdkAppId' | 'secretKey'>,
  identifier: string,
  expireSec: number,
  nowSec: number,
): string {
  const doc = {
    'TLS.ver': '2.0',
    'TLS.identifier': identifier,
    'TLS.sdkappid': tc.sdkAppId,
    'TLS.expire': expireSec,
    'TLS.time': nowSec,
    'TLS.sig': hmacSig(tc.secretKey, identifier, tc.sdkAppId, nowSec, expireSec),
  };
  return escapeSig(deflateSync(Buffer.from(JSON.stringify(doc))).toString('base64'));
}

export const decodeUserSig = (sig: string): Record<string, unknown> =>
  JSON.parse(inflateSync(Buffer.from(unescapeSig(sig), 'base64')).toString('utf8'));

export interface ImCredential {
  mock: boolean;
  sdkAppId: number;
  imId: string;
  userSig: string;
  expireSec: number;
}

export function imCredential(tc: TencentConfig, userId: number, now: Date): ImCredential {
  const imId = imIdOf(userId);
  const mock = isTencentMock(tc);
  return {
    mock,
    sdkAppId: tc.sdkAppId,
    imId,
    userSig: mock ? 'mock' : genUserSig(tc, imId, SIG_EXPIRE_SEC, Math.floor(now.getTime() / 1000)),
    expireSec: SIG_EXPIRE_SEC,
  };
}
