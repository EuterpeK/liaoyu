import { createDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { TEST_DATABASE_URL } from './test-env.ts';

export default async function globalSetup(): Promise<void> {
  const db = createDb(TEST_DATABASE_URL, 1);
  try {
    await db.$client.query(
      'DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;',
    );
    await runMigrations(db);
  } finally {
    await db.$client.end();
  }
}
