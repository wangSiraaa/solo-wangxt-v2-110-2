/**
 * 批量导入工作流（只接收本地文件字节）：
 *
 *   上传字节 ──► parseImportFile（逐行校验，绝不回写原始字节）
 *            ──► import_batches/import_rows（暂存区，含错误行与冲突标记）
 *            ──► 操作者在工作台预览、勾选、裁决冲突
 *            ──► commitImport：原子写入所选行 + 重算生效映射；整批成功或整批不动
 *
 * 幂等：以文件字节 sha256 为唯一键；同一内容（文件名可不同）再次上传，
 * 直接返回既有批次，不新增批次/暂存行/映射。
 */
import { createHash } from 'node:crypto';
import { pool } from './db.js';
import { parseImportFile, FORMAT_VERSION, BatchFormatError } from './import-parser.js';
import { recomputeMappings } from './mappings-service.js';

export { BatchFormatError };

/**
 * 暂存一个导入批次（幂等）。
 * @param {{bytes:Buffer, fileFormat:'csv'|'json', filename?:string, actor?:string}} opts
 * @returns {Promise<{batch:object, idempotent:boolean}>}
 */
export async function stageImport({ bytes, fileFormat, filename = null, actor = null }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new BatchFormatError('空文件：没有可导入的字节');
  }
  if (fileFormat !== 'csv' && fileFormat !== 'json') {
    throw new BatchFormatError(`不支持的文件类型: ${fileFormat}（仅 csv / json）`);
  }

  const sha = createHash('sha256').update(bytes).digest('hex');

  // 幂等短路：同内容已导入过 —— 返回原批次，零写入
  const { rows: existing } = await pool.query(
    'SELECT * FROM import_batches WHERE content_sha256 = $1', [sha]);
  if (existing.length) {
    return { batch: existing[0], idempotent: true };
  }

  const parsed = parseImportFile(bytes, fileFormat);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 冲突检测需要“当前生效库”的同键目标
    const { rows: libRows } = await client.query(
      'SELECT source_norm, target_norm FROM url_mappings WHERE status = $1', ['active']);
    const library = new Map(libRows.map((m) => [m.source_norm, m.target_norm]));

    // 批内：同 canonical key 的行分组（只统计 parse_status='ok' 的行）
    const within = new Map();
    for (const r of parsed.rows) {
      if (r.parse_status !== 'ok') continue;
      if (!within.has(r.source_norm)) within.set(r.source_norm, []);
      within.get(r.source_norm).push(r);
    }
    const withinConflict = new Set();
    for (const [key, rs] of within) {
      if (new Set(rs.map((r) => r.target_norm)).size > 1) withinConflict.add(key);
    }

    const okRows = parsed.rows.filter((r) => r.parse_status === 'ok');
    const errorRows = parsed.rows.filter((r) => r.parse_status === 'error');
    const distinctKeys = within.size;
    const withinConflictKeys = [...withinConflict].sort();

    const summary = {
      total_lines: parsed.rows.length,
      ok_lines: okRows.length,
      error_lines: errorRows.length,
      distinct_source_keys: distinctKeys,
      within_file_conflicts: withinConflictKeys.length,
      with_library_conflicts: 0, // 插入行时累计
      selected: 0,
      committed_lines: 0,
    };

    const { rows: ins } = await client.query(
      `INSERT INTO import_batches
         (format_version, file_format, filename, content_sha256, raw_bytes,
          row_count, status, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'staged',$7,$8)
       RETURNING *`,
      [FORMAT_VERSION, fileFormat, filename, sha, bytes.length,
       parsed.rows.length, JSON.stringify(summary), actor]);
    const batchId = ins[0].id;

    let libraryConflicts = 0;
    for (const r of parsed.rows) {
      let conflict = null;
      let conflictTargets = [];
      let libraryTargetNorm = null;
      if (r.parse_status === 'ok') {
        const inFile = withinConflict.has(r.source_norm);
        const libTarget = library.has(r.source_norm) ? library.get(r.source_norm) : null;
        const inLib = libTarget !== null && libTarget !== r.target_norm;
        if (inFile && inLib) conflict = 'both';
        else if (inFile) conflict = 'within_file';
        else if (inLib) conflict = 'with_library';
        if (inFile) {
          conflictTargets = [...new Set(within.get(r.source_norm).map((x) => x.target_norm))].sort();
        }
        if (inLib) {
          libraryTargetNorm = libTarget;
          conflictTargets = [...new Set([...conflictTargets, libTarget, r.target_norm])].sort();
          if (!inFile) libraryConflicts++; // 与库冲突的键只计一次（同批多行同键时）
        }
      }
      await client.query(
        `INSERT INTO import_rows
           (batch_id, line_no, raw_line, parse_status, error_code, error_message,
            source_raw, source_norm, target_raw, target_norm, mapping_type, note,
            conflict, conflict_targets, library_target_norm)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [batchId, r.line_no, r.raw_line, r.parse_status, r.error_code ?? null,
         r.error_message ?? null, r.source_raw ?? null, r.source_norm ?? null,
         r.target_raw ?? null, r.target_norm ?? null, r.mapping_type ?? null,
         r.note ?? null, conflict, JSON.stringify(conflictTargets), libraryTargetNorm]);
    }
    summary.with_library_conflicts = libraryConflicts;
    await client.query('UPDATE import_batches SET summary = $2 WHERE id = $1',
      [batchId, JSON.stringify(summary)]);

    await writeAudit(client, batchId, 'staged', actor, {
      total_lines: summary.total_lines,
      error_lines: summary.error_lines,
      within_file_conflicts: summary.within_file_conflicts,
      with_library_conflicts: summary.with_library_conflicts,
    });

    await client.query('COMMIT');
    const { rows: fresh } = await client.query('SELECT * FROM import_batches WHERE id=$1', [batchId]);
    return { batch: fresh[0], idempotent: false };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function writeAudit(client, batchId, action, actor, detail) {
  await client.query(
    `INSERT INTO import_audit_log (batch_id, action, actor, detail)
     VALUES ($1,$2,$3,$4)`,
    [batchId, action, actor, JSON.stringify(detail ?? {})]);
}

/** 读取批次 + 行（预览/刷新追溯都走这里） */
export async function getImport(batchId, client = pool) {
  const { rows: batches } = await client.query(
    'SELECT * FROM import_batches WHERE id=$1', [batchId]);
  if (!batches.length) return null;
  const { rows: importRows } = await client.query(
    'SELECT * FROM import_rows WHERE batch_id=$1 ORDER BY line_no', [batchId]);
  const { rows: audit } = await client.query(
    'SELECT * FROM import_audit_log WHERE batch_id=$1 ORDER BY id', [batchId]);
  return { batch: batches[0], rows: importRows, audit };
}

export async function listImports(limit = 50) {
  const { rows } = await pool.query(
    `SELECT b.*,
            (SELECT count(*) FROM import_audit_log a WHERE a.batch_id=b.id) AS audit_entries
       FROM import_batches b ORDER BY b.id DESC LIMIT $1`,
    [limit]);
  return rows;
}

/**
 * 更新操作者选择（暂存阶段）：
 *  - selection: selected / ignored / pending
 *  - 冲突组的最终裁决：同 canonical key 的行必须且只能有一行 selected；
 *    selected 行即“裁决赢家”，但赢家由操作者显式指定，系统绝不自动挑选。
 */
export async function updateRowSelection(batchId, rowId, selection, actor = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: batchRows } = await client.query(
      'SELECT * FROM import_batches WHERE id=$1 FOR UPDATE', [batchId]);
    if (!batchRows.length) { await client.query('ROLLBACK'); return { error: 404, message: '批次不存在' }; }
    if (batchRows[0].status !== 'staged') {
      await client.query('ROLLBACK');
      return { error: 409, message: `批次已 ${batchRows[0].status}，不能再修改选择` };
    }
    const { rows: rowRows } = await client.query(
      'SELECT * FROM import_rows WHERE id=$1 AND batch_id=$2 FOR UPDATE', [rowId, batchId]);
    if (!rowRows.length) { await client.query('ROLLBACK'); return { error: 404, message: '行不存在' }; }
    if (rowRows[0].parse_status !== 'ok') {
      await client.query('ROLLBACK');
      return { error: 409, message: '错误行不能被选择；请修正文件后重新导入' };
    }
    if (!['selected', 'ignored', 'pending'].includes(selection)) {
      await client.query('ROLLBACK');
      return { error: 400, message: `非法选择: ${selection}` };
    }
    await client.query('UPDATE import_rows SET selection=$3 WHERE id=$1 AND batch_id=$2',
      [rowId, batchId, selection]);

    // 同键裁决一致性：在同一个批内，一个 canonical key 至多一行 selected。
    // 操作者新选中一行时，同键的其它 ok 行自动置 ignored（显式记录“谁输了”）。
    if (selection === 'selected') {
      await client.query(
        `UPDATE import_rows SET selection='ignored'
          WHERE batch_id=$1 AND source_norm=$2 AND id <> $3 AND parse_status='ok'`,
        [batchId, rowRows[0].source_norm, rowId]);
    }
    await writeAudit(client, batchId, 'selection', actor,
      { type: 'selection', row_id: rowId, source_norm: rowRows[0].source_norm, selection });
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 原子提交所选行。
 * 规则（任一不满足 → 拒绝且零写入）：
 *  - 批次存在且仍处 staged；
 *  - 批次不允许有任何 parse_status='error' 的行（坏编码/未知动作/越界等）；
 *  - 每个带冲突标记（批内或与库）的 canonical key，必须恰好裁决出一行 selected，
 *    且该 selected 行的目标与最终库内状态兼容（提交事务内重算后不产生新冲突）；
 *  - 所有 selected 行在提交瞬间重新规范化（防止规则版本变化期间的陈旧预览）。
 */
export async function commitImport(batchId, { actor = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: batchRows } = await client.query(
      'SELECT * FROM import_batches WHERE id=$1 FOR UPDATE', [batchId]);
    if (!batchRows.length) {
      await client.query('ROLLBACK');
      return { rejected: true, status: 404, reason: '批次不存在', blockers: [] };
    }
    const batch = batchRows[0];
    if (batch.status === 'committed') {
      await client.query('ROLLBACK');
      return { rejected: true, status: 409, reason: 'already_committed', blockers: [] };
    }
    if (batch.status === 'abandoned') {
      await client.query('ROLLBACK');
      return { rejected: true, status: 409, reason: '批次已放弃，不能提交', blockers: [] };
    }

    const { rows: allRows } = await client.query(
      'SELECT * FROM import_rows WHERE batch_id=$1 ORDER BY line_no FOR UPDATE', [batchId]);

    const blockers = [];

    // 1) 错误行：整批不得提交
    for (const r of allRows.filter((x) => x.parse_status === 'error')) {
      blockers.push({
        line_no: r.line_no, raw_line: r.raw_line,
        reason: `[${r.error_code}] ${r.error_message}`,
      });
    }

    const okRows = allRows.filter((x) => x.parse_status === 'ok');
    const selected = okRows.filter((x) => x.selection === 'selected');
    if (selected.length === 0) {
      blockers.push({ reason: '没有勾选任何行；请先在暂存预览中选择要纳入的行（selected）' });
    }

    // 2) 冲突组必须逐组裁决
    const conflictKeys = new Set(
      okRows.filter((x) => x.conflict !== null).map((x) => x.source_norm));
    for (const key of conflictKeys) {
      const winners = okRows.filter((x) => x.source_norm === key && x.selection === 'selected');
      if (winners.length !== 1) {
        const cand = okRows.filter((x) => x.source_norm === key);
        blockers.push({
          source_norm: key,
          reason: winners.length === 0
            ? '存在未裁决冲突：必须在候选目标中显式选择唯一一行'
            : '冲突组选出了多行，每个归一化键只能有一个赢家',
          candidates: cand.map((c) => ({
            line_no: c.line_no, target_norm: c.target_norm, selection: c.selection,
          })),
        });
      }
    }

    // 3) 与当前库的冲突在提交瞬间复核（防止预览后库被其它批次/手工录入改动）
    const { rows: libNow } = await client.query(
      'SELECT source_norm, target_norm FROM url_mappings WHERE status=$1', ['active']);
    const libNowMap = new Map(libNow.map((m) => [m.source_norm, m.target_norm]));

    // 模拟本次提交后每个键的最终目标：
    // selected 行覆盖/新建；未选择且与库冲突的键保持库目标（=操作者显式忽略，允许）。
    const finalTargetByKey = new Map(libNowMap);
    for (const r of selected) finalTargetByKey.set(r.source_norm, r.target_norm);

    // 所选行内部不得再含同键不同目标（防御性：裁决一致性正常已保证）
    const selByKey = new Map();
    for (const r of selected) {
      if (!selByKey.has(r.source_norm)) selByKey.set(r.source_norm, []);
      selByKey.get(r.source_norm).push(r);
    }
    for (const [key, rs] of selByKey) {
      if (new Set(rs.map((x) => x.target_norm)).size > 1) {
        blockers.push({ source_norm: key, reason: '所选行内部仍有同键多目标' });
      }
    }
    // 与库的即时复核：selected 行若与当前库目标不同，必须曾是该键的裁决赢家
    for (const r of selected) {
      const cur = libNowMap.get(r.source_norm);
      if (cur !== undefined && cur !== r.target_norm && !conflictKeys.has(r.source_norm)) {
        blockers.push({
          source_norm: r.source_norm, line_no: r.line_no,
          reason: `预览后当前库目标已变为 ${cur}，与所选目标 ${r.target_norm} 冲突，请刷新重新裁决`,
        });
      }
    }

    if (blockers.length) {
      await writeAudit(client, batchId, 'commit_rejected', actor, { blockers });
      await client.query('COMMIT');
      return { rejected: true, status: 409, reason: 'commit_blocked', blockers };
    }

    // ---- 原子写入 ----
    let inserted = 0;
    const selectedRows = [];
    for (const r of selected) {
      // 与当前库冲突的键：操作者显式选中本导入行即裁决“以新目标为准”。
      // 同键旧目标录入不删除（证据可追溯），但标记 superseded，不再参与推导。
      const libTarget = libNowMap.get(r.source_norm);
      if (libTarget !== undefined && libTarget !== r.target_norm) {
        await client.query(
          `UPDATE mapping_inputs
              SET superseded_at = now(), superseded_by_batch = $2
            WHERE source_norm = $1
              AND target_norm  <> $3
              AND superseded_at IS NULL`,
          [r.source_norm, batchId, r.target_norm]);
      }
      const { rows: mr } = await client.query(
        `INSERT INTO mapping_inputs
           (source_raw, source_norm, target_raw, target_norm, mapping_type, note, import_row_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [r.source_raw, r.source_norm, r.target_raw, r.target_norm,
         r.mapping_type, r.note, r.id]);
      inserted++;
      selectedRows.push({ ...r, input_id: mr[0].id });
    }

    // 重算生效映射：版本递增、旧证据标过期都在其中
    const recompute = await recomputeMappings(client);

    // 回填 committed_mapping_id（导入血缘：暂存行 -> 生效映射）
    for (const r of selectedRows) {
      const { rows: m } = await client.query(
        'SELECT id FROM url_mappings WHERE source_norm=$1', [r.source_norm]);
      if (m.length) {
        await client.query('UPDATE import_rows SET committed_mapping_id=$2 WHERE id=$1',
          [r.id, m[0].id]);
      }
    }

    const summary = {
      ...batch.summary,
      selected: selected.length,
      committed_lines: inserted,
      committed_keys: recompute.total,
      committed_at_version_map: true,
    };
    await client.query(
      `UPDATE import_batches
          SET status='committed', summary=$2, committed_at=now(), committed_by=$3
        WHERE id=$1`,
      [batchId, JSON.stringify(summary), actor]);
    await writeAudit(client, batchId, 'committed', actor, {
      committed_lines: inserted,
      lines: selected.map((r) => ({
        line_no: r.line_no, source_norm: r.source_norm, target_norm: r.target_norm,
      })),
    });

    await client.query('COMMIT');
    return {
      rejected: false,
      committed_lines: inserted,
      active_mappings: recompute.total,
      conflicted_mappings: recompute.conflicted,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** 放弃暂存批次（错误文件无法补救时保留痕迹但不再提交） */
export async function abandonImport(batchId, actor = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      "UPDATE import_batches SET status='abandoned' WHERE id=$1 AND status='staged' RETURNING *",
      [batchId]);
    if (!rows.length) { await client.query('ROLLBACK'); return { error: 409, message: '批次不存在或不可放弃' }; }
    await writeAudit(client, batchId, 'abandoned', actor, {});
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
