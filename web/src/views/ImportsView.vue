<template>
  <div class="panel">
    <h2>本地文件批量导入（CSV / JSON · 格式版本 v1）</h2>
    <p class="muted small">
      只读取你在本机选择的文件字节：服务端<b>不收 URL、不读服务器路径</b>。
      原始行逐字节留证——百分号编码不 decode、尾斜杠保留、追踪参数不删不改；
      WHATWG 规范化只用于右侧预览列。同内容文件重复导入<b>幂等</b>，不新增任何数据。
    </p>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:2">
        <span>操作者（审计留痕）</span>
        <input v-model="actor" placeholder="工号 / 姓名" />
      </label>
      <label class="field" style="flex:3">
        <span>选择本地文件（.csv 或 .json，≤5MiB）</span>
        <input type="file" accept=".csv,.json,text/csv,application/json" @change="onFile" />
      </label>
      <div style="flex:1">
        <button class="btn" :disabled="!pendingFile || uploading" @click="upload">
          {{ uploading ? '上传暂存中…' : '上传到暂存区预览' }}
        </button>
      </div>
    </div>
    <span v-if="uploadMsg" class="badge" :class="uploadOk ? 'ok' : 'bad'">{{ uploadMsg }}</span>
  </div>

  <div class="panel" v-if="batches.length">
    <h2>导入批次（刷新后仍可追溯：格式版本 · 内容摘要 · 状态）</h2>
    <table>
      <thead><tr>
        <th>#</th><th>文件</th><th>格式/版本</th><th>摘要</th><th>状态</th><th>操作者</th><th>时间</th><th></th>
      </tr></thead>
      <tbody>
        <tr v-for="b in batches" :key="b.id" :class="{ rowActive: current && current.batch.id === b.id }">
          <td>{{ b.id }}</td>
          <td class="mono">{{ b.filename || '（未提供）' }}</td>
          <td>{{ b.file_format }} / {{ b.format_version }}</td>
          <td class="small">
            共 {{ b.summary.total_lines ?? b.row_count }} 行 ·
            <span class="badge ok">合法 {{ b.summary.ok_lines ?? 0 }}</span>
            <span v-if="(b.summary.error_lines ?? 0) > 0" class="badge bad">错误 {{ b.summary.error_lines }}</span>
            <span v-if="(b.summary.within_file_conflicts ?? 0) > 0" class="badge warn">批内冲突 {{ b.summary.within_file_conflicts }}</span>
            <span v-if="(b.summary.with_library_conflicts ?? 0) > 0" class="badge warn">与库冲突 {{ b.summary.with_library_conflicts }}</span>
          </td>
          <td>
            <span class="badge" :class="statusCls(b.status)">{{ statusText(b.status) }}</span>
            <div v-if="b.status==='committed'" class="small muted">
              提交 {{ b.summary.committed_lines ?? 0 }} 行 · {{ fmt(b.committed_at) }}
            </div>
          </td>
          <td class="small">{{ b.created_by || '—' }}</td>
          <td class="small muted">{{ fmt(b.created_at) }}</td>
          <td style="white-space:nowrap">
            <a href="#" @click.prevent="open(b.id)">审阅</a>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 暂存 / 批次审阅 -->
  <template v-if="current">
    <div class="panel">
      <h2>
        批次 #{{ current.batch.id }} 审阅
        <span class="badge" :class="statusCls(current.batch.status)" style="margin-left:8px">
          {{ statusText(current.batch.status) }}
        </span>
      </h2>
      <div class="small muted" style="margin-bottom:8px">
        文件 {{ current.batch.filename || '（未提供）' }} ·
        {{ current.batch.file_format }} / {{ current.batch.format_version }} ·
        {{ current.batch.raw_bytes }} 字节 ·
        sha256 <span class="mono">{{ current.batch.content_sha256.slice(0,16) }}…</span>
      </div>

      <div v-if="errorRows.length" class="callout bad">
        <b>有 {{ errorRows.length }} 行无法解析（逐行错误，修复文件后重导；本批不能提交）：</b>
        <table style="margin-top:8px">
          <thead><tr><th>行</th><th>错误码</th><th>说明</th><th>原始行（逐字节）</th></tr></thead>
          <tbody>
            <tr v-for="r in errorRows" :key="r.id">
              <td>{{ r.line_no }}</td>
              <td><span class="badge bad">{{ r.error_code }}</span></td>
              <td class="small">{{ r.error_message }}</td>
              <td class="mono" style="max-width:420px;overflow:auto">{{ r.raw_line }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="conflictGroups.length" class="callout" style="border-color:var(--warn)">
        <b>⚖️ {{ conflictGroups.length }} 个归一化键存在冲突——系统不挑赢家，必须你显式裁决：</b>
        <div v-for="g in conflictGroups" :key="g.key" style="margin:8px 0">
          <div class="mono">{{ g.key }}</div>
          <div class="small muted">候选目标：<span class="mono" v-for="t in g.targets" :key="t">［{{ t }}］ </span></div>
        </div>
      </div>

      <div class="row" style="margin:10px 0;align-items:center">
        <div style="flex:1">
          <button class="btn" :disabled="!canCommit || busy" @click="commit">
            {{ busy ? '提交中…' : `原子提交所选 ${selectedCount} 行` }}
          </button>
          <button class="btn secondary" style="margin-left:8px"
                  :disabled="current.batch.status !== 'staged' || busy"
                  @click="selectAll(true)">全选合法行</button>
          <button class="btn secondary" style="margin-left:8px"
                  :disabled="current.batch.status !== 'staged' || busy"
                  @click="selectAll(false)">全部不选</button>
          <button class="btn secondary" style="margin-left:8px"
                  v-if="current.batch.status === 'staged'" @click="abandon">放弃此批</button>
        </div>
        <div v-if="commitResult" class="small" style="flex:2">
          <span v-if="commitResult.rejected" class="badge bad">提交被拒（{{ commitResult.blockers?.length ?? 0 }} 项，见下）</span>
          <span v-else class="badge ok">已提交 {{ commitResult.committed_lines }} 行；生效映射 {{ commitResult.active_mappings }}，冲突 {{ commitResult.conflicted_mappings }}</span>
        </div>
      </div>

      <div v-if="commitResult?.rejected" class="callout bad">
        <b>整批未写入（原子回滚），受影响行：</b>
        <ul class="issues">
          <li v-for="(b, i) in commitResult.blockers" :key="i">
            <template v-if="b.line_no">第 {{ b.line_no }} 行：</template>
            <template v-else-if="b.source_norm">{{ b.source_norm }}：</template>
            {{ b.reason }}
          </li>
        </ul>
      </div>

      <table v-if="okRows.length">
        <thead><tr>
          <th>行</th><th>选择</th><th>旧址（原始字节）</th><th>归一化键（预览）</th>
          <th>目标（原始）</th><th>动作</th><th>冲突</th><th>提交</th>
        </tr></thead>
        <tbody>
          <tr v-for="r in okRows" :key="r.id">
            <td>{{ r.line_no }}</td>
            <td>
              <select v-if="current.batch.status==='staged'" :value="r.selection"
                      @change="choose(r, $event.target.value)" style="width:auto">
                <option value="pending">待定</option>
                <option value="selected">纳入</option>
                <option value="ignored">放弃</option>
              </select>
              <span v-else class="badge" :class="r.selection==='selected'?'ok':'neutral'">
                {{ r.selection === 'selected' ? '已纳入' : r.selection === 'ignored' ? '已放弃' : '待定' }}
              </span>
            </td>
            <td class="mono" style="max-width:300px;overflow:auto">{{ r.source_raw }}</td>
            <td class="mono small">{{ r.source_norm }}</td>
            <td class="mono small">{{ r.target_raw }}</td>
            <td>{{ r.mapping_type === 'deleted' ? '删除(410)' : '迁移' }}</td>
            <td>
              <span v-if="r.conflict" class="badge warn">{{ conflictText(r.conflict) }}</span>
              <span v-else class="badge ok">无</span>
              <div v-if="r.conflict" class="small muted">
                现库：<span class="mono">{{ r.library_target_norm || '—' }}</span>
              </div>
            </td>
            <td class="small">
              <span v-if="r.committed_mapping_id" class="badge ok">→ 映射 #{{ r.committed_mapping_id }}</span>
              <span v-else>—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>批次审计轨迹（原始行 / 操作者选择 / 提交版本）</h2>
      <table>
        <thead><tr><th>时间</th><th>动作</th><th>操作者</th><th>详情</th></tr></thead>
        <tbody>
          <tr v-for="a in current.audit" :key="a.id">
            <td class="small muted">{{ fmt(a.created_at) }}</td>
            <td><span class="badge neutral">{{ a.action }}</span></td>
            <td class="small">{{ a.actor || '—' }}</td>
            <td class="mono small">{{ JSON.stringify(a.detail) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['changed']);
const actor = ref('');
const pendingFile = ref(null);
const uploading = ref(false);
const uploadMsg = ref('');
const uploadOk = ref(false);
const busy = ref(false);

const batches = ref([]);
const current = ref(null);
const commitResult = ref(null);

const okRows = computed(() => (current.value?.rows ?? []).filter((r) => r.parse_status === 'ok'));
const errorRows = computed(() => (current.value?.rows ?? []).filter((r) => r.parse_status === 'error'));
const selectedCount = computed(() => okRows.value.filter((r) => r.selection === 'selected').length);
const canCommit = computed(() =>
  current.value?.batch.status === 'staged' &&
  selectedCount.value > 0);

const conflictGroups = computed(() => {
  const map = new Map();
  for (const r of okRows.value) {
    if (!r.conflict) continue;
    if (!map.has(r.source_norm)) map.set(r.source_norm, { key: r.source_norm, targets: new Set() });
    for (const t of r.conflict_targets ?? []) map.get(r.source_norm).targets.add(t);
    map.get(r.source_norm).targets.add(r.target_norm);
    if (r.library_target_norm) map.get(r.source_norm).targets.add(r.library_target_norm);
  }
  return [...map.values()].map((g) => ({ ...g, targets: [...g.targets] }));
});

function onFile(e) {
  const f = e.target.files?.[0];
  pendingFile.value = f ?? null;
  uploadMsg.value = '';
}

function detectFormat(f) {
  if (f.name.toLowerCase().endsWith('.json')) return 'json';
  return 'csv';
}

async function upload() {
  const f = pendingFile.value;
  if (!f) return;
  uploading.value = true; uploadMsg.value = '';
  try {
    const bytes = await f.arrayBuffer();
    const data = await api.uploadImport({
      bytes, format: detectFormat(f), filename: f.name, actor: actor.value.trim() || null,
    });
    uploadOk.value = true;
    uploadMsg.value = data.idempotent
      ? `幂等：相同内容摘要已存在（批次 #${data.batch.id}，${statusText(data.batch.status)}），未新增任何行`
      : `已暂存批次 #${data.batch.id}：${data.batch.row_count} 行，请审阅预览与冲突后再提交`;
    await loadBatches();
    current.value = data;
    commitResult.value = null;
  } catch (e) {
    uploadOk.value = false;
    uploadMsg.value = e.message;
  } finally {
    uploading.value = false;
  }
}

async function loadBatches() {
  const d = await api.listImports();
  batches.value = d.batches;
}
async function open(id) {
  current.value = await api.getImport(id);
  commitResult.value = null;
}
async function choose(row, selection) {
  await api.selectImportRow(current.value.batch.id, row.id, selection, actor.value.trim() || null);
  await open(current.value.batch.id);
}
async function selectAll(on) {
  for (const r of okRows.value) {
    const want = on ? 'selected' : 'pending';
    if (r.selection !== want) await choose(r, want);
  }
}
async function commit() {
  busy.value = true;
  try {
    commitResult.value = await api.commitImport(current.value.batch.id, actor.value.trim() || null);
    await open(current.value.batch.id);
    await loadBatches();
    if (!commitResult.value.rejected) emit('changed');
  } catch (e) {
    commitResult.value = { rejected: true, blockers: [{ reason: e.message }] };
  } finally {
    busy.value = false;
  }
}
async function abandon() {
  if (!confirm('放弃该暂存批次？批次与原始行会保留为审计痕迹，但不再允许提交。')) return;
  await api.abandonImport(current.value.batch.id, actor.value.trim() || null);
  await open(current.value.batch.id);
  await loadBatches();
}

function statusText(s) {
  return { staged: '暂存中', committed: '已提交', abandoned: '已放弃' }[s] || s;
}
function statusCls(s) {
  return s === 'committed' ? 'ok' : s === 'staged' ? 'warn' : 'neutral';
}
function conflictText(c) {
  return { within_file: '批内冲突', with_library: '与库冲突', both: '批内+与库' }[c] || c;
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }

onMounted(loadBatches);
</script>
