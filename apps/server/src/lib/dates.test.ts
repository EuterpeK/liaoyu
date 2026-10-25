import { describe, expect, test } from 'vitest';
import { addDays, dayStartCN, diffDays, eachDay, formatDateTimeCN, previousWeek, todayCN } from './dates.ts';

describe('dates', () => {
  test('addDays 跨月', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  test('diffDays 与 eachDay', () => {
    expect(diffDays('2026-02-27', '2026-03-01')).toBe(2);
    expect(eachDay('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(eachDay('2026-03-02', '2026-03-01')).toEqual([]);
  });

  test('todayCN 按北京时间取日期', () => {
    expect(todayCN(new Date('2026-10-24T16:00:00Z'))).toBe('2026-10-25');
    expect(todayCN(new Date('2026-10-24T15:59:59Z'))).toBe('2026-10-24');
  });

  test('dayStartCN 返回北京时间当日零点', () => {
    expect(dayStartCN('2026-11-01').toISOString()).toBe('2026-10-31T16:00:00.000Z');
  });

  test('formatDateTimeCN 输出北京时间', () => {
    expect(formatDateTimeCN(new Date('2026-11-01T04:00:00Z'))).toBe('2026-11-01 12:00:00');
  });

  test('previousWeek 返回上周一到上周日', () => {
    expect(previousWeek('2026-11-09')).toEqual(['2026-11-02', '2026-11-08']);
    expect(previousWeek('2026-11-15')).toEqual(['2026-11-02', '2026-11-08']);
  });
});
