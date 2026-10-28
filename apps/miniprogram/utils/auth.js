const http = require('./http.js');

const TOKEN_KEY = 'liaoyu_token';

function wxLoginCode() {
  return new Promise((resolve, reject) =>
    wx.login({
      success: (r) => resolve(r.code),
      fail: () => reject(new http.ApiError('微信登录失败，请重试', { kind: 'client' })),
    }),
  );
}

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
}

function fetchMe() {
  return http.send({ method: 'GET', path: '/api/auth/me', token: getToken() });
}

function withRole(me) {
  const role = me.teacher && me.teacher.status === 'active' ? 'teacher' : 'student';
  return { ...me, role };
}

async function wxLogin(code) {
  const res = await http.send({ method: 'POST', path: '/api/auth/wxlogin', data: { code } });
  wx.setStorageSync(TOKEN_KEY, res.token);
  return withRole(await fetchMe());
}

/** 确保已登录并返回 { user, teacher, role }；role: 'teacher' | 'student' */
async function ensureLogin() {
  if (getToken()) {
    try {
      return withRole(await fetchMe());
    } catch (e) {
      // 断网/服务端故障时保留仍可能有效的 token，交给上层重试；其余情况走重新登录
      if (e.kind === 'network' || e.kind === 'server') throw e;
    }
  }
  return wxLogin(await wxLoginCode());
}

/** 401 时强制重登（request 层调用）；并发调用共享同一 in-flight Promise */
let reloginPromise = null;

function relogin() {
  if (!reloginPromise) {
    wx.removeStorageSync(TOKEN_KEY);
    reloginPromise = ensureLogin().finally(() => {
      reloginPromise = null;
    });
  }
  return reloginPromise;
}

/** 以指定 code 登录（开发测试账号切换） */
async function loginAs(code) {
  wx.removeStorageSync(TOKEN_KEY);
  getApp().resetLogin();
  return wxLogin(code);
}

function logout() {
  wx.removeStorageSync(TOKEN_KEY);
  getApp().resetLogin();
}

module.exports = { ensureLogin, relogin, loginAs, logout, fetchMe, withRole, getToken };
