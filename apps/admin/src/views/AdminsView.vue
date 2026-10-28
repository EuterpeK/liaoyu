<script setup lang="ts">
import { DialogPlugin, MessagePlugin, type PrimaryTableCol } from 'tdesign-vue-next';
import { computed, onMounted, reactive, ref } from 'vue';
import { type AdminRow, createAdmin, listAdmins, resetAdminPassword, updateAdmin } from '../api/admins.ts';
import PageTable from '../components/PageTable.vue';
import StatusTag from '../components/StatusTag.vue';
import { formatDateTime } from '../format.ts';
import { ROLE_LABEL } from '../nav.ts';
import { useAuth } from '../stores/auth.ts';
import type { Role } from '../types.ts';

const auth = useAuth();
const loading = ref(true);
const rows = ref<AdminRow[]>([]);
const roleOptions = (Object.keys(ROLE_LABEL) as Role[]).map((value) => ({ value, label: ROLE_LABEL[value] }));
const isSelf = (a: AdminRow) => a.id === auth.me?.id;

async function load() {
  loading.value = true;
  try {
    rows.value = await listAdmins();
  } finally {
    loading.value = false;
  }
}
onMounted(load);

const columns: PrimaryTableCol[] = [
  { colKey: 'username', title: '用户名', cell: 'username' },
  { colKey: 'role', title: '角色', cell: 'role' },
  { colKey: 'status', title: '状态', cell: 'status' },
  { colKey: 'createdAt', title: '创建时间', cell: 'createdAt' },
  { colKey: 'ops', title: '操作', cell: 'ops' },
];

const PASSWORD_MIN = 10;
const passwordError = (p: string) => (p.length < PASSWORD_MIN ? `密码至少 ${PASSWORD_MIN} 位` : '');

// 新建
const creating = ref(false);
const form = reactive({ username: '', password: '', role: 'ops' as Role });
const createError = computed(() => {
  if (form.username.trim().length < 2) return '用户名至少 2 个字符';
  return passwordError(form.password);
});
const submitting = ref(false);

function openCreate() {
  Object.assign(form, { username: '', password: '', role: 'ops' });
  creating.value = true;
}
async function confirmCreate() {
  if (createError.value) return;
  submitting.value = true;
  try {
    await createAdmin({ username: form.username.trim(), password: form.password, role: form.role });
    MessagePlugin.success('管理员已创建');
    creating.value = false;
    await load();
  } finally {
    submitting.value = false;
  }
}

// 改角色
const editing = ref<AdminRow | null>(null);
const editRole = ref<Role>('ops');
function openRole(a: AdminRow) {
  editing.value = a;
  editRole.value = a.role;
}
async function confirmRole() {
  const a = editing.value;
  if (!a) return;
  submitting.value = true;
  try {
    if (editRole.value !== a.role) await updateAdmin(a.id, { role: editRole.value });
    MessagePlugin.success('角色已更新');
    editing.value = null;
    await load();
  } finally {
    submitting.value = false;
  }
}

// 停用 / 启用
function toggleDisabled(a: AdminRow) {
  const disable = !a.disabledAt;
  const dlg = DialogPlugin.confirm({
    header: disable ? '停用账号' : '启用账号',
    body: disable ? `停用后「${a.username}」将无法登录，且已有会话立即失效。` : `确认启用「${a.username}」？`,
    confirmBtn: { content: disable ? '停用' : '启用', theme: disable ? 'danger' : 'primary' },
    onConfirm: async () => {
      try {
        await updateAdmin(a.id, { disabled: disable });
        MessagePlugin.success(disable ? '已停用' : '已启用');
        dlg.destroy();
        await load();
      } catch {
        // 错误提示由全局 HTTP 层统一弹出
      }
    },
  });
}

// 重置密码
const resetting = ref<AdminRow | null>(null);
const newPassword = ref('');
const resetError = computed(() => passwordError(newPassword.value));
function openReset(a: AdminRow) {
  resetting.value = a;
  newPassword.value = '';
}
async function confirmReset() {
  const a = resetting.value;
  if (!a || resetError.value) return;
  submitting.value = true;
  try {
    await resetAdminPassword(a.id, newPassword.value);
    MessagePlugin.success('密码已重置，该账号的会话已全部失效');
    resetting.value = null;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <t-card title="管理员账号" subtitle="仅超级管理员可见。停用/降级自己、移除最后一个超级管理员会被后端拒绝">
    <template #actions><t-button theme="primary" @click="openCreate">新建管理员</t-button></template>
    <page-table :columns="columns" :rows="rows" :loading="loading">
      <template #username="{ row }">
        <b>{{ row.username }}</b> <t-tag v-if="isSelf(row)" size="small" variant="outline">我</t-tag>
      </template>
      <template #role="{ row }"><t-tag variant="light">{{ ROLE_LABEL[row.role as Role] }}</t-tag></template>
      <template #status="{ row }"><status-tag kind="admin" :value="row.disabledAt ? 'disabled' : 'enabled'" /></template>
      <template #createdAt="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      <template #ops="{ row }">
        <t-space>
          <t-button size="small" variant="outline" :disabled="isSelf(row)" @click="openRole(row)">改角色</t-button>
          <t-button
            size="small"
            variant="outline"
            :theme="row.disabledAt ? 'primary' : 'danger'"
            :disabled="isSelf(row)"
            @click="toggleDisabled(row)"
          >
            {{ row.disabledAt ? '启用' : '停用' }}
          </t-button>
          <t-button size="small" variant="outline" @click="openReset(row)">重置密码</t-button>
        </t-space>
      </template>
    </page-table>
  </t-card>

  <t-dialog
    :visible="creating"
    header="新建管理员"
    :confirm-btn="{ content: '创建', loading: submitting, disabled: !!createError }"
    @confirm="confirmCreate"
    @close="creating = false"
  >
    <t-form :data="form" label-align="top">
      <t-form-item label="用户名"><t-input v-model="form.username" autocomplete="off" /></t-form-item>
      <t-form-item label="初始密码（至少 10 位）">
        <t-input v-model="form.password" type="password" autocomplete="new-password" />
      </t-form-item>
      <t-form-item label="角色"><t-select v-model="form.role" :options="roleOptions" /></t-form-item>
    </t-form>
    <div v-if="(form.username || form.password) && createError" class="err">{{ createError }}</div>
  </t-dialog>

  <t-dialog
    :visible="editing !== null"
    header="修改角色"
    :confirm-btn="{ content: '保存', loading: submitting }"
    @confirm="confirmRole"
    @close="editing = null"
  >
    <p class="tip">账号：{{ editing?.username }}</p>
    <t-select v-model="editRole" :options="roleOptions" />
  </t-dialog>

  <t-dialog
    :visible="resetting !== null"
    header="重置密码"
    :confirm-btn="{ content: '重置', loading: submitting, disabled: !!resetError }"
    @confirm="confirmReset"
    @close="resetting = null"
  >
    <p class="tip">账号：{{ resetting?.username }}。重置后其所有已登录会话立即失效。</p>
    <t-input v-model="newPassword" type="password" placeholder="新密码（至少 10 位）" autocomplete="new-password" />
    <div v-if="newPassword && resetError" class="err">{{ resetError }}</div>
  </t-dialog>
</template>

<style scoped>
.tip {
  margin-bottom: 12px;
  color: var(--td-text-color-secondary);
}
.err {
  color: var(--td-error-color);
  font-size: 12px;
  margin-top: 6px;
}
</style>
