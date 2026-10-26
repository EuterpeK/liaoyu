const auth = require('../../utils/auth.js');

Page({
  data: { me: null },

  async onShow() {
    try {
      await getApp().ensureLoginReady();
      this.setData({ me: await auth.fetchMe().then((m) => auth.withRole(m)) });
    } catch (e) {
      wx.redirectTo({ url: '/pages/login/login' });
    }
  },

  onTapSwitch() {
    getApp().resetLogin();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
