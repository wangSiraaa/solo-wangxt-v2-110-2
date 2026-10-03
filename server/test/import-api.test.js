/**
 * 批量导入 Fastify 接口测试（app.inject，不起端口）。
 * 覆盖：原始字节上传、幂等、422 逐行错误、选择/裁决/提交、
 * 提交后旧证据过期使发布闸门 409、重新验证后放行。
 */
import './use-test-env-api.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { pool } from '../src/db.js';
import { startFixture } from '../src/fixture.js';
import apiRoutes from '../src/routes.js';
import { runVerification } from '../src/verify-runner.js';
import { normalize } from '../src/normalize.js';
import { fixtureOrigin } from '../src/config.js';

const O = fixtureOrigin();
let app, fixture;

const csv = (rows) => Buffer.from(
  ['# url-migration-import v1', 'source,target,action,note', ...rows].join('\n'));

before(async () => {
  fixture = await startFixture();
  const f = Fastify();
  await f.register(apiRoutes);
  app = f;
  await pool.query(`TRUNCATE migration_plan_items, migration_plans, verification_verdicts,
    crawl_results, url_mappings, mapping_inputs,
    import_audit_log, import_resolutions, import_batch_rows, import_batches
    RESTART IDENTITY CASCADE`);
});

after(async () => {
  await app.close();
  await fixture.close();
  await pool.end();
});

async function post(path, body, type = 'application/json') {
  return app.inject({
    method: 'POST', url: path,
    headers: { 'content-type': type },
    payload: body,
    remoteAddress: '127.0.0.1',
  });
}

test('GET /api/imports/scope 暴露版本与允许范围', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/imports/scope' });
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.supported_version, 1);
  assert.deepEqual(j.allowed_origins, [O]);
});

test('上传合法 CSV -> 201，原始字节未被解析改动', async () => {
  const source = `${O}/%E9%A2%91%E9%81%93/42.html?utm_source=wx`;
  const r = await post(`/api/imports?format=csv&filename=t.csv`, csv([`${source},${O}/articles/tech/42,redirect,n`]),
    'application/octet-stream');
  assert.equal(r.statusCode, 201, r.body);
  const j = r.json();
  assert.equal(j.batch.status, 'staged');
  assert.equal(j.rows[0].source_raw, source);
  assert.equal(j.rows[0].source_norm, `${O}/%E9%A2%91%E9%81%93/42.html`);
});

test('相同字节再传 -> 200 幂等，不新建批次/行', async () => {
  const buf = csv([`${O}/api/dup,${O}/articles/a,redirect,n`]);
  const r1 = await post('/api/imports?format=csv', buf, 'application/octet-stream');
  const r2 = await post('/api/imports?format=csv&filename=other.csv', buf, 'application/octet-stream');
  assert.equal(r1.statusCode, 201);
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().idempotent, true);
  assert.equal(r2.json().batch.id, r1.json().batch.id);
  const { rows } = await pool.query('SELECT count(*)::int n FROM import_batch_rows WHERE batch_id=$1',
    [r1.json().batch.id]);
  assert.equal(rows[0].n, 1);
});

test('坏编码行 -> 422 且逐行错误；提交 -> 409 rows_invalid', async () => {
  const body = Buffer.concat([
    Buffer.from(`# url-migration-import v1\nsource,target,action,note\n${O}/o,${O}/a,redirect,x\n`),
    Buffer.from([0xff, 0xfe]),
  ]);
  const r = await post('/api/imports?format=csv', body, 'application/octet-stream');
  assert.equal(r.statusCode, 422);
  const j = r.json();
  assert.equal(j.batch.error_lines, 1);
  const c = await post(`/api/imports/${j.batch.id}/commit`, {});
  assert.equal(c.statusCode, 409);
  assert.equal(c.json().code, 'rows_invalid');
  assert.equal(c.json().error_records[0].code, 'bad_encoding');
});

test('不支持版本 -> 422 rejected；非 octet-stream -> 415；坏 format 参数 -> 400', async () => {
  const r = await post('/api/imports?format=csv',
    Buffer.from('# url-migration-import v9\n'), 'application/octet-stream');
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().batch.status, 'rejected');

  const r2 = await post('/api/imports?format=csv', Buffer.from('x'), 'text/plain');
  assert.equal(r2.statusCode, 415);

  const r3 = await post('/api/imports?format=xml', Buffer.from('x'), 'application/octet-stream');
  assert.equal(r3.statusCode, 400);
});

