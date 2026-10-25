import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { buyAndPay, insertPackage, insertTeacher, insertUser, setup } from '../../../tests/helpers.ts';
import { serviceRelations } from '../../db/schema.ts';
import { applyPause, applySubstitute } from '../../domain/segments.ts';
import { loadSegments, rewriteSegments } from './service.ts';

describe('改写服务分段', () => {
  test('改写后同步服务关系结束日', async () => {
    const ctx = await setup();
    const t = await insertTeacher(ctx.db, 't');
    const rel = await buyAndPay(ctx, await insertUser(ctx.db, 'u'), await insertPackage(ctx.db, t));
    await rewriteSegments(ctx.db, rel.id, (s) => applyPause(s, { from: '2026-11-10', to: '2026-11-14' }));
    const [r] = await ctx.db.select().from(serviceRelations).where(eq(serviceRelations.id, rel.id));
    expect(r.endDate).toBe('2026-12-05');
  });

  test('并发改写串行执行，不丢失任何一次修改', async () => {
    const ctx = await setup();
    const t = await insertTeacher(ctx.db, 't');
    const sub = await insertTeacher(ctx.db, 's');
    const rel = await buyAndPay(ctx, await insertUser(ctx.db, 'u'), await insertPackage(ctx.db, t));
    await Promise.all([
      rewriteSegments(ctx.db, rel.id, (s) => applyPause(s, { from: '2026-11-10', to: '2026-11-14' })),
      rewriteSegments(ctx.db, rel.id, (s) =>
        applySubstitute(s, { from: '2026-11-20', to: '2026-11-22', teacherId: sub }),
      ),
    ]);
    const segs = await loadSegments(ctx.db, rel.id);
    expect(segs.filter((s) => s.kind === 'paused')).toHaveLength(1);
    expect(segs.filter((s) => s.kind === 'substitute')).toHaveLength(1);
    expect(segs.at(-1)?.endDate).toBe('2026-12-05');
  });

  test('服务关系不存在返回 404', async () => {
    const ctx = await setup();
    await expect(rewriteSegments(ctx.db, 999, (s) => s)).rejects.toThrow(/不存在/);
  });
});
