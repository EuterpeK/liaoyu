import { describe, expect, test } from 'vitest';
import { formatDateTime, formatYuan } from './format.ts';

describe('format', () => {
  test('formatYuan：分 → ¥ 千分位两位小数', () => {
    expect(formatYuan(0)).toBe('¥0.00');
    expect(formatYuan(5)).toBe('¥0.05');
    expect(formatYuan(123456)).toBe('¥1,234.56');
  });
  test('formatDateTime：空值 —，ISO 转北京时间', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('2026-11-01T04:00:00Z')).toBe('2026-11-01 12:00:00');
  });
});
