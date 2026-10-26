const { baseURL } = require('../../../config/env.js');
const api = require('../../../utils/request.js');

Page({
  data: { title: '', yuan: '', packageId: 0, paying: false, paid: false },

  onLoad({ packageId, title, yuan }) {
    this.setData({ packageId: Number(packageId), title: decodeURIComponent(title), yuan });
  },

  async onTapPay() {
    if (this.data.paying) return;
    this.setData({ paying: true });
    try {
      const order = await api.post('/api/orders', { packageId: this.data.packageId });
      if (order.mock) {
        await this.mockPay(order.outTradeNo);
      } else {
        this.realPay(order);
        this.setData({ paying: false });
        return;
      }
      await this.waitPaid(order.outTradeNo);
      this.setData({ paid: true, paying: false });
      wx.showToast({ title: '支付成功', icon: 'success' });
      setTimeout(() => wx.switchTab({ url: '/pages/services/services' }), 800);
    } catch (e) {
      if (e && e.message === '支付确认超时') {
        wx.showToast({ title: '支付确认超时，请稍后在服务页查看', icon: 'none' });
      }
      this.setData({ paying: false });
    }
  },

  /** 后端模拟收银台：确认接口无鉴权，返回 HTML 忽略 body */
  mockPay(outTradeNo) {
    return new Promise((resolve, reject) => {
      wx.request({
        url: `${baseURL}/api/pay/mock/confirm?out_trade_no=${encodeURIComponent(outTradeNo)}`,
        method: 'POST',
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve();
          wx.showToast({ title: '支付确认失败', icon: 'none' });
          reject(new Error('mock confirm ' + res.statusCode));
        },
        fail: () => {
          wx.showToast({ title: '网络异常，请重试', icon: 'none' });
          reject(new Error('network'));
        },
      });
    });
  },

  realPay(order) {
    // TODO(正式支付): 调用 wx.requestPayment({timeStamp, nonceStr, package, signType, paySign})
    // 参数需后端提供 JSAPI 下单接口（ZPAY 适配），首版仅 MOCK。
    wx.showToast({ title: '正式支付尚未开通', icon: 'none' });
  },

  waitPaid(outTradeNo, times = 10) {
    return new Promise((resolve, reject) => {
      const tick = async (left) => {
        const o = await api.get(`/api/orders/${outTradeNo}`, { silent: true }).catch(() => null);
        if (o && o.paid) return resolve();
        if (left <= 0) return reject(new Error('支付确认超时'));
        setTimeout(() => tick(left - 1), 1000);
      };
      tick(times);
    });
  },
});
