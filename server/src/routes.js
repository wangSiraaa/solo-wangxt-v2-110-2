/** REST API：映射录入、规范化试算、验证、迁移方案与发布闸门、本地文件批量导入。 */
import { pool } from './db.js';
import { normalize, carryTrackers, splitQuery } from './normalize.js';
import { recomputeMappings } from './mappings-service.js';
import { runVerification, VERDICT_LABEL } from './verify-runner.js';
import { config } from './config.js';
import {
  stageImport, getImport, listImports, updateRowSelection,
  commitImport, abandonImport, BatchFormatError,
} from './import-service.js';

/** 上传文件大小上限：迁移栏目映射是小文本，5MiB 足够且防止滥用 */
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const RAW_TYPES = ['text/csv', 'application/import+json', 'application/octet-stream'];

export default async function api(app) {
  // 批量导入必须拿到原始字节（哈希、原始行留证都依赖字节一致性），
  // 因此这些类型按 Buffer 接收，绝不走 application/json 的对象解析。
  // parseAs:'buffer' 时 Fastify 已把 body 聚合成 Buffer 交给解析器。
  const rawParser = (_req, payload, done) => {
    if (payload.length > MAX_IMPORT_BYTES) {
      return done(Object.assign(new Error('导入文件超过 5MiB 上限'), { statusCode: 413 }));
    }
    done(null, payload);
  };
  for (const t of RAW_TYPES) app.addContentTypeParser(t, { parseAs: 'buffer' }, rawParser);

  app.get('/api/health', async () => ({ ok: true, fixture: `127.0.0.1:${config.fixture.port}` }));

  app.get('/api/rules', async () => config.rules);

  // 规范化试算（不写库）：展示大小写/编码/尾斜杠/查询参数如何处理
  app.post('/api/normalize', async (req) => {
    const { urls } = req.body ?? {};
    if (!Array.isArray(urls)) {
      return app.httpErrors?.badRequest?.('urls[] required') ?? { error: 'urls[] required' };
    }
    return urls.map((u) => {
      const r = normalize(String(u));
      if (!r.ok) return { input: u, ok: false, error: r.error };
      const { trackers } = splitQuery(new URL(u).search);
      return {
        input: u, ok: true,
        norm_key: r.normKey,
        pathname: r.pathname,
        identity_query: r.identityQuery,
        tracker_params: [...trackers.keys()],
      };
    });
  });

  // 全量材料：原始输入 + 生效映射 + 最新裁决
  app.get('/api/mappings', async () => {
    const { rows: inputs } = await pool.query(
      `SELECT i.*, v.verdict, v.issues, v.final_status, v.final_url_raw, v.hops,
              v.tracker_preserved, v.verified_at, v.stale, v.mapping_version
         FROM mapping_inputs i
         LEFT JOIN verification_verdicts v ON v.source_norm = i.source_norm
        ORDER BY i.id`);
    const { rows: mappings } = await pool.query('SELECT * FROM url_mappings ORDER BY id');
    const { rows: ambiguities } = await pool.query('SELECT * FROM mapping_ambiguities ORDER BY source_norm');
    return {
      inputs, mappings, ambiguities, verdictLabel: VERDICT_LABEL,
      // 仅统计生效证据（被取代的录入不参与“有效”计数）
      activeInputCount: inputs.filter((i) => i.superseded_at == null).length,
    };
  });

  // 录入一条原始映射：只进 mapping_inputs；随后重算 url_mappings 状态。
  // 与批量导入同一纪律：URL 必须落在随项目启动的本地迁移范围（防 SSRF/外站混入）。
  app.post('/api/mappings', async (req, reply) => {
    const { source_raw, target_raw, mapping_type = 'manual', note } = req.body ?? {};
    const s = normalize(String(source_raw ?? ''));
    const t = normalize(String(target_raw ?? ''));
    if (!s.ok) return reply.code(400).send({ error: `source: ${s.error}` });
    if (!t.ok) return reply.code(400).send({ error: `target: ${t.error}` });
    const inScope = (n) =>
      n.host === config.fixture.host && n.port === String(config.fixture.port);
    if (!inScope(s) || !inScope(t)) {
      return reply.code(400).send({
        error: `URL 不在允许的本地迁移范围 127.0.0.1:${config.fixture.port}`,
      });
    }
    if (!['manual', 'deleted'].includes(mapping_type)) {
      return reply.code(400).send({ error: `非法类型: ${mapping_type}` });
    }
    if (mapping_type === 'deleted' && s.normKey !== t.normKey) {
      return reply.code(400).send({ error: 'deleted 类型的目标必须与旧址同一资源' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [source_raw, s.normKey, target_raw, t.normKey, mapping_type, note ?? null]);
      await recomputeMappings(client);
      await client.query('COMMIT');
      return { ok: true, source_norm: s.normKey, target_norm: t.normKey };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  app.post('/api/verify', async (req) => {
    const onlyKey = req.body?.source_norm ?? null;
    return runVerification({ onlyKey });
  });

  app.get('/api/crawl/:key', async (req, reply) => {
    const key = decodeURIComponent(req.params.key);
    const { rows } = await pool.query(
      'SELECT * FROM crawl_results WHERE source_norm=$1 ORDER BY hop_index', [key]);
    if (!rows.length) return reply.code(404).send({ error: 'no crawl evidence; run verification first' });
    return rows;
  });

  // ---- 本地文件批量导入 -------------------------------------------------
  // 只接收浏览器从本地磁盘读取的文件字节（multipart/URL 远程拉取一律不提供）。
  app.get('/api/imports', async () => ({ batches: await listImports() }));

  app.get('/api/imports/:id', async (req, reply) => {
    const data = await getImport(Number(req.params.id));
    if (!data) return reply.code(404).send({ error: 'import batch not found' });
    return data;
  });

  // POST /api/imports?format=csv|json  body=文件原始字节
  // 元信息走显式头：X-Import-Filename、X-Import-Actor（不收 multipart，避免框架改写字节）
  app.post('/api/imports', async (req, reply) => {
    const fileFormat = req.query?.format;
    const filename = String(req.headers['x-import-filename'] ?? '').slice(0, 255) || null;
    const actor = String(req.headers['x-import-actor'] ?? '').slice(0, 100) || null;
    const bytes = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : '');
    try {
      const result = await stageImport({ bytes, fileFormat, filename, actor });
      const data = await getImport(result.batch.id);
      return reply.code(result.idempotent ? 200 : 201)
        .send({ ...data, idempotent: result.idempotent });
    } catch (e) {
      if (e instanceof BatchFormatError) return reply.code(400).send({ error: e.message });
      throw e;
    }
  });

  // 操作者选择：selected / ignored / pending
  app.post('/api/imports/:id/rows/:rowId/selection', async (req, reply) => {
    const selection = String(req.body?.selection ?? '');
    const actor = String(req.headers['x-import-actor'] ?? '').slice(0, 100) || null;
    const r = await updateRowSelection(
      Number(req.params.id), Number(req.params.rowId), selection, actor);
    if (r.error) return reply.code(r.error).send({ error: r.message });
    return r;
  });

  // 原子提交所选行（冲突必须已显式裁决、批次不得含错误行）
  app.post('/api/imports/:id/commit', async (req, reply) => {
    const actor = String(req.headers['x-import-actor'] ?? '').slice(0, 100) || null;
    const r = await commitImport(Number(req.params.id), { actor });
    if (r.rejected) return reply.code(r.status).send(r);
    return r;
  });

  app.post('/api/imports/:id/abandon', async (req, reply) => {
    const actor = String(req.headers['x-import-actor'] ?? '').slice(0, 100) || null;
    const r = await abandonImport(Number(req.params.id), actor);
    if (r.error) return reply.code(r.error).send({ error: r.message });
    return r;
  });

  // ---- 迁移方案 -------------------------------------------------------

  app.get('/api/plans', async () => {
    const { rows } = await pool.query(
      `SELECT p.*,
              count(pi.id) AS items,
              count(pi.id) FILTER (WHERE pi.item_status='verified') AS verified,
              count(pi.id) FILTER (WHERE pi.item_status='blocked')  AS blocked,
              count(pi.id) FILTER (WHERE pi.item_status='pending')  AS pending
         FROM migration_plans p
         LEFT JOIN migration_plan_items pi ON pi.plan_id=p.id
        GROUP BY p.id ORDER BY p.id`);
    return rows;
  });

  app.post('/api/plans', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'name required' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO migration_plans (name) VALUES ($1)
         RETURNING *`, [name]);
      return rows[0];
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'plan name exists' });
      throw e;
    }
  });

  // 把全部 active 映射纳入方案，并按最新裁决设置条目状态
  app.post('/api/plans/:id/build', async (req, reply) => {
    const planId = Number(req.params.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: plan } = await client.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
      if (!plan.length) { await client.query('ROLLBACK'); return reply.code(404).send({ error: 'plan not found' }); }
      if (plan[0].status === 'published') {
        await client.query('ROLLBACK');
        return reply.code(409).send({ error: '已发布方案不可改' });
      }
      await client.query('DELETE FROM migration_plan_items WHERE plan_id=$1', [planId]);

      const { rows: ms } = await client.query(
        `SELECT m.*, v.verdict, v.issues, v.final_status, v.final_url_raw,
                v.final_url_norm, v.hops, v.tracker_preserved,
                v.stale AS evidence_stale, v.mapping_version AS evidence_version
           FROM url_mappings m
           LEFT JOIN verification_verdicts v ON v.source_norm=m.source_norm
          WHERE m.status='active' ORDER BY m.id`);
      for (const m of ms) {
        // 证据必须新鲜：裁决通过、未被标过期、且取自当前映射版本
        const evidenceFresh =
          (m.verdict === 'ok' || m.verdict === 'deleted_gone_ok') &&
          m.evidence_stale === false &&
          m.evidence_version === m.version;
        // 计划中的最终跳转 URL：携带追踪参数的示例（取首次输入的参数）
        const { rows: ins } = await client.query(
          'SELECT source_raw FROM mapping_inputs WHERE source_norm=$1 ORDER BY id LIMIT 1',
          [m.source_norm]);
        const proposed = m.mapping_type === 'deleted'
          ? null
          : carryTrackers(ins[0].source_raw, m.target_raw);
        const issues = [
          ...(m.issues ?? []),
          ...(m.evidence_stale || (m.evidence_version !== undefined && m.evidence_version !== m.version)
            ? ['映射已变更，旧验证证据已过期，必须重新验证']
            : []),
        ];
        await client.query(
          `INSERT INTO migration_plan_items (plan_id, mapping_id, item_status, evidence)
           VALUES ($1,$2,$3,$4)`,
          [planId, m.id,
           evidenceFresh ? 'verified' : m.verdict ? 'blocked' : 'pending',
           JSON.stringify({
             verdict: m.verdict ?? null,
             issues,
             final_status: m.final_status ?? null,
             final_url: m.final_url_raw ?? null,
             hops: m.hops ?? 0,
             tracker_preserved: m.tracker_preserved ?? null,
             proposed_redirect_url: proposed,
             stale: m.evidence_stale ?? null,
             mapping_version: m.version,
             evidence_version: m.evidence_version ?? null,
           })]);
      }
      await client.query('COMMIT');
      return { built: ms.length };
    } finally {
      client.release();
    }
  });

  app.get('/api/plans/:id', async (req, reply) => {
    const { rows: plans } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [req.params.id]);
    if (!plans.length) return reply.code(404).send({ error: 'not found' });
    const { rows: items } = await pool.query(
      `SELECT pi.*, m.source_raw, m.source_norm, m.target_raw, m.target_norm,
              m.mapping_type, pi.evidence
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 ORDER BY pi.id`, [req.params.id]);
    return { plan: plans[0], items };
  });

  /**
   * 发布闸门：
   *  - 不存在 blocked/pending 条目（每条都必须有成功验证的证据）；
   *  - 不存在未纳入方案的 active 映射；
   *  - 不存在 conflicted 映射；
   *  - 验证证据必须是最近一次（verified_at 晚于映射/输入更新）——这里以
   *    每条 evidence.verdict 为 ok/deleted_gone_ok 为准。
   * 任何一条不满足都拒绝发布并列出受影响链接。
   */
  app.post('/api/plans/:id/publish', async (req, reply) => {
    const planId = Number(req.params.id);
    const blockers = [];

    const { rows: plan } = await pool.query('SELECT * FROM migration_plans WHERE id=$1', [planId]);
    if (!plan.length) return reply.code(404).send({ error: 'not found' });
    if (plan[0].status === 'published') {
      return { alreadyPublished: true, plan: plan[0] };
    }

    const { rows: badItems } = await pool.query(
      `SELECT m.source_raw, pi.item_status, pi.evidence
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
        WHERE pi.plan_id=$1 AND pi.item_status <> 'verified'`, [planId]);
    for (const b of badItems) {
      blockers.push({
        source: b.source_raw,
        reason: b.item_status === 'pending'
          ? '只有映射表条目，没有验证证据（填表不等于迁移完成）'
          : `验证未通过：${(b.evidence?.issues ?? []).join('；') || b.evidence?.verdict}`,
      });
    }

    const { rows: missing } = await pool.query(
      `SELECT m.source_raw FROM url_mappings m
        WHERE m.status='active'
          AND NOT EXISTS (SELECT 1 FROM migration_plan_items pi
                           WHERE pi.mapping_id=m.id AND pi.plan_id=$1)`,
      [planId]);
    missing.forEach((m) => blockers.push({ source: m.source_raw, reason: '生效映射未纳入方案' }));

    const { rows: conflicts } = await pool.query('SELECT source_raw FROM url_mappings WHERE status=$1', ['conflicted']);
    conflicts.forEach((m) => blockers.push({ source: m.source_raw, reason: '归一化歧义未裁决' }));

    // 过期证据：映射在取证后被改动（批量提交/改目标），旧裁决不允许用于发布
    const { rows: stale } = await pool.query(
      `SELECT m.source_raw, m.version, v.verified_at
         FROM url_mappings m
         JOIN verification_verdicts v ON v.source_norm = m.source_norm
        WHERE m.status='active' AND (v.stale OR v.mapping_version IS DISTINCT FROM m.version)`);
    stale.forEach((m) => blockers.push({
      source: m.source_raw,
      reason: `验证证据已过期（映射版本 ${m.version}），请重新验证后再发布`,
    }));

    if (blockers.length) {
      return reply.code(409).send({ published: false, blockers });
    }

    const { rows } = await pool.query(
      `UPDATE migration_plans SET status='published', published_at=now()
        WHERE id=$1 RETURNING *`, [planId]);
    return { published: true, plan: rows[0] };
  });
}
