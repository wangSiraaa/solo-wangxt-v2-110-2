<template>
  <div class="panel">
    <h2>录入旧→新映射（原始形式，先留证再归一）</h2>
    <div class="row">
      <label class="field" style="flex:3">
        <span>旧址 URL（保留真实写法：大小写、%XX、尾斜杠、追踪参数）</span>
        <input v-model="form.source_raw" placeholder="http://127.0.0.1:4568/频道/科技/42.html?utm_source=x" />
      </label>
      <label class="field" style="flex:3">
        <span>新址 URL</span>
        <input v-model="form.target_raw" placeholder="http://127.0.0.1:4568/articles/tech/42" />
      </label>
      <label class="field" style="flex:1">
        <span>类型</span>
        <select v-model="form.mapping_type">
          <option value="manual">迁移到新栏目</option>
          <option value="deleted">栏目已删除（期望 410/404）</option>
        </select>
      </label>
    </div>
    <label class="field">
      <span>备注</span>
      <input v-model="form.note" placeholder="来源、负责人、工单…" />
    </label>
    <button class="btn" @click="submit">录入</button>
    <span v-if="error" class="badge bad" style="margin-left:10px">{{ error }}</span>
  </div>

  <div class="panel">
    <h2>规范化试算（WHATWG URL，不写库）</h2>
    <p class="muted small">
      验证规则：路径大小写敏感；%XX 只统一十六进制大小写、绝不解码；尾斜杠保留；
      非追踪参数参与身份；追踪参数剥离身份但迁移时保留。
    </p>
    <textarea v-model="trialText" rows="3" placeholder="每行一个 URL，对比它们是否会被归并"></textarea>
    <div style="margin:8px 0"><button class="btn secondary" @click="trial">试算归一键</button></div>
    <table v-if="trialResults.length">
      <thead><tr><th>输入</th><th>归一化查表键</th><th>路径</th><th>追踪参数</th></tr></thead>
      <tbody>
        <tr v-for="(r, i) in trialResults" :key="i">
          <td class="mono">{{ r.input }}</td>
          <td class="mono">{{ r.norm_key || r.error }}</td>
          <td class="mono">{{ r.pathname || '—' }}</td>
          <td class="mono">{{ (r.tracker_params || []).join(', ') || '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="ambiguities.length">
    <h2>⚠️ 归一化歧义（多旧址归一后指向不同资源，禁止静默选一个）</h2>
    <div v-for="a in ambiguities" :key="a.source_norm" class="callout bad">
      <div class="mono">{{ a.source_norm }}</div>
      <div class="small muted">出现 {{ a.input_count }} 次录入，候选目标：</div>
      <ul>
        <li v-for="t in a.targets" :key="t" class="mono">{{ t }}</li>
      </ul>
    </div>
  </div>

  <div class="panel">
    <h2>原始录入材料（mapping_inputs）与生效映射</h2>
    <table>
      <thead><tr><th>#</th><th>原始旧址</th><th>归一化键</th><th>新址</th><th>类型</th><th>状态</th><th>备注</th></tr></thead>
      <tbody>
        <tr v-for="i in inputs" :key="i.id">
          <td>{{ i.id }}</td>
          <td class="mono">{{ i.source_raw }}</td>
          <td class="mono">{{ i.source_norm }}</td>
          <td class="mono">{{ i.target_raw }}</td>
          <td>{{ i.mapping_type === 'deleted' ? '已删除' : '迁移' }}</td>
          <td>
            <span v-if="i.superseded_at" class="badge neutral" :title="'被批次 #' + i.superseded_by_batch + ' 的新裁决取代，仅留审计'">已取代</span>
            <span v-else-if="mappingStatus(i.source_norm) === 'conflicted'" class="badge warn">歧义</span>
            <span v-else class="badge ok">生效</span>
          </td>
          <td class="small muted">{{ i.note }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue';
import { api } from '../api.js';

const props = defineProps({ refreshKey: Number });
const emit = defineEmits(['changed']);

const form = ref({ source_raw: '', target_raw: '', mapping_type: 'manual', note: '' });
const error = ref('');
const inputs = ref([]);
const mappings = ref([]);
const ambiguities = ref([]);
const trialText = ref(
  ['http://127.0.0.1:4568/news/123?ref=homepage',
   'http://127.0.0.1:4568/News/123?ref=homepage',
   'http://127.0.0.1:4568/news/123?utm_source=x&ref=homepage',
   'http://127.0.0.1:4568/files%2Fdraft',
   'http://127.0.0.1:4568/files%2fdraft'].join('\n'),
);
const trialResults = ref([]);

async function load() {
  const d = await api.mappings();
  inputs.value = d.inputs; mappings.value = d.mappings; ambiguities.value = d.ambiguities;
}
function mappingStatus(key) {
  return mappings.value.find((m) => m.source_norm === key)?.status;
}
async function submit() {
  error.value = '';
  try {
    await api.addMapping(form.value);
    form.value = { ...form.value, source_raw: '', target_raw: '', note: '' };
    await load();
    emit('changed');
  } catch (e) { error.value = e.message; }
}
async function trial() {
  trialResults.value = await api.normalize(trialText.value.split('\n').map((s) => s.trim()).filter(Boolean));
}
watch(() => props.refreshKey, load);
onMounted(load);
</script>
