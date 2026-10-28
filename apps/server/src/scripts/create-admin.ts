import { loadConfig } from '../config.ts';
import { createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { adminRole } from '../db/schema.ts';
import { upsertAdmin } from '../modules/admin/service.ts';

const [username, password, roleArg = 'super'] = process.argv.slice(2);
const role = adminRole.enumValues.find((r) => r === roleArg);
if (!username || !password || password.length < 10 || !role) {
  console.error('用法: pnpm -F @liaoyu/server create-admin <用户名> <密码(至少10位)> [super|ops|finance]');
  process.exit(1);
}

const db = createDb(loadConfig().databaseUrl, 1);
try {
  await runMigrations(db);
  await upsertAdmin(db, username, password, role);
  console.log(`管理员 ${username}（${role}）已创建/更新`);
} finally {
  await db.$client.end();
}
