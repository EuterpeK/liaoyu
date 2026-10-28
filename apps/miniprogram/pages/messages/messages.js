const api = require('../../utils/request.js');
const page = require('../../utils/page.js');
const { ago } = require('../../utils/format.js');
const { describe } = require('../../utils/notice.js');

Page({
  data: { loading: true, error: '', list: [], unread: 0 },

  onShow() {
    return this.reload();
  },

  async onPullDownRefresh() {
    await this.reload();
    wx.stopPullDownRefresh();
  },

  onRetry() {
    return this.reload();
  },

  async reload() {
    await page.load(this, async () => {
      const rows = await api.get('/api/notifications', { silent: true });
      const list = rows.map((n) => ({ ...n, ...describe(n), time: ago(n.createdAt) }));
      this.setData({ list, unread: list.filter((n) => !n.isRead).length, loading: false });
    });
    getApp().refreshBadge();
  },

  async onTapItem(e) {
    const item = this.data.list.find((n) => n.id === e.currentTarget.dataset.id);
    if (!item) return;
    if (!item.isRead) {
      // 先本地置为已读，保证点击立刻有反馈；接口失败不影响跳转
      this.setData({
        list: this.data.list.map((n) => (n.id === item.id ? { ...n, isRead: true } : n)),
        unread: Math.max(0, this.data.unread - 1),
      });
      api
        .post('/api/notifications/read', { ids: [item.id] }, { silent: true })
        .then(() => getApp().refreshBadge())
        .catch(() => {});
    }
    page.go(item.url, item.isTab);
  },

  async onTapReadAll() {
    if (!this.data.unread) return;
    try {
      await api.post('/api/notifications/read', {});
      this.setData({ list: this.data.list.map((n) => ({ ...n, isRead: true })), unread: 0 });
      getApp().refreshBadge();
    } catch (_e) {
      /* request 层已弹出失败原因 */
    }
  },
});
