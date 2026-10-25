import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { buildSignStr, createZPayProvider, zpaySign } from './zpay.ts';

const CFG = { pid: 'p1', key: 'k1', gateway: 'https://z-pay.cn', publicBaseUrl: 'http://h' };
const signed = (p: Record<string, string>, key = 'k1') => ({ ...p, sign: zpaySign(p, key), sign_type: 'MD5' });
const BASE = {
  pid: 'p1',
  trade_no: 'Z1',
  out_trade_no: 'O1',
  type: 'alipay',
  name: '包月',
  trade_status: 'TRADE_SUCCESS',
};

describe('ZPAY', () => {
  test('未配置 pid/key 为 MOCK：链接指向本地模拟收银台，且拒绝一切回调', () => {
    const z = createZPayProvider({ ...CFG, key: '' });
    expect(z.isMock).toBe(true);
    expect(z.payUrl({ outTradeNo: 'O1', amountCents: 3000, subject: 'x' })).toBe(
      'http://h/api/pay/mock?out_trade_no=O1',
    );
    expect(z.parseNotify(signed({ ...BASE, money: '30.00' }, '')).kind).toBe('invalid');
  });

  test('待签名串：过滤空值与 sign/sign_type，按键名排序', () => {
    expect(buildSignStr({ b: '2', a: '1', sign: 'x', sign_type: 'MD5', c: '' })).toBe('a=1&b=2');
  });

  test('签名 = md5(signStr + key)', () => {
    const p = { pid: 'p1', out_trade_no: 'O1', money: '30.00' };
    const expected = createHash('md5')
      .update(`${buildSignStr(p)}k1`, 'utf8')
      .digest('hex');
    expect(zpaySign(p, 'k1')).toBe(expected);
  });

  test('payUrl 指向 submit.php，含回调地址、中文标题与签名', () => {
    const url = createZPayProvider(CFG).payUrl({ outTradeNo: 'O1', amountCents: 3000, subject: '包月陪伴' });
    expect(url.startsWith('https://z-pay.cn/submit.php?')).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get('type')).toBe('alipay');
    expect(q.get('money')).toBe('30.00');
    expect(q.get('name')).toBe('包月陪伴');
    expect(q.get('notify_url')).toBe('http://h/api/pay/zpay/notify');
    expect(q.get('sign_type')).toBe('MD5');
    const params = Object.fromEntries([...q].filter(([k]) => k !== 'sign' && k !== 'sign_type'));
    expect(q.get('sign')).toBe(zpaySign(params, 'k1'));
  });

  test('parseNotify：验签通过且成功 → paid', () => {
    expect(createZPayProvider(CFG).parseNotify(signed({ ...BASE, money: '30.00' }))).toEqual({
      kind: 'paid',
      outTradeNo: 'O1',
      tradeNo: 'Z1',
      paidCents: 3000,
    });
  });

  test('parseNotify：签名错误/篡改金额/pid 不符 → invalid；非成功状态 → ignored', () => {
    const z = createZPayProvider(CFG);
    const good = signed({ ...BASE, money: '30.00' });
    expect(z.parseNotify({ ...good, sign: 'x'.repeat(32) }).kind).toBe('invalid');
    expect(z.parseNotify({ ...good, money: '0.01' }).kind).toBe('invalid');
    expect(z.parseNotify(signed({ ...BASE, pid: 'p2', money: '30.00' })).kind).toBe('invalid');
    expect(z.parseNotify({ ...BASE, money: '30.00' }).kind).toBe('invalid');
    expect(z.parseNotify(signed({ ...BASE, money: '30.00', trade_status: 'WAIT' })).kind).toBe('ignored');
  });
});
