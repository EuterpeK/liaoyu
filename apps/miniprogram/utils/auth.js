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
      url: `${baseURL}/api/auth/me`,
      header: { Authorization: `Bearer ${getToken()}` },
      success: (res) => (res.statusCode === 200 ? resolve(res.data) : reject(res)),
      fail: () => reject(new Error('network')),
    });
  });
}

function getToken() {
  return wx.getStorageSync(TOKEN_KEY) || '';
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
  const res = await raw('POST', '/api/auth/wxlogin', { code });
  wx.setStorageSync(TOKEN_KEY, res.token);
  return withRole(await fetchMe());
}

module.exports = { ensureLogin, relogin, loginAs, fetchMe, withRole, getToken };
