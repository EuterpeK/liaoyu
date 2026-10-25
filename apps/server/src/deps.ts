import type { Config } from './config.ts';
import type { DbOrTx } from './db/client.ts';
import type { Clock } from './lib/clock.ts';

export interface BaseDeps {
  config: Config;
  clock: Clock;
  db: DbOrTx;
}

export type Deps = BaseDeps;

export function createDeps(base: BaseDeps): Deps {
  return { ...base };
}
