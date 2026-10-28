const auth = require('./utils/auth.js');
const api = require('./utils/request.js');

const MSG_TAB_INDEX = 2;

App({
  loginPromise: null,

  ensureLoginReady() {
    if (!this.loginPromise) {
      this.loginPromise = auth.ensureLogin().catch((e) => {
        this.loginPromise = null;
        throw e;
      });
    }
    return this.loginPromise;
  },

  resetLogin() {
    this.loginPromise = null;
  },

  /** 刷新「消息」Tab 的未读角标；仅在 Tab 页调用，失败静默 */
  async refreshBadge() {
    try {
      const list = await api.get('/api/notifications?unread=true', { silent: true });
      if (list.length > 0)
        wx.setTabBarBadge({ index: MSG_TAB_INDEX, text: list.length > 49 ? '49+' : String(list.length) });
      else wx.removeTabBarBadge({ index: MSG_TAB_INDEX });
    } catch (_e) {
      /* 角标是锦上添花，不打扰用户 */
    }
  },
});
