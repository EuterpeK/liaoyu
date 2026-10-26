const api = require('../../utils/request.js');
const { hm, STATUS_TEXT } = require('../../utils/format.js');

Page({
  data: { role: 'student', loading: true, relations: [], appointments: [] },

  async onShow() {
    try {
      const me = await getApp().ensureLoginReady();
      this.setData({ role: me.role });
      if (me.role === 'teacher') {
        const appointments = await api.get('/api/teacher/appointments', { silent: true }).catch(() => []);
        this.setData({
          appointments: appointments.map((a) => ({
            ...a,
            hm: hm(a.startAt),
            statusText: STATUS_TEXT[a.status] || a.status,
          })),
          loading: false,
        });
      } else {
        const [relations, appointments] = await Promise.all([
          api.get('/api/relations', { silent: true }).catch(() => []),
          api.get('/api/appointments', { silent: true }).catch(() => []),
        ]);
        this.setData({
          relations,
          appointments: appointments.map((a) => ({
            ...a,
            hm: hm(a.startAt),
            statusText: STATUS_TEXT[a.status] || a.status,
          })),
          loading: false,
        });
      }
    } catch (e) {
      wx.reLaunch({ url: '/pages/login/login' });
    }
  },

  onTapBook(e) {
    const r = this.data.relations.find((x) => x.id === e.currentTarget.dataset.id);
    wx.navigateTo({
      url: `/pages/appointment/book/book?relationId=${r.id}&name=${encodeURIComponent(r.teacherName)}`,
    });
  },

  async onTapCancel(e) {
    const id = e.currentTarget.dataset.id;
    const res = await new Promise((resolve) =>
      wx.showModal({ title: '取消预约', content: '确定取消这个时段吗？', success: resolve }),
    );
    if (!res.confirm) return;
    await api.post(`/api/appointments/${id}/cancel`).catch(() => {});
    this.onShow();
  },
});
