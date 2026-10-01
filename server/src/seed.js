/**
 * 演示数据。每一条都对应一个要在报告里讲清楚的场景。
 * 运行：npm run seed
 */
import { ensureDatabase, pool } from './db.js';
import { normalize } from './normalize.js';
import { analyzeInputs } from './ambiguity.js';
import { fixtureOrigin } from './config.js';

const O = fixtureOrigin();

const INPUTS = [
  // 1) 编码中文路径 + 追踪参数：中文必须按 UTF-8 百分号编码，追踪参数保留
  {
    source_raw: `${O}/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html?utm_source=weibo&utm_campaign=autumn`,
    target_raw: `${O}/articles/tech/42`,
    mapping_type: 'manual',
    note: '中文旧路径，编码形式，带投放追踪参数',
  },
  // 2) 小写 /news：正确映射（无查询参数，干净的规范目标）
  {
    source_raw: `${O}/news/123`,
    target_raw: `${O}/articles/123`,
    mapping_type: 'manual',
    note: '正确的小写路径',
  },
  // 3) 尾斜杠：旧站只有带斜杠的 /column/weekly/ 是资源
  {
    source_raw: `${O}/column/weekly/`,
    target_raw: `${O}/sections/weekly`,
    mapping_type: 'manual',
    note: '尾斜杠是资源身份的一部分',
  },
  // 4) 编码斜杠：文件名里真的含有 "/" 字符，不可与 /files/draft 合并
  {
    source_raw: `${O}/old-files%2Fdraft`,
    target_raw: `${O}/files%2Fdraft`,
    mapping_type: 'manual',
    note: '%2F 是文件名中的字符，不是路径分隔符',
  },
  // 5) 已删除栏目：不应 301 到首页，应明确消亡（410）
  {
    source_raw: `${O}/forum/announce/9`,
    target_raw: `${O}/forum/announce/9`,
    mapping_type: 'deleted',
    note: '栏目已删除，期望 410 Gone',
  },
  // 6) 重定向环：有人把环上两个地址互相填成了“迁移目标”
  {
    source_raw: `${O}/loop/a`,
    target_raw: `${O}/loop/b`,
    mapping_type: 'manual',
    note: '已知环，验证必须报 redirect_loop',
  },
  // 7) 过长链：7 跳，超过上限 5
  {
    source_raw: `${O}/chain/0`,
    target_raw: `${O}/chain/7`,
    mapping_type: 'manual',
    note: '7 跳长链，必须报 chain_too_long 并要求压缩为直跳',
  },
  // 8) 歧义：另一个团队按带追踪参数的写法导入，归一后与条目 2 同键，目标却不同
  {
    source_raw: `${O}/news/123?utm_source=partner`,
    target_raw: `${O}/articles/999`,
    mapping_type: 'manual',
    note: '追踪参数不影响归一化键，归一后与条目 2 同键但目标不同 → 歧义',
  },
  // 9) 非本地地址：验证器必须拒绝（演示白名单）
  {
    source_raw: 'http://example.com/external-old',
    target_raw: 'http://example.com/external-new',
    mapping_type: 'manual',
    note: '外网地址，不应被验证器请求',
  },
  // 10) 大小写错误写法：有人按标题习惯录成 /News/123
  {
    source_raw: `${O}/News/123`,
    target_raw: `${O}/articles/123`,
    mapping_type: 'manual',
    note: '路径大小写错误，旧站不存在 /News/123，验证会失败',
  },
];

export async function seed() {
  await ensureDatabase();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE migration_plan_items, migration_plans, verification_verdicts, crawl_results, url_mappings, mapping_inputs RESTART IDENTITY');

    for (const row of INPUTS) {
      const s = normalize(row.source_raw);
      const t = normalize(row.target_raw);
      if (!s.ok || !t.ok) throw new Error(`seed url invalid: ${s.error || t.error}`);
      await client.query(
        `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type, note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.source_raw, s.normKey, row.target_raw, t.normKey, row.mapping_type, row.note],
      );
    }

    // 依据输入材料建生效映射；冲突键置 conflicted，不挑赢家
    const { groups, ambiguous } = analyzeInputs(INPUTS.map((r, i) => ({ id: i + 1, ...r })));
    const conflictKeys = new Set(ambiguous.map((a) => a.source_norm));
    for (const [sourceNorm, items] of groups) {
      const first = items[0];
      await client.query(
        `INSERT INTO url_mappings
           (source_raw, source_norm, target_raw, target_norm, mapping_type, status, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          first.source_raw, sourceNorm, first.target_raw, first.t.normKey,
          first.mapping_type,
          conflictKeys.has(sourceNorm) ? 'conflicted' : 'active',
          conflictKeys.has(sourceNorm)
            ? '同归一化键存在多个不同目标，待人工裁决'
            : first.note ?? null,
        ],
      );
    }
    await client.query('COMMIT');
    console.log(`seeded ${INPUTS.length} inputs, ${ambiguous.length} ambiguous group(s)`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seed().catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}
