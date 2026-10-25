interface PgLikeError {
  code?: string;
  constraint?: string;
}

/** 从 Drizzle 包裹的错误里取出原始 pg 错误的约束名 */
export function pgConstraint(err: unknown): string | null {
  const e = (err instanceof Error && err.cause ? err.cause : err) as PgLikeError | null;
  return typeof e?.code === 'string' && e.code.startsWith('23') ? (e.constraint ?? null) : null;
}
