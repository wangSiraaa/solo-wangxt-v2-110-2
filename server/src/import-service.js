/**
 * 批量导入工作流（只处理本地文件上传来的字节）。
 *
 * 阶段：
 *   upload   解析 -> 逐行 WHATWG 规范化预览 -> 文件内/与库冲突检测 -> 暂存
 *   decide   操作者逐行选择、为冲突键显式裁决唯一目标（不自动挑赢家）
 *   commit   单个事务：写入所选 mapping_inputs、按裁决排除判负证据、
 *            重算生效映射、使受影响的旧验证证据与方案条目过期
 *
 * 纪律：
 *  - 任何一行 parse_status='error' 都让整批不可提交；
 *  - 未提交的暂存行绝不进入 mapping_inputs / url_mappings；
 *  - 相同内容摘要（sha256 字节）重复上传直接返回既有批次，不新增任何行；
 *  - 同 canonical key 不同 target 一律显式冲突，必须人工裁决。
 */
import crypto from 'node:crypto';
import { pool } from './db.js';
import { config, fixtureOrigin } from './config.js';
import { normalize, splitQuery } from './normalize.js';
import { parseImportFile } from './import-parser.js';
import { recomputeMappings } from './mappings-service.js';

const ACTION_TO_TYPE = { redirect: 'manual', delete: 'deleted' };

export function allowedTargetOrigins() {
  return new Set([fixtureOrigin(), ...config.import.allowedOrigins]);
}

