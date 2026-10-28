/**
 * 页面加载封装：统一「登录 → 拉数据 → 失败处理」。
 *  - 登录失效（kind=auth）→ 回登录页
 *  - 其余失败 → 页面展示错误与重试（不把失败吞成空列表）
 * 用法：onShow() { return page.load(this, async (me) => { ...setData }); }
 */
async function load(page, fn) {
  page.setData({ error: '' });
  try {
    const me = await getApp().ensureLoginReady();
    await fn(me);
  } catch (e) {
    if (e && e.kind === 'auth') return wx.reLaunch({ url: '/pages/login/login' });
    page.setData({ loading: false, error: e?.message || '加载失败，请重试' });
  }
  return undefined;
}

/** 二次确认弹窗 → Promise<boolean> */
function confirm(title, content) {
  return new Promise((resolve) =>
    wx.showModal({
      title,
      content,
      confirmColor: '#1d7a52',
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false),
    }),
  );
}

function toast(title, icon = 'none') {
  wx.showToast({ title, icon });
}

/** 去某个页面；tab 页用 switchTab */
function go(url, isTab) {
  if (!url) return;
  if (isTab) wx.switchTab({ url });
  else wx.navigateTo({ url });
}

module.exports = { load, confirm, toast, go };
