Page({
  data: { loading: false },

  async onTapLogin() {
    this.setData({ loading: true });
    try {
      await getApp().ensureLoginReady();
      wx.reLaunch({ url: '/pages/index/index' });
    } catch (e) {
      /* toast 已由下层给出 */
    }
    this.setData({ loading: false });
  },
});
