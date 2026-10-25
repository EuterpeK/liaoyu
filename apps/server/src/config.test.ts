import { describe, expect, test } from 'vitest';
import { loadConfig } from './config.ts';

const PROD = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(32),
  FIELD_KEY: Buffer.alloc(32, 7).toString('base64'),
  COOKIE_SECURE: 'true',
  ZPAY_PID: 'p',
  ZPAY_KEY: 'k',
  WX_APPID: 'wx1',
  WX_APPSECRET: 's',
  TENCENT_SDKAPPID: '1400000001',
  TENCENT_SECRETKEY: 'sk',
  IM_CALLBACK_TOKEN: 'tok',
  TRTC_CALLBACK_KEY: 'ck',
};

describe('config', () => {
  test('开发默认值可直接使用', () => {
    const c = loadConfig({});
    expect(c.port).toBe(8700);
    expect(c.nodeEnv).toBe('development');
    expect(c.zpay.gateway).toBe('https://z-pay.cn');
    expect(c.cookieSecure).toBe(false);
  });

  test('PUBLIC_BASE_URL 去掉末尾斜杠', () => {
    expect(loadConfig({ PUBLIC_BASE_URL: 'https://a.com/' }).publicBaseUrl).toBe('https://a.com');
  });

  test('FIELD_KEY 必须是 32 字节 base64', () => {
    expect(() => loadConfig({ FIELD_KEY: 'abc' })).toThrow(/FIELD_KEY/);
  });

  test('生产环境缺少密钥或支付配置直接失败', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...PROD, ZPAY_KEY: '' })).toThrow(/ZPAY/);
    expect(() => loadConfig({ ...PROD, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });

  test('生产环境配置齐全可启动', () => {
    expect(loadConfig(PROD).cookieSecure).toBe(true);
  });

  test('腾讯云默认 MOCK，生产环境必须配置齐全', () => {
    const c = loadConfig({});
    expect(c.tencent).toEqual({ sdkAppId: 0, secretKey: '', imCallbackToken: '', trtcCallbackKey: '' });
    expect(c.crisisHotline).toBe('12356');
    expect(() => loadConfig({ ...PROD, TRTC_CALLBACK_KEY: '' })).toThrow(/TENCENT/);
    expect(loadConfig(PROD).tencent.sdkAppId).toBe(1400000001);
  });
});
