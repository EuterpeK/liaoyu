import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { type PackageType, packages } from '../../db/schema.ts';
import { HttpError } from '../../lib/errors.ts';
import { requireActiveTeacher } from '../teachers/service.ts';

export const PACKAGE_DAYS: Record<PackageType, number> = { single: 0, month: 30, quarter: 90, year: 365 };

export interface CreatePackageInput {
  type: PackageType;
  title: string;
  priceCents: number;
  callQuota: number;
  replyHours: number;
}

export async function createPackage(db: DbOrTx, teacherId: number, input: CreatePackageInput) {
  const t = await requireActiveTeacher(db, teacherId);
  if (input.type === 'year' && t.level < 3) throw new HttpError(403, '年包仅 L3 及以上老师可开放');
  const [p] = await db
    .insert(packages)
    .values({
      teacherId,
      ...input,
      days: PACKAGE_DAYS[input.type],
      callQuota: input.type === 'single' ? 1 : input.callQuota,
    })
    .returning();
  return p;
}

export async function listOwnPackages(db: DbOrTx, teacherId: number) {
  await requireActiveTeacher(db, teacherId);
  return db.select().from(packages).where(eq(packages.teacherId, teacherId)).orderBy(asc(packages.id));
}

export async function updateOwnPackage(
  db: DbOrTx,
  teacherId: number,
  id: number,
  patch: { onSale?: boolean; priceCents?: number; title?: string },
) {
  await requireActiveTeacher(db, teacherId);
  const [p] = await db
    .update(packages)
    .set(patch)
    .where(and(eq(packages.id, id), eq(packages.teacherId, teacherId)))
    .returning();
  if (!p) throw new HttpError(404, '套餐不存在');
  return p;
}
