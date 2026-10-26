// 开发直连本地后端；生产换成 https://$DOMAIN（需加入小程序 request 合法域名）
const ENV = 'dev';

const BASE_URLS = {
  // 云工作区 IP（微信开发者工具运行在 Mac 上，localhost 指向 Mac 本机，须直连工作区）
  dev: 'http://21.91.250.149:8700',
  prod: 'https://CHANGE_ME.example.com',
};

module.exports = { baseURL: BASE_URLS[ENV] };
