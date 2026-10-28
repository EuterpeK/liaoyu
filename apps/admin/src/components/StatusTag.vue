<script setup lang="ts">
import { computed } from 'vue';

type Theme = 'success' | 'warning' | 'danger' | 'default';

const MAP: Record<string, Record<string, [string, Theme]>> = {
  teacher: {
    active: ['在职', 'success'],
    pending: ['待审核', 'warning'],
    rejected: ['已驳回', 'danger'],
    disabled: ['已停用', 'default'],
  },
  order: { pending: ['待支付', 'warning'], paid: ['已支付', 'success'] },
  settlement: { pending: ['待打款', 'warning'], paid: ['已打款', 'success'] },
  admin: { enabled: ['正常', 'success'], disabled: ['已停用', 'default'] },
};

const props = defineProps<{ kind: 'teacher' | 'order' | 'settlement' | 'admin'; value: string }>();
const view = computed(() => MAP[props.kind][props.value] ?? [props.value, 'default']);
</script>

<template>
  <t-tag variant="light" :theme="view[1]">{{ view[0] }}</t-tag>
</template>
