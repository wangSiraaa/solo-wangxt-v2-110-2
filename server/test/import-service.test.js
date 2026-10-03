/**
 * 批量导入工作流集成测试（PostgreSQL 真实暂存/提交 + 本地 fixture 验证）。
 *
 * 这些测试直接调用 service 层（不经 HTTP），共享一个独立的测试库表数据，
 * 每个用例自清理自己的导入批次；seed 数据由 npm run seed 预置。
 * 运行：node --test server/test/import-service.test.js（需先 pg:start + seed）
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { ensureDatabase } from '../src/db.js';
import { startFixture } from '../src/fixture.js';
import { fixtureOrigin } from '../src/config.js';
import {
  stageImport, getImport, updateRowSelection, commitImport, abandonImport,
} from '../src/import-service.js';
import { runVerification } from '../src/verify-runner.js';

const O = fixtureOrigin();
let fixture;
let seq = 0;
const uniq = (p) => p.replace('PATH', `t${process.pid}_${++seq}`);

before(async () => {
  await ensureDatabase();
  fixture = await startFixture();
});
after(async () => {
  await fixture.close();
  await pool.end();
});

// 每个用例清掉自己可能产生的批次（mapping_inputs 的 import_row_id ON DELETE SET NULL，
// 但已提交产生的 mapping_inputs 会留下——用例使用互不相同的路径避免相互干扰）。
beforeEach(async () => {
  await pool.query('DELETE FROM import_batches WHERE created_by = $1', [TEST_ACTOR]);
});
const TEST_ACTOR = 'it-actor';

function csvBuffer(rows) {
  const head = 'source_raw,target_raw,action,note\n';
  return Buffer.from(head + rows.map((r) => r.join(',')).join('\n'), 'utf8');
}

test('幂等：同字节 sha256 第二次上传返回同一批次，零新增行/映射', async () => {
  const bytes = csvBuffer([
    [uniq(`${O}/PATH/a`), uniq(`${O}/PATH/new-a`), 'migrate', 'x'],
  ]);
  const r1 = await stageImport({ bytes, fileFormat: 'csv', filename: 'f.csv', actor: TEST_ACTOR });
  assert.equal(r1.idempotent, false);
  const r2 = await stageImport({ bytes, fileFormat: 'csv', filename: 'other.csv', actor: TEST_ACTOR });
  assert.equal(r2.idempotent, true);
  assert.equal(r2.batch.id, r1.batch.id);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM import_rows WHERE batch_id=$1', [r1.batch.id]);
  assert.equal(rows[0].n, 1);
  // 未提交：不新增 mapping_inputs
  const { rows: mi } = await pool.query(
    'SELECT count(*)::int AS n FROM mapping_inputs WHERE source_norm=$1',
    [uniq(`${O}/PATH/a`)]);
  assert.equal(mi[0].n, 0);
});

test('含错误行的批次原子拒绝：不写任何 mapping_inputs，不改变 url_mappings 计数', async () => {
  const before = (await pool.query('SELECT count(*)::int AS n FROM url_mappings')).rows[0].n;
  const bytes = csvBuffer([
    [uniq(`${O}/PATH/ok`), uniq(`${O}/PATH/new`), 'migrate', 'ok'],
    [uniq(`${O}/PATH/bad%zz`), `${O}/x`, 'migrate', '坏编码'],
  ]);
  const { batch } = await stageImport({ bytes, fileFormat: 'csv', actor: TEST_ACTOR });
  const data = await getImport(batch.id);
  const errRow = data.rows.find((r) => r.parse_status === 'error');
  const okRow = data.rows.find((r) => r.parse_status === 'ok');
  assert.equal(errRow.error_code, 'bad_percent_encoding');

  await updateRowSelection(batch.id, okRow.id, 'selected', TEST_ACTOR);
  const res = await commitImport(batch.id, { actor: TEST_ACTOR });
  assert.equal(res.rejected, true);
  assert.equal(res.status, 409);
  assert.ok(res.blockers.some((b) => b.line_no === errRow.line_no));

  const after = (await pool.query('SELECT count(*)::int AS n FROM url_mappings')).rows[0].n;
  assert.equal(after, before, '生效映射数量不变');
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM mapping_inputs WHERE note=$1', ['ok']);
  // note='ok' 可能与其它用例撞名，用路径精确判
  const { rows: hit } = await pool.query(
    'SELECT count(*)::int AS n FROM mapping_inputs WHERE source_norm=$1', [uniq(`${O}/PATH/ok`)]);
  assert.equal(hit[0].n, 0, '被拒批次的行未写入 mapping_inputs');
});

test('批内同键不同目标：未裁决不能提交；显式裁决唯一赢家后提交，输家录入被取代留痕', async () => {
  const src = uniq(`${O}/PATH/dup`);
  const bytes = csvBuffer([
    [`${src}?utm_source=a`, uniq(`${O}/PATH/t100`), 'migrate', '目标100'],
    [`${src}`, uniq(`${O}/PATH/t200`), 'migrate', '目标200'],
  ]);
  const { batch } = await stageImport({ bytes, fileFormat: 'csv', actor: TEST_ACTOR });
  const data = await getImport(batch.id);
  assert.ok(data.rows.every((r) => r.conflict === 'within_file'));
  // 未裁决（即使都选）也应拒绝 —— 先只选一个
  const winner = data.rows.find((r) => r.target_norm.endsWith('/t200'));
  await updateRowSelection(batch.id, winner.id, 'selected', TEST_ACTOR);
  let res = await commitImport(batch.id, { actor: TEST_ACTOR });
  // 唯一赢家即合法裁决
  assert.equal(res.rejected, false, JSON.stringify(res.blockers));
  const { rows: m } = await pool.query(
    'SELECT target_norm, status FROM url_mappings WHERE source_norm=$1', [src]);
  assert.equal(m.length, 1);
  assert.ok(m[0].target_norm.endsWith('/t200'));
  assert.equal(m[0].status, 'active');
  // 赢家已提交；输家未进入 mapping_inputs（只有被选中的行才插入）
  const { rows: inputs } = await pool.query(
    'SELECT count(*)::int AS n FROM mapping_inputs WHERE source_norm=$1', [src]);
  assert.equal(inputs[0].n, 1);
});

test('与当前库冲突：勾选导入行=显式改目标，旧目标录入被 superseded 且版本递增、证据过期', async () => {
  const src = uniq(`${O}/PATH/lib`);
  const t1 = uniq(`${O}/PATH/original`);
  // 先手工建立映射并写入一条“新鲜证据”（不实际请求，这些路径不存在；
  // 本用例只验证提交对版本/stale/superseded 的传播，不验证 HTTP 成败）
  await pool.query(
    `INSERT INTO mapping_inputs (source_raw, source_norm, target_raw, target_norm, mapping_type)
     VALUES ($1,$1,$2,$2,'manual')`, [src, t1]);
  await pool.query(
    `INSERT INTO url_mappings (source_raw, source_norm, target_raw, target_norm, mapping_type, status, version)
     VALUES ($1,$1,$2,$2,'manual','active',1)`, [src, t1]);
  await pool.query(
    `INSERT INTO verification_verdicts
       (source_norm, source_raw, verdict, stale, mapping_version, issues, verified_at)
     VALUES ($1,$1,'ok',false,1,'[]',now()-interval '1 hour')`, [src]);

  const t2 = uniq(`${O}/PATH/revised`);
  const bytes = csvBuffer([[`${src}?utm_campaign=r`, t2, 'migrate', '改目标']]);
  const { batch } = await stageImport({ bytes, fileFormat: 'csv', actor: TEST_ACTOR });
  const data = await getImport(batch.id);
  assert.equal(data.rows[0].conflict, 'with_library');
  await updateRowSelection(batch.id, data.rows[0].id, 'selected', TEST_ACTOR);
  const res = await commitImport(batch.id, { actor: TEST_ACTOR });
  assert.equal(res.rejected, false, JSON.stringify(res.blockers));

  const { rows: mm } = await pool.query(
    'SELECT target_norm, version FROM url_mappings WHERE source_norm=$1', [src]);
  assert.ok(mm[0].target_norm.endsWith('/revised'));
  assert.ok(Number(mm[0].version) >= 2, `版本应递增，实际 ${mm[0].version}`);
  const { rows: v } = await pool.query(
    'SELECT stale, mapping_version FROM verification_verdicts WHERE source_norm=$1', [src]);
  assert.equal(v[0].stale, true, '旧证据必须被标过期');
  const { rows: sup } = await pool.query(
    'SELECT count(*)::int AS n FROM mapping_inputs WHERE source_norm=$1 AND superseded_at IS NOT NULL', [src]);
  assert.equal(sup[0].n, 1, '旧目标录入被取代但保留');
});

test('放弃的批次不能提交', async () => {
  const bytes = csvBuffer([[uniq(`${O}/PATH/ab`), uniq(`${O}/PATH/ab2`), 'migrate', 'x']]);
  const { batch } = await stageImport({ bytes, fileFormat: 'csv', actor: TEST_ACTOR });
  const data = await getImport(batch.id);
  await updateRowSelection(batch.id, data.rows[0].id, 'selected', TEST_ACTOR);
  await abandonImport(batch.id, TEST_ACTOR);
  const res = await commitImport(batch.id, { actor: TEST_ACTOR });
  assert.equal(res.rejected, true);
  assert.match(res.reason, /放弃/);
});

test('提交后可经 getImport 追溯：原始行、裁决、committed_mapping_id 与审计', async () => {
  const src = uniq(`${O}/PATH/trace`);
  const tgt = uniq(`${O}/PATH/tracenew`);
  const bytes = csvBuffer([[src, tgt, 'migrate', '留痕']]);
  const { batch } = await stageImport({ bytes, fileFormat: 'csv', filename: 'trace.csv', actor: TEST_ACTOR });
  const data0 = await getImport(batch.id);
  await updateRowSelection(batch.id, data0.rows[0].id, 'selected', TEST_ACTOR);
  await commitImport(batch.id, { actor: TEST_ACTOR });
  const data = await getImport(batch.id);
  assert.equal(data.batch.status, 'committed');
  assert.equal(data.rows[0].raw_line, `${src},${tgt},migrate,留痕`);
  assert.ok(data.rows[0].committed_mapping_id);
  const actions = data.audit.map((a) => a.action);
  assert.ok(actions.includes('staged'));
  assert.ok(actions.includes('selection'));
  assert.ok(actions.includes('committed'));
});

test('JSON 格式同样可暂存提交；文件级坏版本由 parser 在 stage 抛出', async () => {
  const src = uniq(`${O}/PATH/json`);
  const tgt = uniq(`${O}/PATH/jsonnew`);
  const doc = Buffer.from(JSON.stringify({
    format_version: 'v1',
    rows: [{ source_raw: src, target_raw: tgt, action: 'migrate', note: 'j' }],
  }), 'utf8');
  const { batch } = await stageImport({ bytes: doc, fileFormat: 'json', actor: TEST_ACTOR });
  const data = await getImport(batch.id);
  assert.equal(data.rows[0].parse_status, 'ok');
  await updateRowSelection(batch.id, data.rows[0].id, 'selected', TEST_ACTOR);
  const res = await commitImport(batch.id, { actor: TEST_ACTOR });
  assert.equal(res.rejected, false);
});
