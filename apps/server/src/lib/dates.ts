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

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

export const addMs = (t: Date, ms: number): Date => new Date(t.getTime() + ms);

/** 北京时间 date 日的 minute（自零点起）对应的时刻 */
export const cnTime = (date: string, minute: number): Date => new Date(parse(date) + minute * MINUTE_MS - CN_OFFSET_MS);

export const weekdayOf = (d: string): number => new Date(parse(d)).getUTCDay();

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = parse(s);
  return fmt(t) === s;
}

export const hhmmToMin = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

export const minToHhmm = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
