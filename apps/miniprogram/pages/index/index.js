const api = require('../../utils/request.js');
const page = require('../../utils/page.js');
const { viewAppointment, ymd } = require('../../utils/format.js');

Page({
  data: {
    role: 'student',
    loading: true,
    error: '',
    // 学员
    all: [],
    teachers: [],
    directions: [],
    direction: '',
    // 老师工作台
    stats: null,
    today: [],
    inviteCount: 0,
    todayLabel: '',
  },

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
    await page.load(this, async (me) => {
      this.setData({ role: me.role });
      if (me.role === 'teacher') await this.loadWorkbench();
      else await this.loadTeachers();
      this.setData({ loading: false });
    });
    getApp().refreshBadge();
  },

  /* ---------------- 学员：老师列表 ---------------- */
  async loadTeachers() {
    const list = await api.get('/api/teachers', { silent: true });
    const all = list.map((t, i) => ({
      ...t,
      initial: (t.displayName || '?')[0],
      tone: i % 4,
      yuan: t.minPriceCents ? (t.minPriceCents / 100).toFixed(0) : '',
    }));
    const directions = [...new Set(all.flatMap((t) => t.directions || []))];
    const direction = directions.includes(this.data.direction) ? this.data.direction : '';
    this.setData({ all, directions, direction });
    this.applyFilter();
  },

  applyFilter() {
    const d = this.data.direction;
    this.setData({ teachers: d ? this.data.all.filter((t) => (t.directions || []).includes(d)) : this.data.all });
  },

  onTapDirection(e) {
    const d = e.currentTarget.dataset.d;
    this.setData({ direction: d === this.data.direction ? '' : d });
    this.applyFilter();
  },

  onTapTeacher(e) {
    wx.navigateTo({ url: `/pages/teacher/detail/detail?id=${e.currentTarget.dataset.id}` });
  },

  /* ---------------- 老师：工作台 ---------------- */
  async loadWorkbench() {
    const [appointments, students, reply, invites] = await Promise.all([
      api.get('/api/teacher/appointments', { silent: true }),
      api.get('/api/teacher/students', { silent: true }).catch(() => []),
      api.get('/api/teacher/reply-stats', { silent: true }).catch(() => null),
      api.get('/api/teacher/substitute-invites', { silent: true }).catch(() => []),
    ]);
    const today = ymd(new Date());
    const todayList = appointments
      .filter((a) => a.date === today && a.status !== 'cancelled')
      .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
      .map((a) => ({ ...viewAppointment(a, 'userNickname'), initial: (a.userNickname || '学')[0] }));
    this.setData({
      todayLabel: today,
      today: todayList,
      inviteCount: invites.filter((i) => i.status === 'invited').length,
      stats: {
        students: students.filter((s) => s.status === 'active').length,
        today: todayList.length,
        rate: reply && reply.rate !== null ? `${Math.round(reply.rate * 100)}%` : '—',
      },
    });
  },

  onTapEntry(e) {
    wx.navigateTo({ url: e.currentTarget.dataset.url });
  },

  onTapInvites() {
    wx.navigateTo({ url: '/pages/teacher/leaves/leaves' });
  },
});
