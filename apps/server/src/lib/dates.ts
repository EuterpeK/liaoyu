const DAY_MS = 86_400_000;
const CN_OFFSET_MS = 8 * 3_600_000;

function parse(d: string): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

const fmt = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (d: string, n: number): string => fmt(parse(d) + n * DAY_MS);

export const diffDays = (a: string, b: string): number => Math.round((parse(b) - parse(a)) / DAY_MS);

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export const todayCN = (now: Date): string => fmt(now.getTime() + CN_OFFSET_MS);

export const dayStartCN = (d: string): Date => new Date(parse(d) - CN_OFFSET_MS);

export const formatDateTimeCN = (t: Date): string =>
  new Date(t.getTime() + CN_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');

export function previousWeek(today: string): [string, string] {
  const dow = new Date(parse(today)).getUTCDay();
  const monday = addDays(today, -((dow + 6) % 7));
  return [addDays(monday, -7), addDays(monday, -1)];
}
