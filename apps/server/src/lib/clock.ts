export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const t = new Date(iso).getTime();
  return { now: () => new Date(t) };
}
