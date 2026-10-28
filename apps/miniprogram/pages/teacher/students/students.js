const api = require('../../../utils/request.js');
const page = require('../../../utils/page.js');
const { daysLeft, TYPE_TEXT, REL_STATUS_TEXT, REL_STATUS_TONE } = require('../../../utils/format.js');

Page({
  data: { loading: true, error: '', active: [], past: [] },

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
      const rows = await api.get('/api/teacher/students', { silent: true });
      const views = rows.map((r, i) => ({
        ...r,
        name: r.userNickname || `学员${r.userId}`,
        initial: (r.userNickname || '学')[0],
        tone: i % 4,
        typeText: TYPE_TEXT[r.packageType] || r.packageType,
        statusText: REL_STATUS_TEXT[r.status] || r.status,
        statusTone: REL_STATUS_TONE[r.status] || 'gray',
        left: daysLeft(r.endDate),
      }));
      this.setData({
        active: views.filter((v) => v.status === 'active'),
        past: views.filter((v) => v.status !== 'active'),
        loading: false,
      });
    });
  },
});
