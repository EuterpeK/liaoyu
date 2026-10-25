import { describe, expect, test } from 'vitest';
import {
  applyPause,
  applySubstitute,
  initialSegments,
  inRange,
  pauseFromSubstitute,
  pauseRange,
  type Segment,
  substituteFromPause,
} from './segments.ts';

const seg = (kind: Segment['kind'], teacherId: number | null, startDate: string, endDate: string): Segment => ({
  kind,
  teacherId,
  startDate,
  endDate,
});
const LEAVE = { from: '2026-11-10', to: '2026-11-14', ownerId: 1, blocked: inRange('2026-11-10', '2026-11-14') };
const month = () => initialSegments(1, '2026-11-01', '2026-11-30');
const paused = () => pauseRange(month(), LEAVE);
const short = () => pauseRange(initialSegments(1, '2026-11-01', '2026-11-12'), LEAVE);

describe('请假分段改写', () => {
  test('pauseRange：窗口内正常日改为暂停并顺延，结果与 applyPause 一致', () => {
    expect(paused()).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('paused', null, '2026-11-10', '2026-11-14'),
      seg('normal', 1, '2026-11-15', '2026-12-05'),
    ]);
    expect(paused()).toEqual(applyPause(month(), { from: '2026-11-10', to: '2026-11-14' }));
  });

  test('pauseRange：服务在请假期间到期，顺延日跳过请假日', () => {
    expect(short()).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('paused', null, '2026-11-10', '2026-11-14'),
      seg('normal', 1, '2026-11-15', '2026-11-17'),
    ]);
  });

  test('pauseRange：不移动窗口外已有的代班分段', () => {
    const base = applySubstitute(month(), { from: '2026-11-20', to: '2026-11-21', teacherId: 3 });
    expect(pauseRange(base, { from: '2026-11-10', to: '2026-11-12', ownerId: 1 })).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('paused', null, '2026-11-10', '2026-11-12'),
      seg('normal', 1, '2026-11-13', '2026-11-19'),
      seg('substitute', 3, '2026-11-20', '2026-11-21'),
      seg('normal', 1, '2026-11-22', '2026-12-03'),
    ]);
  });

  test('暂停日部分改为代班，收回等量顺延天数', () => {
    expect(substituteFromPause(paused(), { ...LEAVE, from: '2026-11-12', teacherId: 2 })).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('paused', null, '2026-11-10', '2026-11-11'),
      seg('substitute', 2, '2026-11-12', '2026-11-14'),
      seg('normal', 1, '2026-11-15', '2026-12-02'),
    ]);
  });

  test('服务在请假期间到期：改为代班后结束日恢复原值', () => {
    expect(substituteFromPause(short(), { ...LEAVE, teacherId: 2 })).toEqual([
      seg('normal', 1, '2026-11-01', '2026-11-09'),
      seg('substitute', 2, '2026-11-10', '2026-11-12'),
    ]);
  });

  test('代班改回暂停：与直接暂停结果一致', () => {
    const sub = substituteFromPause(paused(), { ...LEAVE, teacherId: 2 });
    expect(pauseFromSubstitute(sub, { ...LEAVE, teacherId: 2 })).toEqual(paused());
    const shortSub = substituteFromPause(short(), { ...LEAVE, teacherId: 2 });
    expect(pauseFromSubstitute(shortSub, { ...LEAVE, teacherId: 2 })).toEqual(short());
  });

  test('只改写指定代班老师的分段', () => {
    const base = applySubstitute(month(), { from: '2026-11-10', to: '2026-11-10', teacherId: 3 });
    expect(pauseFromSubstitute(base, { from: '2026-11-01', to: '2026-11-30', teacherId: 2, ownerId: 1 })).toEqual(base);
  });

  test('请假已开始后才选代班：从当天起改为代班，已过去的暂停日保留', () => {
    const w = { from: '2026-11-01', to: '2026-11-05', ownerId: 1, blocked: inRange('2026-11-01', '2026-11-05') };
    const p = pauseRange(month(), w);
    expect(substituteFromPause(p, { ...w, from: '2026-11-03', teacherId: 2 })).toEqual([
      seg('paused', null, '2026-11-01', '2026-11-02'),
      seg('substitute', 2, '2026-11-03', '2026-11-05'),
      seg('normal', 1, '2026-11-06', '2026-12-02'),
    ]);
  });
});
