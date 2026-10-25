import { addDays, diffDays, eachDay } from '../lib/dates.ts';

export type SegmentKind = 'normal' | 'substitute' | 'paused';

export interface Segment {
  kind: SegmentKind;
  teacherId: number | null;
  startDate: string;
  endDate: string;
}

interface Day {
  date: string;
  kind: SegmentKind;
  teacherId: number | null;
}

function expand(segments: readonly Segment[]): Day[] {
  return segments.flatMap((s) =>
    eachDay(s.startDate, s.endDate).map((date) => ({ date, kind: s.kind, teacherId: s.teacherId })),
  );
}

function compress(days: readonly Day[]): Segment[] {
  const out: Segment[] = [];
  for (const d of days) {
    const last = out.at(-1);
    if (last && last.kind === d.kind && last.teacherId === d.teacherId && addDays(last.endDate, 1) === d.date) {
      last.endDate = d.date;
    } else {
      out.push({ kind: d.kind, teacherId: d.teacherId, startDate: d.date, endDate: d.date });
    }
  }
  return out;
}

export const initialSegments = (teacherId: number, startDate: string, endDate: string): Segment[] => [
  { kind: 'normal', teacherId, startDate, endDate },
];

export function applySubstitute(
  segments: readonly Segment[],
  { from, to, teacherId }: { from: string; to: string; teacherId: number },
): Segment[] {
  return compress(
    expand(segments).map((d) =>
      d.date >= from && d.date <= to && d.kind === 'normal' ? { ...d, kind: 'substitute', teacherId } : d,
    ),
  );
}

export function applyPause(segments: readonly Segment[], { from, to }: { from: string; to: string }): Segment[] {
  const days = expand(segments);
  const idx = days.findIndex((d) => d.date >= from);
  if (idx === -1) throw new Error('暂停起始日不在服务期内');
  const paused: Omit<Day, 'date'>[] = Array.from({ length: diffDays(from, to) + 1 }, () => ({
    kind: 'paused',
    teacherId: null,
  }));
  const seq = [...days.slice(0, idx), ...paused, ...days.slice(idx)];
  const start = segments[0].startDate;
  return compress(seq.map((d, i) => ({ kind: d.kind, teacherId: d.teacherId, date: addDays(start, i) })));
}

export const segmentOn = (segments: readonly Segment[], date: string): Segment | null =>
  segments.find((s) => s.startDate <= date && date <= s.endDate) ?? null;

export function activeDayIndex(segments: readonly Segment[], date: string): number {
  let n = 0;
  for (const s of segments) {
    if (s.kind === 'paused') continue;
    if (s.endDate < date) n += diffDays(s.startDate, s.endDate) + 1;
    else if (s.startDate < date) n += diffDays(s.startDate, date);
  }
  return n;
}

export type DayPredicate = (date: string) => boolean;

const NEVER: DayPredicate = () => false;

export const inRange =
  (from: string, to: string): DayPredicate =>
  (d) =>
    d >= from && d <= to;

const countActive = (days: readonly Day[]): number => days.filter((d) => d.kind !== 'paused').length;

/** 调整尾部，让非暂停天数恢复为 span：多了从尾部裁掉；少了在尾部补原老师正常日（遇到 blocked 日补暂停日） */
function fitSpan(days: readonly Day[], span: number, ownerId: number, blocked: DayPredicate): Day[] {
  const out = days.slice();
  let active = countActive(out);
  while (active > span) {
    const d = out.pop();
    if (d && d.kind !== 'paused') active -= 1;
  }
  while (active < span) {
    const last = out.at(-1);
    if (!last) throw new Error('分段不能为空');
    const date = addDays(last.date, 1);
    if (blocked(date)) {
      out.push({ date, kind: 'paused', teacherId: null });
    } else {
      out.push({ date, kind: 'normal', teacherId: ownerId });
      active += 1;
    }
  }
  while (out.at(-1)?.kind === 'paused') out.pop();
  return out;
}

export interface LeaveWindow {
  from: string;
  to: string;
  /** 原老师（服务关系的购买对象） */
  ownerId: number;
  /** 原老师的请假日，尾部补齐时跳过 */
  blocked?: DayPredicate;
}

interface RemapOptions extends LeaveWindow {
  match: (d: Day) => boolean;
  into: Pick<Day, 'kind' | 'teacherId'>;
}

function remap(
  segments: readonly Segment[],
  { from, to, match, into, ownerId, blocked = NEVER }: RemapOptions,
): Segment[] {
  const days = expand(segments);
  const span = countActive(days);
  const mapped = days.map((d) => (d.date >= from && d.date <= to && match(d) ? { ...d, ...into } : d));
  return compress(fitSpan(mapped, span, ownerId, blocked));
}

export const pauseRange = (segments: readonly Segment[], w: LeaveWindow): Segment[] =>
  remap(segments, {
    ...w,
    blocked: w.blocked ?? inRange(w.from, w.to),
    match: (d) => d.kind === 'normal' && d.teacherId === w.ownerId,
    into: { kind: 'paused', teacherId: null },
  });

export const substituteFromPause = (segments: readonly Segment[], w: LeaveWindow & { teacherId: number }): Segment[] =>
  remap(segments, {
    ...w,
    match: (d) => d.kind === 'paused',
    into: { kind: 'substitute', teacherId: w.teacherId },
  });

export const pauseFromSubstitute = (segments: readonly Segment[], w: LeaveWindow & { teacherId: number }): Segment[] =>
  remap(segments, {
    ...w,
    match: (d) => d.kind === 'substitute' && d.teacherId === w.teacherId,
    into: { kind: 'paused', teacherId: null },
  });
