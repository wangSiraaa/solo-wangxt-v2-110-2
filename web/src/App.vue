<template>
  <header class="topbar">
    <h1>🔗 URL 迁移验证工作台</h1>
    <nav class="tabs">
      <button v-for="t in tabs" :key="t.id" :class="{ active: tab === t.id }" @click="tab = t.id">
        {{ t.label }}
      </button>
    </nav>
    <span class="muted small" style="margin-left:auto">只验证随项目启动的本地站点 · WHATWG URL 规范化</span>
  </header>
  <main>
    <RulesView v-if="tab === 'rules'" />
    <DashboardView v-else-if="tab === 'dash'" />
    <MappingsView v-else-if="tab === 'maps'" :refresh-key="refreshKey" @changed="bump" />
    <ImportsView v-else-if="tab === 'imports'" @changed="onImportCommitted" />
    <PlansView v-else-if="tab === 'plans'" :refresh-key="refreshKey" />
  </main>
</template>

<script setup>
import { ref } from 'vue';
import RulesView from './views/RulesView.vue';
import DashboardView from './views/DashboardView.vue';
import MappingsView from './views/MappingsView.vue';
import ImportsView from './views/ImportsView.vue';
import PlansView from './views/PlansView.vue';

const tabs = [
  { id: 'dash', label: '验证总览' },
  { id: 'maps', label: '映射与爬取证据' },
  { id: 'imports', label: '批量导入 / 冲突裁决' },
  { id: 'plans', label: '迁移方案 / 发布闸门' },
  { id: 'rules', label: '规范化规则' },
];
const tab = ref('dash');
const refreshKey = ref(0);
function bump() { refreshKey.value++; tab.value = 'maps'; }
function onImportCommitted() { refreshKey.value++; }
</script>
