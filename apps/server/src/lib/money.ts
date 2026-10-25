export function splitEvenly(totalCents: number, n: number, index: number): number {
  const base = Math.floor(totalCents / n);
  return base + (index < totalCents - base * n ? 1 : 0);
}

export const centsToYuan = (cents: number): string => (cents / 100).toFixed(2);

export function yuanToCents(s: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export const commissionOf = (grossCents: number, bps: number): number => Math.round((grossCents * bps) / 10_000);
