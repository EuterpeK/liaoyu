import { createHash, timingSafeEqual } from 'node:crypto';
import { centsToYuan, yuanToCents } from '../../lib/money.ts';
import type { NotifyResult, PaymentProvider, PayRequest } from './types.ts';

export interface ZPayConfig {
  pid: string;
  key: string;
  gateway: string;
  publicBaseUrl: string;
}

export function buildSignStr(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export const zpaySign = (params: Record<string, string>, key: string): string =>
  createHash('md5')
    .update(buildSignStr(params) + key, 'utf8')
    .digest('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function toStringRecord(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (typeof v === 'string') out[k] = v;
  return out;
}

export function createZPayProvider(cfg: ZPayConfig): PaymentProvider {
  const isMock = !cfg.pid || !cfg.key;

  return {
    name: 'zpay',
    isMock,

    payUrl({ outTradeNo, amountCents, subject }: PayRequest): string {
      if (isMock) return `${cfg.publicBaseUrl}/api/pay/mock?out_trade_no=${encodeURIComponent(outTradeNo)}`;
      const params = {
        pid: cfg.pid,
        money: centsToYuan(amountCents),
        name: subject,
        notify_url: `${cfg.publicBaseUrl}/api/pay/zpay/notify`,
        out_trade_no: outTradeNo,
        return_url: `${cfg.publicBaseUrl}/api/pay/return`,
        sitename: 'LiaoYu',
        type: 'alipay',
      };
      const query = new URLSearchParams({ ...params, sign: zpaySign(params, cfg.key), sign_type: 'MD5' });
      return `${cfg.gateway}/submit.php?${query.toString()}`;
    },

    parseNotify(raw): NotifyResult {
      if (isMock) return { kind: 'invalid' };
      const p = toStringRecord(raw);
      if (!p.sign || !safeEqual(zpaySign(p, cfg.key), p.sign.toLowerCase())) return { kind: 'invalid' };
      if (p.pid !== cfg.pid) return { kind: 'invalid' };
      if (p.trade_status !== 'TRADE_SUCCESS') return { kind: 'ignored' };
      const paidCents = yuanToCents(p.money ?? '');
      if (paidCents === null || !p.out_trade_no) return { kind: 'invalid' };
      return { kind: 'paid', outTradeNo: p.out_trade_no, tradeNo: p.trade_no ?? '', paidCents };
    },
  };
}
