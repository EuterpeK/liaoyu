const auth = require('./auth.js');
const http = require('./http.js');

function toast(msg) {
  wx.showToast({ title: msg, icon: 'none' });
}

/** 发送一次请求；401 时重登并重放一次 */
async function sendWithAuth(method, path, data) {
  try {
    return await http.send({ method, path, data, token: auth.getToken() });
  } catch (e) {
    if (e.kind !== 'auth') throw e;
    await auth.relogin();
    return http.send({ method, path, data, token: auth.getToken() });
  }
}

const isTransient = (e) => e.kind === 'network' || e.kind === 'server';

/**
 * silent: 失败时不弹 toast（调用方自行处理错误）。
 * 仅幂等的 GET 在断网/5xx 时自动重试一次；POST 不重试，避免重复提交。
 */
async function request(method, path, { data, silent } = {}) {
  try {
    try {
      return await sendWithAuth(method, path, data);
    } catch (e) {
      if (method === 'GET' && isTransient(e)) return await sendWithAuth(method, path, data);
      throw e;
    }
  } catch (e) {
    if (!silent) toast(e.kind === 'auth' ? '请先登录' : e.message);
    throw e;
  }
}

module.exports = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, data, opts) => request('POST', path, { ...opts, data }),
  put: (path, data, opts) => request('PUT', path, { ...opts, data }),
  patch: (path, data, opts) => request('PATCH', path, { ...opts, data }),
};
