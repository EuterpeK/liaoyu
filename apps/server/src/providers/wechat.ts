import { createHash } from 'node:crypto';
import { HttpError } from '../lib/errors.ts';

export interface Wechat {
  readonly isMock: boolean;
  code2Session(code: string): Promise<{ openid: string }>;
}

export function createWechat(cfg: { appid: string; secret: string }): Wechat {
  const isMock = !cfg.appid || !cfg.secret;
  return {
    isMock,
    async code2Session(code) {
      if (isMock) {
        return { openid: `mock_${createHash('sha1').update(`mock:${code}`).digest('hex').slice(0, 24)}` };
      }
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({
        appid: cfg.appid,
        secret: cfg.secret,
        js_code: code,
        grant_type: 'authorization_code',
      }).toString();
      const data = (await (await fetch(url)).json()) as { openid?: string; errcode?: number; errmsg?: string };
      if (!data.openid) throw new HttpError(401, `微信登录失败: ${data.errmsg ?? data.errcode ?? '未知错误'}`);
      return { openid: data.openid };
    },
  };
}