export function contentDigest(buffer) {
  return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 校验一条记录的字段，返回 {ok, sourceRaw,targetRaw,mappingType,error} */
export function validateRecord(fields) {
  if (!fields) return { ok: false, code: 'bad_csv', message: 'CSV 字段结构损坏' };
  if (fields.extraColumns?.length) {
    return { ok: false, code: 'bad_csv', message: '列数多于表头（多余字段未加引号？）' };
  }
  if (fields.shapeError) {
    return { ok: false, code: 'bad_json', message: 'rows 中的元素必须是对象' };
  }
  const action = typeof fields.action === 'string' ? fields.action : undefined;
  if (!action) return { ok: false, code: 'unknown_action', message: '缺少 action（允许 redirect/delete）' };
  if (!Object.hasOwn(ACTION_TO_TYPE, action)) {
    return { ok: false, code: 'unknown_action', message: `未知动作 "${action}"（仅允许 redirect/delete）` };
  }
  const sourceRaw = typeof fields.source === 'string' ? fields.source : '';
  let targetRaw = typeof fields.target === 'string' ? fields.target : '';
  if (sourceRaw.trim() === '') return { ok: false, code: 'bad_source_url', message: 'source 为空' };

  const s = normalize(sourceRaw);
  if (!s.ok) return { ok: false, code: 'bad_source_url', message: `source 无法规范化：${s.error}` };

  if (action === 'delete') {
    // 已删除栏目没有迁移目标：target 可空，语义为旧址自身消亡（410/404）。
    if (targetRaw.trim() === '') targetRaw = sourceRaw;
    const t = normalize(targetRaw);
    if (!t.ok) return { ok: false, code: 'bad_target_url', message: `target 无法规范化：${t.error}` };
    if (t.normKey !== s.normKey) {
      return {
        ok: false,
        code: 'bad_target_url',
        message: 'delete 动作的目标必须为空（以旧址自身为消亡资源），不允许指向其它地址',
      };
    }
  } else {
    if (targetRaw.trim() === '') return { ok: false, code: 'bad_target_url', message: 'redirect 动作必须给出 target' };
    const t = normalize(targetRaw);
    if (!t.ok) return { ok: false, code: 'bad_target_url', message: `target 无法规范化：${t.error}` };
    if (!allowedTargetOrigins().has(originOf(t))) {
      return {
        ok: false,
        code: 'target_out_of_scope',
        message: `目标 ${originOf(t)} 不在允许的本地迁移范围（${[...allowedTargetOrigins()].join(', ')}）`,
      };
    }
  }

  const t = normalize(targetRaw);
  return {
    ok: true,
    sourceRaw,
    targetRaw,
    mappingType: ACTION_TO_TYPE[action],
    sourceNorm: s.normKey,
    targetNorm: t.normKey,
    normDetail: {
      href: s.href,
      pathname: s.pathname,
      identity_query: s.identityQuery,
      tracker_params: [...splitQuery(new URL(sourceRaw).search).trackers.keys()],
      target_pathname: t.pathname,
    },
  };
}

function originOf(n) {
  // normalize 结果协议固定 http/https；从 normKey 取 origin
  const u = new URL(n.normKey);
  return u.origin;
}

/* ------------------------------------------------------------- upload */

/**
 * 上传并解析为暂存批次。
 * @param {Buffer} buffer 原始字节
 * @param {{format:'csv'|'json', filename:string, actor:string}} meta
 */
export async function uploadBatch(buffer, { format, filename, actor }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw httpError(400, 'empty_file', '文件为空');
  }
  if (buffer.length > config.import.maxBytes) {
    throw httpError(413, 'file_too_large', `文件超过 ${config.import.maxBytes} 字节上限`);
  }
  const digest = contentDigest(buffer);

  // 幂等：相同字节内容直接返回既有批次（无论它处于 staged/committed/rejected）。
  const existing = await pool.query('SELECT * FROM import_batches WHERE content_digest=$1', [digest]);
  if (existing.rows.length) {
    const detail = await getBatch(existing.rows[0].id);
    return { ...detail, idempotent: true };
  }

  const parsed = parseImportFile(buffer, format);
  const rejected = !parsed.supported;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: ins } = await client.query(
      `INSERT INTO import_batches
         (content_digest, format, format_version, filename, byte_length, raw_content,
          status, parse_errors, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        digest, format, parsed.formatVersion ?? 0, filename, buffer.length, buffer,
        rejected ? 'rejected' : 'staged',
        JSON.stringify(parsed.batchErrors),
        actor,
      ],
    );
    const batchId = ins[0].id;

    let okLines = 0;
    let errorLines = 0;
    const validByKey = new Map(); // source_norm -> [{recordNo,targetNorm}]

    for (const rec of parsed.records) {
      let status = 'parsed';
      let errorCode = null;
      let errorMessage = null;
      let sourceRaw = null, targetRaw = null, mappingType = null;
      let sourceNorm = null, targetNorm = null, normDetail = null;

      if (rec.encodingError) {
        status = 'error';
        errorCode = 'bad_encoding';
        errorMessage = `第 ${rec.lineNo} 行不是合法 UTF-8 字节，已按逐字节证据保留，无法解析`;
      } else if (rec.csvError) {
        status = 'error';
        errorCode = 'bad_csv';
        errorMessage = rec.csvError === 'unterminated_quote'
          ? '引号字段未闭合'
          : '引号字段结构损坏（闭合引号后出现非法字符）';
      } else {
        const v = validateRecord(rec.fields);
        if (!v.ok) {
          status = 'error';
          errorCode = v.code;
          errorMessage = v.message;
        } else {
          sourceRaw = v.sourceRaw;
          targetRaw = v.targetRaw;
          mappingType = v.mappingType;
          sourceNorm = v.sourceNorm;
          targetNorm = v.targetNorm;
          normDetail = v.normDetail;
          if (!validByKey.has(sourceNorm)) validByKey.set(sourceNorm, []);
          validByKey.get(sourceNorm).push({ recordNo: rec.recordNo, targetNorm, targetRaw });
        }
      }

      await client.query(
        `INSERT INTO import_batch_rows
           (batch_id, line_no, end_line_no, record_no, raw_line,
            source_raw, target_raw, action, mapping_type, note,
            parse_status, error_code, error_message,
            source_norm, target_norm, norm_detail, selected)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          batchId, rec.lineNo, rec.endLineNo, rec.recordNo, rec.raw,
          sourceRaw, targetRaw, rec.fields?.action ?? null, mappingType,
          rec.fields?.note ?? null,
          status, errorCode, errorMessage,
          sourceNorm, targetNorm,
          normDetail ? JSON.stringify(normDetail) : null,
          status === 'parsed',
        ],
      );
      if (status === 'error') errorLines++; else okLines++;
    }

    // 文件内冲突：同 canonical key 且不同 target_norm。同键同目标（书写变体）不是冲突。
    const fileConflictGroups = new Map(); // source_norm -> groupNo
    let groupNo = 0;
    for (const [sourceNorm, items] of validByKey) {
      const variants = new Set(items.map((i) => i.targetNorm));
      if (variants.size > 1) {
        groupNo++;
        fileConflictGroups.set(sourceNorm, groupNo);
      }
    }
    for (const [sourceNorm, g] of fileConflictGroups) {
      await client.query(
        'UPDATE import_batch_rows SET conflict_group=$1 WHERE batch_id=$2 AND source_norm=$3',
        [g, batchId, sourceNorm]);
    }

    // 与当前库冲突：库中已存在该 canonical key，且新行带来任何一个库里没有的
    // target_norm —— 不自动挑赢家。比较范围含 excluded=true 的判负证据：
    // 重新纳入旧目标必须再显式裁决一次，不能悄悄翻案。
    if (validByKey.size) {
      const keys = [...validByKey.keys()];
      const { rows: current } = await client.query(
        `SELECT source_norm, target_norm FROM mapping_inputs
          WHERE source_norm = ANY($1)`, [keys]);
      const currentByKey = new Map();
      for (const c of current) {
        if (!currentByKey.has(c.source_norm)) currentByKey.set(c.source_norm, new Set());
        currentByKey.get(c.source_norm).add(c.target_norm);
      }
      for (const [sourceNorm, items] of validByKey) {
        const have = currentByKey.get(sourceNorm);
        if (!have) continue;
        const incoming = new Set(items.map((i) => i.targetNorm));
        const differs = [...incoming].some((t) => !have.has(t));
        if (differs) {
          await client.query(
            `UPDATE import_batch_rows SET conflicted_with_current=TRUE
              WHERE batch_id=$1 AND source_norm=$2`,
            [batchId, sourceNorm]);
        }
      }
    }

    await client.query(
      `UPDATE import_batches
          SET total_lines=$2, ok_lines=$3, error_lines=$4,
              selected_count=(SELECT count(*) FROM import_batch_rows
                               WHERE batch_id=$1 AND parse_status='parsed' AND selected)
        WHERE id=$1`,
      [batchId, parsed.records.length, okLines, errorLines]);

    await audit(client, batchId, 'uploaded', actor, {
      filename, format, total: parsed.records.length, ok_lines: okLines, error_lines: errorLines,
      rejected,
    });
    await client.query('COMMIT');
    return getBatch(batchId);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------- queries */

