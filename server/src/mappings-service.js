/**
 * mapping_inputs（原始录入材料）-> url_mappings（生效映射）的重算。
 * 冲突键置 conflicted：不挑赢家、不静默覆盖。
 *
 * 裁决：mapping_inputs.excluded=true 的证据（人工判负）保留在表中用于审计，
 * 但不参与重算，也不参与歧义判定（视图 mapping_ambiguities 同样过滤）。
 *
 * 证据过期：revision 记录每个键“目标内容”的代次。目标（target_norm）或状态
 * 发生变化时 revision+1，此前的 verification_verdicts 标 stale，方案条目退回
 * pending/blocked——填表不等于迁移完成，改了映射必须重新验证。
 */
import { analyzeInputs } from './ambiguity.js';

/**
 * @param {import('pg').PoolClient} client
 * @returns {Promise<{conflicted:number,total:number,changedKeys:string[],
 *                    staleVerdicts:number,stalePlanItems:number}>}
 */
export async function recomputeMappings(client) {
  const { rows } = await client.query(
    'SELECT * FROM mapping_inputs WHERE excluded IS FALSE ORDER BY id');
  const { groups, ambiguous } = analyzeInputs(rows);
  const conflict = new Set(ambiguous.map((a) => a.source_norm));

  const { rows: old } = await client.query('SELECT * FROM url_mappings');
  const oldByKey = new Map(old.map((m) => [m.source_norm, m]));

  const changedKeys = [];
  const newKeys = new Set(groups.keys());

  for (const [sourceNorm, items] of groups) {
    const first = items[0];
    const status = conflict.has(sourceNorm) ? 'conflicted' : 'active';
    const prev = oldByKey.get(sourceNorm);

    if (prev) {
      if (prev.target_norm !== first.target_norm || prev.status !== status) {
        changedKeys.push(sourceNorm);
        await client.query(
          `UPDATE url_mappings
              SET source_raw=$2, target_raw=$3, target_norm=$4,
                  mapping_type=$5, status=$6, note=$7, revision=revision+1
            WHERE id=$1`,
          [prev.id, first.source_raw, first.target_raw, first.target_norm,
           first.mapping_type, status, first.note ?? null]);
      }
    } else {
      changedKeys.push(sourceNorm);
      const { rows: ins } = await client.query(
        `INSERT INTO url_mappings
           (source_raw, source_norm, target_raw, target_norm, mapping_type, status, note, revision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,1) RETURNING id`,
        [first.source_raw, sourceNorm, first.target_raw, first.target_norm,
         first.mapping_type, status, first.note ?? null]);
      void ins;
    }
  }

  // 消失的键：先删引用它的方案条目（FK 无 ON DELETE CASCADE），
  // 再删其验证裁决/逐跳证据（不残留结论），最后删生效映射。
  const removedKeys = [...oldByKey.keys()].filter((k) => !newKeys.has(k));
  if (removedKeys.length) {
    await client.query(
      `DELETE FROM migration_plan_items
        WHERE mapping_id IN (SELECT id FROM url_mappings WHERE source_norm = ANY($1))`,
      [removedKeys]);
    await client.query('DELETE FROM verification_verdicts WHERE source_norm = ANY($1)', [removedKeys]);
    await client.query('DELETE FROM crawl_results WHERE source_norm = ANY($1)', [removedKeys]);
    await client.query('DELETE FROM url_mappings WHERE source_norm = ANY($1)', [removedKeys]);
    changedKeys.push(...removedKeys);
  }

  // 旧验证证据：映射仍在、但证据代次落后（或历史证据未记录代次）-> stale；
  // 消失键的证据由调用方/验证器清理，不残留结论。
  let staleVerdicts = 0;
  let stalePlanItems = 0;
  if (changedKeys.length) {
    const staleRes = await client.query(
      `UPDATE verification_verdicts v
          SET stale=TRUE
        FROM url_mappings m
       WHERE v.source_norm = m.source_norm
         AND v.source_norm = ANY($1)
         AND v.stale IS FALSE
         AND (v.mapping_revision IS NULL OR v.mapping_revision < m.revision)`,
      [changedKeys]);
    staleVerdicts = staleRes.rowCount;

    // 方案条目：verified 但证据已过期 -> pending（必须重新验证才能再发布）。
    const piRes = await client.query(
      `UPDATE migration_plan_items pi
          SET item_status='pending',
              evidence = jsonb_set(
                CASE WHEN coalesce(jsonb_typeof(evidence),'object')='object' THEN evidence ELSE '{}'::jsonb END,
                '{stale}', 'true'::jsonb)
        WHERE pi.item_status='verified'
          AND pi.mapping_id IN (
            SELECT m.id FROM url_mappings m
              JOIN verification_verdicts v ON v.source_norm=m.source_norm
             WHERE m.source_norm = ANY($1) AND v.stale IS TRUE)`,
      [changedKeys]);
    stalePlanItems = piRes.rowCount;
  }

  return {
    conflicted: conflict.size,
    total: groups.size,
    changedKeys,
    staleVerdicts,
    stalePlanItems,
  };
}

/**
 * 同步某个键在全部未发布方案中的条目状态/证据（验证器跑完后调用）。
 * 已发布方案冻结，不回改。
 */
export async function syncPlanEvidence(client, { sourceNorm, verdict, issues, finalStatus,
  finalUrlRaw, hops, tracker, revision, stale }) {
  const good = verdict === 'ok' || verdict === 'deleted_gone_ok';
  const newStatus = good ? 'verified' : verdict ? 'blocked' : 'pending';
  // 证据代次落后时即使裁决 ok 也不能回到 verified，必须按当前 revision 重新验证
  const effectiveStatus = newStatus === 'verified' && stale ? 'pending' : newStatus;
  const evidencePatch = JSON.stringify({
    verdict: verdict ?? null,
    issues: issues ?? [],
    final_status: finalStatus ?? null,
    final_url: finalUrlRaw ?? null,
    hops: hops ?? 0,
    tracker_preserved: tracker ? tracker.ok : null,
    mapping_revision: revision ?? null,
    stale: Boolean(stale),
  });
  await client.query(
    `UPDATE migration_plan_items pi
        SET item_status = $3,
            evidence = pi.evidence || $4::jsonb
       FROM url_mappings m, migration_plans p
      WHERE pi.mapping_id = m.id
        AND pi.plan_id = p.id
        AND m.source_norm = $1
        AND p.status <> 'published'
        AND ($2::boolean IS FALSE OR pi.item_status <> 'verified')`,
    [sourceNorm, false, effectiveStatus, evidencePatch]);
}
