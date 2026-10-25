import { createDb, type Db } from '../src/db/client.ts';
import { TEST_DATABASE_URL } from './test-env.ts';

let shared: Db | undefined;

export function testDb(): Db {
  shared ??= createDb(TEST_DATABASE_URL, 10);
  return shared;
}

export async function closeTestDb(): Promise<void> {
  if (!shared) return;
  const db = shared;
  shared = undefined;
  await db.$client.end();
}

export async function resetDb(db: Db): Promise<void> {
  const { rows } = await db.$client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length === 0) return;
  await db.$client.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export interface PgErrorInfo {
  code?: string;
  constraint?: string;
  message: string;
}

/** 断言 Promise 被数据库拒绝，并返回原始 pg 错误（兼容 Drizzle 的错误包装） */
export async function pgError(p: PromiseLike<unknown>): Promise<PgErrorInfo> {
  try {
    await p;
  } catch (e) {
    const inner = e instanceof Error && e.cause instanceof Error ? e.cause : e;
    return inner as PgErrorInfo;
  }
  throw new Error('预期数据库报错，但执行成功');
}
