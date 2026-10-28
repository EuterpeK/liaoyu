<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { listOrders, type OrderRow, type OrderSummary, orderSummary } from '../api/orders.ts';
import { listTeachers, type TeacherRow } from '../api/teachers.ts';
import MoneyText from '../components/MoneyText.vue';
import OrderTable from '../components/OrderTable.vue';
import { can } from '../permissions.ts';
import { useAuth } from '../stores/auth.ts';

const auth = useAuth();
const loading = ref(true);
const summary = ref<OrderSummary | null>(null);
const recent = ref<OrderRow[]>([]);
const teachers = ref<TeacherRow[] | null>(null);

const showTeachers = computed(() => can(auth.role, 'teacher.view'));

onMounted(async () => {
  try {
    const [s, r, t] = await Promise.all([
      orderSummary(),
      listOrders({}, { page: 1, pageSize: 8 }),
      showTeachers.value ? listTeachers() : Promise.resolve(null),
    ]);
    summary.value = s;
    recent.value = r;
    teachers.value = t;
  } finally {
    loading.value = false;
  }
});

const activeCount = computed(() => teachers.value?.filter((t) => t.status === 'active').length ?? 0);
const pendingCount = computed(() => teachers.value?.filter((t) => t.status === 'pending').length ?? 0);
</script>

<template>
  <t-row :gutter="16" class="stats">
    <t-col v-if="teachers" :xs="12" :sm="6" :lg="3">
      <t-card :loading="loading"><t-statistic title="入驻老师" :value="activeCount" /><div class="hint">待审 {{ pendingCount }}</div></t-card>
    </t-col>
    <t-col :xs="12" :sm="6" :lg="3">
      <t-card :loading="loading"><t-statistic title="购买学员" :value="summary?.buyerCount ?? 0" /><div class="hint">按订单去重</div></t-card>
    </t-col>
    <t-col :xs="12" :sm="6" :lg="3">
      <t-card :loading="loading"><t-statistic title="订单数" :value="summary?.orderCount ?? 0" /><div class="hint">已支付 {{ summary?.paidCount ?? 0 }}</div></t-card>
    </t-col>
    <t-col :xs="12" :sm="6" :lg="3">
      <t-card :loading="loading">
        <div class="k">累计收入</div>
        <div class="v"><money-text :cents="summary?.revenueCents ?? 0" /></div>
        <div class="hint">已支付订单合计</div>
      </t-card>
    </t-col>
  </t-row>

  <t-card title="最近订单" subtitle="按创建时间倒序，最多 8 条" class="recent">
    <order-table :rows="recent" :loading="loading" />
  </t-card>
</template>

<style scoped>
.stats {
  margin-bottom: 16px;
}
.hint {
  color: #8fa89b;
  font-size: 12px;
  margin-top: 6px;
}
.k {
  color: var(--td-text-color-secondary);
  font-size: 14px;
}
.v {
  font-size: 28px;
  margin-top: 6px;
}
</style>
