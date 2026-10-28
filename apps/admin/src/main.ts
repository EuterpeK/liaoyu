import 'tdesign-vue-next/es/style/index.css';
import { createPinia } from 'pinia';
import { MessagePlugin } from 'tdesign-vue-next';
import { createApp } from 'vue';
import App from './App.vue';
import { configureHttp } from './api/http.ts';
import { router } from './router/index.ts';
import { useAuth } from './stores/auth.ts';

const app = createApp(App);
app.use(createPinia());
app.use(router);

const auth = useAuth();
configureHttp({
  onUnauthorized: () => {
    auth.clear();
    router.push({ path: '/login', query: { redirect: router.currentRoute.value.fullPath } });
  },
  onForbidden: () => {
    MessagePlugin.warning('无权限执行该操作');
  },
  onError: (message) => {
    MessagePlugin.error(message);
  },
});

app.mount('#app');
