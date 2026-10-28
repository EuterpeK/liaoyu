<script setup lang="ts">
import { LockOnIcon } from 'tdesign-icons-vue-next';
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api/http.ts';
import { useAuth } from '../stores/auth.ts';

const auth = useAuth();
const route = useRoute();
const router = useRouter();

const form = reactive({ username: '', password: '' });
const error = ref('');
const submitting = ref(false);

async function submit() {
  error.value = '';
  if (!form.username.trim() || !form.password) {
    error.value = '请输入用户名和密码';
    return;
  }
  submitting.value = true;
  try {
    await auth.login(form.username.trim(), form.password);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/overview';
    await router.replace(redirect.startsWith('/') ? redirect : '/overview');
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '网络异常或服务未启动';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <div class="card">
      <div class="logo">LiaoYu</div>
      <div class="sub">管 理 台</div>
      <t-form :data="form" @submit="submit">
        <t-form-item name="username">
          <t-input v-model="form.username" placeholder="管理员用户名" autocomplete="username" size="large" />
        </t-form-item>
        <t-form-item name="password">
          <t-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            autocomplete="current-password"
            size="large"
            @enter="submit"
          >
            <template #prefix-icon><lock-on-icon /></template>
          </t-input>
        </t-form-item>
        <t-button block size="large" theme="primary" type="submit" :loading="submitting">登 录</t-button>
      </t-form>
      <div v-if="error" class="err" role="alert">{{ error }}</div>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(180deg, #e8f3ec 0%, #f2f8f3 100%);
}
.card {
  width: 360px;
  padding: 40px 36px;
  border-radius: 16px;
  background: #fff;
  box-shadow: 0 12px 40px rgba(31, 59, 44, 0.08);
}
.logo {
  font-size: 34px;
  font-weight: 800;
  letter-spacing: 3px;
  color: #1d5c3f;
  text-align: center;
}
.sub {
  color: #6f8b7d;
  font-size: 13px;
  letter-spacing: 4px;
  text-align: center;
  margin: 8px 0 28px;
}
.err {
  color: #c05a3c;
  font-size: 13px;
  margin-top: 12px;
  text-align: center;
}
</style>
