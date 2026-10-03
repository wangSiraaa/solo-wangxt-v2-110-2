import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportFile } from '../src/import-parser.js';
import { validateRecord, contentDigest, allowedTargetOrigins } from '../src/import-service.js';

const O = 'http://127.0.0.1:4568';
const csv = (rows) => Buffer.from(
  ['# url-migration-import v1', 'source,target,action,note', ...rows].join('\n'));

/* ---------------------------------------------------------- 解析纪律 */

test('CSV：中文百分号编码、尾斜杠、utm 参数逐字节保留，不做任何规整', () => {
  const r = parseImportFile(csv([
    `${O}/%E9%A2%91%E9%81%93/42.html?utm_source=a%2fb&x=1,${O}/articles/42/,redirect,备注`,
  ]), 'csv');
  assert.equal(r.supported, true);
  assert.deepEqual(r.batchErrors, []);
  const f = r.records[0].fields;
  assert.equal(f.source, `${O}/%E9%A2%91%E9%81%93/42.html?utm_source=a%2fb&x=1`);
  assert.equal(f.target, `${O}/articles/42/`); // 尾斜杠原样
  assert.equal(f.note, '备注');
  assert.equal(r.records[0].lineNo, 3);
});

test('CSV：%2f 与 %2F、字段大小写、+ 号都不被解析器改动', () => {
  const r = parseImportFile(csv([`${O}/a%2fb?c=%2f&g=a+b,${O}/B,redirect,n`]), 'csv');
  assert.equal(r.records[0].fields.source, `${O}/a%2fb?c=%2f&g=a+b`);
});

test('CSV：引号内逗号、引号转义、CRLF 与引号内换行正确处理', () => {
  const body = Buffer.from(
    '# url-migration-import v1\r\nsource,target,action,note\r\n'
    + `"${O}/q?a=1,2",${O}/t,redirect,"含,逗号"\r\n`
    + `"${O}/multi\nline",${O}/t2,redirect,x\r\n`);
  const r = parseImportFile(body, 'csv');
  assert.deepEqual(r.batchErrors, []);
  assert.equal(r.records.length, 2);
  assert.equal(r.records[0].fields.source, `${O}/q?a=1,2`);
  assert.equal(r.records[0].fields.note, '含,逗号');
  assert.equal(r.records[1].fields.source, `${O}/multi\nline`);
  assert.equal(r.records[1].lineNo, 4);
  assert.equal(r.records[1].endLineNo, 5);
});

test('CSV：物理行含非法 UTF-8 字节 -> 该行 bad_encoding，其它行照常', () => {
  const body = Buffer.concat([
    Buffer.from('# url-migration-import v1\nsource,target,action,note\n'),
    Buffer.from(`${O}/ok,${O}/t,redirect,好行\n`),
    Buffer.from(`${O}/`), Buffer.from([0xff, 0xfe]), Buffer.from(`,${O}/t,redirect,坏行\n`),
  ]);
  const r = parseImportFile(body, 'csv');
  assert.equal(r.records[0].encodingError, null);
  assert.equal(r.records[1].encodingError, 'bad_encoding');
  assert.equal(r.records[1].lineNo, 4);
});

test('CSV：未闭合引号 -> 记录 csvError + 批次 bad_csv', () => {
  const r = parseImportFile(csv([`"${O}/a,${O}/t,redirect,x`]), 'csv');
  assert.equal(r.records[0].csvError, 'unterminated_quote');
  assert.ok(r.batchErrors.some((e) => e.code === 'bad_csv'));
});

test('CSV：版本缺失 / 不支持 / 表头错误 -> supported=false，不产生记录', () => {
  let r = parseImportFile(Buffer.from('source,target,action,note\n'), 'csv');
  assert.equal(r.supported, false);
  assert.equal(r.batchErrors[0].code, 'missing_version');

  r = parseImportFile(csv([]).toString().replace('v1', 'v7') ? Buffer.from('# url-migration-import v7\nsource,target,action,note\n') : Buffer.alloc(0), 'csv');
  assert.equal(r.supported, false);
  assert.equal(r.formatVersion, 7);
  assert.equal(r.batchErrors[0].code, 'unsupported_version');
  assert.equal(r.records.length, 0);

  r = parseImportFile(Buffer.from('# url-migration-import v1\nwrong,header\n'), 'csv');
  assert.equal(r.supported, true);
  assert.equal(r.batchErrors[0].code, 'bad_header');
});

test('CSV：空文件 / 空字节被识别', () => {
  const r = parseImportFile(Buffer.from(''), 'csv');
  assert.equal(r.supported, false);
  assert.equal(r.batchErrors[0].code, 'empty_file');
});

