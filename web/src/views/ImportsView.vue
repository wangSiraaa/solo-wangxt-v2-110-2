<template>
  <div class="panel">
    <h2>批量导入遗留栏目映射（仅本地文件）</h2>
    <p class="muted small">
      文件以<b>原始字节</b>上传：CSV/JSON 解析不会改动百分号编码、尾斜杠或追踪参数。
      先在暂存区按现有 WHATWG 规则预览、处理冲突，再原子提交；任一行损坏则整批不可提交，
      未提交数据绝不影响当前生效映射。仅接受回环本机请求，目标必须在
      <b>{{ scope.allowed_origins.join('、') }}</b> 范围内，格式版本仅支持
      v{{ scope.supported_version }}。
    </p>
    <div class="row" style="align-items:flex-end">
      <label class="field" style="flex:3">
        <span>选择本地文件（.csv 首行须为 <code># url-migration-import v1</code>；.json 须含 format_version/rows）</span>
        <input type="file" accept=".csv,.json" @change="onPick" />
      </label>
      <label class="field" style="flex:1">
        <span>格式</span>
        <select v-model="format">
          <option value="auto">按扩展名自动</option>
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>
      </label>
      <label class="field" style="flex:1">
        <span>操作者</span>
        <input v-model="actor" placeholder="迁移团队" />
      </label>
      <div style="flex:1">
        <button class="btn" :disabled="!file || uploading" @click="upload">
          {{ uploading ? '上传解析中…' : '上传到暂存区' }}
        </button>
      </div>
    </div>
    <div v-if="uploadNote" class="callout" :class="uploadNote.kind">{{ uploadNote.text }}</div>
  </div>

  <!-- 批次历史（刷新后可追溯） -->
  <div class="panel">
    <h2>导入批次</h2>
    <table>
      <thead>
        <tr><th>#</th><th>文件</th><th>格式/版本</th><th>摘要</th><th>行（正常/错误）</th>
          <th>状态</th><th>提交数</th><th>操作者</th><th>时间</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="b in batches" :key="b.id" :class="{ activeRow: current && current.batch.id === b.id }">
          <td>{{ b.id }}</td>
          <td class="mono">{{ b.filename }} <span class="muted">({{ b.byte_length }}B)</span></td>
          <td>{{ b.format }} v{{ b.format_version }}</td>
          <td class="mono small">{{ b.content_digest.slice(0, 22) }}…</td>
          <td>{{ b.total_lines }}（{{ b.ok_lines }}/{{ b.error_lines }}）</td>
          <td><span class="badge" :class="statusClass(b.status)">{{ statusText(b.status) }}</span></td>
          <td>{{ b.committed_count ?? '—' }}</td>
          <td>{{ b.committed_by || b.created_by }}</td>
          <td class="small muted">{{ fmt(b.committed_at || b.created_at) }}</td>
          <td><a href="#" @click.prevent="open(b.id)">查看</a></td>
        </tr>
        <tr v-if="!batches.length"><td colspan="10" class="muted">尚无批次</td></tr>
      </tbody>
    </table>
  </div>

  <!-- 批次详情 / 预览 / 冲突 / 提交 -->
  <template v-if="current">
    <div class="panel">
      <h2>
        批次 #{{ current.batch.id }}：{{ current.batch.filename }}
        <span class="badge" :class="statusClass(current.batch.status)" style="margin-left:8px">
          {{ statusText(current.batch.status) }}
        </span>
      </h2>
      <div class="small muted" style="margin-bottom:8px">
        内容摘要 <span class="mono">{{ current.batch.content_digest }}</span> ·
        {{ current.batch.byte_length }} 字节 · 格式 {{ current.batch.format }} v{{ current.batch.format_version }} ·
        上传者 {{ current.batch.created_by }} · {{ fmt(current.batch.created_at) }}
        <template v-if="current.batch.status === 'committed'">
          · 提交 {{ current.batch.committed_count }} 行，{{ current.batch.committed_by }}
          于 {{ fmt(current.batch.committed_at) }}
        </template>
      </div>

      <div v-for="e in current.batch.parse_errors" :key="e.code" class="callout bad">
        <b>{{ e.code }}</b>：{{ e.message }}<span v-if="e.line_no">（第 {{ e.line_no }} 行）</span>
      </div>

      <!-- 提交结果/阻断信息 -->
      <div v-if="commitNote" class="callout" :class="commitNote.kind">
        <template v-if="commitNote.kind === 'ok'">
          ✅ 已原子提交 {{ commitNote.committed_count }} 行；
          {{ commitNote.staleVerdicts }} 条旧验证证据被标记过期，
          {{ commitNote.stalePlanItems }} 个方案条目退回待验证——请对受影响映射重新验证。
        </template>
        <template v-else>
          <b>无法提交：</b>{{ commitNote.text }}
          <ul v-if="commitNote.records?.length" class="issues">
            <li v-for="r in commitNote.records" :key="r.record_no">
              第 {{ r.line_no }} 行（记录 #{{ r.record_no }}）：{{ r.code }} — {{ r.message }}
            </li>
          </ul>
          <ul v-if="commitNote.unresolved?.length" class="issues">
            <li v-for="k in commitNote.unresolved" :key="k" class="mono">{{ k }}</li>
          </ul>
        </template>
      </div>

      <div class="row" style="align-items:center;margin-top:8px">
        <div style="flex:3" class="small">
          <span class="badge neutral">正常 {{ current.batch.ok_lines }}</span>
          <span class="badge bad" v-if="current.batch.error_lines">错误 {{ current.batch.error_lines }}</span>
          <span class="badge warn" v-if="conflictKeys.length">待裁决冲突 {{ conflictKeys.length }}</span>
          <span class="badge neutral">已选 {{ current.batch.selected_count }}</span>
        </div>
        <div style="flex:1; text-align:right" v-if="current.batch.status === 'staged'">
          <button class="btn" :disabled="!canCommit" @click="commit">
            原子提交所选行
          </button>
          <div v-if="!canCommit" class="small muted" style="margin-top:4px">{{ commitBlockReason }}</div>
        </div>
      </div>
    </div>

    <!-- 冲突裁决区 -->
    <div class="panel" v-for="key in conflictKeys" :key="'cf-'+key">
      <h2>⚖️ 冲突裁决：<span class="mono">{{ key }}</span></h2>
      <p class="muted small">
        下列候选归一到同一 canonical key 却指向不同目标。系统<b>不会自动挑赢家</b>；
        未裁决前该键不会被验证器请求，也不能提交。
      </p>
      <table>
        <thead><tr><th>选择</th><th>来源</th><th>原始目标</th><th>目标归一化键</th><th>类型</th></tr></thead>
        <tbody>
          <tr v-for="opt in winnerOptions(key)" :key="opt.target_norm">
            <td>
              <input type="radio" :name="'w-'+key" style="width:auto"
                :checked="resolutionFor(key) === opt.target_norm"
                :disabled="current.batch.status !== 'staged'"
                @change="resolve(key, opt.target_norm)" />
            </td>
            <td>
              <span v-for="kn in opt.kinds" :key="kn" class="badge"
                :class="kn === '本批' ? 'neutral' : 'warn'" style="margin-right:4px">
                {{ kn === '本批' ? `本批 #${[...new Set(opt.recordNos)].join(',#')}` : '当前库' }}
              </span>
            </td>
            <td class="mono">{{ opt.target_raw }}</td>
            <td class="mono">{{ opt.target_norm }}</td>
            <td>{{ opt.mapping_type === 'deleted' ? '已删除' : '迁移' }}</td>
          </tr>
        </tbody>
      </table>
      <div class="small" style="margin-top:6px">
        <span v-if="resolutionFor(key)" class="badge ok">
          已裁决胜出：{{ resolutionFor(key) }}
        </span>
        <span v-else class="badge bad">尚未裁决</span>
      </div>
    </div>

    <!-- 逐行预览 -->
    <div class="panel">
      <h2>逐行暂存预览（原始值 ｜ WHATWG 规范化结果）</h2>
      <table>
        <thead>
          <tr>
            <th>纳入</th><th>#</th><th>行</th><th>状态</th>
            <th>原始旧址 source_raw（逐字节）</th><th>规范化键 source_norm</th>
            <th>原始新址 target_raw</th><th>动作</th><th>追踪参数</th><th>冲突</th><th>原始行 / 错误</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in current.rows" :key="r.id" :class="{ rowError: r.parse_status === 'error' }">
            <td>
              <input type="checkbox" style="width:auto" v-model="selection[r.record_no]"
                :disabled="r.parse_status !== 'parsed' || current.batch.status !== 'staged'"
                @change="toggle(r)" />
            </td>
            <td>{{ r.record_no }}</td>
            <td class="small muted">{{ r.line_no }}<template v-if="r.end_line_no !== r.line_no">–{{ r.end_line_no }}</template></td>
            <td>
              <span v-if="r.parse_status === 'error'" class="badge bad">错误</span>
              <span v-else-if="current.batch.status === 'committed' && !r.selected" class="badge neutral">判负未提交</span>
              <span v-else-if="current.batch.status === 'committed'" class="badge ok">已提交</span>
              <span v-else class="badge ok">可提交</span>
            </td>
            <td class="mono">{{ r.source_raw || '—' }}</td>
            <td class="mono">{{ r.source_norm || '—' }}
              <div v-if="r.norm_detail" class="small muted">
                路径 {{ r.norm_detail.pathname }}<span v-if="r.norm_detail.identity_query">?{{ r.norm_detail.identity_query }}</span>
              </div>
            </td>
            <td class="mono">{{ r.target_raw || '—' }}</td>
            <td>{{ r.action }}<span v-if="r.mapping_type"> → {{ r.mapping_type === 'deleted' ? 'deleted' : 'manual' }}</span></td>
            <td class="mono small">{{ (r.norm_detail?.tracker_params || []).join(', ') || '—' }}</td>
            <td>
              <span v-if="r.conflict_group != null" class="badge warn">文件内冲突组 {{ r.conflict_group }}</span>
              <span v-if="r.conflicted_with_current" class="badge bad">与当前库冲突</span>
            </td>
            <td class="small">
              <div v-if="r.parse_status === 'error'" class="issues" style="margin:0">
                <li>{{ r.error_code }}：{{ r.error_message }}</li>
              </div>
              <details v-else>
                <summary class="muted">查看原始行</summary>
                <pre class="evidence">{{ r.raw_line }}</pre>
              </details>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 审计轨迹 -->
    <div class="panel">
      <h2>批次审计轨迹</h2>
      <table>
        <thead><tr><th>时间</th><th>事件</th><th>操作者</th><th>明细</th></tr></thead>
        <tbody>
          <tr v-for="e in audit" :key="e.id">
            <td class="small muted">{{ fmt(e.at) }}</td>
            <td><span class="badge neutral">{{ eventText(e.event) }}</span></td>
            <td>{{ e.actor }}</td>
            <td class="mono small">{{ JSON.stringify(e.detail) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['changed']);

const scope = ref({ supported_version: 1, allowed_origins: [], max_bytes: 0, tracker_params: [] });
const batches = ref([]);
const current = ref(null);
const audit = ref([]);
const file = ref(null);
const format = ref('auto');
const actor = ref('迁移团队');
const uploading = ref(false);
const uploadNote = ref(null);
const commitNote = ref(null);
const selection = reactive({});

const conflictKeys = computed(() => {
  if (!current.value) return [];
  const ks = new Set();
  for (const r of current.value.rows) {
    if (r.conflict_group != null || r.conflicted_with_current) ks.add(r.source_norm);
  }
  return [...ks];
});

const canCommit = computed(() => {
  if (!current.value || current.value.batch.status !== 'staged') return false;
  if (current.value.batch.error_lines > 0) return false;
  if (!conflictKeys.value.every((k) => resolutionFor(k) != null)) return false;
  return current.value.rows.some((r) => r.selected && r.parse_status === 'parsed');
});

const commitBlockReason = computed(() => {
  if (!current.value) return '';
  if (current.value.batch.error_lines > 0) return `存在 ${current.value.batch.error_lines} 行损坏，整批不可提交`;
  const un = conflictKeys.value.filter((k) => resolutionFor(k) == null);
  if (un.length) return `${un.length} 个冲突键尚未裁决`;
  if (!current.value.rows.some((r) => r.selected && r.parse_status === 'parsed')) {
    return '至少需要选择一行';
  }
  return '';
});

function resolutionFor(key) {
  return current.value?.resolutions?.find((r) => r.source_norm === key)?.winner_target_norm ?? null;
}

/** 某个冲突键的全部候选（本批 + 当前库），按 target_norm 合并来源标签 */
function winnerOptions(key) {
  const byNorm = new Map();
  const first = current.value.rows.find((r) => r.source_norm === key);
  for (const c of first?.file_candidates ?? []) {
    if (!byNorm.has(c.target_norm)) {
      byNorm.set(c.target_norm, { ...c, kinds: [], recordNos: [] });
    }
    const o = byNorm.get(c.target_norm);
    if (!o.kinds.includes('本批')) o.kinds.push('本批');
    o.recordNos.push(c.record_no);
  }
  for (const c of first?.current_candidates ?? []) {
    if (!byNorm.has(c.target_norm)) {
      byNorm.set(c.target_norm, { ...c, kinds: [], recordNos: [] });
    }
    const o = byNorm.get(c.target_norm);
    if (!o.kinds.includes('当前库')) o.kinds.push('当前库');
  }
  return [...byNorm.values()];
}

function onPick(e) {
  file.value = e.target.files?.[0] ?? null;
  if (file.value && format.value === 'auto') {
    format.value = file.value.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
  }
}

async function upload() {
  if (!file.value) return;
  uploading.value = true;
  uploadNote.value = null;
  commitNote.value = null;
  try {
    const fmt = format.value === 'auto'
      ? (file.value.name.endsWith('.json') ? 'json' : 'csv')
      : format.value;
    const result = await api.uploadImport(file.value, fmt, actor.value);
    await loadBatches();
    await open(result.batch.id);
    if (result.idempotent) {
      uploadNote.value = { kind: 'ok', text: '相同内容摘要已存在，直接返回既有批次（幂等，不新增映射或暂存行）。' };
    } else if (result.batch.status === 'rejected') {
      uploadNote.value = { kind: 'bad', text: '文件被整批拒绝（版本不支持或结构无法解析）。' };
    } else if (result.batch.error_lines > 0) {
      uploadNote.value = { kind: 'bad', text: `已暂存备查，但有 ${result.batch.error_lines} 行损坏，修复文件后重新上传。` };
    } else {
      uploadNote.value = { kind: 'ok', text: '已解析入暂存区，请核对原始值与规范化结果、处理冲突后提交。' };
    }
  } catch (e) {
    uploadNote.value = { kind: 'bad', text: e.message };
  } finally {
    uploading.value = false;
  }
}

async function loadBatches() {
  batches.value = (await api.imports()).batches;
}

async function open(id) {
  commitNote.value = null;
  current.value = await api.importBatch(id);
  audit.value = (await api.importAudit(id)).events;
  for (const k of Object.keys(selection)) delete selection[k];
  for (const r of current.value.rows) selection[r.record_no] = r.selected;
}

async function toggle(row) {
  if (current.value.batch.status !== 'staged') return;
  try {
    current.value = await api.setImportSelection(
      current.value.batch.id,
      [{ record_no: row.record_no, selected: selection[row.record_no] }],
      actor.value);
    await loadBatches();
  } catch (e) {
    uploadNote.value = { kind: 'bad', text: e.message };
    selection[row.record_no] = !selection[row.record_no];
  }
}

async function resolve(key, winner) {
  try {
    current.value = await api.resolveImport(current.value.batch.id, key, winner, actor.value);
    for (const r of current.value.rows) selection[r.record_no] = r.selected;
  } catch (e) {
    uploadNote.value = { kind: 'bad', text: e.message };
  }
}

async function commit() {
  commitNote.value = null;
  try {
    const r = await api.commitImport(current.value.batch.id, actor.value);
    commitNote.value = {
      kind: 'ok',
      committed_count: r.committed_count,
      staleVerdicts: r.staleVerdicts,
      stalePlanItems: r.stalePlanItems,
    };
    await open(r.batch.id);
    await loadBatches();
    emit('changed');
  } catch (e) {
    // 409 响应体携带逐行错误/未裁决键
    commitNote.value = {
      kind: 'bad',
      text: e.message,
      records: e.records,
      unresolved: e.unresolved,
    };
  }
}

function statusClass(s) {
  return s === 'committed' ? 'ok' : s === 'rejected' ? 'bad' : 'warn';
}
function statusText(s) {
  return { staged: '暂存待审', committed: '已提交', rejected: '整批拒绝' }[s] || s;
}
function eventText(e) {
  return { uploaded: '上传', updated_selection: '修改选择', resolved: '冲突裁决', committed: '提交' }[e] || e;
}
function fmt(ts) { return ts ? new Date(ts).toLocaleString('zh-CN') : '—'; }

onMounted(async () => {
  scope.value = await api.importScope();
  await loadBatches();
});
</script>

<style scoped>
.activeRow { background: var(--panel2); }
.rowError { background: rgba(248, 81, 73, 0.06); }
code { font-family: ui-monospace, Menlo, monospace; }
</style>
