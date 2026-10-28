<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <div class="page">
    <div class="code">403</div>
    <div class="desc">你的角色没有访问该页面的权限</div>
    <t-button theme="primary" @click="router.replace('/overview')">返回首页</t-button>
  </div>
</template>

<style scoped>
.page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.code {
  font-size: 72px;
  font-weight: 800;
  color: #1d5c3f;
}
.desc {
  color: #6f8b7d;
  margin-bottom: 8px;
}
</style>
