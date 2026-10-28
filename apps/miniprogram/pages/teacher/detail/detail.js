const api = require('../../../utils/request.js');
const { FEN, TYPE_TEXT } = require('../../../utils/format.js');

Page({
  data: { loading: true, error: '', t: null, packages: [], id: 0 },

  onLoad({ id }) {
    this.setData({ id: Number(id) });
    return this.reload();
  },

  onRetry() {
    return this.reload();
  },

  async reload() {
    this.setData({ loading: true, error: '' });
    try {
      const t = await api.get(`/api/teachers/${this.data.id}`, { silent: true });
      wx.setNavigationBarTitle({ title: t.displayName });
      this.setData({
        t: { ...t, initial: (t.displayName || '?')[0] },
        packages: t.packages.map((p) => ({
          ...p,
          typeText: TYPE_TEXT[p.type] || p.type,
          daysText: p.type === 'single' ? '一次性' : `${p.days} 天`,
          yuan: FEN(p.priceCents),
        })),
        loading: false,
      });
    } catch (e) {
      this.setData({
        loading: false,
        error: e.kind === 'client' && e.status === 404 ? '老师不存在或已下架' : e.message || '加载失败，请重试',
      });
    }
  },

  onTapBuy(e) {
    const p = this.data.packages.find((x) => x.id === e.currentTarget.dataset.id);
    const desc = `${this.data.t.displayName} · ${p.typeText} · ${p.daysText} · 通话 ${p.callQuota} 次`;
    wx.navigateTo({
      url: `/pages/package/buy/buy?packageId=${p.id}&title=${encodeURIComponent(p.title)}&yuan=${p.yuan}&desc=${encodeURIComponent(desc)}`,
    });
  },
});
