<template>
  <span class="badge" :class="cls">{{ text }}</span>
</template>
<script setup>
import { computed } from 'vue';
const props = defineProps({ verdict: String, label: Object });
const OK = new Set(['ok', 'deleted_gone_ok']);
const WARN = new Set(['ambiguity']);
const text = computed(() => props.label?.[props.verdict] ?? (props.verdict || '未验证'));
const cls = computed(() => {
  if (!props.verdict) return 'neutral';
  if (OK.has(props.verdict)) return 'ok';
  if (WARN.has(props.verdict)) return 'warn';
  return 'bad';
});
</script>