test('JSON：合法 v1 解析、行号定位、字节保留', () => {
  const r = parseImportFile(Buffer.from(JSON.stringify({
    format_version: 1,
    rows: [{ source: `${O}/a?utm_source=x`, target: `${O}/b`, action: 'redirect', note: 'n' }],
  }, null, 2)), 'json');
  assert.equal(r.formatVersion, 1);
  assert.equal(r.records[0].fields.source, `${O}/a?utm_source=x`);
  assert.ok(r.records[0].lineNo >= 3);
});

test('JSON：坏 JSON / 非对象根 / 缺 rows / 版本不支持 / 非 UTF-8', () => {
  let r = parseImportFile(Buffer.from('{oops'), 'json');
  assert.equal(r.batchErrors[0].code, 'bad_json');

  r = parseImportFile(Buffer.from('[1,2]'), 'json');
  assert.equal(r.batchErrors[0].code, 'bad_structure');

  r = parseImportFile(Buffer.from(JSON.stringify({ format_version: 1 })), 'json');
  assert.equal(r.batchErrors[0].code, 'missing_rows');

  r = parseImportFile(Buffer.from(JSON.stringify({ format_version: 3, rows: [] })), 'json');
  assert.equal(r.supported, false);
  assert.equal(r.batchErrors[0].code, 'unsupported_version');

  r = parseImportFile(Buffer.concat([Buffer.from('{"format_version":1,'), Buffer.from([0xff])]), 'json');
  assert.equal(r.batchErrors[0].code, 'bad_encoding');
});

/* ---------------------------------------------------------- 行校验 */

test('validateRecord：redirect 成功（含 utm 规范化预览）', () => {
  const v = validateRecord({
    source: `${O}/news/1?utm_source=x&r=1`, target: `${O}/a/1/`, action: 'redirect', note: '',
    extraColumns: [],
  });
  assert.equal(v.ok, true);
  assert.equal(v.sourceNorm, `${O}/news/1?r=1`);
  assert.deepEqual(v.normDetail.tracker_params, ['utm_source']);
  assert.equal(v.mappingType, 'manual');
});

test('validateRecord：delete 无 target 合法（以旧址自身消亡）', () => {
  const v = validateRecord({ source: `${O}/gone/9`, target: '', action: 'delete', extraColumns: [] });
  assert.equal(v.ok, true);
  assert.equal(v.mappingType, 'deleted');
  assert.equal(v.targetNorm, v.sourceNorm);
});

test('validateRecord：delete 指向其它地址 -> bad_target_url', () => {
  const v = validateRecord({ source: `${O}/g`, target: `${O}/other`, action: 'delete', extraColumns: [] });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'bad_target_url');
});

test('validateRecord：未知动作 / 缺动作', () => {
  let v = validateRecord({ source: `${O}/a`, target: `${O}/b`, action: 'rewrite', extraColumns: [] });
  assert.equal(v.code, 'unknown_action');
  v = validateRecord({ source: `${O}/a`, target: `${O}/b`, extraColumns: [] });
  assert.equal(v.code, 'unknown_action');
});

test('validateRecord：redirect 缺 target / 坏 URL', () => {
  let v = validateRecord({ source: `${O}/a`, target: '', action: 'redirect', extraColumns: [] });
  assert.equal(v.code, 'bad_target_url');
  v = validateRecord({ source: 'not a url', target: `${O}/b`, action: 'redirect', extraColumns: [] });
  assert.equal(v.code, 'bad_source_url');
});

test('validateRecord：目标不在本地迁移范围 -> target_out_of_scope', () => {
  const v = validateRecord({ source: `${O}/a`, target: 'http://example.com/new', action: 'redirect', extraColumns: [] });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'target_out_of_scope');
  assert.ok(v.message.includes('example.com'));
  assert.ok([...allowedTargetOrigins()].includes(O));
});

test('validateRecord：非 http(s) scheme 被拒', () => {
  const v = validateRecord({ source: 'file:///etc/passwd', target: `${O}/b`, action: 'redirect', extraColumns: [] });
  assert.equal(v.code, 'bad_source_url');
});

test('validateRecord：多余列 -> bad_csv', () => {
  const v = validateRecord({ source: `${O}/a`, target: `${O}/b`, action: 'redirect', extraColumns: ['x'] });
  assert.equal(v.code, 'bad_csv');
});

test('contentDigest：相同字节相同摘要，差一个字节不同', () => {
  const a = contentDigest(Buffer.from('hello'));
  const b = contentDigest(Buffer.from('hello'));
  const c = contentDigest(Buffer.from('hellp'));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
});
