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
