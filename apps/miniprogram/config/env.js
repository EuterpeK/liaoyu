// 按运行环境自动选择：开发版 → dev；体验版/正式版 → prod（无需手动改常量，避免发版遗漏）
// prod 域名需加入小程序后台「request 合法域名」
const BASE_URLS = {
  // 云工作区 IP（微信开发者工具运行在 Mac 上，localhost 指向 Mac 本机，须直连工作区）
  dev: 'http://21.91.250.149:10001',
  prod: 'https://CHANGE_ME.example.com',
};

function detectEnvVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || 'develop';
  } catch (_e) {
    return 'develop';
  }
}

const envVersion = detectEnvVersion();
const ENV = envVersion === 'develop' ? 'dev' : 'prod';

module.exports = { baseURL: BASE_URLS[ENV], isDev: ENV === 'dev', envVersion };