export async function listBatches() {
  const { rows } = await pool.query(
    `SELECT id, content_digest, format, format_version, filename, byte_length, status,
            total_lines, ok_lines, error_lines, selected_count, committed_count,
            committed_by, committed_at, created_by, created_at
       FROM import_batches ORDER BY id DESC`);
  return rows;
}

export async function getBatch(batchId) {
  const { rows: batches } = await pool.query('SELECT * FROM import_batches WHERE id=$1', [batchId]);
  if (!batches.length) throw httpError(404, 'not_found', '批次不存在');
  const batch = batches[0];
  // 原始字节仅服务端留存（审计/重新解析），不随 API 响应下发（逐行原文已在行内）。
  delete batch.raw_content;
  batch.parse_errors = batch.parse_errors ?? [];
  const { rows: rows_ } = await pool.query(
    `SELECT r.*,
            (SELECT json_agg(json_build_object('target_raw', target_raw,
                                               'target_norm', target_norm,
                                               'mapping_type', mapping_type,
                                               'record_no', record_no))
               FROM import_batch_rows x WHERE x.batch_id=r.batch_id
                 AND x.source_norm=r.source_norm AND x.parse_status='parsed') AS file_candidates,
            (SELECT json_agg(json_build_object('source_raw', source_raw,
                                               'target_raw', target_raw,
                                               'target_norm', target_norm,
                                               'mapping_type', mapping_type,
                                               'input_id', id))
               FROM mapping_inputs mi WHERE mi.source_norm=r.source_norm
                 AND mi.excluded IS FALSE) AS current_candidates
       FROM import_batch_rows r WHERE r.batch_id=$1 ORDER BY r.record_no`,
    [batchId],
  );
  // 去重候选（每个 source_norm 只附一次）
  const seen = new Set();
  const rowsOut = rows_.map((r) => {
    const { file_candidates, current_candidates, ...rest } = r;
    if (seen.has(r.source_norm)) return { ...rest, file_candidates: null, current_candidates: null };
    seen.add(r.source_norm);
    return { ...rest, file_candidates, current_candidates };
  });
  const { rows: resolutions } = await pool.query(
    'SELECT source_norm, winner_target_norm, decided_by, decided_at FROM import_resolutions WHERE batch_id=$1',
    [batchId]);
  return { batch, rows: rowsOut, resolutions };
}

/* ------------------------------------------------------------- decide */

