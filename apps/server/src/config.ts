import { z } from 'zod';

const DEV_JWT_SECRET = 'dev-jwt-secret-change-me';
const DEV_FIELD_KEY = Buffer.alloc(32, 1).toString('base64');

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(8700),
    DATABASE_URL: z.string().min(1).default('postgres://liaoyu:liaoyu@localhost:54329/liaoyu'),
    PUBLIC_BASE_URL: z.url().default('http://localhost:8700'),
    JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
    FIELD_KEY: z
      .string()
      .refine((s) => Buffer.from(s, 'base64').length === 32, 'FIELD_KEY 必须是 32 字节的 base64')
      .default(DEV_FIELD_KEY),
    COOKIE_SECURE: z.stringbool().default(false),
    ZPAY_PID: z.string().default(''),
    ZPAY_KEY: z.string().default(''),
    ZPAY_GATEWAY: z.url().default('https://z-pay.cn'),
    WX_APPID: z.string().default(''),
    WX_APPSECRET: z.string().default(''),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV !== 'production') return;
    const need = (ok: boolean, key: string, message: string) => {
      if (!ok) ctx.addIssue({ code: 'custom', path: [key], message });
    };
    need(e.JWT_SECRET !== DEV_JWT_SECRET, 'JWT_SECRET', '生产环境必须设置 JWT_SECRET');
    need(e.FIELD_KEY !== DEV_FIELD_KEY, 'FIELD_KEY', '生产环境必须设置 FIELD_KEY');
    need(e.COOKIE_SECURE, 'COOKIE_SECURE', '生产环境必须开启 COOKIE_SECURE');
    need(Boolean(e.ZPAY_PID && e.ZPAY_KEY), 'ZPAY_KEY', '生产环境必须配置 ZPAY_PID/ZPAY_KEY');
    need(Boolean(e.WX_APPID && e.WX_APPSECRET), 'WX_APPSECRET', '生产环境必须配置 WX_APPID/WX_APPSECRET');
  });

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const r = EnvSchema.safeParse(env);
  if (!r.success) throw new Error(`配置错误:\n${z.prettifyError(r.error)}`);
  const e = r.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    publicBaseUrl: e.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    jwtSecret: e.JWT_SECRET,
    fieldKey: e.FIELD_KEY,
    cookieSecure: e.COOKIE_SECURE,
    zpay: { pid: e.ZPAY_PID, key: e.ZPAY_KEY, gateway: e.ZPAY_GATEWAY.replace(/\/+$/, '') },
    wx: { appid: e.WX_APPID, secret: e.WX_APPSECRET },
  };
}

export type Config = ReturnType<typeof loadConfig>;
