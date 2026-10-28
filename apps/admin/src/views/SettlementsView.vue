<script setup lang="ts">
import { MessagePlugin, type PrimaryTableCol } from 'tdesign-vue-next';
import { computed, onMounted, ref } from 'vue';
import {
  generateSettlements,
  getCommissionBps,
  listSettlements,
  paySettlement,
  type SettlementRow,
  setCommissionBps,
} from '../api/settlements.ts';
import MoneyText from '../components/MoneyText.vue';
import PageTable from '../components/PageTable.vue';
import StatusTag from '../components/StatusTag.vue';
import { formatDateTime } from '../format.ts';
import { can } from '../permissions.ts';
import { useAuth } from '../stores/auth.ts';

const auth = useAuth();
const canEditBps = computed(() => can(auth.role, 'commission.edit'));
const canGenerate = computed(() => can(auth.role, 'settlement.generate'));
const canPay = computed(() => can(auth.role, 'settlement.pay'));

const loading = ref(true);
const rows = ref<SettlementRow[]>([]);
const bps = ref(0);
const savingBps = ref(false);

async function load() {
  loading.value = true;
  try {
    const [list, current] = await Promise.all([listSettlements(), getCommissionBps()]);
    rows.value = list;
    bps.value = current;
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function saveBps() {
  savingBps.value = true;
  try {
    await setCommissionBps(Number(bps.value));
    MessagePlugin.success('佣金比例已更新');
  } finally {
    savingBps.value = false;
  }
}

// 生成结算单
const period = ref<string[]>([]);
const generating = ref(false);
async function generate() {
  if (period.value.length !== 2) {
    MessagePlugin.warning('请选择结算周期的起止日期');
    return;
  }
  generating.value = true;
  try {
    const created = await generateSettlements({ periodStart: period.value[0], periodEnd: period.value[1] });
    MessagePlugin.success(`已生成 ${created.length} 张结算单`);
    await load();
  } finally {
    generating.value = false;
  }
}

// 标记已打款：凭证必填
const paying = ref<SettlementRow | null>(null);
const proof = ref('');
const proofError = computed(() => {
  const n = proof.value.trim().length;
  return n === 0 ? '请填写打款凭证' : n > 200 ? '凭证不能超过 200 字' : '';
});
const submitting = ref(false);

function openPay(s: SettlementRow) {
  paying.value = s;
  proof.value = '';
}

async function confirmPay() {
  const s = paying.value;
  if (!s || proofError.value) return;
  submitting.value = true;
  try {
    await paySettlement(s.id, proof.value);
    MessagePlugin.success('已标记打款');
    paying.value = null;
    await load();
  } finally {
    submitting.value = false;
  }
}

const columns = computed<PrimaryTableCol[]>(() => [
  { colKey: 'teacherName', title: '老师' },
  { colKey: 'period', title: '周期', cell: 'period' },
  { colKey: 'grossCents', title: '流水', cell: 'gross' },
  { colKey: 'commissionCents', title: '佣金', cell: 'commission' },
  { colKey: 'netCents', title: '应结', cell: 'net' },
  { colKey: 'status', title: '状态', cell: 'status' },
  { colKey: 'ops', title: '操作', cell: 'ops' },
]);
</script>

<template>
  <t-card title="平台佣金比例" subtitle="基点（bps），10000 = 100%" class="block">
    <t-space align="center">
      <t-input-number v-model="bps" :min="0" :max="9999" :disabled="!canEditBps" :decimal-places="0" />
      <span class="pct">= {{ (bps / 100).toFixed(2) }}%</span>
      <t-button v-if="canEditBps" theme="primary" :loading="savingBps" @click="saveBps">保存</t-button>
      <span v-else class="ro">仅超级管理员可修改</span>
    </t-space>
  </t-card>

  <t-card v-if="canGenerate" title="生成结算单" subtitle="对该周期内已完成服务的计提生成结算" class="block">
    <t-space>
      <t-date-range-picker v-model="period" value-type="YYYY-MM-DD" format="YYYY-MM-DD" clearable />
      <t-button theme="primary" :loading="generating" @click="generate">生成</t-button>
    </t-space>
  </t-card>

  <t-card :title="`结算单（${rows.length}）`">
    <page-table :columns="columns" :rows="rows" :loading="loading">
      <template #period="{ row }">{{ row.periodStart }} ~ {{ row.periodEnd }}</template>
      <template #gross="{ row }"><money-text :cents="row.grossCents" /></template>
      <template #commission="{ row }">
        -<money-text :cents="row.commissionCents" /> <span class="ro">({{ (row.commissionBps / 100).toFixed(1) }}%)</span>
      </template>
      <template #net="{ row }"><money-text :cents="row.netCents" /></template>
      <template #status="{ row }"><status-tag kind="settlement" :value="row.status" /></template>
      <template #ops="{ row }">
        <span v-if="row.status === 'paid'" class="ro">{{ row.proof }} · {{ formatDateTime(row.paidAt) }}</span>
        <t-button v-else-if="canPay" size="small" variant="outline" @click="openPay(row)">标记已打款</t-button>
      </template>
    </page-table>
  </t-card>

  <t-dialog
    :visible="paying !== null"
    header="标记已打款"
    :confirm-btn="{ content: '确认打款', loading: submitting, disabled: !!proofError }"
    @confirm="confirmPay"
    @close="paying = null"
  >
    <p class="tip">
      向「{{ paying?.teacherName }}」打款 <money-text :cents="paying?.netCents ?? 0" />，请填写转账单号或凭证说明：
    </p>
    <t-textarea v-model="proof" :maxlength="200" placeholder="转账单号 / 截图说明" autofocus />
    <div v-if="proof && proofError" class="err">{{ proofError }}</div>
  </t-dialog>
</template>

<style scoped>
.block {
  margin-bottom: 16px;
}
.pct,
.ro {
  color: var(--td-text-color-secondary);
  font-size: 13px;
}
.tip {
  margin-bottom: 12px;
}
.err {
  color: var(--td-error-color);
  font-size: 12px;
  margin-top: 6px;
}
</style>
