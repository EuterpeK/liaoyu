import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './errors.ts';

export interface RateState {
  ok: boolean;
  retryAfterSec: number;
}

export interface RateLimiter {
  /** 计数 +1 并返回是否仍在额度内 */
  hit(key: string): RateState;
  /** 只查看是否已超额，不计数 */
  peek(key: string): RateState;
  reset(key: string): void;
  prune(): void;
  size(): number;
}

interface Entry {
  count: number;
  resetAt: number;
}

const PRUNE_THRESHOLD = 5000;

/** 进程内固定窗口限流；单实例部署足够，多实例需换成共享存储 */
export function createRateLimiter(opts: { max: number; windowMs: number; now?: () => number }): RateLimiter {
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const live = (key: string): Entry | undefined => {
    const e = entries.get(key);
    if (e && e.resetAt <= now()) {
      entries.delete(key);
      return undefined;
    }
    return e;
  };
  const state = (e: Entry | undefined): RateState => ({
    ok: !e || e.count <= opts.max,
    retryAfterSec: e ? Math.max(1, Math.ceil((e.resetAt - now()) / 1000)) : 0,
  });

  const limiter: RateLimiter = {
    hit(key) {
      if (entries.size >= PRUNE_THRESHOLD) limiter.prune();
      let e = live(key);
      if (!e) {
        e = { count: 0, resetAt: now() + opts.windowMs };
        entries.set(key, e);
      }
      e.count += 1;
      return state(e);
    },
    peek(key) {
      const e = live(key);
      // peek 语义：已用满额度即视为被限（下一次 hit 将超额）
      return e && e.count >= opts.max
        ? { ok: false, retryAfterSec: state(e).retryAfterSec }
        : { ok: true, retryAfterSec: 0 };
    },
    reset(key) {
      entries.delete(key);
    },
    prune() {
      const t = now();
      for (const [k, e] of entries) if (e.resetAt <= t) entries.delete(k);
    },
    size: () => entries.size,
  };
  return limiter;
}

export const TOO_MANY = '请求过于频繁，请稍后再试';

export function throwIfLimited(reply: FastifyReply, s: RateState): void {
  if (s.ok) return;
  reply.header('retry-after', String(s.retryAfterSec));
  throw new HttpError(429, TOO_MANY);
}

/** 按来源 IP 限流的 preHandler */
export function ipRateLimit(limiter: RateLimiter) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    throwIfLimited(reply, limiter.hit(req.ip));
  };
}
