/**
 * mapping_inputs（原始录入材料）-> url_mappings（生效映射）的重算。
 * 冲突键置 conflicted：不挑赢家、不静默覆盖。
 */
import { analyzeInputs } from './ambiguity.js';

export async function recomputeMappings(client) {
  const { rows } = await client.query('SELECT * FROM mapping_inputs ORDER BY id');
  const { groups, ambiguous } = analyzeInputs(rows);
  const conflict = new Set(ambiguous.map((a) => a.source_norm));
  await client.query('TRUNCATE url_mappings RESTART IDENTITY CASCADE');
  for (const [sourceNorm, items] of groups) {
    const first = items[0];
    await client.query(
      `INSERT INTO url_mappings
         (source_raw, source_norm, target_raw, target_norm, mapping_type, status, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [first.source_raw, sourceNorm, first.target_raw, first.target_norm,
       first.mapping_type, conflict.has(sourceNorm) ? 'conflicted' : 'active',
       first.note ?? null]);
  }
  return { conflicted: conflict.size, total: groups.size };
}
