import { describe, expect, test } from 'vitest';
import { activeDayIndex, applyPause, applySubstitute, initialSegments, segmentOn } from './segments.ts';

const base = () => initialSegments(1, '2026-11-01', '2026-11-30');

describe('服务分段', () => {
  test('代班：中间插入代班分段', () => {
    expect(applySubstitute(base(), { from: '2026-11-10', to: '2026-11-12', teacherId: 2 })).toEqual([
      { kind: 'normal', teacherId: 1, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'substitute', teacherId: 2, startDate: '2026-11-10', endDate: '2026-11-12' },
      { kind: 'normal', teacherId: 1, startDate: '2026-11-13', endDate: '2026-11-30' },
    ]);
  });

  test('暂停：插入暂停分段并整体顺延', () => {
    expect(applyPause(base(), { from: '2026-11-10', to: '2026-11-14' })).toEqual([
      { kind: 'normal', teacherId: 1, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'paused', teacherId: null, startDate: '2026-11-10', endDate: '2026-11-14' },
      { kind: 'normal', teacherId: 1, startDate: '2026-11-15', endDate: '2026-12-05' },
    ]);
  });

  test('代班不覆盖暂停日', () => {
    const paused = applyPause(base(), { from: '2026-11-10', to: '2026-11-14' });
    const segs = applySubstitute(paused, { from: '2026-11-12', to: '2026-11-16', teacherId: 2 });
    expect(segs).toEqual([
      { kind: 'normal', teacherId: 1, startDate: '2026-11-01', endDate: '2026-11-09' },
      { kind: 'paused', teacherId: null, startDate: '2026-11-10', endDate: '2026-11-14' },
      { kind: 'substitute', teacherId: 2, startDate: '2026-11-15', endDate: '2026-11-16' },
      { kind: 'normal', teacherId: 1, startDate: '2026-11-17', endDate: '2026-12-05' },
    ]);
  });

  test('暂停起始日晚于服务期则报错', () => {
    expect(() => applyPause(base(), { from: '2026-12-01', to: '2026-12-02' })).toThrow();
  });

  test('segmentOn 与 activeDayIndex 跳过暂停日', () => {
    const segs = applyPause(base(), { from: '2026-11-10', to: '2026-11-14' });
    expect(segmentOn(segs, '2026-11-12')?.kind).toBe('paused');
    expect(segmentOn(segs, '2026-12-06')).toBeNull();
    expect(activeDayIndex(segs, '2026-11-01')).toBe(0);
    expect(activeDayIndex(segs, '2026-11-15')).toBe(9);
    expect(activeDayIndex(segs, '2026-12-05')).toBe(29);
  });
});
