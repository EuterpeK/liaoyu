import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { type TeacherStatus, teacherProfiles } from '../../db/schema.ts';
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
    .onConflictDoUpdate({ target: teacherProfiles.userId, set: values, setWhere: eq(teacherProfiles.status, 'rejected') })
    .returning({ userId: teacherProfiles.userId });
  if (rows.length === 0) throw new HttpError(409, '已提交过入驻申请');
}

export async function requireActiveTeacher(db: DbOrTx, userId: number): Promise<{ level: number }> {
  const [t] = await db
    .select({ level: teacherProfiles.level, status: teacherProfiles.status })
    .from(teacherProfiles)
    .where(eq(teacherProfiles.userId, userId));
  if (!t || t.status !== 'active') throw new HttpError(403, '仅已认证老师可操作');
  return { level: t.level };
}

export async function listTeachersForAdmin(db: DbOrTx, fieldKey: string, status?: TeacherStatus) {
  const rows = await db
    .select()
    .from(teacherProfiles)
    .where(status ? eq(teacherProfiles.status, status) : undefined)
    .orderBy(asc(teacherProfiles.createdAt), asc(teacherProfiles.userId));
  return rows.map(({ realNameEnc, ...rest }) => ({ ...rest, realName: decryptField(fieldKey, realNameEnc) }));
}

export async function reviewTeacher(
  db: DbOrTx,
  clock: Clock,
  userId: number,
  d: { approve: boolean; level?: number },
) {
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
