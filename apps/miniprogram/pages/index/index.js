const api = require('../../utils/request.js');

Page({
  data: { role: 'student', loading: true, teachers: [], directions: [], direction: '', appointments: [], todayLabel: '' },

  async onShow() {
    try {
      const me = await getApp().ensureLoginReady();
      this.setData({ role: me.role });
      if (me.role === 'teacher') await this.loadTeacherHome();
      else await this.loadTeachers();
    } catch (e) {
      wx.redirectTo({ url: '/pages/login/login' });
    }
  },

  async loadTeachers() {
    this.setData({ loading: true });
    const q = this.data.direction ? `?direction=${encodeURIComponent(this.data.direction)}` : '';
    const teachers = await api.get(`/api/teachers${q}`, { silent: true }).catch(() => []);
    this.setData({ teachers, loading: false });
  },

  async loadTeacherHome() {
    const appointments = await api.get('/api/teacher/appointments', { silent: true }).catch(() => []);
    this.setData({ appointments, todayLabel: new Date().toLocaleDateString('zh-CN'), loading: false });
  },

  onTapDirection(e) {
    const direction = e.currentTarget.dataset.d === this.data.direction ? '' : e.currentTarget.dataset.d;
    this.setData({ direction }, () => this.loadTeachers());
  },

  onTapTeacher(e) {
    wx.navigateTo({ url: `/pages/teacher/detail/detail?id=${e.currentTarget.dataset.id}` });
  },
});