/** 逐行更新操作者选择（仅 staged 批次；error 行不可选） */
export async function setSelection(batchId, selections, actor) {
  const { rows: batches } = await pool.query('SELECT * FROM import_batches WHERE id=$1', [batchId]);
  if (!batches.length) throw httpError(404, 'not_found', '批次不存在');
  if (batches[0].status !== 'staged') {
    throw httpError(409, 'batch_not_staged', `批次已 ${batches[0].status}，选择不可再改`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sel of selections) {
      const { rows: r } = await client.query(
        `UPDATE import_batch_rows SET selected=$3
          WHERE batch_id=$1 AND record_no=$2 AND parse_status='parsed' RETURNING id`,
        [batchId, sel.record_no, Boolean(sel.selected)]);
      if (!r.length) {
        throw httpError(400, 'row_not_selectable',
          `记录 #${sel.record_no} 不存在或为损坏行，不能选择`);
      }
    }
    await client.query(
      `UPDATE import_batches SET selected_count=(
         SELECT count(*) FROM import_batch_rows WHERE batch_id=$1 AND parse_status='parsed' AND selected)
       WHERE id=$1`, [batchId]);
    await audit(client, batchId, 'updated_selection', actor, { count: selections.length });
    await client.query('COMMIT');
    return getBatch(batchId);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 为冲突键显式裁决唯一胜出 target_norm（文件内或与库冲突）。
 * 幂等：同一批次同一键再次裁决会覆盖（记录决策轨迹）。
 */
export async function resolveConflict(batchId, sourceNorm, winnerTargetNorm, actor) {
  const { rows: batches } = await pool.query('SELECT * FROM import_batches WHERE id=$1', [batchId]);
  if (!batches.length) throw httpError(404, 'not_found', '批次不存在');
  if (batches[0].status !== 'staged') {
    throw httpError(409, 'batch_not_staged', `批次已 ${batches[0].status}，裁决不可再改`);
  }
  const { rows: winnerRows } = await pool.query(
    `SELECT DISTINCT target_norm FROM import_batch_rows
      WHERE batch_id=$1 AND source_norm=$2 AND parse_status='parsed'`,
    [batchId, sourceNorm]);
  const winnerOptions = new Set(winnerRows.map((r) => r.target_norm));
  const { rows: cur } = await pool.query(
    'SELECT DISTINCT target_norm FROM mapping_inputs WHERE source_norm=$1 AND excluded IS FALSE',
    [sourceNorm]);
  for (const c of cur) winnerOptions.add(c.target_norm);

  if (!winnerOptions.has(winnerTargetNorm)) {
    throw httpError(400, 'invalid_winner', '胜出目标必须是该冲突键的某个候选 target_norm');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO import_resolutions (batch_id, source_norm, winner_target_norm, decided_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (batch_id, source_norm)
       DO UPDATE SET winner_target_norm=EXCLUDED.winner_target_norm,
                     decided_by=EXCLUDED.decided_by, decided_at=now()`,
      [batchId, sourceNorm, winnerTargetNorm, actor]);
    // 裁决结果同步到逐行选择：非胜出目标的行自动取消选择。
    await client.query(
      `UPDATE import_batch_rows SET selected = (target_norm = $3)
        WHERE batch_id=$1 AND source_norm=$2 AND parse_status='parsed'`,
      [batchId, sourceNorm, winnerTargetNorm]);
    await client.query(
      `UPDATE import_batches SET selected_count=(
         SELECT count(*) FROM import_batch_rows WHERE batch_id=$1 AND parse_status='parsed' AND selected)
       WHERE id=$1`, [batchId]);
    await audit(client, batchId, 'resolved', actor, { source_norm: sourceNorm, winner_target_norm: winnerTargetNorm });
    await client.query('COMMIT');
    return getBatch(batchId);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------- commit */

export async function commitBatch(batchId, actor) {
  const { rows: batches } = await pool.query('SELECT * FROM import_batches WHERE id=$1', [batchId]);
  if (!batches.length) throw httpError(404, 'not_found', '批次不存在');
  const batch = batches[0];
  if (batch.status === 'committed') {
    return { idempotent: true, committed_count: batch.committed_count, batch: (await getBatch(batchId)).batch };
  }
  if (batch.status === 'rejected') {
    throw httpError(409, 'batch_rejected', '批次被整批拒绝（版本不支持或文件无法解析），不能提交');
  }

  const { rows: allRows } = await pool.query(
    'SELECT * FROM import_batch_rows WHERE batch_id=$1 ORDER BY record_no', [batchId]);
  const errorRows = allRows.filter((r) => r.parse_status === 'error');
  if (errorRows.length) {
    throw httpError(409, 'rows_invalid',
      `存在 ${errorRows.length} 行损坏，整批不可提交（未提交数据不影响生效映射）`,
      { error_records: errorRows.map((r) => ({ record_no: r.record_no, line_no: r.line_no, code: r.error_code, message: r.error_message })) });
  }

  const selected = allRows.filter((r) => r.selected);
  const selectedKeys = new Set(selected.map((r) => r.source_norm));

  // 所有“被选择行涉及的冲突键”都必须已有显式裁决
  const conflictedKeys = new Set(
    allRows.filter((r) => r.conflict_group != null || r.conflicted_with_current).map((r) => r.source_norm),
  );
  const { rows: resRows } = await pool.query(
    'SELECT source_norm, winner_target_norm FROM import_resolutions WHERE batch_id=$1', [batchId]);
  const resolutions = new Map(resRows.map((r) => [r.source_norm, r.winner_target_norm]));

  const unresolved = [];
  for (const key of selectedKeys) {
    if (conflictedKeys.has(key) && !resolutions.has(key)) {
      unresolved.push(key);
    }
  }
  if (unresolved.length) {
    throw httpError(409, 'unresolved_conflicts',
      `${unresolved.length} 个冲突键尚未人工裁决，不能提交`, { unresolved });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) 按裁决把该键“非胜出目标”的全部库证据标记判负（保留行）。
    //    只置 excluded=true，从不把已判负行改回 false——重新翻案必须再走一次裁决
    //    （下一次上传该目标会因与库证据不同而再次成为显式冲突）。
    for (const [sourceNorm, winnerNorm] of resolutions) {
      if (!selectedKeys.has(sourceNorm)) continue;
      await client.query(
        `UPDATE mapping_inputs
            SET excluded=TRUE,
                excluded_reason=COALESCE(excluded_reason, $3),
                excluded_by=$4, excluded_at=now()
          WHERE source_norm=$1 AND target_norm <> $2 AND excluded IS FALSE`,
        [sourceNorm, winnerNorm, `导入批次 #${batchId} 冲突裁决判负`, actor]);
    }

    // 2) 写入所选行。判负的暂存行不写库；与库“未排除证据”三要素完全相同
    //    （source_raw/target_raw/mapping_type）的行不重复插入；
    //    被排除的旧证据原文即使再次出现也会作为新证据插入（显式翻案的结果）。
    let inserted = 0;
    for (const r of selected) {
      const winnerNorm = resolutions.get(r.source_norm);
      if (conflictedKeys.has(r.source_norm) && winnerNorm && r.target_norm !== winnerNorm) continue;

      const { rowCount } = await client.query(
        `INSERT INTO mapping_inputs
           (source_raw, source_norm, target_raw, target_norm, mapping_type, note,
            import_batch_id)
         SELECT $1,$2,$3,$4,$5,$6,$7
        WHERE NOT EXISTS (
           SELECT 1 FROM mapping_inputs
            WHERE source_raw=$1 AND target_raw=$3 AND mapping_type=$5
              AND excluded IS FALSE)`,
        [r.source_raw, r.source_norm, r.target_raw, r.target_norm,
         r.mapping_type, r.note, batchId]);
      inserted += rowCount;
    }

    // 3) 重算生效映射（基于未排除证据），并标记旧验证证据过期
    const recompute = await recomputeMappings(client);

    // 4) 批次落账
    await client.query(
      `UPDATE import_batches
          SET status='committed', committed_count=$2, committed_by=$3, committed_at=now()
        WHERE id=$1`,
      [batchId, inserted, actor]);
    await audit(client, batchId, 'committed', actor, {
      inserted, affected_keys: [...selectedKeys], conflicted: [...conflictedKeys].filter((k) => selectedKeys.has(k)),
    });
    await client.query('COMMIT');
    return { committed_count: inserted, ...recompute, batch: (await getBatch(batchId)).batch };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------- helpers */

async function audit(client, batchId, event, actor, detail) {
  await client.query(
    'INSERT INTO import_audit_log (batch_id, event, actor, detail) VALUES ($1,$2,$3,$4)',
    [batchId, event, actor, JSON.stringify(detail ?? {})]);
}

export async function getAuditLog(batchId) {
  const { rows } = await pool.query(
    'SELECT id, batch_id, event, actor, detail, at FROM import_audit_log WHERE batch_id=$1 ORDER BY id',
    [batchId]);
  return rows;
}

function httpError(status, code, message, extra = undefined) {
  const e = new Error(message);
  e.statusCode = status;
  e.code = code;
  if (extra) e.extra = extra;
  return e;
}
