const api = require('../../../utils/request.js');
const { FEN } = require('../../../utils/format.js');

const TYPE_TEXT = { single: '单次通话', month: '月度陪伴', quarter: '季度陪伴', year: '年度陪伴' };

Page({
  data: { t: null, packages: [] },

  async onLoad({ id }) {
    const t = await api.get(`/api/teachers/${id}`).catch(() => null);
    if (!t) return wx.showToast({ title: '老师不存在', icon: 'none' });
    this.setData({
      t: { ...t, initial: (t.displayName || '?')[0] },
      packages: t.packages.map((p) => ({ ...p, typeText: TYPE_TEXT[p.type] || p.type, yuan: FEN(p.priceCents) })),
    });
  },

  onTapBuy(e) {
    const p = this.data.packages.find((x) => x.id === e.currentTarget.dataset.id);
    wx.navigateTo({
      url: `/pages/package/buy/buy?packageId=${p.id}&title=${encodeURIComponent(p.title)}&yuan=${p.yuan}`,
    });
  },
});
