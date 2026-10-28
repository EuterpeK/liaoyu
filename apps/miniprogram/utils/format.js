const FEN = (cents) => (cents / 100).toFixed(2);

const p2 = (n) => String(n).padStart(2, '0');

const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

const WEEKS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 未来 n 天（含今天）的 [{date, label}]，label 如「10-26 周一」 */
function nextDays(n) {
  const today = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    return { date: ymd(d), label: `${ymd(d).slice(5)} ${WEEKS[d.getDay()]}` };
  });
}

/** ISO 时间串 → 本地 "HH:MM" */
const hm = (iso) => {
  const d = new Date(iso);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** "YYYY-MM-DD" → "MM-DD 周X"（按本地日历日，避免时区偏移） */
function dayLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${p2(m)}-${p2(d)} ${WEEKS[new Date(y, m - 1, d).getDay()]}`;
}

/** 距离某个 YYYY-MM-DD（含当天）还有几天；已过期返回 0 */
function daysLeft(endDate, now = new Date()) {
  const [y, m, d] = endDate.split('-').map(Number);
  const end = new Date(y, m - 1, d).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(0, Math.round((end - today) / 86400000) + 1);
}

/** 距截止时间的人性化文案：「还剩 3 小时 20 分」「已截止」 */
function countdown(iso, now = new Date()) {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return '已截止';
  const mins = Math.floor(ms / 60000);
  const days = Math.floor(mins / 1440);
  if (days >= 1) return `还剩 ${days} 天 ${Math.floor((mins % 1440) / 60)} 小时`;
  const hours = Math.floor(mins / 60);
  return hours >= 1 ? `还剩 ${hours} 小时 ${mins % 60} 分` : `还剩 ${mins} 分钟`;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / MM-DD */
function ago(iso, now = new Date()) {
  const d = new Date(iso);
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  if (mins < 1440 && ymd(d) === ymd(now)) return `${Math.floor(mins / 60)} 小时前`;
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm(iso)}`;
}

/** 预约状态：文案 + 色调 */
const STATUS_TEXT = { booked: '已预约', completed: '已完成', cancelled: '已取消', teacher_no_show: '老师缺席' };
const STATUS_TONE = { booked: 'green', completed: 'gray', cancelled: 'gray', teacher_no_show: 'red' };

/** 单次通话确认状态（仅 completed 且 confirmStatus 非空时有意义） */
const CONFIRM_TEXT = { pending: '待确认', confirmed: '已确认', auto: '已自动确认', disputed: '有异议' };

const REL_STATUS_TEXT = { active: '服务中', ended: '已结束', refunded: '已退款', switched: '已转出' };
const REL_STATUS_TONE = { active: 'green', ended: 'gray', refunded: 'gray', switched: 'gray' };

const ORDER_STATUS_TEXT = { pending: '待支付', paid: '已支付' };
const ORDER_STATUS_TONE = { pending: 'gold', paid: 'green' };

const TYPE_TEXT = { single: '单次通话', month: '月度陪伴', quarter: '季度陪伴', year: '年度陪伴' };

/** 把预约行补全为视图模型 */
function viewAppointment(a, nameKey = 'teacherName') {
  const confirm = a.status === 'completed' && a.confirmStatus ? a.confirmStatus : '';
  return {
    ...a,
    peerName: a[nameKey] || (nameKey === 'userNickname' ? '学员' : '老师'),
    dayText: dayLabel(a.date),
    hm: hm(a.startAt),
    endHm: hm(a.endAt),
    statusText: confirm ? CONFIRM_TEXT[confirm] : STATUS_TEXT[a.status] || a.status,
    tone: confirm
      ? confirm === 'disputed'
        ? 'red'
        : confirm === 'pending'
          ? 'gold'
          : 'green'
      : STATUS_TONE[a.status] || 'gray',
    needConfirm: confirm === 'pending',
  };
}

/** 预约拆分：未结束的 booked（按开始时间升序）与历史（倒序，沿用接口顺序） */
function splitAppointments(list) {
  const upcoming = list.filter((a) => a.status === 'booked').sort((a, b) => new Date(a.startAt) - new Date(b.startAt));
  const history = list.filter((a) => a.status !== 'booked');
  return { upcoming, history };
}

module.exports = {
  FEN,
  ymd,
  WEEKS,
  nextDays,
  hm,
  dayLabel,
  daysLeft,
  countdown,
  ago,
  STATUS_TEXT,
  CONFIRM_TEXT,
  REL_STATUS_TEXT,
  REL_STATUS_TONE,
  ORDER_STATUS_TEXT,
  ORDER_STATUS_TONE,
  TYPE_TEXT,
  viewAppointment,
  splitAppointments,
};
