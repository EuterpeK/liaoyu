/** 排班与表单的纯逻辑（无 wx 依赖，可在 Node 中直接测试） */

/** 展示顺序：周一 → 周日；weekday 沿用后端约定（0=周日） */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEK_LABEL = { 0: '周日', 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六' };

const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function sortItems(items) {
  return [...items].sort((a, b) => a.weekday - b.weekday || toMin(a.start) - toMin(b.start));
}

/** 向某天添加一个时段。返回 { items } 或 { error } */
function addRange(items, r) {
  if (!r.start || !r.end) return { error: '请选择开始与结束时间' };
  if (toMin(r.start) >= toMin(r.end)) return { error: '结束时间须晚于开始时间' };
  const clash = items.some(
    (x) => x.weekday === r.weekday && toMin(r.start) < toMin(x.end) && toMin(x.start) < toMin(r.end),
  );
  if (clash) return { error: '与已有时段重叠' };
  return { items: sortItems([...items, { weekday: r.weekday, start: r.start, end: r.end }]) };
}

function removeRange(items, weekday, start) {
  return items.filter((x) => !(x.weekday === weekday && x.start === start));
}

/** 把 from 这天的时段复制到 targets（先清空目标日再复制） */
function copyDay(items, from, targets) {
  const src = items.filter((x) => x.weekday === from);
  const rest = items.filter((x) => !targets.includes(x.weekday) || x.weekday === from);
  const copies = targets
    .filter((t) => t !== from)
    .flatMap((t) => src.map((x) => ({ weekday: t, start: x.start, end: x.end })));
  return sortItems([...rest, ...copies]);
}

/** 7 天概览：[{ wd, label, count, ranges }]，按周一到周日 */
function groupByDay(items) {
  return WEEK_ORDER.map((wd) => {
    const ranges = items.filter((x) => x.weekday === wd).map((x) => ({ start: x.start, end: x.end }));
    return { wd, label: WEEK_LABEL[wd], count: ranges.length, ranges };
  });
}

/** 元 → 分；非法/非正数返回 null。最多两位小数 */
function parseYuan(s) {
  const t = String(s).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 ? cents : null;
}

/** 正整数；非法返回 null */
function parsePositiveInt(s) {
  const t = String(s).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/** 非负整数；空串视为 0；非法返回 null */
function parseCount(s) {
  const t = String(s).trim();
  if (t === '') return 0;
  return /^\d+$/.test(t) ? Number(t) : null;
}

const MAX_LEAVE_DAYS = 60;
const MAX_CANDIDATES = 3;

/** 两个 YYYY-MM-DD 之间相差的天数（b - a） */
function daysBetween(a, b) {
  const t = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / 86400000);
}

/** 请假表单校验（规则与后端一致）。返回错误文案，无错返回空串 */
function validateLeave({ startDate, endDate, picked }, today) {
  if (!startDate || !endDate) return '请选择请假起止日期';
  if (startDate < today) return '请假开始日期不能早于今天';
  if (endDate < startDate) return '结束日期不能早于开始日期';
  if (daysBetween(startDate, endDate) + 1 > MAX_LEAVE_DAYS) return `单次请假最长 ${MAX_LEAVE_DAYS} 天`;
  if (!picked.length) return `请至少指定 1 位代班老师`;
  if (picked.length > MAX_CANDIDATES) return `最多指定 ${MAX_CANDIDATES} 位代班老师`;
  return '';
}

module.exports = {
  MAX_LEAVE_DAYS,
  MAX_CANDIDATES,
  daysBetween,
  validateLeave,
  WEEK_ORDER,
  WEEK_LABEL,
  toMin,
  addRange,
  removeRange,
  copyDay,
  groupByDay,
  parseYuan,
  parsePositiveInt,
  parseCount,
};
