import { hash } from '@node-rs/argon2';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { type AdminRole, admins } from '../../db/schema.ts';
import { HttpError } from '../../lib/errors.ts';
import { pgConstraint } from '../../lib/pg-errors.ts';
import { deleteSessionsOf } from './service.ts';

const PUBLIC = {
  id: admins.id,
  username: admins.username,
  role: admins.role,
  disabledAt: admins.disabledAt,
  createdAt: admins.createdAt,
};

export const listAdmins = (db: DbOrTx) => db.select(PUBLIC).from(admins).orderBy(asc(admins.id));

export async function createAdmin(db: DbOrTx, i: { username: string; password: string; role: AdminRole }) {
  const passwordHash = await hash(i.password);
  try {
    const [a] = await db.insert(admins).values({ username: i.username, passwordHash, role: i.role }).returning(PUBLIC);
    return a;
  } catch (e) {
    if (pgConstraint(e)?.includes('username')) throw new HttpError(409, '用户名已存在');
    throw e;
  }
}

/** 在事务内调用。先锁住所有启用的 super 行，保证「最后一个 super」判断不被并发绕过 */
export async function updateAdmin(
  tx: DbOrTx,
  now: Date,
  actorId: number,
  id: number,
  patch: { role?: AdminRole; disabled?: boolean },
) {
  const supers = await tx
    .select({ id: admins.id })
    .from(admins)
    .where(and(eq(admins.role, 'super'), isNull(admins.disabledAt)))
    .orderBy(asc(admins.id))
    .for('update');
  const [target] = await tx.select().from(admins).where(eq(admins.id, id)).for('update');
  if (!target) throw new HttpError(404, '管理员不存在');

  if (id === actorId && (patch.disabled === true || (patch.role && patch.role !== target.role))) {
    throw new HttpError(400, '不能停用或修改自己的角色');
  }
  const losesSuper =
    supers.some((s) => s.id === id) && ((patch.role && patch.role !== 'super') || patch.disabled === true);
  if (losesSuper && supers.length <= 1) throw new HttpError(400, '至少保留一个启用的超级管理员');

  const set: Partial<typeof admins.$inferInsert> = {};
  if (patch.role) set.role = patch.role;
  if (patch.disabled !== undefined) set.disabledAt = patch.disabled ? now : null;
  if (Object.keys(set).length === 0) throw new HttpError(400, '没有可更新的字段');
  const [row] = await tx.update(admins).set(set).where(eq(admins.id, id)).returning(PUBLIC);
  if (patch.disabled === true) await deleteSessionsOf(tx, id);
  return row;
}

export async function resetPassword(tx: DbOrTx, id: number, password: string): Promise<void> {
  const passwordHash = await hash(password);
  const r = await tx.update(admins).set({ passwordHash }).where(eq(admins.id, id)).returning({ id: admins.id });
  if (r.length === 0) throw new HttpError(404, '管理员不存在');
  await deleteSessionsOf(tx, id);
}
