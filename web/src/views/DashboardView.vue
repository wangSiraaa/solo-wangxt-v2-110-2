<template>
  <div class="panel">
    <h2>验证总览 —— 真实请求本地站点，逐跳取证</h2>
    <div class="row" style="align-items:center">
      <p class="muted small" style="flex:3">
        验证器只允许访问随项目启动的本地站点（127.0.0.1:4568）；
        每一跳的状态码、Location、最终状态都落库。映射表填完<b>不等于</b>迁移完成——
        只有这里出现绿色裁决，发布闸门才可能放行。
      </p>
      <div style="flex:1; text-align:right">
        <button class="btn" :disabled="running" @click="runAll">
          {{ running ? '验证中…' : '对全部映射重新验证' }}
        </button>
      </div>
    </div>

    <div class="kpi" style="margin-top:12px">
      <div class="card"><div class="num" style="color:var(--ok)">{{ counts.ok }}</div><div class="lbl">通过（含已删除正确消亡）</div></div>
      <div class="card"><div class="num" style="color:var(--warn)">{{ counts.ambiguity }}</div><div class="lbl">归一化歧义</div></div>
      <div class="card"><div class="num" style="color:var(--bad)">{{ counts.loop + counts.long + counts.badStatus + counts.fetch }}</div><div class="lbl">环/长链/最终页异常/越权</div></div>
      <div class="card"><div class="num" style="color:var(--warn)">{{ counts.stale }}</div><div class="lbl">证据已过期（映射改动后需重验）</div></div>
      <div class="card"><div class="num">{{ counts.unverified }}</div><div class="lbl">从未验证（仅填表）</div></div>
    </div>
  </div>

  <div class="panel">
    <h2>逐条裁决与证据</h2>
    <table>
      <thead>
        <tr>
          <th>裁决</th><th>旧址（原始录入）</th><th>最终 URL</th><th>最终状态</th>
          <th>跳数</th><th>追踪参数</th><th>问题 / 证据</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>
            <VerdictBadge :verdict="row.verdict" :label="label" />
            <div v-if="row.verdict_stale" class="badge warn" style="margin-top:3px">证据过期·需重验</div>
          </td>
          <td class="mono">{{ row.source_raw }}</td>
          <td class="mono">{{ row.final_url_raw || '—' }}</td>
          <td>{{ row.final_status ?? '—' }}</td>
          <td>{{ row.hops ?? '—' }}</td>
          <td>
            <span v-if="row.tracker_preserved === true" class="badge ok">已保留</span>
            <span v-else-if="row.tracker_preserved === false" class="badge bad">丢失</span>
            <span v-else class="badge neutral">—</span>
          </td>
          <td>
            <ul v-if="row.issues && row.issues.length" class="issues">
              <li v-for="(i, k) in row.issues" :key="k">{{ i }}</li>
            </ul>
            <span v-else class="muted small">无</span>
            <div class="small" v-if="row.verified_at">
              <a href="#" @click.prevent="showHops(row)">查看逐跳证据</a>
              · {{ fmt(row.verified_at) }}
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="panel" v-if="hops.length">
    <h2>逐跳证据：{{ hopsKey }}</h2>
    <table>
      <thead><tr><th>#</th><th>请求 URL（规范化）</th><th>状态</th><th>Location（原样）</th><th>错误</th></tr></thead>
      <tbody>
        <tr v-for="h in hops" :key="h.hop_index">
          <td>{{ h.hop_index }}</td>
          <td class="mono">{{ h.url_norm }}</td>
          <td>{{ h.status_code ?? '—' }}</td>
          <td class="mono">{{ h.location_raw || '—' }}</td>
          <td class="mono">{{ h.fetch_error || '' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import VerdictBadge from '../components/VerdictBadge.vue';

const rows = ref([]);
const label = ref({});
const running = ref(false);
const hops = ref([]);
const hopsKey = ref('');

const counts = computed(() => {
  const c = { ok: 0, ambiguity: 0, loop: 0, long: 0, badStatus: 0, fetch: 0, unverified: 0, stale: 0 };
  for (const r of rows.value) {
    if (r.verdict_stale) c.stale++;
    if (!r.verdict) c.unverified++;
    else if (r.verdict === 'ok' || r.verdict === 'deleted_gone_ok') c.ok++;
    else if (r.verdict === 'ambiguity') c.ambiguity++;
    else if (r.verdict === 'redirect_loop') c.loop++;
    else if (r.verdict === 'chain_too_long') c.long++;
    else if (r.verdict === 'final_status_bad' || r.verdict === 'deleted_not_gone') c.badStatus++;
    else if (r.verdict === 'fetch_error') c.fetch++;
  }
  return c;
});

async function load() {
  const d = await api.mappings();
  label.value = d.verdictLabel;
  // 输入材料去重为每个归一化键一行展示
  const byKey = new Map();
  for (const i of d.inputs) {
    if (!byKey.has(i.source_norm)) byKey.set(i.source_norm, i);
  }
  rows.value = [...byKey.values()];
}
async function runAll() {
  running.value = true;
  try { await api.verify(); await load(); }
  finally { running.value = false; }
}
async function showHops(row) {
  hopsKey.value = row.source_norm;
  hops.value = await api.crawl(row.source_norm);
}
function fmt(ts) { return new Date(ts).toLocaleString('zh-CN'); }
onMounted(load);
</script>
