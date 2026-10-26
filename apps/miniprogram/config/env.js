// 开发直连本地后端；生产换成 https://$DOMAIN（需加入小程序 request 合法域名）
const ENV = 'dev';

const BASE_URLS = {
  dev: 'http://localhost:8700',
  prod: 'https://CHANGE_ME.example.com',
};

module.exports = { baseURL: BASE_URLS[ENV] };
