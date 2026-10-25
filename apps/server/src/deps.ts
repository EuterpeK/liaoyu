import type { Config } from './config.ts';
import type { DbOrTx } from './db/client.ts';
import type { Clock } from './lib/clock.ts';
import { createWechat, type Wechat } from './providers/wechat.ts';

export interface BaseDeps {
  config: Config;
  clock: Clock;
  db: DbOrTx;
}

export interface Deps extends BaseDeps {
  wechat: Wechat;
}

export function createDeps(base: BaseDeps): Deps {
  return { ...base, wechat: createWechat(base.config.wx) };
}
