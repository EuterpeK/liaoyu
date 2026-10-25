import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const money = (name: string) => bigint(name, { mode: 'number' });
const day = (name: string) => date(name, { mode: 'string' });
const tstz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => tstz('created_at').notNull().defaultNow();
const id = () => integer('id').primaryKey().generatedAlwaysAsIdentity();

export const teacherStatus = pgEnum('teacher_status', ['pending', 'active', 'rejected', 'disabled']);
export const packageType = pgEnum('package_type', ['single', 'month', 'quarter', 'year']);
export const orderStatus = pgEnum('order_status', ['pending', 'paid']);
export const relationStatus = pgEnum('relation_status', ['active', 'ended', 'refunded', 'switched']);
export const segmentKind = pgEnum('segment_kind', ['normal', 'substitute', 'paused']);
export const settlementStatus = pgEnum('settlement_status', ['pending', 'paid']);

export type TeacherStatus = (typeof teacherStatus.enumValues)[number];
export type PackageType = (typeof packageType.enumValues)[number];

export interface PackageSnapshot {
  type: PackageType;
  title: string;
  priceCents: number;
  days: number;
  callQuota: number;
  replyHours: number;
}

export const users = pgTable('users', {
  id: id(),
  openid: text('openid').notNull().unique(),
  nickname: text('nickname').notNull().default(''),
  createdAt: createdAt(),
});

export const admins = pgTable('admins', {
  id: id(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
});

export const adminSessions = pgTable('admin_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  adminId: integer('admin_id')
    .notNull()
    .references(() => admins.id, { onDelete: 'cascade' }),
  expiresAt: tstz('expires_at').notNull(),
  createdAt: createdAt(),
});

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  adminId: integer('admin_id').references(() => admins.id),
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
});

export const teacherProfiles = pgTable(
  'teacher_profiles',
  {
    userId: integer('user_id')
      .primaryKey()
      .references(() => users.id),
    displayName: text('display_name').notNull(),
    realNameEnc: text('real_name_enc').notNull(),
    intro: text('intro').notNull().default(''),
    directions: text('directions').array().notNull().default(sql`'{}'::text[]`),
    credentials: text('credentials').array().notNull().default(sql`'{}'::text[]`),
    level: integer('level').notNull().default(0),
    status: teacherStatus('status').notNull().default('pending'),
    createdAt: createdAt(),
    reviewedAt: tstz('reviewed_at'),
  },
  (t) => [check('teacher_level_range', sql`${t.level} BETWEEN 0 AND 5`)],
);

