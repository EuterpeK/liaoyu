const api = require('../../../utils/request.js');
const page = require('../../../utils/page.js');

const PRESET = ['情感', '婚恋', '家庭', '职场', '学业', '成长', '人际', '情绪', '睡眠', '亲子'];

const splitLines = (s) =>
  s
    .split(/[\n,，、;；]/)
    .map((x) => x.trim())
    .filter(Boolean);

Page({
  data: {
    presets: PRESET.map((name) => ({ name, on: false })),
    displayName: '',
    realName: '',
    intro: '',
    credentials: '',
    submitting: false,
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.k]: e.detail.value });
  },

  onTapDirection(e) {
    const i = e.currentTarget.dataset.i;
    const on = this.data.presets.filter((p) => p.on).length;
    const cur = this.data.presets[i];
    if (!cur.on && on >= 5) return page.toast('最多选择 5 个方向');
    this.setData({ [`presets[${i}].on`]: !cur.on });
    return undefined;
  },

  /** 返回错误文案；无错返回空串 */
  validate() {
    const d = this.data;
    if (!d.displayName.trim()) return '请填写展示名';
    if (!d.realName.trim()) return '请填写真实姓名';
    if (!d.presets.some((p) => p.on)) return '请至少选择一个擅长方向';
    return '';
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const err = this.validate();
    if (err) {
      page.toast(err);
      return;
    }
    const d = this.data;
    this.setData({ submitting: true });
    try {
      await api.post('/api/teacher/apply', {
        displayName: d.displayName.trim(),
        realName: d.realName.trim(),
        intro: d.intro.trim(),
        directions: d.presets.filter((p) => p.on).map((p) => p.name),
        credentials: splitLines(d.credentials),
      });
      getApp().resetLogin();
      page.toast('已提交，等待审核', 'success');
      setTimeout(() => wx.navigateBack(), 900);
    } catch (_e) {
      /* request 层已弹出失败原因 */
    }
    this.setData({ submitting: false });
  },
});
