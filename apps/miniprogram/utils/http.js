const { baseURL } = require('../config/env.js');

const TIMEOUT_MS = 10000;

/**
 * kind:
 *  - network  断网/超时
 *  - auth     401，登录失效
 *  - server   5xx
 *  - client   其余 4xx（业务错误，message 为服务端返回的文案）
 */
class ApiError extends Error {
  constructor(message, { kind, status } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

function kindOf(status) {
  if (status === 401) return 'auth';
  return status >= 500 ? 'server' : 'client';
}

/** 底层请求：2xx 返回 res.data，其余统一抛 ApiError。不做重试、不弹 toast */
function send({ method, path, data, token }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: baseURL + path,
      method,
      data,
      timeout: TIMEOUT_MS,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        const message = res.data?.error || '请求失败';
        return reject(new ApiError(message, { kind: kindOf(res.statusCode), status: res.statusCode }));
      },
      fail: () => reject(new ApiError('网络异常，请重试', { kind: 'network' })),
    });
  });
}

module.exports = { send, ApiError, TIMEOUT_MS };
