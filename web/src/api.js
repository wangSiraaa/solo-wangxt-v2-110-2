const j = async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
};

export const api = {
  rules: () => fetch('/api/rules').then(j),
  mappings: () => fetch('/api/mappings').then(j),
  addMapping: (payload) =>
    fetch('/api/mappings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(j),
  normalize: (urls) =>
    fetch('/api/normalize', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ urls }),
    }).then(j),
  verify: (sourceNorm = null) =>
    fetch('/api/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sourceNorm ? { source_norm: sourceNorm } : {}),
    }).then(j),
  crawl: (key) =>
    fetch('/api/crawl/' + encodeURIComponent(key)).then(j),
  plans: () => fetch('/api/plans').then(j),
  plan: (id) => fetch(`/api/plans/${id}`).then(j),
  createPlan: (name) =>
    fetch('/api/plans', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(j),
  buildPlan: (id) =>
    fetch(`/api/plans/${id}/build`, { method: 'POST' }).then(j),
  publishPlan: (id) =>
    fetch(`/api/plans/${id}/publish`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then(j),

  // ---- 批量导入 ----
  importScope: () => fetch('/api/imports/scope').then(j),
  imports: () => fetch('/api/imports').then(j),
  importBatch: (id) => fetch(`/api/imports/${id}`).then(j),
  importAudit: (id) => fetch(`/api/imports/${id}/audit`).then(j),
  /** 以原始字节上传本地文件，绝不交给表单/JSON 解析 */
  uploadImport: async (file, format, actor) => {
    const q = new URLSearchParams({ format, filename: file.name, actor });
    const r = await fetch(`/api/imports?${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file, // File 原样作为字节流发送
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok && !(r.status === 422 && body.batch)) {
      throw new Error(body.error || `HTTP ${r.status}`);
    }
    return body; // 422（含逐行错误/rejected）也把批次交给前端展示
  },
  setImportSelection: (id, selections, actor) =>
    fetch(`/api/imports/${id}/selection`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor, selections }),
    }).then(j),
  resolveImport: (id, sourceNorm, winnerTargetNorm, actor) =>
    fetch(`/api/imports/${id}/resolve`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_norm: sourceNorm, winner_target_norm: winnerTargetNorm, actor }),
    }).then(j),
  commitImport: async (id, actor) => {
    const r = await fetch(`/api/imports/${id}/commit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      // 保留服务端逐行错误（error_records）与未裁决键（unresolved）供界面渲染
      const err = new Error(body.error || `HTTP ${r.status}`);
      err.records = body.error_records;
      err.unresolved = body.unresolved;
      throw err;
    }
    return body;
  },
};
