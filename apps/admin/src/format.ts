const yuanFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 分 → ¥1,234.56 */
export const formatYuan = (cents: number): string => `¥${yuanFmt.format(cents / 100)}`;

const dtFmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** ISO 时间 → 北京时间 YYYY-MM-DD HH:mm:ss；空值显示 — */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dtFmt.format(new Date(iso));
}
