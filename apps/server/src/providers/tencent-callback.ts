import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const IM_MAX_SKEW_SEC = 300;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** IM 回调：URL 查询参数 `RequestTime` + `Sign = sha256(Token + RequestTime)` */
export function verifyImSign(token: string, q: { RequestTime?: string; Sign?: string }, now: Date): boolean {
  if (!token) return true;
  if (!q.RequestTime || !/^\d+$/.test(q.RequestTime)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(q.RequestTime)) > IM_MAX_SKEW_SEC) return false;
  return safeEqual(createHash('sha256').update(`${token}${q.RequestTime}`).digest('hex'), q.Sign ?? '');
}

/** TRTC 回调：请求头 `Sign = base64(HMAC-SHA256(key, 原始请求体))` */
export function verifyTrtcSign(key: string, rawBody: Buffer, sign: string | undefined): boolean {
  if (!key) return true;
  return safeEqual(createHmac('sha256', key).update(rawBody).digest('base64'), sign ?? '');
}
