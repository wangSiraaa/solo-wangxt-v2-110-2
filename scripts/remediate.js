/**
 * 整改脚本（演示“填完表 ≠ 完成”的正确后续动作）：
 *  1. 业务裁决歧义：保留 /articles/123，删除错误导入 /articles/999；
 *  2. 删除错误的大小写录入 /News/123（旧站本无此资源）；
 *  3. 剔除非本站地址（example.com 不属于本次迁移范围）；
 *  4. 重算生效映射。
 * 长链与环的修复在站点侧（FIXTURE_MODE=fixed 模拟已上线的修复配置）。
 *
 * 运行：FIXTURE_MODE=fixed node scripts/remediate.js
 */
import { pool } from '../server/src/db.js';
import { normalize } from '../server/src/normalize.js';
import { recomputeMappings } from '../server/src/mappings-service.js';
import { fixtureOrigin } from '../server/src/config.js';

const O = fixtureOrigin();
const client = await pool.connect();
try {
  await client.query('BEGIN');

  // 1) 歧义裁决：/news/123 唯一目标 /articles/123，删除指向 999 的错误录入
  const wrong999 = normalize(`${O}/articles/999`).normKey;
  const newsKey = normalize(`${O}/news/123`).normKey;
  const r1 = await client.query(
    'DELETE FROM mapping_inputs WHERE source_norm=$1 AND target_norm=$2',
    [newsKey, wrong999]);
  console.log(`歧义裁决：删除错误录入 ${r1.rowCount} 条（错误目标 /articles/999）`);

  // 2) 大小写错误录入：/News/123 在旧站不存在，不是合法旧址
  const badCase = normalize(`${O}/News/123`).normKey;
  const r2 = await client.query('DELETE FROM mapping_inputs WHERE source_norm=$1', [badCase]);
  console.log(`剔除大小写错误录入 ${r2.rowCount} 条（/News/123 旧站 404）`);

  // 3) 非本站地址不纳入本次迁移
  const r3 = await client.query(
    "DELETE FROM mapping_inputs WHERE source_raw LIKE 'http://example.com%'");
  console.log(`剔除非白名单站点录入 ${r3.rowCount} 条`);

  const { total, conflicted } = await recomputeMappings(client);
  void total; void conflicted;

  // 4) 环已在站点侧打断：修正映射目标为修复后的真实落点
  //    （改 mapping_inputs 后重算，revision+1 会让旧验证证据过期）
  const loopKey = normalize(`${O}/loop/a`).normKey;
  const loopTargetRaw = `${O}/articles/tech/42`;
  const loopTarget = normalize(loopTargetRaw);
  await client.query(
    `UPDATE mapping_inputs
        SET target_raw=$2, target_norm=$3, note='环已打断，直跳到科技文章'
      WHERE source_norm=$1 AND excluded IS FALSE`,
    [loopKey, loopTargetRaw, loopTarget.normKey]);
  const recompute2 = await recomputeMappings(client);
  console.log('环修复：/loop/a 的映射目标更新为修复后的真实落点（旧验证证据标记过期）');
  console.log(`重算生效映射：${recompute2.total} 条，冲突 ${recompute2.conflicted} 条，过期证据 ${recompute2.staleVerdicts} 条`);
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}
