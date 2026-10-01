/**
 * 命令行验证：npm run verify
 * 输出每条映射的裁决、跳数、最终状态，并以退出码反映是否全部健康。
 * 不启动 API，但必须先有本地站点（index.js 启动时一并起；本脚本自己起）。
 */
import { pool } from './db.js';
import { startFixture } from './fixture.js';
import { runVerification, VERDICT_LABEL } from './verify-runner.js';

const fixture = await startFixture();
try {
  const { results } = await runVerification();
  console.log('\n===== 链接验证结果 =====');
  for (const r of results) {
    const tag = r.verdict === 'ok' || r.verdict === 'deleted_gone_ok' ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${VERDICT_LABEL[r.verdict] ?? r.verdict}  hops=${r.hops ?? '-'}  ${r.source_norm}`);
    for (const i of r.issues ?? []) console.log(`       - ${i}`);
  }
  const bad = results.filter(
    (r) => r.verdict !== 'ok' && r.verdict !== 'deleted_gone_ok',
  );
  console.log(`\n共 ${results.length} 条，通过 ${results.length - bad.length}，阻断 ${bad.length}`);
  process.exitCode = bad.length ? 2 : 0;
} finally {
  await fixture.close();
  await pool.end();
}
