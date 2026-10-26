Page({
  data: { loading: false },

  async onTapLogin() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLoginReady();
      wx.reLaunch({ url: '/pages/index/index' });
    } catch (e) {
      wx.showToast({ title: '登录失败，请重试', icon: 'none' });
    }
    this.setData({ loading: false });
  },
});
