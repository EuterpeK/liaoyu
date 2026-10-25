import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { verifyImSign, verifyTrtcSign } from './tencent-callback.ts';

describe('腾讯云回调验签', () => {
  test('TRTC：HMAC-SHA256(原始请求体)；未配置密钥时放行', () => {
    const raw = Buffer.from('{"a":1}');
    const sign = createHmac('sha256', 'ck').update(raw).digest('base64');
    expect(verifyTrtcSign('ck', raw, sign)).toBe(true);
    expect(verifyTrtcSign('ck', raw, 'x')).toBe(false);
    expect(verifyTrtcSign('ck', raw, undefined)).toBe(false);
    expect(verifyTrtcSign('', raw, undefined)).toBe(true);
  });

  test('IM：sha256(Token + RequestTime)，偏差超过 300 秒无效', () => {
    const sec = 1_700_000_000;
    const at = (s: number) => new Date(s * 1000);
    const Sign = createHash('sha256').update(`tok${sec}`).digest('hex');
    const q = { RequestTime: String(sec), Sign };
    expect(verifyImSign('tok', q, at(sec))).toBe(true);
    expect(verifyImSign('tok', q, at(sec + 300))).toBe(true);
    expect(verifyImSign('tok', q, at(sec + 301))).toBe(false);
    expect(verifyImSign('tok', { ...q, Sign: 'x' }, at(sec))).toBe(false);
    expect(verifyImSign('tok', {}, at(sec))).toBe(false);
    expect(verifyImSign('', {}, at(0))).toBe(true);
  });
});
