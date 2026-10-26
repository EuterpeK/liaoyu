const auth = require('./utils/auth.js');

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
});
