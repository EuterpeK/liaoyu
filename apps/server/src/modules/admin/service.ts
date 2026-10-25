import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.ts';
import { adminSessions, admins } from '../../db/schema.ts';

export const ADMIN_COOKIE = 'ly_admin';
export const SESSION_TTL_MS = 12 * 3_600_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function upsertAdmin(db: DbOrTx, username: string, password: string): Promise<number> {
  const passwordHash = await hash(password);
  const [a] = await db
    .insert(admins)
    .values({ username, passwordHash })
    .onConflictDoUpdate({ target: admins.username, set: { passwordHash } })
    .returning({ id: admins.id });
  return a.id;
}

export async function verifyAdminLogin(
  db: DbOrTx,
  username: string,
  password: string,
): Promise<{ id: number; username: string } | null> {
  const [a] = await db.select().from(admins).where(eq(admins.username, username));
  if (!a || !(await verify(a.passwordHash, password))) return null;
  return { id: a.id, username: a.username };
}

export async function createSession(db: DbOrTx, now: Date, adminId: number): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db
    .insert(adminSessions)
    .values({ tokenHash: sha256(token), adminId, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
  return token;
}

export async function resolveSession(db: DbOrTx, now: Date, token: string): Promise<number | null> {
  const [s] = await db
    .select({ adminId: adminSessions.adminId })
    .from(adminSessions)
    .where(and(eq(adminSessions.tokenHash, sha256(token)), gt(adminSessions.expiresAt, now)));
  return s?.adminId ?? null;
}

export async function deleteSession(db: DbOrTx, token: string): Promise<void> {
  await db.delete(adminSessions).where(eq(adminSessions.tokenHash, sha256(token)));
}
