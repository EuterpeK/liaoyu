<script setup lang="ts">
import {
  DashboardIcon,
  HistoryIcon,
  MoneyIcon,
  SecuredIcon,
  UserCircleIcon,
  ViewListIcon,
} from 'tdesign-icons-vue-next';
import { type Component, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { menuFor, ROLE_LABEL } from '../nav.ts';
import { useAuth } from '../stores/auth.ts';

const ICONS: Record<string, Component> = {
  dashboard: DashboardIcon,
  history: HistoryIcon,
  money: MoneyIcon,
  secured: SecuredIcon,
  'user-circle': UserCircleIcon,
  'view-list': ViewListIcon,
};

const auth = useAuth();
const route = useRoute();
const router = useRouter();

const menu = computed(() => menuFor(auth.role));
const active = computed(() => String(route.name ?? ''));

async function logout() {
  await auth.logout();
  await router.replace('/login');
}
</script>

<template>
  <t-layout class="shell">
    <t-aside width="220px" class="aside">
      <div class="brand">LiaoYu <small>管理台</small></div>
      <t-menu :value="active" width="220px" @change="(v: string | number) => router.push({ name: String(v) })">
        <t-menu-item v-for="item in menu" :key="item.name" :value="item.name">
          <template #icon><component :is="ICONS[item.icon]" /></template>
          {{ item.title }}
        </t-menu-item>
      </t-menu>
    </t-aside>
    <t-layout>
      <t-header class="header">
        <span class="who">{{ auth.me?.username }}</span>
        <t-tag v-if="auth.role" variant="light" theme="success">{{ ROLE_LABEL[auth.role] }}</t-tag>
        <t-button variant="outline" size="small" @click="logout">退出</t-button>
      </t-header>
      <t-content class="content"><router-view /></t-content>
    </t-layout>
  </t-layout>
</template>

<style scoped>
.shell {
  min-height: 100vh;
}
.brand {
  padding: 18px 24px;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 2px;
  color: #1d5c3f;
}
.brand small {
  font-weight: 400;
  color: #6f8b7d;
  font-size: 13px;
  letter-spacing: 0;
  margin-left: 6px;
}
.header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 0 24px;
  background: #fff;
  border-bottom: 1px solid var(--td-component-stroke);
}
.who {
  color: #6f8b7d;
}
.content {
  padding: 20px 24px 60px;
}
</style>
