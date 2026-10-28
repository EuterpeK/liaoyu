const api = require('../../utils/request.js');
const auth = require('../../utils/auth.js');
const page = require('../../utils/page.js');
const { isDev } = require('../../config/env.js');

const APPLY_TEXT = {
  none: { label: '成为陪伴老师', hint: '分享你的专业，陪伴需要的人' },
  pending: { label: '老师申请审核中', hint: '我们会尽快处理，请耐心等待' },
  rejected: { label: '申请未通过，重新申请', hint: '完善资料后可再次提交' },
  disabled: { label: '老师资格已停用', hint: '如有疑问请联系平台' },
};

Page({
  data: { loading: true, error: '', me: null, initial: '?', apply: null, reply: null, isDev },

  onShow() {
    return this.reload();
  },

  onRetry() {
    return this.reload();
  },

  async reload() {
    await page.load(this, async (me) => {
      const teacher = me.role === 'teacher';
      const displayName = teacher ? me.teacher.displayName : me.user.nickname;
      const status = me.teacher ? me.teacher.status : 'none';
      let reply = null;
      if (teacher) {
        const s = await api.get('/api/teacher/reply-stats', { silent: true }).catch(() => null);
        if (s)
          reply = { rate: s.rate === null ? '—' : `${Math.round(s.rate * 100)}%`, onTime: s.onTime, total: s.total };
      }
      this.setData({
        me,
        initial: (displayName || `U${me.user.id}`)[0],
        apply: teacher ? null : { status, ...APPLY_TEXT[status], canApply: status === 'none' || status === 'rejected' },
        reply,
        loading: false,
      });
    });
    getApp().refreshBadge();
  },

  onTapGo(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  onTapApply() {
    if (!this.data.apply.canApply) return page.toast(this.data.apply.hint);
    return wx.navigateTo({ url: '/pages/teacher/apply/apply' });
  },

  async onTapLogout() {
    if (!(await page.confirm(isDev ? '切换账号' : '退出登录', '确定要退出当前账号吗？'))) return;
    auth.logout();
    wx.removeTabBarBadge({ index: 2, fail: () => {} });
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
