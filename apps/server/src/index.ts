import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { createDeps } from './deps.ts';
import { startJobs } from './jobs/index.ts';
import { systemClock } from './lib/clock.ts';

const config = loadConfig();
const db = createDb(config.databaseUrl);
await runMigrations(db);

const deps = createDeps({ config, clock: systemClock, db });
const app = await buildApp(deps);
const boss = await startJobs(config.databaseUrl, { db, clock: systemClock, log: app.log });

if (deps.payment.isMock) app.log.warn('ZPAY 未配置，支付走 MOCK 收银台');
if (deps.wechat.isMock) app.log.warn('微信未配置，登录走 MOCK');

await app.listen({ host: '0.0.0.0', port: config.port });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, '正在关闭');
  try {
    await app.close();
    await boss.stop({ graceful: true, timeout: 10_000 });
    await db.$client.end();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, '关闭失败');
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
