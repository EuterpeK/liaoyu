const api = require('../../../utils/request.js');
const page = require('../../../utils/page.js');
const forms = require('../../../utils/forms.js');

const WORKDAYS = [1, 2, 3, 4, 5];

Page({
  data: {
    loading: true,
    error: '',
    items: [],
    days: [],
    wd: 1,
    ranges: [],
    start: '09:00',
    end: '10:00',
    dirty: false,
    saving: false,
  },

  onShow() {
    // 编辑中不要被 onShow 覆盖未保存的改动
    if (this.data.dirty) return undefined;
    return this.reload();
  },

  onRetry() {
    return this.reload();
  },

  async reload() {
    await page.load(this, async () => {
      const items = await api.get('/api/teacher/schedule', { silent: true });
      this.setItems(items, false);
      this.setData({ loading: false });
    });
  },

  setItems(items, dirty) {
    const days = forms.groupByDay(items);
    this.setData({
      items,
      days,
      ranges: (days.find((d) => d.wd === this.data.wd) || { ranges: [] }).ranges,
      dirty,
    });
  },

  onTapDay(e) {
    const wd = e.currentTarget.dataset.wd;
    this.setData({ wd, ranges: this.data.days.find((d) => d.wd === wd).ranges });
  },

  onStart(e) {
    this.setData({ start: e.detail.value });
  },

  onEnd(e) {
    this.setData({ end: e.detail.value });
  },

  onTapAdd() {
    const r = forms.addRange(this.data.items, { weekday: this.data.wd, start: this.data.start, end: this.data.end });
    if (r.error) {
      page.toast(r.error);
      return;
    }
    this.setItems(r.items, true);
  },

  onTapRemove(e) {
    this.setItems(forms.removeRange(this.data.items, this.data.wd, e.currentTarget.dataset.start), true);
  },

  async onTapCopyWorkdays() {
    if (!this.data.ranges.length) {
      page.toast('当前这天还没有时段');
      return;
    }
    if (!(await page.confirm('复制到工作日', '将把当天的时段复制到周一至周五，并覆盖这些天原有的时段。'))) return;
    this.setItems(forms.copyDay(this.data.items, this.data.wd, WORKDAYS), true);
  },

  async onTapSave() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      const items = await api.put('/api/teacher/schedule', { items: this.data.items });
      this.setItems(items, false);
      page.toast('已保存', 'success');
    } catch (_e) {
      /* request 层已弹出失败原因 */
    }
    this.setData({ saving: false });
  },
});
