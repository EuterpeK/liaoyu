/** 站内通知 → 展示文案与跳转页（均为 tab 页或普通页的绝对路径） */

const SERVICES = '/pages/services/services';
const CHOICES = '/pages/choices/choices';
const LEAVES = '/pages/teacher/leaves/leaves';

const TABS = new Set([SERVICES, '/pages/index/index', '/pages/messages/messages', '/pages/profile/profile']);

const MAP = {
  order_paid: { title: '支付成功', body: '服务已开通，快去预约第一次通话吧', url: SERVICES },
  appointment_booked: {
    title: '收到新的预约',
    body: (p) => (p.date ? `${p.date} ${p.start || ''} 的预约已生成` : '有学员预约了你的时段'),
    url: SERVICES,
  },
  appointment_cancelled: {
    title: '预约已取消',
    body: (p) => (p.by === 'leave' ? '因老师请假，预约已取消' : '一个预约已被取消'),
    url: SERVICES,
  },
  teacher_no_show: { title: '老师未按时进入', body: '该次预约已记为老师缺席，不会扣减次数', url: SERVICES },
  call_confirm_request: { title: '请确认本次通话', body: '48 小时内未确认将自动确认', url: SERVICES },
  call_disputed: { title: '学员对通话有异议', body: '平台将介入核实，请保持联系方式畅通', url: SERVICES },
  leave_notice: {
    title: '老师请假通知',
    body: (p) =>
      p.startDate ? `${p.startDate} 至 ${p.endDate}，请在 48 小时内选择等待或更换代班老师` : '请选择等待或更换代班老师',
    url: CHOICES,
  },
  substitute_available: { title: '有代班老师可选', body: '一位老师已同意代班，可前往选择', url: CHOICES },
  substitute_revoked: { title: '代班安排已调整', body: '代班被撤销，请重新选择', url: CHOICES },
  leave_choice_expired: { title: '选择已超时', body: '服务将暂停并顺延，老师回来后自动恢复', url: SERVICES },
  substitute_assigned: { title: '你被安排代班', body: '请留意新增的学员与预约', url: SERVICES },
  substitute_invite: { title: '代班邀请', body: '有老师邀请你在其请假期间代班', url: LEAVES },
  substitute_response: {
    title: '代班回复',
    body: (p) => (p.accept ? '有老师同意代班' : '有老师拒绝了代班'),
    url: LEAVES,
  },
  leave_choice: { title: '学员做出了选择', body: '学员已选择等待或更换代班', url: LEAVES },
  crisis_hotline: {
    title: '我们很关心你',
    body: (p) => `如果你正处于危急情况，请拨打求助热线 ${p.hotline || '12356'}，或联系身边的人`,
    url: '',
  },
  crisis_alert: { title: '风险提示', body: '对话中出现了需要关注的内容，请及时关怀并按规范处理', url: '' },
  private_trade_warning: { title: '请勿私下交易', body: '平台外交易不受保障，请通过平台完成服务与支付', url: '' },
};

const FALLBACK = { title: '新消息', body: '', url: '' };

/** 通知 → { title, body, url, isTab } */
function describe(n) {
  const m = MAP[n.type] || FALLBACK;
  const payload = n.payload || {};
  const body = typeof m.body === 'function' ? m.body(payload) : m.body;
  return { title: m.title, body, url: m.url, isTab: TABS.has(m.url) };
}

module.exports = { describe, MAP, TABS };
