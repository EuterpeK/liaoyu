export interface PayRequest {
  outTradeNo: string;
  amountCents: number;
  subject: string;
}

export type NotifyResult =
  | { kind: 'invalid' }
  | { kind: 'ignored' }
  | { kind: 'paid'; outTradeNo: string; tradeNo: string; paidCents: number };

export interface PaymentProvider {
  readonly name: string;
  readonly isMock: boolean;
  payUrl(req: PayRequest): string;
  parseNotify(params: Record<string, unknown>): NotifyResult;
}