export const packages = pgTable(
  'packages',
  {
    id: id(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    type: packageType('type').notNull(),
    title: text('title').notNull(),
    priceCents: money('price_cents').notNull(),
    days: integer('days').notNull(),
    callQuota: integer('call_quota').notNull().default(0),
    replyHours: integer('reply_hours').notNull().default(24),
    onSale: boolean('on_sale').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [check('package_price_positive', sql`${t.priceCents} > 0`), index('packages_teacher_idx').on(t.teacherId)],
);

export const orders = pgTable(
  'orders',
  {
    id: id(),
    outTradeNo: text('out_trade_no').notNull().unique(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    packageId: integer('package_id')
      .notNull()
      .references(() => packages.id),
    packageSnapshot: jsonb('package_snapshot').$type<PackageSnapshot>().notNull(),
    amountCents: money('amount_cents').notNull(),
    payProvider: text('pay_provider').notNull(),
    status: orderStatus('status').notNull().default('pending'),
    tradeNo: text('trade_no'),
    paidAt: tstz('paid_at'),
    createdAt: createdAt(),
  },
  (t) => [index('orders_user_idx').on(t.userId), index('orders_teacher_idx').on(t.teacherId)],
);

export const serviceRelations = pgTable(
  'service_relations',
  {
    id: id(),
    orderId: integer('order_id')
      .notNull()
      .unique()
      .references(() => orders.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    packageType: packageType('package_type').notNull(),
    amountCents: money('amount_cents').notNull(),
    totalDays: integer('total_days').notNull(),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
    callsLeft: integer('calls_left').notNull().default(0),
    replyHours: integer('reply_hours').notNull().default(24),
    status: relationStatus('status').notNull().default('active'),
    frozen: boolean('frozen').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('relations_user_teacher_idx').on(t.userId, t.teacherId),
    index('relations_teacher_idx').on(t.teacherId),
    check('relation_dates', sql`${t.endDate} >= ${t.startDate}`),
  ],
);

export const serviceSegments = pgTable(
  'service_segments',
  {
    id: id(),
    relationId: integer('relation_id')
      .notNull()
      .references(() => serviceRelations.id, { onDelete: 'cascade' }),
    kind: segmentKind('kind').notNull(),
    teacherId: integer('teacher_id').references(() => users.id),
    startDate: day('start_date').notNull(),
    endDate: day('end_date').notNull(),
  },
  (t) => [
    index('segments_relation_idx').on(t.relationId),
    check('segment_dates', sql`${t.endDate} >= ${t.startDate}`),
    check('segment_teacher', sql`(${t.kind} = 'paused') = (${t.teacherId} IS NULL)`),
  ],
);

export const settlements = pgTable(
  'settlements',
  {
    id: id(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    periodStart: day('period_start').notNull(),
    periodEnd: day('period_end').notNull(),
    grossCents: money('gross_cents').notNull(),
    commissionBps: integer('commission_bps').notNull(),
    commissionCents: money('commission_cents').notNull(),
    netCents: money('net_cents').notNull(),
    status: settlementStatus('status').notNull().default('pending'),
    proof: text('proof'),
    operatorId: integer('operator_id').references(() => admins.id),
    paidAt: tstz('paid_at'),
    createdAt: createdAt(),
  },
  (t) => [index('settlements_teacher_idx').on(t.teacherId)],
);

export const accruals = pgTable(
  'accruals',
  {
    id: id(),
    relationId: integer('relation_id')
      .notNull()
      .references(() => serviceRelations.id),
    date: day('date').notNull(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    amountCents: money('amount_cents').notNull(),
    settlementId: integer('settlement_id').references(() => settlements.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique('accruals_relation_date_uq').on(t.relationId, t.date),
    index('accruals_teacher_date_idx').on(t.teacherId, t.date),
  ],
);

export const notificationType = pgEnum('notification_type', [
  'order_paid',
  'leave_notice',
  'substitute_invite',
  'substitute_response',
  'substitute_available',
  'substitute_assigned',
  'substitute_revoked',
  'leave_choice',
  'leave_choice_expired',
  'appointment_cancelled',
  'teacher_no_show',
  'call_confirm_request',
  'call_disputed',
  'crisis_alert',
  'crisis_hotline',
  'private_trade_warning',
]);

export const appointmentStatus = pgEnum('appointment_status', ['booked', 'completed', 'cancelled', 'teacher_no_show']);

export const confirmStatus = pgEnum('confirm_status', ['pending', 'confirmed', 'auto', 'disputed']);

export type CancelActor = 'user' | 'teacher' | 'leave' | 'system';

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    type: notificationType('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    isRead: boolean('is_read').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.isRead)],
);

export const schedules = pgTable(
  'schedules',
  {
    id: id(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weekday: integer('weekday').notNull(),
    startMin: integer('start_min').notNull(),
    endMin: integer('end_min').notNull(),
  },
  (t) => [
    check('schedule_weekday', sql`${t.weekday} BETWEEN 0 AND 6`),
    check('schedule_time', sql`${t.startMin} >= 0 AND ${t.endMin} <= 1440 AND ${t.startMin} < ${t.endMin}`),
  ],
);

export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    relationId: integer('relation_id')
      .notNull()
      .references(() => serviceRelations.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    date: day('date').notNull(),
    startAt: tstz('start_at').notNull(),
    endAt: tstz('end_at').notNull(),
    status: appointmentStatus('status').notNull().default('booked'),
    cancelBy: text('cancel_by').$type<CancelActor>(),
    teacherJoinedAt: tstz('teacher_joined_at'),
    userJoinedAt: tstz('user_joined_at'),
    endedAt: tstz('ended_at'),
    confirmStatus: confirmStatus('confirm_status'),
    createdAt: createdAt(),
  },
  (t) => [
    index('appointments_user_idx').on(t.userId, t.startAt),
    index('appointments_teacher_idx').on(t.teacherId, t.startAt),
  ],
);

export const leaves = pgTable('leaves', {
  id: id(),
  teacherId: integer('teacher_id')
    .notNull()
    .references(() => users.id),
  startDate: day('start_date').notNull(),
  endDate: day('end_date').notNull(),
  reason: text('reason').notNull().default(''),
  createdAt: createdAt(),
});

export const substituteCandidates = pgTable('substitute_candidates', {
  id: id(),
  leaveId: integer('leave_id')
    .notNull()
    .references(() => leaves.id, { onDelete: 'cascade' }),
  teacherId: integer('teacher_id')
    .notNull()
    .references(() => users.id),
  status: text('status').$type<'invited' | 'accepted' | 'rejected' | 'revoked'>().notNull().default('invited'),
  respondedAt: tstz('responded_at'),
});

export const leaveChoices = pgTable('leave_choices', {
  id: id(),
  leaveId: integer('leave_id')
    .notNull()
    .references(() => leaves.id, { onDelete: 'cascade' }),
  relationId: integer('relation_id')
    .notNull()
    .references(() => serviceRelations.id),
  status: text('status').$type<'pending' | 'wait' | 'substitute' | 'expired'>().notNull().default('pending'),
  substituteTeacherId: integer('substitute_teacher_id').references(() => users.id),
  decidedAt: tstz('decided_at'),
  deadlineAt: tstz('deadline_at').notNull(),
});

export const crisisEvents = pgTable('crisis_events', {
  id: id(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  peerId: integer('peer_id')
    .notNull()
    .references(() => users.id),
  keyword: text('keyword').notNull(),
  excerpt: text('excerpt').notNull(),
  status: text('status').$type<'open' | 'handled'>().notNull().default('open'),
  createdAt: createdAt(),
});

export const riskEvents = pgTable('risk_events', {
  id: id(),
  fromUserId: integer('from_user_id')
    .notNull()
    .references(() => users.id),
  toUserId: integer('to_user_id')
    .notNull()
    .references(() => users.id),
  keyword: text('keyword').notNull(),
  excerpt: text('excerpt').notNull(),
  createdAt: createdAt(),
});

export const replyWaits = pgTable(
  'reply_waits',
  {
    id: id(),
    teacherId: integer('teacher_id')
      .notNull()
      .references(() => users.id),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    relationId: integer('relation_id')
      .notNull()
      .references(() => serviceRelations.id),
    replyHours: integer('reply_hours').notNull(),
    askedAt: tstz('asked_at').notNull(),
    repliedAt: tstz('replied_at'),
  },
  (t) => [uniqueIndex('reply_waits_open_uq').on(t.teacherId, t.userId).where(sql`replied_at IS NULL`)],
);
