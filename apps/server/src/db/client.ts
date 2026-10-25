import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema.ts';

// int8 → number：金额以分存储，远小于 2^53
pg.types.setTypeParser(20, (v: string) => Number(v));
// date → 'YYYY-MM-DD' 原样字符串，避免按本地时区换算
pg.types.setTypeParser(1082, (v: string) => v);

export function createDb(url: string, max = 10) {
  return drizzle(new pg.Pool({ connectionString: url, max }), { schema });
}

export type Db = ReturnType<typeof createDb>;

/** 服务函数一律接收 DbOrTx：既可传连接池，也可传事务 */
export type DbOrTx = PgDatabase<NodePgQueryResultHKT, typeof schema>;