test('完整闸门：提交改目标 -> 旧证据过期 -> 发布 409 -> 重新验证 -> 发布 200', async () => {
  // 1) 录入一条会验证通过的映射
  const key = `${O}/news/123`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = normalize(key), t = normalize(`${O}/articles/123`);
    await client.query(
      `INSERT INTO mapping_inputs (source_raw,source_norm,target_raw,target_norm,mapping_type)
       VALUES ($1,$2,$3,$4,'manual')`,
      [key, s.normKey, `${O}/articles/123`, t.normKey]);
    const { recomputeMappings } = await import('../src/mappings-service.js');
    await recomputeMappings(client);
    await client.query('COMMIT');
  } finally { client.release(); }

  await runVerification({ onlyKey: normalize(key).normKey });

  // 2) 建方案并纳入全部生效映射 -> 该条 verified
  const plan = (await pool.query("INSERT INTO migration_plans (name) VALUES ('api-gate') RETURNING id")).rows[0].id;
  const built = await post(`/api/plans/${plan}/build`, {});
  assert.equal(built.statusCode, 200);

  // 3) 导入同键不同目标，裁决新目标，提交
  const up = await post('/api/imports?format=csv',
    csv([`${key},${O}/articles/123?rev=2,redirect,改身份查询参数`]), 'application/octet-stream');
  const batch = up.json();
  assert.equal(batch.rows[0].conflicted_with_current, true);
  const winner = batch.rows[0].target_norm;
  const res = await post(`/api/imports/${batch.batch.id}/resolve`, {
    source_norm: batch.rows[0].source_norm,
    winner_target_norm: winner,
  });
  assert.equal(res.statusCode, 200, res.body);
  const committed = await post(`/api/imports/${batch.batch.id}/commit`, {});
  assert.equal(committed.statusCode, 200, committed.body);
  assert.ok(committed.json().staleVerdicts >= 1);

  // 4) 重新 build：旧证据过期 -> 条目应为 pending；发布闸门 409
  await post(`/api/plans/${plan}/build`, {});
  const pub1 = await post(`/api/plans/${plan}/publish`, {});
  assert.equal(pub1.statusCode, 409);
  assert.ok(pub1.json().blockers.some((b) => b.reason.includes('过期') || b.reason.includes('证据')),
    pub1.body);

  // 5) 重新验证（新目标 /articles/123?rev=2 在 fixture 不存在 -> 仍失败），
  //    改用可达目标验证“过期清除后按真实裁决放行”的闸门：先把目标改回可达的 /articles/123 同键等价路径。
  //    这里直接再导入一个与当前同键、与库证据一致的可达目标批次（书写变体，非冲突）。
  const up2 = await post('/api/imports?format=csv',
    csv([`${key}?utm_source=z,${O}/articles/123,redirect,带追踪参数的同目标变体`]),
    'application/octet-stream');
  const b2 = up2.json();
  // 该键当前只有一个 target_norm=/articles/123?rev=2，新行目标 /articles/123 不同 -> 仍属冲突，需裁决
  await post(`/api/imports/${b2.batch.id}/resolve`, {
    source_norm: b2.rows[0].source_norm,
    winner_target_norm: b2.rows[0].target_norm,
  });
  const c2 = await post(`/api/imports/${b2.batch.id}/commit`, {});
  assert.equal(c2.statusCode, 200, c2.body);

  await runVerification({ onlyKey: normalize(key).normKey });
  await post(`/api/plans/${plan}/build`, {});
  const pub2 = await post(`/api/plans/${plan}/publish`, {});
  assert.equal(pub2.statusCode, 200, `重新验证后应放行：${pub2.body}`);
  assert.equal(pub2.json().published, true);
});

test('审计轨迹可经 GET /api/imports/:id/audit 追溯', async () => {
  const r = await post('/api/imports?format=csv&actor=alice',
    csv([`${O}/audit/1,${O}/a,redirect,n`]), 'application/octet-stream');
  const id = r.json().batch.id;
  const log = await app.inject({ method: 'GET', url: `/api/imports/${id}/audit` });
  const events = log.json().events;
  assert.ok(events.some((e) => e.event === 'uploaded' && e.actor === 'alice'));
});
