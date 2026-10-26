import { and, arrayContains, asc, desc, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { packages, type TeacherStatus, teacherProfiles } from '../../db/schema.ts';
import type { Clock } from '../../lib/clock.ts';
import { decryptField, encryptField } from '../../lib/crypto.ts';
import { HttpError } from '../../lib/errors.ts';

export interface ApplyInput {
  displayName: string;
  realName: string;
  intro: string;
  directions: string[];
  credentials: string[];
}

export async function applyTeacher(db: DbOrTx, fieldKey: string, userId: number, input: ApplyInput): Promise<void> {
  const values = {
    displayName: input.displayName,
    realNameEnc: encryptField(fieldKey, input.realName),
    intro: input.intro,
    directions: input.directions,
    credentials: input.credentials,
    status: 'pending' as const,
    reviewedAt: null,
  };
  const rows = await db
    .insert(teacherProfiles)
    .values({ userId, ...values })
    .onConflictDoUpdate({
      target: teacherProfiles.userId,
      set: values,
      setWhere: eq(teacherProfiles.status, 'rejected'),
    })
    .returning({ userId: teacherProfiles.userId });
  if (rows.length === 0) throw new HttpError(409, '已提交过入驻申请');
}

export async function requireActiveTeacher(db: DbOrTx, userId: number): Promise<{ level: number }> {
  const [t] = await db
    .select({ level: teacherProfiles.level, status: teacherProfiles.status })
    .from(teacherProfiles)
    .where(eq(teacherProfiles.userId, userId));
  if (t?.status !== 'active') throw new HttpError(403, '仅已认证老师可操作');
  return { level: t.level };
}

/** 锁定老师资料行；mode 决定锁强度，必须全项目统一加锁顺序以避免死锁 */
export async function lockTeacher(
  db: DbOrTx,
  userId: number,
  mode: 'update' | 'share' = 'update',
): Promise<{ level: number; status: TeacherStatus } | undefined> {
  const rows = await db
    .select({ level: teacherProfiles.level, status: teacherProfiles.status })
    .from(teacherProfiles)
    .where(eq(teacherProfiles.userId, userId))
    .for(mode);
  return rows[0];
}

export async function listTeachersForAdmin(db: DbOrTx, fieldKey: string, status?: TeacherStatus) {
  const rows = await db
    .select()
    .from(teacherProfiles)
    .where(status ? eq(teacherProfiles.status, status) : undefined)
    .orderBy(asc(teacherProfiles.createdAt), asc(teacherProfiles.userId));
  return rows.map(({ realNameEnc, ...rest }) => ({ ...rest, realName: decryptField(fieldKey, realNameEnc) }));
}

export async function reviewTeacher(db: DbOrTx, clock: Clock, userId: number, d: { approve: boolean; level?: number }) {
  if (d.approve && (d.level === undefined || d.level < 1 || d.level > 3)) throw new HttpError(400, '初始等级须为 1~3');
  const set = d.approve
    ? { status: 'active' as const, level: d.level, reviewedAt: clock.now() }
    : { status: 'rejected' as const, reviewedAt: clock.now() };
  const [row] = await db
    .update(teacherProfiles)
    .set(set)
    .where(and(eq(teacherProfiles.userId, userId), eq(teacherProfiles.status, 'pending')))
    .returning({ userId: teacherProfiles.userId, status: teacherProfiles.status, level: teacherProfiles.level });
  if (row) return row;
  const [exists] = await db
    .select({ userId: teacherProfiles.userId })
    .from(teacherProfiles)
    .where(eq(teacherProfiles.userId, userId));
  throw exists ? new HttpError(409, '该申请不在待审核状态') : new HttpError(404, '申请不存在');
}

const minPriceCents = sql<number | null>`(
  SELECT MIN(${packages.priceCents}) FROM ${packages}
  WHERE ${packages.teacherId} = ${teacherProfiles.userId} AND ${packages.onSale}
)`;

const publicColumns = {
  id: teacherProfiles.userId,
  displayName: teacherProfiles.displayName,
  intro: teacherProfiles.intro,
  directions: teacherProfiles.directions,
  level: teacherProfiles.level,
  minPriceCents,
};

export async function listPublicTeachers(db: DbOrTx, f: { direction?: string; level?: number }) {
  return db
    .select(publicColumns)
    .from(teacherProfiles)
    .where(
      and(
        eq(teacherProfiles.status, 'active'),
        f.direction ? arrayContains(teacherProfiles.directions, [f.direction]) : undefined,
        f.level ? eq(teacherProfiles.level, f.level) : undefined,
      ),
    )
    .orderBy(desc(teacherProfiles.level), asc(teacherProfiles.userId));
}

export async function getPublicTeacher(db: DbOrTx, id: number) {
  const [t] = await db
    .select(publicColumns)
    .from(teacherProfiles)
    .where(and(eq(teacherProfiles.userId, id), eq(teacherProfiles.status, 'active')));
  if (!t) throw new HttpError(404, '老师不存在');
  const pkgs = await db
    .select({
      id: packages.id,
      type: packages.type,
      title: packages.title,
      priceCents: packages.priceCents,
      days: packages.days,
      callQuota: packages.callQuota,
      replyHours: packages.replyHours,
    })
    .from(packages)
    .where(and(eq(packages.teacherId, id), eq(packages.onSale, true)))
    .orderBy(asc(packages.priceCents));
  return { ...t, packages: pkgs };
}
