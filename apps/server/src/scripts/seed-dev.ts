import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { loadConfig } from '../config.ts';
import { createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { appointments, orders, packages, schedules, serviceRelations, teacherProfiles, users } from '../db/schema.ts';
import { encryptField } from '../lib/crypto.ts';

/** 与 providers/wechat.ts 的 MOCK 逻辑保持一致：不同 code 得到不同用户 */
function mockOpenid(code: string): string {
  return `mock_${createHash('sha1').update(`mock:${code}`).digest('hex').slice(0, 24)}`;
}

interface SeedTeacher {
  code: string;
  name: string;
  realName: string;
  level: number;
  directions: string[];
  intro: string;
  credentials: string[];
  packages: {
    type: 'single' | 'month' | 'quarter' | 'year';
    title: string;
    priceCents: number;
    days: number;
    callQuota: number;
    replyHours: number;
  }[];
  weekdays: { weekday: number; startMin: number; endMin: number }[];
}

const TEACHERS: SeedTeacher[] = [
  {
    code: 'dev-teacher-1',
    name: '陈屿',
    realName: '陈屿',
    level: 3,
    directions: ['情绪压力', '职场困惑'],
    intro: '从业八年，擅长情绪疏导与职场迷茫期陪伴，温柔而有力量。',
    credentials: ['国家二级心理咨询师', 'OH 卡牌治疗师'],
    packages: [
      { type: 'month', title: '月度陪伴 · 陈屿', priceCents: 99900, days: 30, callQuota: 4, replyHours: 12 },
      { type: 'quarter', title: '季度深度陪伴', priceCents: 269900, days: 90, callQuota: 12, replyHours: 12 },
    ],
    weekdays: [
      { weekday: 1, startMin: 600, endMin: 720 },
      { weekday: 2, startMin: 600, endMin: 720 },
      { weekday: 3, startMin: 600, endMin: 720 },
      { weekday: 4, startMin: 1140, endMin: 1260 },
      { weekday: 5, startMin: 1140, endMin: 1260 },
    ],
  },
  {
    code: 'dev-teacher-2',
    name: '林晚',
    realName: '林晚',
    level: 2,
    directions: ['学业压力', '成长困惑'],
    intro: '前高校辅导员，陪伴三百余名学生走出低谷，相信每一步都算数。',
    credentials: ['应用心理学硕士'],
    packages: [
      { type: 'month', title: '月度陪伴 · 林晚', priceCents: 59900, days: 30, callQuota: 2, replyHours: 24 },
      { type: 'single', title: '单次通话 · 林晚', priceCents: 9900, days: 1, callQuota: 1, replyHours: 24 },
    ],
    weekdays: [
      { weekday: 1, startMin: 840, endMin: 960 },
      { weekday: 3, startMin: 840, endMin: 960 },
      { weekday: 5, startMin: 840, endMin: 960 },
    ],
  },
  {
    code: 'dev-teacher-3',
    name: '苏晴',
    realName: '苏晴',
    level: 3,
    directions: ['情感关系', '亲密关系'],
    intro: '专注亲密关系与情感沟通，帮你把话说出口，把心贴回去。',
    credentials: ['婚姻家庭咨询师', '萨提亚模式受训'],
    packages: [
      { type: 'month', title: '月度陪伴 · 苏晴', priceCents: 128000, days: 30, callQuota: 6, replyHours: 6 },
      { type: 'year', title: '年度成长同行', priceCents: 899900, days: 365, callQuota: 40, replyHours: 6 },
    ],
    weekdays: [
      { weekday: 2, startMin: 1140, endMin: 1260 },
      { weekday: 4, startMin: 1140, endMin: 1260 },
      { weekday: 6, startMin: 600, endMin: 840 },
    ],
  },
  {
    code: 'dev-teacher-4',
    name: '周予安',
    realName: '周予安',
    level: 1,
    directions: ['日常陪伴'],
    intro: '安静的倾听者。不需要理由，随时可以来聊聊今天的天空。',
    credentials: [],
    packages: [{ type: 'single', title: '单次通话 · 周予安', priceCents: 4900, days: 1, callQuota: 1, replyHours: 24 }],
    weekdays: [
      { weekday: 0, startMin: 600, endMin: 1140 },
      { weekday: 6, startMin: 600, endMin: 1140 },
    ],
  },
];

const STUDENTS = [
  { code: 'dev-student-1', nickname: '小明' },
  { code: 'dev-student-2', nickname: '小红' },
  { code: 'dev-student-3', nickname: '小刚' },
];

async function upsertUser(db: ReturnType<typeof createDb>, code: string, nickname: string | null) {
  const openid = mockOpenid(code);
  const [row] = await db
    .insert(users)
    .values({ openid, nickname: nickname ?? '' })
    .onConflictDoUpdate({ target: users.openid, set: { openid, ...(nickname ? { nickname } : {}) } })
    .returning({ id: users.id });
  return row.id;
}

const ymd = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const db = createDb(loadConfig().databaseUrl, 1);
try {
  await runMigrations(db);
  const fieldKey = loadConfig().fieldKey;

  for (const t of TEACHERS) {
    const userId = await upsertUser(db, t.code, t.name);
    await db
      .insert(teacherProfiles)
      .values({
        userId,
        displayName: t.name,
        realNameEnc: encryptField(fieldKey, t.realName),
        intro: t.intro,
        directions: t.directions,
        credentials: t.credentials,
        level: t.level,
        status: 'active',
        reviewedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: teacherProfiles.userId,
        set: {
          displayName: t.name,
          intro: t.intro,
          directions: t.directions,
          credentials: t.credentials,
          level: t.level,
          status: 'active',
        },
      });
    // 排班：仅当该老师没有任何排班时写入（幂等）
    const existing = await db
      .select({ id: schedules.id })
      .from(schedules)
      .where(eq(schedules.teacherId, userId))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(schedules).values(t.weekdays.map((w) => ({ teacherId: userId, ...w })));
    }
    // 套餐：仅当该老师没有任何套餐时写入（幂等）
    const existingPkg = await db
      .select({ id: packages.id })
      .from(packages)
      .where(eq(packages.teacherId, userId))
      .limit(1);
    if (existingPkg.length === 0) {
      await db.insert(packages).values(t.packages.map((p) => ({ teacherId: userId, ...p })));
    }
    console.log(`老师 ${t.name} (userId=${userId}, Lv${t.level}) OK`);
  }

  for (const s of STUDENTS) {
    const userId = await upsertUser(db, s.code, s.nickname);
    console.log(`学员 ${s.nickname} (userId=${userId}) OK`);
  }

  // 演示数据：小明的进行中服务 + 一条已预约（幂等：以订单号为准）
  const seedOrder = await db
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.outTradeNo, 'SEED_DEMO_0001'))
    .limit(1);
  if (seedOrder.length === 0) {
    const stuId = await upsertUser(db, 'dev-student-1', '小明');
    const t1 = TEACHERS[0];
    const teaId = await upsertUser(db, t1.code, t1.name);
    const [pkg] = await db
      .select({
        id: packages.id,
        title: packages.title,
        type: packages.type,
        priceCents: packages.priceCents,
        days: packages.days,
        callQuota: packages.callQuota,
        replyHours: packages.replyHours,
      })
      .from(packages)
      .where(and(eq(packages.teacherId, teaId), eq(packages.onSale, true)))
      .limit(1);
    const today = new Date();
    const end = new Date(today.getTime() + pkg.days * 86400000);
    const [order] = await db
      .insert(orders)
      .values({
        outTradeNo: 'SEED_DEMO_0001',
        userId: stuId,
        teacherId: teaId,
        packageId: pkg.id,
        packageSnapshot: {
          type: pkg.type,
          title: pkg.title,
          priceCents: pkg.priceCents,
          days: pkg.days,
          callQuota: pkg.callQuota,
          replyHours: pkg.replyHours,
        },
        amountCents: pkg.priceCents,
        payProvider: 'mock',
        status: 'paid',
        tradeNo: 'SEED_TRADE_0001',
        paidAt: today,
      })
      .returning({ id: orders.id });
    const [rel] = await db
      .insert(serviceRelations)
      .values({
        orderId: order.id,
        userId: stuId,
        teacherId: teaId,
        packageType: pkg.type,
        amountCents: pkg.priceCents,
        totalDays: pkg.days,
        startDate: ymd(today),
        endDate: ymd(end),
        callsLeft: pkg.callQuota,
        replyHours: pkg.replyHours,
        status: 'active',
      })
      .returning({ id: serviceRelations.id });
    // 下周三 10:00 一条已预约
    const wed = new Date(today);
    wed.setDate(wed.getDate() + ((3 - wed.getDay() + 7) % 7 || 7));
    const date = ymd(wed);
    await db.insert(appointments).values({
      relationId: rel.id,
      userId: stuId,
      teacherId: teaId,
      date,
      startAt: new Date(`${date}T10:00:00+08:00`),
      endAt: new Date(`${date}T11:00:00+08:00`),
      status: 'booked',
    });
    console.log('演示数据（小明 ↔ 陈屿 的服务与预约）OK');
  } else {
    console.log('演示数据已存在，跳过');
  }

  console.log(
    '种子数据完成。测试账号 code：dev-student-1/2/3，dev-teacher-1/2/3/4；管理员用 pnpm -F @liaoyu/server create-admin',
  );
} finally {
  await db.$client.end();
}
