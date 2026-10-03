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

  // ---- 本地文件批量导入（body 为文件原始字节，绝不走 JSON 对象解析）----
  listImports: () => fetch('/api/imports').then(j),
  getImport: (id) => fetch(`/api/imports/${id}`).then(j),
  uploadImport: ({ bytes, format, filename, actor }) => {
    const params = new URLSearchParams({ format });
    return fetch(`/api/imports?${params}`, {
      method: 'POST',
      headers: {
        // 自定义类型：明确告知服务端按原始字节处理；不带 multipart，避免任何重编码
        'content-type': format === 'json' ? 'application/import+json' : 'text/csv',
        ...(filename ? { 'X-Import-Filename': encodeURIComponent(filename) } : {}),
        ...(actor ? { 'X-Import-Actor': actor } : {}),
      },
      body: bytes,
    }).then(j);
  },
  selectImportRow: (batchId, rowId, selection, actor) =>
    fetch(`/api/imports/${batchId}/rows/${rowId}/selection`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(actor ? { 'X-Import-Actor': actor } : {}),
      },
      body: JSON.stringify({ selection }),
    }).then(j),
  commitImport: (id, actor) =>
    fetch(`/api/imports/${id}/commit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(actor ? { 'X-Import-Actor': actor } : {}),
      },
      body: '{}',
    }).then(j),
  abandonImport: (id, actor) =>
    fetch(`/api/imports/${id}/abandon`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(actor ? { 'X-Import-Actor': actor } : {}),
      },
      body: '{}',
    }).then(j),
};
