<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  countOrders,
  exportUrl,
  listOrders,
  type OrderFilter,
  type OrderRow,
  type OrderSummary,
  orderSummary,
} from '../api/orders.ts';
import MoneyText from '../components/MoneyText.vue';
import OrderTable from '../components/OrderTable.vue';
import { can } from '../permissions.ts';
import { useAuth } from '../stores/auth.ts';

const auth = useAuth();
const canExport = computed(() => can(auth.role, 'orders.export'));

const emptyFilter = (): OrderFilter => ({ status: '', userId: '', teacherId: '', from: '', to: '' });
const filter = reactive<OrderFilter>(emptyFilter());
const range = ref<string[]>([]);

const rows = ref<OrderRow[]>([]);
const total = ref(0);
const summary = ref<OrderSummary | null>(null);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);

// 以最近一次「查询」时的筛选为准，翻页不受输入框未提交内容的影响
let applied: OrderFilter = emptyFilter();

async function fetchData() {
  loading.value = true;
  try {
    const [list, count, sum] = await Promise.all([
      listOrders(applied, { page: page.value, pageSize: pageSize.value }),
      countOrders(applied),
      orderSummary(applied),
    ]);
    rows.value = list;
    total.value = count;
    summary.value = sum;
  } finally {
    loading.value = false;
  }
}

function search() {
  applied = { ...filter, from: range.value[0] ?? '', to: range.value[1] ?? '' };
  page.value = 1;
  return fetchData();
}

function reset() {
  Object.assign(filter, emptyFilter());
  range.value = [];
  return search();
}

function onPage(p: number) {
  page.value = p;
  return fetchData();
}

function onPageSize(size: number) {
  pageSize.value = size;
  page.value = 1;
  return fetchData();
}

function download() {
  window.location.href = exportUrl(applied);
}

onMounted(search);
</script>

<template>
  <t-card title="订单" subtitle="按条件筛选；汇总与导出均以当前已查询的条件为准">
    <t-form layout="inline" class="filters" @submit="search">
      <t-form-item label="状态">
        <t-select v-model="filter.status" style="width: 140px" placeholder="全部状态" clearable>
          <t-option value="pending" label="待支付" />
          <t-option value="paid" label="已支付" />
        </t-select>
      </t-form-item>
      <t-form-item label="学员ID"><t-input v-model="filter.userId" style="width: 110px" clearable /></t-form-item>
      <t-form-item label="老师ID"><t-input v-model="filter.teacherId" style="width: 110px" clearable /></t-form-item>
      <t-form-item label="下单日期">
        <t-date-range-picker v-model="range" value-type="YYYY-MM-DD" format="YYYY-MM-DD" clearable />
      </t-form-item>
      <t-space>
        <t-button theme="primary" type="submit" :loading="loading">查询</t-button>
        <t-button variant="outline" @click="reset">重置</t-button>
        <t-button v-if="canExport" variant="outline" @click="download">导出 CSV</t-button>
      </t-space>
    </t-form>

    <div v-if="summary" class="summary">
      共 <b>{{ summary.orderCount }}</b> 单，已支付 <b>{{ summary.paidCount }}</b> 单，
      购买学员 <b>{{ summary.buyerCount }}</b> 人，收入 <money-text :cents="summary.revenueCents" />
    </div>

    <order-table
      :rows="rows"
      :loading="loading"
      :total="total"
      :page="page"
      :page-size="pageSize"
      @update:page="onPage"
      @update:page-size="onPageSize"
    />
  </t-card>
</template>

<style scoped>
.filters {
  margin-bottom: 12px;
  row-gap: 12px;
}
.summary {
  margin: 4px 0 12px;
  color: var(--td-text-color-secondary);
}
</style>
