const api = require('../../utils/request.js');
const page = require('../../utils/page.js');
const { FEN, ago, ORDER_STATUS_TEXT, ORDER_STATUS_TONE, TYPE_TEXT } = require('../../utils/format.js');

Page({
  data: { loading: true, error: '', list: [] },

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
      const rows = await api.get('/api/orders', { silent: true });
      this.setData({
        list: rows.map((o) => ({
          ...o,
          yuan: FEN(o.amountCents),
          typeText: TYPE_TEXT[o.packageType] || '',
          statusText: ORDER_STATUS_TEXT[o.status] || o.status,
          tone: ORDER_STATUS_TONE[o.status] || 'gray',
          time: ago(o.paidAt || o.createdAt),
        })),
        loading: false,
      });
    });
  },

  onTapOrder(e) {
    wx.navigateTo({ url: `/pages/teacher/detail/detail?id=${e.currentTarget.dataset.tid}` });
  },
});
