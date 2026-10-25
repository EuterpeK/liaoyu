import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { DbOrTx } from '../../db/client.ts';
import {
  crisisEvents,
  riskEvents,
  serviceRelations,
  serviceSegments,
  teacherProfiles,
  users,
} from '../../db/schema.ts';
import { scanText } from '../../domain/keywords.ts';
import { segmentOn } from '../../domain/segments.ts';
import { todayCN } from '../../lib/dates.ts';
import { type Notice, notify } from '../../lib/notify.ts';
import { imIdOf } from '../../providers/tencent.ts';
import { loadSegments } from '../relations/service.ts';
import { onMessage } from './replies.ts';

type Relation = typeof serviceRelations.$inferSelect;

export interface ChatLink {
  relation: Relation;
  studentId: number;
  teacherId: number;
  /** 当天负责该关系的老师；暂停日为 null */
  responsible: number | null;
}

async function linkOf(db: DbOrTx, studentId: number, teacherId: number, today: string): Promise<ChatLink | null> {
  const rels = await db
    .select()
    .from(serviceRelations)
    .where(and(eq(serviceRelations.userId, studentId), eq(serviceRelations.status, 'active')))
    .orderBy(asc(serviceRelations.id));
  let found: ChatLink | null = null;
  for (const r of rels) {
    // biome-ignore lint/performance/noAwaitInLoops: 关系数很少，顺序读取即可
    const seg = segmentOn(await loadSegments(db, r.id), today);
    const responsible = seg && seg.kind !== 'paused' ? seg.teacherId : null;
    const isOwner = r.teacherId === teacherId;
    const isSubstitute = seg?.kind === 'substitute' && seg.teacherId === teacherId;
    if (!isOwner && !isSubstitute) continue;
    const link: ChatLink = { relation: r, studentId, teacherId, responsible };
    if (responsible === teacherId) return link;
    found ??= link;
  }
  return found;
}

export async function resolvePair(db: DbOrTx, a: number, b: number, today: string): Promise<ChatLink | null> {
  return (await linkOf(db, a, b, today)) ?? (await linkOf(db, b, a, today));
}

export interface Contact {
  userId: number;
  imId: string;
  role: 'teacher' | 'student';
  substitute: boolean;
  name: string;
}

export async function contactsOf(db: DbOrTx, userId: number, today: string): Promise<Contact[]> {
  const out = new Map<number, Omit<Contact, 'name'>>();
  const add = (id: number, role: Contact['role'], substitute: boolean) => {
    if (!out.has(id)) out.set(id, { userId: id, imId: imIdOf(id), role, substitute });
  };

  const asStudent = await db
    .select({ id: serviceRelations.id, teacherId: serviceRelations.teacherId })
    .from(serviceRelations)
    .where(and(eq(serviceRelations.userId, userId), eq(serviceRelations.status, 'active')))
    .orderBy(asc(serviceRelations.id));
  for (const r of asStudent) {
    add(r.teacherId, 'teacher', false);
    // biome-ignore lint/performance/noAwaitInLoops: 关系数很少，顺序读取即可
    const seg = segmentOn(await loadSegments(db, r.id), today);
    if (seg?.kind === 'substitute' && seg.teacherId !== null) add(seg.teacherId, 'teacher', true);
  }

  const asOwner = await db
    .select({ userId: serviceRelations.userId })
    .from(serviceRelations)
    .where(and(eq(serviceRelations.teacherId, userId), eq(serviceRelations.status, 'active')))
    .orderBy(asc(serviceRelations.id));
  for (const r of asOwner) add(r.userId, 'student', false);

  const asSubstitute = await db
    .select({ userId: serviceRelations.userId })
    .from(serviceRelations)
    .innerJoin(serviceSegments, eq(serviceSegments.relationId, serviceRelations.id))
    .where(
      and(
        eq(serviceRelations.status, 'active'),
        eq(serviceSegments.kind, 'substitute'),
        eq(serviceSegments.teacherId, userId),
        lte(serviceSegments.startDate, today),
        gte(serviceSegments.endDate, today),
      ),
    )
    .orderBy(asc(serviceRelations.id));
  for (const r of asSubstitute) add(r.userId, 'student', true);

  const list = [...out.values()];
  if (list.length === 0) return [];
  const names = await db
    .select({ id: users.id, nickname: users.nickname, displayName: teacherProfiles.displayName })
    .from(users)
    .leftJoin(teacherProfiles, eq(teacherProfiles.userId, users.id))
    .where(
      inArray(
        users.id,
        list.map((c) => c.userId),
      ),
    );
  const byId = new Map(names.map((n) => [n.id, n]));
  return list.map((c) => {
    const n = byId.get(c.userId);
    return { ...c, name: (c.role === 'teacher' ? n?.displayName : n?.nickname) ?? '' };
  });
}

const TextElem = z.object({ MsgType: z.literal('TIMTextElem'), MsgContent: z.object({ Text: z.string() }) });

/** 取出 IM 消息体中的全部文本元素 */
export function textOf(msgBody: unknown): string {
  if (!Array.isArray(msgBody)) return '';
  return msgBody
    .flatMap((e) => {
      const r = TextElem.safeParse(e);
      return r.success ? [r.data.MsgContent.Text] : [];
    })
    .join('\n');
}

const EXCERPT_CHARS = 200;

export async function handleAfterSend(
  db: DbOrTx,
  m: { from: number; to: number; text: string; now: Date; hotline: string },
): Promise<void> {
  const pair = await resolvePair(db, m.from, m.to, todayCN(m.now));
  if (!pair) return;
  const excerpt = [...m.text].slice(0, EXCERPT_CHARS).join('');
  const { crisis, privateTrade } = scanText(m.text);
  await db.transaction(async (tx) => {
    const notices: Notice[] = [];
    if (crisis) {
      const [e] = await tx
        .insert(crisisEvents)
        .values({ userId: m.from, peerId: m.to, keyword: crisis, excerpt, createdAt: m.now })
        .returning({ id: crisisEvents.id });
      notices.push(
        { userId: m.from, type: 'crisis_hotline', payload: { hotline: m.hotline } },
        { userId: m.to, type: 'crisis_alert', payload: { eventId: e.id, fromUserId: m.from } },
      );
    }
    if (privateTrade) {
      await tx
        .insert(riskEvents)
        .values({ fromUserId: m.from, toUserId: m.to, keyword: privateTrade, excerpt, createdAt: m.now });
      notices.push({ userId: m.from, type: 'private_trade_warning', payload: { keyword: privateTrade } });
    }
    await onMessage(tx, pair, m.from, m.now);
    await notify(tx, ...notices);
  });
}
