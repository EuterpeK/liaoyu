const CRISIS_WORDS = ['自杀', '轻生', '不想活', '想死', '活不下去', '结束生命', '割腕', '跳楼', '自残'];
const PRIVATE_WORDS = ['微信', 'vx', 'v信', '加我', '私下', '转账', '支付宝', 'qq'];
const PHONE = /1[3-9]\d{9}/;

export interface ScanResult {
  crisis: string | null;
  privateTrade: string | null;
}

export function scanText(text: string): ScanResult {
  const t = text.toLowerCase();
  const crisis = CRISIS_WORDS.find((k) => t.includes(k)) ?? null;
  const privateTrade = PRIVATE_WORDS.find((k) => t.includes(k)) ?? PHONE.exec(t)?.[0] ?? null;
  return { crisis, privateTrade };
}
