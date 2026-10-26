const { baseURL } = require('../config/env.js');

const TOKEN_KEY = 'liaoyu_token';

function raw(method, path, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: baseURL + path,
      method,
      data,
      success: (res) => (res.statusCode >= 200 && res.statusCode < 300 ? resolve(res.data) : reject(res)),
      fail: () => reject(new Error('network')),
    });
  });
}

function wxLoginCode() {
  return new Promise((resolve, reject) => wx.login({ success: (r) => resolve(r.code), fail: reject }));
}

function fetchMe() {
  return new Promise((resolve, reject) => {
    wx.request({
      url: baseURL + '/api/auth/me',
      header: { Authorization: 'Bearer ' + (wx.getStorageSync(TOKEN_KEY) || '') },
      success: (res) => (res.statusCode === 200 ? resolve(res.data) : reject(res)),
      fail: () => reject(new Error('network')),
    });
  });
}

function withRole(me) {
  const role = me.teacher && me.teacher.status === 'active' ? 'teacher' : 'student';
  return { ...me, role };
}

/** 确保已登录并返回 { user, teacher, role }；role: 'teacher' | 'student' */
async function ensureLogin() {
  const token = wx.getStorageSync(TOKEN_KEY);
  if (token) {
    const me = await fetchMe().catch(() => null);
    if (me) return withRole(me);
  }
  const res = await raw('POST', '/api/auth/wxlogin', { code: await wxLoginCode() });
  wx.setStorageSync(TOKEN_KEY, res.token);
  return withRole(await fetchMe());
}

/** 401 时强制重登（request 层调用） */
async function relogin() {
  wx.removeStorageSync(TOKEN_KEY);
  return ensureLogin();
}

module.exports = { ensureLogin, relogin, fetchMe, withRole };
