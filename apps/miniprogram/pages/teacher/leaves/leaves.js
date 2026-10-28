const api = require('../../../utils/request.js');
const page = require('../../../utils/page.js');
const forms = require('../../../utils/forms.js');
const { dayLabel, ymd } = require('../../../utils/format.js');

const CAND_TEXT = { invited: '待回复', accepted: '已同意', rejected: '已拒绝', revoked: '已撤销' };
const CAND_TONE = { invited: 'gold', accepted: 'green', rejected: 'gray', revoked: 'gray' };

function viewLeave(l, today) {
  const count = (s) => l.choices.filter((c) => c.status === s).length;
  const open = l.endDate >= today;
  return {
    ...l,
    range: `${dayLabel(l.startDate)} 至 ${dayLabel(l.endDate)}`,
    days: forms.daysBetween(l.startDate, l.endDate) + 1,
    open,
    candidates: l.candidates.map((c) => ({
      ...c,
      initial: (c.displayName || '师')[0],
      statusText: CAND_TEXT[c.status] || c.status,
      tone: CAND_TONE[c.status] || 'gray',
      canRevoke: open && c.status === 'accepted',
    })),
    summary: l.choices.length
      ? `学员选择：等待 ${count('wait')} · 代班 ${count('substitute')} · 待选 ${count('pending')} · 超时 ${count('expired')}`
      : '',
  };
}

Page({
  data: {
    loading: true,
    error: '',
    today: '',
    invites: [],
    leaves: [],
    showForm: false,
    form: { startDate: '', endDate: '', reason: '' },
    teachers: [],
    submitting: false,
    busyKey: '',
  },

  onShow() {
    return this.reload();
  },

  onRetry() {
    return this.reload();
  },

  async reload() {
    await page.load(this, async () => {
      const today = ymd(new Date());
      const [leaves, invites] = await Promise.all([
        api.get('/api/teacher/leaves', { silent: true }),
        api.get('/api/teacher/substitute-invites', { silent: true }),
      ]);
      this.setData({
        today,
        leaves: leaves.map((l) => viewLeave(l, today)),
        invites: invites.map((i) => ({
          ...i,
          range: `${dayLabel(i.startDate)} 至 ${dayLabel(i.endDate)}`,
          statusText: CAND_TEXT[i.status] || i.status,
          tone: CAND_TONE[i.status] || 'gray',
          pending: i.status === 'invited' && i.endDate >= today,
        })),
        loading: false,
      });
    });
  },

  /* ---------------- 代班邀请 ---------------- */
  async onTapRespond(e) {
    const { id, accept } = e.currentTarget.dataset;
    const yes = accept === true || accept === 'true';
    if (
      !(await page.confirm(
        yes ? '同意代班' : '拒绝代班',
        yes ? '同意后，学员可能选择由你代班。' : '确定拒绝这次代班邀请吗？',
      ))
    )
      return;
    this.setData({ busyKey: `i${id}` });
    try {
      await api.post(`/api/teacher/substitute-invites/${id}/respond`, { accept: yes });
      page.toast(yes ? '已同意' : '已拒绝', 'success');
      await this.reload();
    } catch (_e) {
      /* request 层已弹出失败原因 */
    }
    this.setData({ busyKey: '' });
  },

  /* ---------------- 撤销代班 ---------------- */
  async onTapRevoke(e) {
    const { lid, tid, name } = e.currentTarget.dataset;
    if (!(await page.confirm('撤销代班', `撤销后 ${name} 的代班安排将取消，相关学员需要重新选择。`))) return;
    this.setData({ busyKey: `r${lid}-${tid}` });
    try {
      await api.post(`/api/teacher/leaves/${lid}/candidates/${tid}/revoke`);
      page.toast('已撤销', 'success');
      await this.reload();
    } catch (_e) {
      /* request 层已弹出失败原因 */
    }
    this.setData({ busyKey: '' });
  },

  /* ---------------- 申请请假 ---------------- */
  async onTapToggleForm() {
    const show = !this.data.showForm;
    this.setData({ showForm: show });
    if (show && !this.data.teachers.length) await this.loadTeachers();
  },

  async loadTeachers() {
    try {
      const me = await getApp().ensureLoginReady();
      const list = await api.get('/api/teachers', { silent: true });
      this.setData({
        teachers: list
          .filter((t) => t.id !== me.user.id)
          .map((t) => ({ id: t.id, displayName: t.displayName, level: t.level, on: false })),
      });
    } catch (e) {
      page.toast(e.message || '加载老师列表失败');
    }
  },

  onPickDate(e) {
    this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value });
  },

  onInputReason(e) {
    this.setData({ 'form.reason': e.detail.value });
  },

  onTapCandidate(e) {
    const i = e.currentTarget.dataset.i;
    const cur = this.data.teachers[i];
    const picked = this.data.teachers.filter((t) => t.on).length;
    if (!cur.on && picked >= forms.MAX_CANDIDATES) {
      page.toast(`最多指定 ${forms.MAX_CANDIDATES} 位代班老师`);
      return;
    }
    this.setData({ [`teachers[${i}].on`]: !cur.on });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const { form, today } = this.data;
    const picked = this.data.teachers.filter((t) => t.on).map((t) => t.id);
    const err = forms.validateLeave({ startDate: form.startDate, endDate: form.endDate, picked }, today);
    if (err) {
      page.toast(err);
      return;
    }
    if (!(await page.confirm('提交请假', '提交后，请假期间的预约将被取消，并通知相关学员选择等待或代班。'))) return;
    this.setData({ submitting: true });
    try {
      await api.post('/api/teacher/leaves', {
        startDate: form.startDate,
        endDate: form.endDate,
        reason: form.reason.trim(),
        candidateIds: picked,
      });
      page.toast('已提交', 'success');
      this.setData({
        showForm: false,
        form: { startDate: '', endDate: '', reason: '' },
        teachers: this.data.teachers.map((t) => ({ ...t, on: false })),
      });
      await this.reload();
    } catch (_e) {
      /* request 层已弹出失败原因 */
    }
    this.setData({ submitting: false });
  },
});
