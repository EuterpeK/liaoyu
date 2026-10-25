const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (FORMULA_PREFIX.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return `\ufeff${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}
