/**
 * 验证流水线：对每条生效映射真实请求本地站点，
 * 保存每一跳证据（crawl_results）与最终裁决（verification_verdicts）。
 * 冲突键不请求，直接判 ambiguity —— 连请求都不应该开始。
 */
import { pool } from './db.js';
import { normalize } from './normalize.js';
import { judge } from './verifier.js';

const VERDICT_LABEL = {
  ok: '通过',
  redirect_loop: '重定向环',
  chain_too_long: '跳转链过长',
  fetch_error: '请求被拒/失败',
  deleted_gone_ok: '已删除-状态正确',
  deleted_not_gone: '已删除但未消亡',
  ambiguity: '归一化歧义',
  final_status_bad: '最终页状态异常',
};

export async function runVerification({ onlyKey = null } = {}) {
  if (!onlyKey) {
    // 清理已不在 url_mappings 中的旧裁决与爬取证据（映射被剔除后不得残留结论）
    await pool.query(
      `DELETE FROM verification_verdicts v
        WHERE NOT EXISTS (SELECT 1 FROM url_mappings m WHERE m.source_norm = v.source_norm)`);
    await pool.query(
      `DELETE FROM crawl_results c
        WHERE NOT EXISTS (SELECT 1 FROM url_mappings m WHERE m.source_norm = c.source_norm)`);
  }
  const { rows: mappings } = await pool.query(
    `SELECT m.*,
            (SELECT count(*) FROM mapping_inputs i WHERE i.source_norm = m.source_norm) AS input_count
       FROM url_mappings m ${onlyKey ? 'WHERE m.source_norm = $1' : ''}
       ORDER BY m.id`,
    onlyKey ? [onlyKey] : [],
  );

  const results = [];
  for (const m of mappings) {
    // 1) 歧义键：阻断，不发请求
    if (m.status === 'conflicted') {
      const { rows: amb } = await pool.query(
        `SELECT source_forms, targets FROM mapping_ambiguities WHERE source_norm = $1`,
        [m.source_norm],
      );
      const issues = [
        `同归一化键 ${m.source_norm} 有多个不同目标`,
        ...(amb[0]?.targets ?? []).map((t) => `候选目标: ${t}`),
      ];
      await saveVerdict({
        sourceNorm: m.source_norm, sourceRaw: m.source_raw,
        verdict: 'ambiguity', issues, final: {}, hops: 0, tracker: null,
      });
      results.push({ source_norm: m.source_norm, verdict: 'ambiguity', issues });
      continue;
    }

    // 2) 目标自身解析校验（deleted 类型 target 即自身）
    const t = normalize(m.target_raw);
    const { verdict, issues, crawl, tracker } = await judge(m.source_raw, m.mapping_type, t.normKey);

    await pool.query('DELETE FROM crawl_results WHERE source_norm = $1', [m.source_norm]);
    for (const h of crawl.hops) {
      await pool.query(
        `INSERT INTO crawl_results
           (source_norm, hop_index, url_raw, url_norm, status_code,
            location_raw, location_norm, is_redirect, fetch_error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [m.source_norm, h.index, h.url_raw, h.url_norm, h.status,
         h.location_raw ?? null, h.location_norm ?? null, h.is_redirect, h.fetch_error ?? null],
      );
    }
    await saveVerdict({
      sourceNorm: m.source_norm, sourceRaw: m.source_raw, verdict, issues,
      final: {
        raw: crawl.finalRaw, norm: crawl.finalNorm, status: crawl.finalStatus,
      },
      hops: crawl.hops.length,
      tracker,
    });
    results.push({ source_norm: m.source_norm, verdict, issues, hops: crawl.hops.length });
  }
  return { count: results.length, results, label: VERDICT_LABEL };
}

async function saveVerdict({ sourceNorm, sourceRaw, verdict, issues, final, hops, tracker }) {
  await pool.query(
    `INSERT INTO verification_verdicts
       (source_norm, source_raw, final_url_raw, final_url_norm, final_status,
        hops, tracker_preserved, verdict, issues, verified_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (source_norm) DO UPDATE SET
       source_raw=EXCLUDED.source_raw, final_url_raw=EXCLUDED.final_url_raw,
       final_url_norm=EXCLUDED.final_url_norm, final_status=EXCLUDED.final_status,
       hops=EXCLUDED.hops, tracker_preserved=EXCLUDED.tracker_preserved,
       verdict=EXCLUDED.verdict, issues=EXCLUDED.issues, verified_at=now()`,
    [sourceNorm, sourceRaw, final.raw ?? null, final.norm ?? null, final.status ?? null,
     hops,
     tracker ? tracker.ok : null,
     verdict, JSON.stringify(issues)],
  );
}

export { VERDICT_LABEL };
