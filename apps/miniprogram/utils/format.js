const FEN = (cents) => (cents / 100).toFixed(2);

const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 未来 n 天（含今天）的 [{date, label}]，label 如「10-26 周一」 */
function nextDays(n) {
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const today = new Date();
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    return { date: ymd(d), label: `${ymd(d).slice(5)} ${weeks[d.getDay()]}` };
  });
}

module.exports = { FEN, ymd, nextDays };
