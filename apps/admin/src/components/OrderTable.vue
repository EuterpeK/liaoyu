<script setup lang="ts">
import type { PrimaryTableCol } from 'tdesign-vue-next';
import type { OrderRow } from '../api/orders.ts';
import { formatDateTime } from '../format.ts';
import MoneyText from './MoneyText.vue';
import PageTable from './PageTable.vue';
import StatusTag from './StatusTag.vue';

defineProps<{ rows: OrderRow[]; loading?: boolean; total?: number; page?: number; pageSize?: number }>();
const emit = defineEmits<{ 'update:page': [number]; 'update:pageSize': [number] }>();

const columns: PrimaryTableCol[] = [
  { colKey: 'outTradeNo', title: '订单号', cell: 'outTradeNo' },
  { colKey: 'userNickname', title: '学员', cell: 'user' },
  { colKey: 'teacherName', title: '老师' },
  { colKey: 'packageTitle', title: '套餐' },
  { colKey: 'amountCents', title: '金额', cell: 'amount' },
  { colKey: 'status', title: '状态', cell: 'status' },
  { colKey: 'paidAt', title: '支付时间', cell: 'paidAt' },
];
</script>

<template>
  <page-table
    :columns="columns"
    :rows="rows"
    :loading="loading"
    :total="total"
    :page="page"
    :page-size="pageSize"
    row-key="outTradeNo"
    @update:page="emit('update:page', $event)"
    @update:page-size="emit('update:pageSize', $event)"
  >
    <template #outTradeNo="{ row }"><span class="mono">{{ row.outTradeNo }}</span></template>
    <template #user="{ row }">{{ row.userNickname || row.userId }}</template>
    <template #amount="{ row }"><money-text :cents="row.amountCents" /></template>
    <template #status="{ row }"><status-tag kind="order" :value="row.status" /></template>
    <template #paidAt="{ row }">{{ formatDateTime(row.paidAt) }}</template>
  </page-table>
</template>

<style scoped>
.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
</style>
