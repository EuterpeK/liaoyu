<script setup lang="ts">
import type { PrimaryTableCol } from 'tdesign-vue-next';
import { computed, onMounted, ref } from 'vue';
import { type AuditLog, listAuditLogs } from '../api/audit.ts';
import PageTable from '../components/PageTable.vue';
import { formatDateTime } from '../format.ts';

const loading = ref(true);
const logs = ref<AuditLog[]>([]);
const action = ref('');
const page = ref(1);
const pageSize = ref(20);

onMounted(async () => {
  try {
    logs.value = await listAuditLogs(200);
  } finally {
    loading.value = false;
  }
});

const actions = computed(() => [...new Set(logs.value.map((l) => l.action))].sort());
const filtered = computed(() => (action.value ? logs.value.filter((l) => l.action === action.value) : logs.value));
const pageRows = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));

function onFilter() {
  page.value = 1;
}
function onPageSize(size: number) {
  pageSize.value = size;
  page.value = 1;
}

const columns: PrimaryTableCol[] = [
  { colKey: 'createdAt', title: '时间', cell: 'createdAt' },
  { colKey: 'action', title: '操作', cell: 'action' },
  { colKey: 'target', title: '对象', cell: 'target' },
  { colKey: 'adminId', title: '管理员ID', cell: 'adminId' },
  { colKey: 'detail', title: '详情', cell: 'detail' },
];

const expanded = ref(new Set<number>());
function toggle(id: number) {
  const next = new Set(expanded.value);
  if (!next.delete(id)) next.add(id);
  expanded.value = next;
}
const brief = (d: Record<string, unknown>) => {
  const s = JSON.stringify(d);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};
</script>

<template>
  <t-card :title="`审计日志（最近 ${logs.length} 条）`" subtitle="append-only，按时间倒序">
    <t-space class="bar">
      <t-select v-model="action" placeholder="全部操作" clearable style="width: 220px" @change="onFilter">
        <t-option v-for="a in actions" :key="a" :value="a" :label="a" />
      </t-select>
      <span class="hint">共 {{ filtered.length }} 条</span>
    </t-space>
    <page-table
      :columns="columns"
      :rows="pageRows"
      :loading="loading"
      :total="filtered.length"
      :page="page"
      :page-size="pageSize"
      @update:page="page = $event"
      @update:page-size="onPageSize"
    >
      <template #createdAt="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      <template #action="{ row }"><t-tag variant="light" theme="success">{{ row.action }}</t-tag></template>
      <template #target="{ row }"><span class="mono">{{ row.target }}</span></template>
      <template #adminId="{ row }">{{ row.adminId ?? '—' }}</template>
      <template #detail="{ row }">
        <a class="link" @click="toggle(row.id)">
          <pre v-if="expanded.has(row.id)" class="json">{{ JSON.stringify(row.detail, null, 2) }}</pre>
          <span v-else class="mono">{{ brief(row.detail) }}</span>
        </a>
      </template>
    </page-table>
  </t-card>
</template>

<style scoped>
.bar {
  margin-bottom: 12px;
}
.hint {
  color: var(--td-text-color-secondary);
  font-size: 13px;
}
.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 12.5px;
}
.link {
  cursor: pointer;
}
.json {
  margin: 0;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
