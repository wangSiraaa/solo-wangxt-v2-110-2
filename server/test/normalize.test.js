import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, splitQuery, carryTrackers } from '../src/normalize.js';
import { analyzeInputs } from '../src/ambiguity.js';
import { fixtureOrigin } from '../src/config.js';

const O = fixtureOrigin();

test('路径大小写敏感：/News 与 /news 是不同键', () => {
  const a = normalize(`${O}/News/123`);
  const b = normalize(`${O}/news/123`);
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.normKey, b.normKey);
});

test('百分号编码只规范化十六进制大小写，绝不解码', () => {
  const a = normalize(`${O}/files%2Fdraft`);
  const b = normalize(`${O}/files%2fdraft`);
  assert.equal(a.normKey, b.normKey, '%2f 与 %2F 归一一致');
  const c = normalize(`${O}/files/draft`);
  assert.notEqual(a.normKey, c.normKey, '%2F 绝不能被当成路径分隔符合并');
});

test('编码中文按 UTF-8 保留，解码形式与编码形式归一相同', () => {
  const a = normalize(`${O}/%E9%A2%91%E9%81%93/42`);
  const b = normalize(`${O}/频道/42`);
  assert.equal(a.normKey, b.normKey);
  assert.match(a.pathname, /%E9%A2%91%E9%81%93/);
});

test('尾斜杠默认保留：两键不同', () => {
  const a = normalize(`${O}/column/weekly`);
  const b = normalize(`${O}/column/weekly/`);
  assert.notEqual(a.normKey, b.normKey);
});

test('追踪参数不参与身份，但保留在完整 URL 中', () => {
  const a = normalize(`${O}/news/123?ref=home`);
  const b = normalize(`${O}/news/123?utm_source=x&ref=home`);
  assert.equal(a.normKey, b.normKey, '追踪参数不改变查表键');
  assert.deepEqual([...splitQuery(new URL(b.href).search).trackers.keys()], ['utm_source']);
});

test('非追踪参数参与身份，顺序不影响键', () => {
  const a = normalize(`${O}/news/123?a=1&b=2`);
  const b = normalize(`${O}/news/123?b=2&a=1`);
  assert.equal(a.normKey, b.normKey);
  const c = normalize(`${O}/news/123?a=1&b=3`);
  assert.notEqual(a.normKey, c.normKey);
});

test('fragment 不参与身份', () => {
  const a = normalize(`${O}/news/123#section-1`);
  const b = normalize(`${O}/news/123#other`);
  assert.equal(a.normKey, b.normKey);
});

test('host 大小写与默认端口归一，scheme 非 http(s) 拒绝', () => {
  const a = normalize(`http://127.0.0.1/foo`);
  assert.equal(a.normKey, 'http://127.0.0.1/foo');
  const bad = normalize('file:///etc/passwd');
  assert.equal(bad.ok, false);
});

test('carryTrackers：迁移跳转保留追踪参数且不破坏目标自身参数', () => {
  const out = carryTrackers(`${O}/old?a=1&utm_source=wx`, `${O}/new?page=2`);
  const u = new URL(out);
  assert.equal(u.pathname, '/new');
  assert.equal(u.searchParams.get('page'), '2', '目标自身参数保留');
  assert.equal(u.searchParams.get('a'), null, '旧址身份参数不污染新页');
  assert.equal(u.searchParams.get('utm_source'), 'wx', '追踪参数必须保留');
});

test('歧义检测：同归一化键不同目标必须报歧义', () => {
  const { ambiguous, groups } = analyzeInputs([
    { id: 1, source_raw: `${O}/news/123?ref=home`, target_raw: `${O}/articles/123`, mapping_type: 'manual' },
    { id: 2, source_raw: `${O}/news/123?utm_source=x&ref=home`, target_raw: `${O}/articles/999`, mapping_type: 'manual' },
  ]);
  assert.equal(groups.size, 1);
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].target_norms.length, 2);
});

test('非歧义：书写变体（追踪参数差异）同目标不报歧义', () => {
  const { ambiguous } = analyzeInputs([
    { id: 1, source_raw: `${O}/news/123`, target_raw: `${O}/articles/123`, mapping_type: 'manual' },
    { id: 2, source_raw: `${O}/news/123?utm_source=x`, target_raw: `${O}/articles/123`, mapping_type: 'manual' },
  ]);
  assert.equal(ambiguous.length, 0);
});
