<template>
  <div class="panel">
    <h2>规范化规则（集中定义，不可在代码里临时解码合并）</h2>
    <ol class="small">
      <li>解析器：WHATWG <code>URL</code>（Node 全局），不手写 split，不做 <code>decodeURIComponent</code> 后比较。</li>
      <li>scheme/host 转小写；默认端口去除；路径<b>大小写敏感</b>——<code>/News</code> 与 <code>/news</code> 是不同资源。</li>
      <li>百分号编码：仅统一十六进制大小写（<code>%2f→%2F</code>），<b>绝不解码</b>；原始中文经 WHATWG 以 UTF-8 编码；
        <code>%2F</code> 不视为分隔符，<code>/files%2Fdraft</code> 与 <code>/files/draft</code> 不合并。</li>
      <li>尾斜杠：默认保留（<code>keep</code>），<code>/column/weekly/</code> 与 <code>/column/weekly</code> 身份不同。</li>
      <li>查询参数：未登记参数一律参与资源身份；追踪参数（{{ rules.trackerParams?.join('、') }}）不参与身份，
        但生成迁移跳转时<b>原样带到最终 URL</b>。</li>
      <li>fragment 不参与身份，直接丢弃。</li>
      <li>多旧址归一后同键却指向不同目标 → 歧义，冲突行 <code>conflicted</code> 不生效、不请求、阻断发布。</li>
    </ol>
    <pre class="evidence">{{ JSON.stringify(rules, null, 2) }}</pre>
  </div>

  <div class="panel">
    <h2>验证器纪律</h2>
    <ul class="small">
      <li>白名单：只允许 {{ host }}，DNS 不参与，每一跳 Location 重新解析并重新过白名单（防 SSRF）。</li>
      <li>环检测：归一化 URL 在同链中重复即 <code>redirect_loop</code>，立即停止。</li>
      <li>长链：最多跟随 5 跳，仍给 Location 即 <code>chain_too_long</code>。</li>
      <li>最终状态必须核实：普通迁移期望 2xx 且落点等于映射目标；已删除栏目期望 410（也接受 404），不允许 301 到首页。</li>
      <li>所有跳与裁决都写 PostgreSQL（<code>crawl_results</code> / <code>verification_verdicts</code>）。</li>
    </ul>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';
import { api } from '../api.js';
const rules = ref({});
const host = 'http://127.0.0.1:4568';
onMounted(async () => { rules.value = await api.rules(); });
</script>
