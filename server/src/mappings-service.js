/**
 * mapping_inputs（原始录入材料）-> url_mappings（生效映射）的重算。
 *
 * 采用 diff/upsert（不再 TRUNCATE 重建），因为：
 *  - 冲突键置 conflicted：不挑赢家、不静默覆盖；
 *  - 生效映射的 id 必须稳定（方案条目、导入血缘都引用它）；
 *  - 目标或状态每发生一次实质变化，version +1、updated_at 刷新；
 *  - 映射变化后，旧验证证据立即标记 stale（过期），发布闸门要求重新验证；
 *  - 键被彻底删除时，其裁决/爬取证据一并清理，方案条目随 CASCADE 移除。
 */
import { analyzeInputs } from './ambiguity.js';

export async function recomputeMappings(client) {
  const { rows: inputs } = await client.query('SELECT * FROM mapping_inputs ORDER BY id');
  const { groups, ambiguous } = analyzeInputs(inputs);
  const conflict = new Set(ambiguous.map((a) => a.source_norm));

  const { rows: existingRows } = await client.query('SELECT * FROM url_mappings');
  const existing = new Map(existingRows.map((m) => [m.source_norm, m]));

  const changedKeys = [];
  let conflictedCount = 0;

  for (const [sourceNorm, items] of groups) {
    const first = items[0];
    const newStatus = conflict.has(sourceNorm) ? 'conflicted' : 'active';
    if (newStatus === 'conflicted') conflictedCount++;
    const old = existing.get(sourceNorm);

    if (!old) {
      // 新键：version=1，没有旧证据需要标过期
      await client.query(
        `INSERT INTO url_mappings
           (source_raw, source_norm, target_raw, target_norm, mapping_type,
            status, note, version, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1,now())`,
        [first.source_raw, sourceNorm, first.target_raw, first.target_norm,
         first.mapping_type, newStatus,
         newStatus === 'conflicted' ? '同归一化键存在多个不同目标，待人工裁决' : (first.note ?? null)]);
    } else {
      const substantive =
        old.target_norm !== first.target_norm ||
        old.mapping_type !== first.mapping_type ||
        old.status !== newStatus;
      await client.query(
        `UPDATE url_mappings
            SET source_raw=$2, target_raw=$3, target_norm=$4, mapping_type=$5,
                status=$6, note=$7,
                version = version + CASE WHEN $8 THEN 1 ELSE 0 END,
                updated_at = CASE WHEN $8 THEN now() ELSE updated_at END
          WHERE id=$1`,
        [old.id, first.source_raw, first.target_raw, first.target_norm,
         first.mapping_type, newStatus,
         newStatus === 'conflicted'
           ? '同归一化键存在多个不同目标，待人工裁决'
           : (first.note ?? old.note),
         substantive]);
      if (substantive) changedKeys.push(sourceNorm);
    }
  }

  // 被删除的键：清理映射及证据；方案条目经 ON DELETE CASCADE 移除
  const removedKeys = [];
  for (const [key, m] of existing) {
    if (!groups.has(key)) removedKeys.push({ key, id: m.id });
  }
  for (const { key, id } of removedKeys) {
    await client.query('DELETE FROM url_mappings WHERE id=$1', [id]);
    await client.query('DELETE FROM crawl_results WHERE source_norm=$1', [key]);
    await client.query('DELETE FROM verification_verdicts WHERE source_norm=$1', [key]);
  }

  // 实质变化的键：旧验证证据标过期，方案条目立即降为 blocked（等重建/重新验证）
  for (const key of changedKeys) {
    await client.query(
      `UPDATE verification_verdicts
          SET stale = true
        WHERE source_norm = $1 AND stale = false`, [key]);
    await client.query(
      `UPDATE migration_plan_items pi
          SET item_status = 'blocked',
              evidence = jsonb_set(
                COALESCE(pi.evidence, '{}'::jsonb),
                '{stale}', 'true'::jsonb)
        FROM url_mappings m
       WHERE pi.mapping_id = m.id AND m.source_norm = $1
         AND pi.item_status <> 'blocked'`, [key]);
  }

  return {
    total: groups.size,
    conflicted: conflictedCount,
    changed: changedKeys.length,
    removed: removedKeys.length,
    changedKeys,
  };
}
