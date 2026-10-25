import { loadConfig } from '../config.ts';
import { createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { upsertAdmin } from '../modules/admin/service.ts';

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 10) {
  console.error('用法: pnpm -F @liaoyu/server create-admin <用户名> <密码(至少10位)>');
  process.exit(1);
}

const db = createDb(loadConfig().databaseUrl, 1);
try {
  await runMigrations(db);
  await upsertAdmin(db, username, password);
  console.log(`管理员 ${username} 已创建/更新`);
} finally {
  await db.$client.end();
}
