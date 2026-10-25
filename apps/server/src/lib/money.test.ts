import { describe, expect, test } from 'vitest';
import { centsToYuan, commissionOf, splitEvenly, yuanToCents } from './money.ts';

describe('money', () => {
  test('splitEvenly 余数分摊到前几天且总和不变', () => {
    expect([0, 1, 2].map((i) => splitEvenly(1000, 3, i))).toEqual([334, 333, 333]);
    let sum = 0;
    for (let i = 0; i < 30; i++) sum += splitEvenly(1000, 30, i);
    expect(sum).toBe(1000);
  });

  test('centsToYuan', () => {
    expect(centsToYuan(1999)).toBe('19.99');
    expect(centsToYuan(3000)).toBe('30.00');
  });

  test('yuanToCents 严格解析，不经过浮点', () => {
    expect(yuanToCents('19.99')).toBe(1999);
    expect(yuanToCents('30')).toBe(3000);
    expect(yuanToCents('0.1')).toBe(10);
    for (const bad of ['', 'abc', '1.234', '-1', '1e3', ' 1']) expect(yuanToCents(bad)).toBeNull();
  });

  test('commissionOf 按基点四舍五入', () => {
    expect(commissionOf(700, 2000)).toBe(140);
    expect(commissionOf(333, 2000)).toBe(67);
  });
});
