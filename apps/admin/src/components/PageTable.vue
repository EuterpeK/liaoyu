<script setup lang="ts">
import type { PrimaryTableCol } from 'tdesign-vue-next';
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    columns: PrimaryTableCol[];
    rows: object[];
    loading?: boolean;
    rowKey?: string;
    /** 不传 total 表示不分页（整表展示） */
    total?: number;
    page?: number;
    pageSize?: number;
  }>(),
  { loading: false, rowKey: 'id', page: 1, pageSize: 20 },
);

const emit = defineEmits<{ 'update:page': [number]; 'update:pageSize': [number] }>();

const pagination = computed(() =>
  props.total === undefined
    ? undefined
    : { current: props.page, pageSize: props.pageSize, total: props.total, showJumper: true },
);

function onPageChange(info: { current: number; pageSize: number }) {
  if (info.pageSize !== props.pageSize) emit('update:pageSize', info.pageSize);
  if (info.current !== props.page) emit('update:page', info.current);
}
</script>

<template>
  <t-table
    :columns="columns"
    :data="rows"
    :loading="loading"
    :row-key="rowKey"
    :pagination="pagination"
    hover
    table-layout="auto"
    @page-change="onPageChange"
  >
    <template v-for="(_, name) in $slots" :key="name" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps ?? {}" />
    </template>
    <template #empty>暂无数据</template>
  </t-table>
</template>
