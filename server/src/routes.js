/** REST API：映射录入、规范化试算、验证、迁移方案与发布闸门、批量导入。 */
import { pool } from './db.js';
import { normalize, carryTrackers, splitQuery } from './normalize.js';
import { recomputeMappings, syncPlanEvidence } from './mappings-service.js';
import { runVerification, VERDICT_LABEL } from './verify-runner.js';
import { config } from './config.js';
import * as imports from './import-service.js';

export default async function api(app) {
  // 批量上传口需要原始字节：百分号编码/尾斜杠/追踪参数绝不能被 JSON/表单解析改动。
  app.addContentTypeParser(
    ['application/octet-stream', 'application/x-import'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

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

  // 全量材料：原始输入 + 生效映射 + 最新裁决（含证据代次/过期标记）
  app.get('/api/mappings', async () => {
    const { rows: inputs } = await pool.query(
      `SELECT i.*, v.verdict, v.issues, v.final_status, v.final_url_raw, v.hops,
              v.tracker_preserved, v.verified_at, v.stale AS verdict_stale,
              v.mapping_revision AS verdict_revision
         FROM mapping_inputs i
         LEFT JOIN verification_verdicts v ON v.source_norm = i.source_norm
        ORDER BY i.id`);
    const { rows: mappings } = await pool.query(
      `SELECT m.*, v.stale AS verdict_stale,
              (v.mapping_revision IS NOT NULL
                AND v.mapping_revision < m.revision) AS evidence_outdated
         FROM url_mappings m
         LEFT JOIN verification_verdicts v ON v.source_norm = m.source_norm
        ORDER BY m.id`);
    const { rows: ambiguities } = await pool.query('SELECT * FROM mapping_ambiguities ORDER BY source_norm');
    return { inputs, mappings, ambiguities, verdictLabel: VERDICT_LABEL };
  });

  // 录入一条原始映射：只进 mapping_inputs；随后重算 url_mappings 状态
  app.post('/api/mappings', async (req, reply) => {
    const { source_raw, target_raw, mapping_type = 'manual', note } = req.body ?? {};
    const s = normalize(String(source_raw ?? ''));
    const t = normalize(String(target_raw ?? ''));
    if (!s.ok) return reply.code(400).send({ error: `source: ${s.error}` });
    if (!t.ok) return reply.code(400).send({ error: `target: ${t.error}` });

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

  // ---- 批量导入（仅本地文件） -----------------------------------------

  /** 只允许回环地址访问上传口：文件必须来自本机工作台，不接受任何远端来源 */
  function loopbackOnly(req, reply, done) {
    const addr = req.ip;
    if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
      return reply.code(403).send({ error: '批量导入只接收本地文件（仅允许回环访问）' });
    }
    done();
  }

  app.get('/api/imports/scope', async () => ({
    supported_version: config.import.supportedVersion,
    max_bytes: config.import.maxBytes,
    allowed_origins: [...imports.allowedTargetOrigins()],
    tracker_params: config.rules.trackerParams,
  }));

  app.get('/api/imports', async () => ({ batches: await imports.listBatches() }));

  // 上传原始字节文件。format/filename/actor 通过查询参数携带，body 必须是字节。
  app.post('/api/imports', { preHandler: loopbackOnly }, async (req, reply) => {
    const format = String(req.query.format ?? '').toLowerCase();
    if (format !== 'csv' && format !== 'json') {
      return reply.code(400).send({ error: 'format 查询参数必须是 csv 或 json' });
    }
    const filename = String(req.query.filename ?? `import.${format}`);
    const actor = String(req.query.actor ?? '').trim() || '迁移团队';
    if (!Buffer.isBuffer(req.body)) {
      return reply.code(415).send({ error: '请以 application/octet-stream 上传文件原始字节' });
    }
    const result = await imports.uploadBatch(req.body, { format, filename, actor });
    if (result.batch.status === 'rejected') return reply.code(422).send(result);
    // 批次已暂存，但含有逐行错误：207 语义最贴近“多状态”，这里用 422 表达
    // “文件收下待审，但当前不可整体提交”，前端据 rows[].parse_status 逐行展示。
    if (result.batch.error_lines > 0) return reply.code(422).send(result);
    return reply.code(result.idempotent ? 200 : 201).send(result);
  });

  app.get('/api/imports/:id', async (req, reply) => {
    try {
      return await imports.getBatch(Number(req.params.id));
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code });
    }
  });

  app.get('/api/imports/:id/audit', async (req, reply) => {
    try {
      return { events: await imports.getAuditLog(Number(req.params.id)) };
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code });
    }
  });

  // 逐行选择（body: {actor, selections:[{record_no, selected}]}）
  app.post('/api/imports/:id/selection', { preHandler: loopbackOnly }, async (req, reply) => {
    try {
      const actor = String(req.body?.actor ?? '').trim() || '迁移团队';
      const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
      return await imports.setSelection(Number(req.params.id), selections, actor);
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code, ...(e.extra ?? {}) });
    }
  });

  // 冲突裁决（body: {actor, source_norm, winner_target_norm}）
  app.post('/api/imports/:id/resolve', { preHandler: loopbackOnly }, async (req, reply) => {
    try {
      const actor = String(req.body?.actor ?? '').trim() || '迁移团队';
      return await imports.resolveConflict(
        Number(req.params.id),
        String(req.body?.source_norm ?? ''),
        String(req.body?.winner_target_norm ?? ''),
        actor);
    } catch (e) {
      return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code });
    }
  });

  // 原子提交所选行
  app.post('/api/imports/:id/commit', { preHandler: loopbackOnly }, async (req, reply) => {
    try {
      const actor = String(req.body?.actor ?? '').trim() || '迁移团队';
      return await imports.commitBatch(Number(req.params.id), actor);
    } catch (e) {
      return reply.code(e.statusCode ?? 500)
        .send({ error: e.message, code: e.code, ...(e.extra ?? {}) });
    }
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
                v.mapping_revision, v.stale AS verdict_stale
           FROM url_mappings m
           LEFT JOIN verification_verdicts v ON v.source_norm=m.source_norm
          WHERE m.status='active' ORDER BY m.id`);
      for (const m of ms) {
        const evidenceStale = m.verdict_stale === true
          || (m.mapping_revision != null && m.revision !== m.mapping_revision);
        const good = (m.verdict === 'ok' || m.verdict === 'deleted_gone_ok') && !evidenceStale;
        // 计划中的最终跳转 URL：携带追踪参数的示例（取首次输入的参数）
        const { rows: ins } = await client.query(
          'SELECT source_raw FROM mapping_inputs WHERE source_norm=$1 AND excluded IS FALSE ORDER BY id LIMIT 1',
          [m.source_norm]);
        const proposed = m.mapping_type === 'deleted'
          ? null
          : carryTrackers(ins[0].source_raw, m.target_raw);
        await client.query(
          `INSERT INTO migration_plan_items (plan_id, mapping_id, item_status, evidence)
           VALUES ($1,$2,$3,$4)`,
          [planId, m.id,
           good ? 'verified' : m.verdict ? (evidenceStale ? 'pending' : 'blocked') : 'pending',
           JSON.stringify({
             verdict: m.verdict ?? null,
             issues: m.issues ?? [],
             final_status: m.final_status ?? null,
             final_url: m.final_url_raw ?? null,
             hops: m.hops ?? 0,
             tracker_preserved: m.tracker_preserved ?? null,
             proposed_redirect_url: proposed,
             mapping_revision: m.mapping_revision ?? null,
             stale: evidenceStale,
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
      `SELECT m.source_raw, pi.item_status, pi.evidence, v.stale AS verdict_stale,
              (v.mapping_revision IS NOT NULL
                AND v.mapping_revision < m.revision) AS evidence_outdated
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
         LEFT JOIN verification_verdicts v ON v.source_norm=m.source_norm
        WHERE pi.plan_id=$1 AND pi.item_status <> 'verified'`, [planId]);
    for (const b of badItems) {
      const stale = b.verdict_stale === true || b.evidence_outdated === true
        || b.evidence?.stale === true;
      blockers.push({
        source: b.source_raw,
        reason: stale
          ? '验证证据已过期：映射在验证后被改动（revision 变化），请重新验证'
          : b.item_status === 'pending'
            ? '只有映射表条目，没有当前版本的验证证据（填表不等于迁移完成）'
            : `验证未通过：${(b.evidence?.issues ?? []).join('；') || b.evidence?.verdict}`,
      });
    }

    // 防御性兜底：即便条目标着 verified，证据代次落后也不允许发布。
    const { rows: staleVerified } = await pool.query(
      `SELECT m.source_raw
         FROM migration_plan_items pi
         JOIN url_mappings m ON m.id=pi.mapping_id
         JOIN verification_verdicts v ON v.source_norm=m.source_norm
        WHERE pi.plan_id=$1 AND pi.item_status='verified'
          AND (v.stale IS TRUE OR v.mapping_revision IS DISTINCT FROM m.revision)`,
      [planId]);
    staleVerified.forEach((s) => blockers.push({
      source: s.source_raw,
      reason: '验证证据已过期：映射在验证后被改动（revision 变化），请重新验证',
    }));

    const { rows: missing } = await pool.query(
      `SELECT m.source_raw FROM url_mappings m
        WHERE m.status='active'
          AND NOT EXISTS (SELECT 1 FROM migration_plan_items pi
                           WHERE pi.mapping_id=m.id AND pi.plan_id=$1)`,
      [planId]);
    missing.forEach((m) => blockers.push({ source: m.source_raw, reason: '生效映射未纳入方案' }));

    const { rows: conflicts } = await pool.query('SELECT source_raw FROM url_mappings WHERE status=$1', ['conflicted']);
    conflicts.forEach((m) => blockers.push({ source: m.source_raw, reason: '归一化歧义未裁决' }));

    if (blockers.length) {
      return reply.code(409).send({ published: false, blockers });
    }

    const { rows } = await pool.query(
      `UPDATE migration_plans SET status='published', published_at=now()
        WHERE id=$1 RETURNING *`, [planId]);
    return { published: true, plan: rows[0] };
  });
}
