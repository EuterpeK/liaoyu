const api = require('../../../utils/request.js');
const { nextDays } = require('../../../utils/format.js');

Page({
  data: { relationId: 0, name: '', days: [], date: '', slots: [], chosen: '', booking: false },

  onLoad({ relationId, name }) {
    const days = nextDays(7);
    this.setData({ relationId: Number(relationId), name: decodeURIComponent(name), days, date: days[0].date });
    this.loadSlots();
  },

  onTapDay(e) {
    this.setData({ date: e.currentTarget.dataset.d, chosen: '' }, () => this.loadSlots());
  },

  async loadSlots() {
    const res = await api
      .get(`/api/appointments/slots?relationId=${this.data.relationId}&date=${this.data.date}`, { silent: true })
      .catch(() => null);
    this.setData({ slots: res ? res.slots : [] });
  },

  onTapSlot(e) {
    this.setData({ chosen: e.currentTarget.dataset.s });
  },

  async onTapBook() {
    if (!this.data.chosen || this.data.booking) return;
    this.setData({ booking: true });
    await api
      .post('/api/appointments', { relationId: this.data.relationId, date: this.data.date, start: this.data.chosen })
      .then(() => {
        wx.showToast({ title: '预约成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      })
      .catch(() => {});
    this.setData({ booking: false });
  },
});
