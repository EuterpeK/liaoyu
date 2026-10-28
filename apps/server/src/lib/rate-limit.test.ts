import { describe, expect, test } from 'vitest';
import { createRateLimiter } from './rate-limit.ts';

function limiter(max: number, windowMs: number) {
  let t = 0;
  const l = createRateLimiter({ max, windowMs, now: () => t });
  return { l, advance: (ms: number) => (t += ms) };
}

describe('固定窗口限流器', () => {
  test('窗口内超过上限被拒绝并给出重试秒数', () => {
    const { l } = limiter(2, 60_000);
    expect(l.hit('a').ok).toBe(true);
    expect(l.hit('a').ok).toBe(true);
    const third = l.hit('a');
    expect(third.ok).toBe(false);
    expect(third.retryAfterSec).toBe(60);
  });

  test('不同 key 互不影响', () => {
    const { l } = limiter(1, 1000);
    expect(l.hit('a').ok).toBe(true);
    expect(l.hit('b').ok).toBe(true);
    expect(l.hit('a').ok).toBe(false);
  });

  test('窗口过期后重新计数', () => {
    const { l, advance } = limiter(1, 1000);
    l.hit('a');
    expect(l.hit('a').ok).toBe(false);
    advance(1001);
    expect(l.hit('a').ok).toBe(true);
  });

  test('peek 不计数；reset 清除计数', () => {
    const { l } = limiter(1, 1000);
    expect(l.peek('a').ok).toBe(true);
    expect(l.peek('a').ok).toBe(true);
    l.hit('a');
    expect(l.peek('a').ok).toBe(false);
    l.reset('a');
    expect(l.peek('a').ok).toBe(true);
  });

  test('过期条目会被清理，避免内存无限增长', () => {
    const { l, advance } = limiter(1, 1000);
    for (let i = 0; i < 50; i++) l.hit(`k${i}`);
    expect(l.size()).toBe(50);
    advance(2000);
    l.prune();
    expect(l.size()).toBe(0);
  });
});
