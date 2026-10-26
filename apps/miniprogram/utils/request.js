const { baseURL } = require('../config/env.js');
const auth = require('./auth.js');

function toast(msg) {
  wx.showToast({ title: msg, icon: 'none' });
}

function request(method, path, { data, silent } = {}) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: baseURL + path,
      method,
      data,
      header: { Authorization: 'Bearer ' + (wx.getStorageSync('liaoyu_token') || '') },
      success: async (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        if (res.statusCode === 401 && !silent) {
          try {
            await auth.relogin();
            return resolve(await request(method, path, { data, silent: true }));
          } catch (e) {
            if (!silent) toast('请先登录');
            return reject(e);
          }
        }
        const msg = (res.data && res.data.error) || '请求失败';
        if (!silent) toast(msg);
        return reject(new Error(msg));
      },
      fail: () => {
        if (!silent) toast('网络异常，请重试');
        reject(new Error('network'));
      },
    });
  });
}

module.exports = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, data, opts) => request('POST', path, { ...opts, data }),
};
