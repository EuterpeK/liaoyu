const api = require('../../../utils/request.js');
const page = require('../../../utils/page.js');
const { nextDays } = require('../../../utils/format.js');

Page({
  data: {
    relationId: 0,
    name: '',
    days: [],
    date: '',
    slots: [],
    chosen: '',
    loadingSlots: true,
    slotsError: '',
    booking: false,
  },

  onLoad({ relationId, name }) {
    const days = nextDays(14);
    this.setData({ relationId: Number(relationId), name: decodeURIComponent(name), days, date: days[0].date });
    return this.loadSlots();
  },

  onTapDay(e) {
    this.setData({ date: e.currentTarget.dataset.d, chosen: '' });
    return this.loadSlots();
  },

  async loadSlots() {
    const date = this.data.date;
    this.setData({ loadingSlots: true, slotsError: '' });
    try {
      const res = await api.get(`/api/appointments/slots?relationId=${this.data.relationId}&date=${date}`, {
        silent: true,
      });
      if (date !== this.data.date) return; // 用户已切到别的日期，丢弃过期响应
      this.setData({ slots: res.slots, loadingSlots: false });
    } catch (e) {
      if (date !== this.data.date) return;
      this.setData({ slots: [], loadingSlots: false, slotsError: e.message || '加载失败，请重试' });
    }
  },

  onTapSlot(e) {
    this.setData({ chosen: e.currentTarget.dataset.s });
  },

  async onTapBook() {
    if (!this.data.chosen || this.data.booking) return;
    this.setData({ booking: true });
    try {
      await api.post('/api/appointments', {
        relationId: this.data.relationId,
        date: this.data.date,
        start: this.data.chosen,
      });
      page.toast('预约成功', 'success');
      setTimeout(() => wx.navigateBack(), 800);
    } catch (_e) {
      // 失败原因已由 request 层提示；时段可能刚被占用，刷新一下
      this.setData({ chosen: '' });
      this.loadSlots();
    }
    this.setData({ booking: false });
  },
});
