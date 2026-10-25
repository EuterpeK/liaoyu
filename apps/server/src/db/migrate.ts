import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.ts';

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)) });
}
