const api = require('../../utils/request.js');
const page = require('../../utils/page.js');
const { countdown, dayLabel } = require('../../utils/format.js');

const RESULT_TEXT = { wait: '已选择等待', substitute: '已选择代班', expired: '已超时（服务暂停顺延）' };
const RESULT_TONE = { wait: 'green', substitute: 'green', expired: 'gray' };

function view(c, now) {
  const open = c.status === 'pending' && new Date(c.deadlineAt).getTime() > now;
  return {
    ...c,
    candidates: c.candidates.map((x) => ({ ...x, initial: (x.displayName || '师')[0] })),
    open,
    range: `${dayLabel(c.startDate)} 至 ${dayLabel(c.endDate)}`,
    left: open ? countdown(c.deadlineAt) : '',
    resultText: c.status === 'pending' ? '已超时（服务暂停顺延）' : RESULT_TEXT[c.status] || c.status,
    resultTone: c.status === 'pending' ? 'gray' : RESULT_TONE[c.status] || 'gray',
    pickedName: c.candidates.find((x) => x.teacherId === c.substituteTeacherId)?.displayName || '',
  };
}

Page({
  data: { loading: true, error: '', open: [], closed: [], busyId: 0 },

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
      const rows = await api.get('/api/leave-choices', { silent: true });
      const now = Date.now();
      const views = rows.map((c) => view(c, now));
      this.setData({ open: views.filter((c) => c.open), closed: views.filter((c) => !c.open), loading: false });
    });
  },

  async decide(choiceId, body, title, content) {
    if (!(await page.confirm(title, content))) return;
    this.setData({ busyId: choiceId });
    try {
      await api.post(`/api/leave-choices/${choiceId}`, body);
      page.toast('已提交', 'success');
      await this.reload();
    } catch (_e) {
      /* request 层已弹出失败原因 */
    }
    this.setData({ busyId: 0 });
  },

  onTapWait(e) {
    const c = this.data.open.find((x) => x.id === e.currentTarget.dataset.id);
    return this.decide(
      c.id,
      { action: 'wait' },
      '等待原老师',
      `请假期间服务暂停，到期自动顺延，确定等待 ${c.ownerName} 吗？`,
    );
  },

  onTapSubstitute(e) {
    const { id, tid, name } = e.currentTarget.dataset;
    return this.decide(
      id,
      { action: 'substitute', teacherId: tid },
      '选择代班老师',
      `请假期间由 ${name} 为你服务，确定吗？`,
    );
  },
});
