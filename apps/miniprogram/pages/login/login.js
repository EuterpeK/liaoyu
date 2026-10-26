const auth = require('../../utils/auth.js');

/** 开发测试账号（与 pnpm -F @liaoyu/server seed 的种子数据一一对应） */
const DEV_ACCOUNTS = [
  { label: '小明', role: '学员', code: 'dev-student-1' },
  { label: '小红', role: '学员', code: 'dev-student-2' },
  { label: '小刚', role: '学员', code: 'dev-student-3' },
  { label: '陈屿', role: '老师 · Lv3', code: 'dev-teacher-1' },
  { label: '林晚', role: '老师 · Lv2', code: 'dev-teacher-2' },
  { label: '苏晴', role: '老师 · Lv3', code: 'dev-teacher-3' },
  { label: '周予安', role: '老师 · Lv1', code: 'dev-teacher-4' },
];

Page({
  data: { loading: '', accounts: DEV_ACCOUNTS },

  async onTapLogin() {
    if (this.data.loading) return;
    this.setData({ loading: 'wx' });
    try {
      await getApp().ensureLoginReady();
      wx.reLaunch({ url: '/pages/index/index' });
    } catch (e) {
      wx.showToast({ title: '登录失败，请重试', icon: 'none' });
    }
    this.setData({ loading: '' });
  },

  async onTapAccount(e) {
    const code = e.currentTarget.dataset.code;
    if (this.data.loading) return;
    this.setData({ loading: code });
    try {
      const me = await auth.loginAs(code);
      getApp().loginPromise = Promise.resolve(me);
      wx.reLaunch({ url: '/pages/index/index' });
    } catch (err) {
      wx.showToast({ title: '登录失败，请确认已运行 seed', icon: 'none' });
    }
    this.setData({ loading: '' });
  },
});
