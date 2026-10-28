const api = require('../../../utils/request.js');
const page = require('../../../utils/page.js');
const forms = require('../../../utils/forms.js');
const { FEN, TYPE_TEXT } = require('../../../utils/format.js');

const TYPES = ['single', 'month', 'quarter', 'year'].map((k) => ({ k, text: TYPE_TEXT[k] }));

const view = (p) => ({
  ...p,
  yuan: FEN(p.priceCents),
  typeText: TYPE_TEXT[p.type] || p.type,
  daysText: p.type === 'single' ? '一次性' : `${p.days} 天`,
});

Page({
  data: {
    loading: true,
    error: '',
    list: [],
    types: TYPES,
    showForm: false,
    form: { type: 'month', title: '', yuan: '', callQuota: '4', replyHours: '24' },
    submitting: false,
    busyId: 0,
  },

  onShow() {
    return this.reload();
  },

  onRetry() {
    return this.reload();
  },

  async reload() {
    await page.load(this, async () => {
      const rows = await api.get('/api/teacher/packages', { silent: true });
      this.setData({ list: rows.map(view), loading: false });
    });
  },

  async onSwitchSale(e) {
    const { id } = e.currentTarget.dataset;
    const onSale = e.detail.value;
    this.setData({ busyId: id });
    try {
      await api.patch(`/api/teacher/packages/${id}`, { onSale });
      this.setData({ list: this.data.list.map((p) => (p.id === id ? { ...p, onSale } : p)) });
    } catch (_e) {
      await this.reload(); // 开关回滚到服务端真实状态
    }
    this.setData({ busyId: 0 });
  },

  /** 改价：已购买的订单不受影响（订单保存了套餐快照） */
  onTapPrice(e) {
    const p = this.data.list.find((x) => x.id === e.currentTarget.dataset.id);
    wx.showModal({
      title: '修改价格（元）',
      editable: true,
      placeholderText: p.yuan,
      content: '',
      confirmColor: '#1d7a52',
      success: async (r) => {
        if (!r.confirm) return;
        const cents = forms.parseYuan(r.content);
        if (!cents) {
          page.toast('请输入大于 0 的金额，最多两位小数');
          return;
        }
        try {
          await api.patch(`/api/teacher/packages/${p.id}`, { priceCents: cents });
          page.toast('已更新', 'success');
          await this.reload();
        } catch (_e) {
          /* request 层已弹出失败原因 */
        }
      },
    });
  },

  onTapToggleForm() {
    this.setData({ showForm: !this.data.showForm });
  },

  onPickType(e) {
    this.setData({ 'form.type': e.currentTarget.dataset.k });
  },

  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.k}`]: e.detail.value });
  },

  /** 返回 { error } 或 { body } */
  buildBody() {
    const f = this.data.form;
    const title = f.title.trim();
    if (!title) return { error: '请填写套餐名称' };
    const priceCents = forms.parseYuan(f.yuan);
    if (!priceCents) return { error: '请输入大于 0 的价格，最多两位小数' };
    const replyHours = forms.parsePositiveInt(f.replyHours);
    if (!replyHours) return { error: '回复时限须为正整数（小时）' };
    const callQuota = f.type === 'single' ? 1 : forms.parseCount(f.callQuota);
    if (callQuota === null) return { error: '通话次数须为非负整数' };
    return { body: { type: f.type, title, priceCents, callQuota, replyHours } };
  },

  async onSubmit() {
    if (this.data.submitting) return;
    const r = this.buildBody();
    if (r.error) {
      page.toast(r.error);
      return;
    }
    this.setData({ submitting: true });
    try {
      await api.post('/api/teacher/packages', r.body);
      page.toast('已创建', 'success');
      this.setData({ showForm: false, form: { type: 'month', title: '', yuan: '', callQuota: '4', replyHours: '24' } });
      await this.reload();
    } catch (_e) {
      /* request 层已弹出失败原因（如：年包仅 L3 及以上开放） */
    }
    this.setData({ submitting: false });
  },
});
