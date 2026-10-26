const auth = require('../../utils/auth.js');

Page({
  data: { me: null },

  async onShow() {
    try {
      const me = await getApp().ensureLoginReady();
      this.setData({ me });
    } catch (e) {
      wx.reLaunch({ url: '/pages/login/login' });
    }
  },

  onTapSwitch() {
    getApp().resetLogin();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
