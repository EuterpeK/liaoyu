const _auth = require('../../utils/auth.js');

Page({
  data: { me: null, initial: '?' },

  async onShow() {
    try {
      const me = await getApp().ensureLoginReady();
      const displayName = me.role === 'teacher' ? me.teacher.displayName : me.user.nickname;
      this.setData({ me, initial: (displayName || `U${me.user.id}`)[0] });
    } catch (_e) {
      wx.reLaunch({ url: '/pages/login/login' });
    }
  },

  onTapSwitch() {
    getApp().resetLogin();
    wx.reLaunch({ url: '/pages/login/login' });
  },
});
