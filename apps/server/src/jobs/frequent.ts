import type { DbOrTx } from '../db/client.ts';
import { autoComplete, autoConfirm, markNoShows } from '../modules/appointments/calls.ts';
import { expireChoices } from '../modules/leaves/choices.ts';

export interface FrequentResult {
  expiredChoices: number;
  noShows: number;
  autoCompleted: number;
  autoConfirmed: number;
}

/** 分钟级任务：顺序执行，均幂等 */
export async function runFrequentJobs(db: DbOrTx, now: Date): Promise<FrequentResult> {
  const expiredChoices = await expireChoices(db, now);
  const noShows = await markNoShows(db, now);
  const autoCompleted = await autoComplete(db, now);
  const autoConfirmed = await autoConfirm(db, now);
  return { expiredChoices, noShows, autoCompleted, autoConfirmed };
}
