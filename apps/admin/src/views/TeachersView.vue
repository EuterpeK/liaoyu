<script setup lang="ts">
import { DialogPlugin, MessagePlugin, type PrimaryTableCol } from 'tdesign-vue-next';
import { computed, onMounted, ref } from 'vue';
import { listTeachers, reviewTeacher, type TeacherRow } from '../api/teachers.ts';
import PageTable from '../components/PageTable.vue';
import StatusTag from '../components/StatusTag.vue';
import { formatDateTime } from '../format.ts';
import { can } from '../permissions.ts';
import { useAuth } from '../stores/auth.ts';

const auth = useAuth();
const canReview = computed(() => can(auth.role, 'teacher.review'));

const loading = ref(true);
const all = ref<TeacherRow[]>([]);
const tab = ref<'pending' | 'all'>('pending');
const pending = computed(() => all.value.filter((t) => t.status === 'pending'));

async function load() {
  loading.value = true;
  try {
    all.value = await listTeachers();
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const pendingColumns = computed<PrimaryTableCol[]>(() => [
  { colKey: 'displayName', title: '老师' },
  { colKey: 'realName', title: '实名' },
  { colKey: 'directions', title: '方向', cell: 'directions' },
  { colKey: 'credentials', title: '资质', cell: 'credentials' },
  { colKey: 'createdAt', title: '申请时间', cell: 'createdAt' },
  ...(canReview.value ? [{ colKey: 'ops', title: '操作', cell: 'ops' }] : []),
]);
const allColumns: PrimaryTableCol[] = [
  { colKey: 'displayName', title: '老师' },
  { colKey: 'realName', title: '实名' },
  { colKey: 'level', title: '等级', cell: 'level' },
  { colKey: 'status', title: '状态', cell: 'status' },
  { colKey: 'directions', title: '方向', cell: 'directions' },
  { colKey: 'createdAt', title: '入驻时间', cell: 'createdAt' },
];

// 批准：对话框选择初始等级 1~3
const approving = ref<TeacherRow | null>(null);
const level = ref(2);
const submitting = ref(false);

function openApprove(t: TeacherRow) {
  approving.value = t;
  level.value = 2;
}

async function confirmApprove() {
  const t = approving.value;
  if (!t) return;
  submitting.value = true;
  try {
    await reviewTeacher(t.userId, { approve: true, level: level.value });
    MessagePlugin.success(`${t.displayName} 已批准（Lv${level.value}）`);
    approving.value = null;
    await load();
  } finally {
    submitting.value = false;
  }
}

function reject(t: TeacherRow) {
  const dlg = DialogPlugin.confirm({
    header: '驳回申请',
    body: `确认驳回「${t.displayName}」的入驻申请？`,
    confirmBtn: { content: '驳回', theme: 'danger' },
    onConfirm: async () => {
      try {
        await reviewTeacher(t.userId, { approve: false });
        MessagePlugin.success(`${t.displayName} 已驳回`);
        dlg.destroy();
        await load();
      } catch {
        // 错误提示由全局 HTTP 层统一弹出
      }
    },
  });
}
</script>

<template>
  <t-card>
    <t-tabs v-model="tab">
      <t-tab-panel value="pending" :label="`待审核（${pending.length}）`">
        <page-table :columns="pendingColumns" :rows="pending" :loading="loading" row-key="userId">
          <template #directions="{ row }">{{ row.directions.join('、') }}</template>
          <template #credentials="{ row }">{{ row.credentials.join('、') || '—' }}</template>
          <template #createdAt="{ row }">{{ formatDateTime(row.createdAt) }}</template>
          <template #ops="{ row }">
            <t-space>
              <t-button size="small" theme="primary" @click="openApprove(row)">批准</t-button>
              <t-button size="small" theme="danger" variant="outline" @click="reject(row)">驳回</t-button>
            </t-space>
          </template>
        </page-table>
      </t-tab-panel>
      <t-tab-panel value="all" :label="`全部老师（${all.length}）`">
        <page-table :columns="allColumns" :rows="all" :loading="loading" row-key="userId">
          <template #level="{ row }">Lv{{ row.level }}</template>
          <template #status="{ row }"><status-tag kind="teacher" :value="row.status" /></template>
          <template #directions="{ row }">{{ row.directions.join('、') }}</template>
          <template #createdAt="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </page-table>
      </t-tab-panel>
    </t-tabs>
  </t-card>

  <t-dialog
    :visible="approving !== null"
    header="批准入驻"
    :confirm-btn="{ content: '批准', loading: submitting }"
    @confirm="confirmApprove"
    @close="approving = null"
  >
    <p class="tip">为「{{ approving?.displayName }}」指定初始等级（最高 Lv3）：</p>
    <t-radio-group v-model="level" variant="default-filled">
      <t-radio-button :value="1">Lv1</t-radio-button>
      <t-radio-button :value="2">Lv2</t-radio-button>
      <t-radio-button :value="3">Lv3</t-radio-button>
    </t-radio-group>
  </t-dialog>
</template>

<style scoped>
.tip {
  margin-bottom: 12px;
  color: var(--td-text-color-secondary);
}
</style>
