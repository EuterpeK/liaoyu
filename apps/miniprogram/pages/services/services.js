const api = require('../../utils/request.js');
const page = require('../../utils/page.js');
const {
  daysLeft,
  viewAppointment,
  splitAppointments,
  REL_STATUS_TEXT,
  REL_STATUS_TONE,
  TYPE_TEXT,
} = require('../../utils/format.js');

const HISTORY_LIMIT = 10;

function viewRelation(r, i) {
  const left = daysLeft(r.endDate);
  const single = r.packageType === 'single';
  const percent =
    !single && r.totalDays > 0 ? Math.min(100, Math.max(0, Math.round((1 - left / r.totalDays) * 100))) : 0;
  return {
    ...r,
    initial: (r.teacherName || '师')[0],
    tone: i % 4,
    typeText: TYPE_TEXT[r.packageType] || r.packageType,
    statusText: REL_STATUS_TEXT[r.status] || r.status,
    statusTone: REL_STATUS_TONE[r.status] || 'gray',
    active: r.status === 'active',
    single,
    left,
    percent,
  };
}

Page({
  data: {
    role: 'student',
    loading: true,
    error: '',
    relations: [],
    toConfirm: [],
    upcoming: [],
    history: [],
    historyMore: false,
    pendingChoices: 0,
    busyId: 0,
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
      const teacher = me.role === 'teacher';
      this.setData({ role: me.role });
      const [appointments, relations, choices] = await Promise.all([
        api.get(teacher ? '/api/teacher/appointments' : '/api/appointments', { silent: true }),
        teacher ? Promise.resolve([]) : api.get('/api/relations', { silent: true }),
        teacher ? Promise.resolve([]) : api.get('/api/leave-choices', { silent: true }).catch(() => []),
      ]);

      const views = appointments.map((a) => viewAppointment(a, teacher ? 'userNickname' : 'teacherName'));
      const { upcoming, history } = splitAppointments(views);
      const now = Date.now();
      this.setData({
        relations: relations.map(viewRelation).sort((a, b) => Number(b.active) - Number(a.active)),
        toConfirm: teacher ? [] : history.filter((a) => a.needConfirm),
        upcoming,
        history: history.filter((a) => !a.needConfirm || teacher).slice(0, HISTORY_LIMIT),
        historyMore: history.length > HISTORY_LIMIT,
        pendingChoices: choices.filter((c) => c.status === 'pending' && new Date(c.deadlineAt).getTime() > now).length,
        loading: false,
      });
    });
    getApp().refreshBadge();
  },

  onTapBook(e) {
    const r = this.data.relations.find((x) => x.id === e.currentTarget.dataset.id);
    wx.navigateTo({
      url: `/pages/appointment/book/book?relationId=${r.id}&name=${encodeURIComponent(r.teacherName)}`,
    });
  },

  onTapRelationTeacher(e) {
    wx.navigateTo({ url: `/pages/teacher/detail/detail?id=${e.currentTarget.dataset.tid}` });
  },

  onTapChoices() {
    wx.navigateTo({ url: '/pages/choices/choices' });
  },

  onTapOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' });
  },

  async onTapCancel(e) {
    const id = e.currentTarget.dataset.id;
    const teacher = this.data.role === 'teacher';
    const ok = await page.confirm(
      '取消预约',
      teacher ? '取消后学员会收到通知，确定取消吗？' : '开始前 12 小时内无法取消，确定取消这个时段吗？',
    );
    if (!ok) return;
    this.setData({ busyId: id });
    try {
      await api.post(`${teacher ? '/api/teacher/appointments' : '/api/appointments'}/${id}/cancel`);
      page.toast('已取消', 'success');
      await this.reload();
    } catch (_e) {
      /* request 层已弹出失败原因 */
    }
    this.setData({ busyId: 0 });
  },

  async onTapConfirm(e) {
    const { id, ok } = e.currentTarget.dataset;
    const agreed = ok === true || ok === 'true';
    if (!agreed && !(await page.confirm('提出异议', '提出异议后平台将介入核实，确定吗？'))) return;
    this.setData({ busyId: id });
    try {
      await api.post(`/api/appointments/${id}/confirm`, { ok: agreed });
      page.toast(agreed ? '已确认，感谢反馈' : '已提交异议', 'success');
      await this.reload();
    } catch (_e) {
      /* request 层已弹出失败原因 */
    }
    this.setData({ busyId: 0 });
  },
});
