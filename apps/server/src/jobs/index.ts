import type { FastifyBaseLogger } from 'fastify';
import { PgBoss } from 'pg-boss';
import type { DbOrTx } from '../db/client.ts';
import type { Clock } from '../lib/clock.ts';
import { todayCN } from '../lib/dates.ts';
import { runWeeklySettlement } from '../modules/settlement/service.ts';
import { runDailyJobs } from './daily.ts';
import { runFrequentJobs } from './frequent.ts';

export const TZ = 'Asia/Shanghai';

export interface JobContext {
  db: DbOrTx;
  clock: Clock;
  log: Pick<FastifyBaseLogger, 'info' | 'error'>;
}

export interface JobDef {
  name: string;
  cron: string;
  run(ctx: JobContext): Promise<unknown>;
}

export const JOBS: readonly JobDef[] = [
  {
    name: 'daily',
    cron: '10 0 * * *',
    run: ({ db, clock }) => runDailyJobs(db, todayCN(clock.now())),
  },
  {
    name: 'weekly-settlement',
    cron: '0 2 * * 1',
    run: async ({ db, clock }) => ({ created: (await runWeeklySettlement(db, todayCN(clock.now()))).length }),
  },
  {
    name: 'frequent',
    cron: '* * * * *',
    run: ({ db, clock }) => runFrequentJobs(db, clock.now()),
  },
];

/** pg-boss 的最小子集，便于测试替换 */
export interface JobBoss {
  getQueue(name: string): Promise<unknown>;
  createQueue(name: string): Promise<void>;
  work(name: string, handler: (jobs: unknown[]) => Promise<unknown>): Promise<string>;
  schedule(name: string, cron: string, data: object, options: { tz: string }): Promise<void>;
}

/** 连续失败达到该次数时，日志升级为带 alert 标记的告警，便于日志告警规则匹配 */
export const ALERT_AFTER_FAILURES = 3;

export async function registerJobs(boss: JobBoss, ctx: JobContext, jobs: readonly JobDef[] = JOBS): Promise<void> {
  const failures = new Map<string, number>();
  for (const job of jobs) {
    if (!(await boss.getQueue(job.name))) await boss.createQueue(job.name);
    await boss.work(job.name, async () => {
      const startedAt = performance.now();
      const durationMs = () => Math.round(performance.now() - startedAt);
      try {
        const result = await job.run(ctx);
        failures.set(job.name, 0);
        ctx.log.info({ job: job.name, result, durationMs: durationMs() }, '定时任务完成');
        return result;
      } catch (err) {
        const consecutive = (failures.get(job.name) ?? 0) + 1;
        failures.set(job.name, consecutive);
        ctx.log.error(
          {
            job: job.name,
            err,
            durationMs: durationMs(),
            consecutiveFailures: consecutive,
            alert: consecutive >= ALERT_AFTER_FAILURES,
          },
          consecutive >= ALERT_AFTER_FAILURES ? '定时任务连续失败' : '定时任务失败',
        );
        throw err;
      }
    });
    await boss.schedule(job.name, job.cron, {}, { tz: TZ });
  }
}

export async function startJobs(databaseUrl: string, ctx: JobContext): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'pgboss' });
  boss.on('error', (err) => ctx.log.error({ err }, 'pg-boss 错误'));
  await boss.start();
  await registerJobs(boss, ctx);
  return boss;
}
