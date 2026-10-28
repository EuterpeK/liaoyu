<script setup lang="ts">
import { formatYuan } from '../format.ts';

defineProps<{ cents: number }>();
</script>

<template>
  <span class="money">{{ formatYuan(cents) }}</span>
</template>

<style scoped>
.money {
  font-weight: 700;
  color: #b9752e;
}
</style>
