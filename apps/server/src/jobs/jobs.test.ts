import { describe, expect, test, vi } from 'vitest';
import { buyAndPay, insertPackage, insertTeacher, insertUser, setup } from '../../tests/helpers.ts';
import { fixedClock } from '../lib/clock.ts';
import { JOBS, type JobBoss, type JobContext, registerJobs, TZ } from './index.ts';

type Handler = (jobs: unknown[]) => Promise<unknown>;

function fakeBoss(existing: string[] = []) {
  const queues = new Set(existing);
  const created: string[] = [];
  const handlers = new Map<string, Handler>();
  const schedules: { name: string; cron: string; tz: string }[] = [];
  const boss: JobBoss = {
    getQueue: async (name) => (queues.has(name) ? { name } : null),
    createQueue: async (name) => {
      queues.add(name);
      created.push(name);
    },
    work: async (name, handler) => {
      handlers.set(name, handler);
      return name;
    },
    schedule: async (name, cron, _data, options) => {
      schedules.push({ name, cron, tz: options.tz });
    },
  };
  return { boss, created, handlers, schedules };
}

const fakeLog = () => ({ info: vi.fn(), error: vi.fn() });

describe('定时任务', () => {
  test('任务清单与调度时间', () => {
    expect(JOBS.map((j) => [j.name, j.cron])).toEqual([
      ['daily', '10 0 * * *'],
      ['weekly-settlement', '0 2 * * 1'],
    ]);
    expect(TZ).toBe('Asia/Shanghai');
  });

  test('注册：缺失的队列才创建，按北京时间调度；daily 处理器计提并结束到期关系', async () => {
    const ctx = await setup();
    const t = await insertTeacher(ctx.db, 't');
    await buyAndPay(ctx, await insertUser(ctx.db, 'u'), await insertPackage(ctx.db, t));

    const f = fakeBoss(['daily']);
    const log = fakeLog();
    const jobCtx: JobContext = { db: ctx.db, clock: fixedClock('2026-12-01T04:00:00Z'), log };
    await registerJobs(f.boss, jobCtx);

    expect(f.created).toEqual(['weekly-settlement']);
    expect(f.schedules).toEqual([
      { name: 'daily', cron: '10 0 * * *', tz: TZ },
      { name: 'weekly-settlement', cron: '0 2 * * 1', tz: TZ },
    ]);
    expect(await f.handlers.get('daily')?.([])).toEqual({ accrued: 30, ended: 1 });
    expect(log.info).toHaveBeenCalled();
  });

  test('任务失败：记录错误并抛出，交给 pg-boss 重试', async () => {
    const ctx = await setup();
    const f = fakeBoss();
    const log = fakeLog();
    const boom = {
      name: 'boom',
      cron: '* * * * *',
      run: async () => {
        throw new Error('炸了');
      },
    };
    await registerJobs(f.boss, { db: ctx.db, clock: ctx.clock, log }, [boom]);
    await expect(f.handlers.get('boom')?.([])).rejects.toThrow('炸了');
    expect(log.error).toHaveBeenCalled();
  });
});
