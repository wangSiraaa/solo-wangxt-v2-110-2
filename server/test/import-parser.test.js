/**
 * 导入解析器单测：字节保真、逐行错误、版本/动作/范围校验。
 * 不连数据库、不起服务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportFile, checkPercentEncoding, BatchFormatError } from '../src/import-parser.js';
import { fixtureOrigin } from '../src/config.js';

const O = fixtureOrigin();

function csv(lines) {
  return Buffer.from('source_raw,target_raw,action,note\n' + lines.join('\n'), 'utf8');
}

test('原始行逐字节保留：%XX 不解码、尾斜杠保留、utm 不删、字段不 trim', () => {
  const raw = `${O}/%E9%A2%91%E9%81%93/x?utm_source=w&b=2`;
  const f = parseImportFile(csv([`${raw},${O}/articles/x,migrate,  保留空格备注 `]), 'csv');
  const r = f.rows[0];
  assert.equal(r.parse_status, 'ok');
  // 原始行保持文件字节（含未 trim 的备注）
  assert.equal(r.raw_line, `${raw},${O}/articles/x,migrate,  保留空格备注 `);
  assert.equal(r.source_raw, raw);
  // 规范化键：中文仍为大写百分号编码、utm 不在键中、身份参数 b=2 在
  assert.match(r.source_norm, /%E9%A2%91%E9%81%93/);
  assert.doesNotMatch(r.source_norm, /utm/);
  assert.match(r.source_norm, /b=2/);
  // 尾斜杠
  const f2 = parseImportFile(csv([`${O}/a/,${O}/b,migrate,x`]), 'csv');
  assert.ok(f2.rows[0].source_norm.endsWith('/a/'));
});

test('CSV 表头必须精确，否则批次级错误', () => {
  assert.throws(
    () => parseImportFile(Buffer.from('src,dst,act,note\n', 'utf8'), 'csv'),
    /表头必须是/,
  );
});

test('CRLF 与 BOM 兼容', () => {
  const body = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('source_raw,target_raw,action,note\r\n', 'utf8'),
    Buffer.from(`${O}/a,${O}/b,migrate,x\r\n`, 'utf8'),
  ]);
  const f = parseImportFile(body, 'csv');
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].parse_status, 'ok');
  assert.equal(f.rows[0].line_no, 2);
});

test('列数错误是逐行 malformed_row，不影响其它行', () => {
  const f = parseImportFile(csv([
    `${O}/a,${O}/b,migrate`,               // 缺 note 列（3 列）
    `${O}/c,${O}/d,migrate,ok`,
  ]), 'csv');
  assert.equal(f.rows[0].parse_status, 'error');
  assert.equal(f.rows[0].error_code, 'malformed_row');
  assert.equal(f.rows[1].parse_status, 'ok');
});

test('坏百分号编码：%zz 与孤立 % 都被显式拦下', () => {
  assert.equal(checkPercentEncoding('/a%zz'), "百分号转义损坏：'%' 后必须紧跟两位十六进制（如 %2F）");
  assert.equal(checkPercentEncoding('/a%'), "百分号转义损坏：'%' 后必须紧跟两位十六进制（如 %2F）");
  assert.equal(checkPercentEncoding('/a%E4%B8%AD'), null, '合法 UTF-8 中文三字节通过');
  // 非法 UTF-8 序列（%FF%FF 不可能是合法 UTF-8 起始）
  assert.match(checkPercentEncoding('/a%FF%FF'), /不是合法 UTF-8/);
  const f = parseImportFile(csv([`${O}/a%zz,${O}/b,migrate,x`]), 'csv');
  assert.equal(f.rows[0].error_code, 'bad_percent_encoding');
});

test('未知动作逐行报错；delete 行目标必须与旧址同址', () => {
  const f = parseImportFile(csv([
    `${O}/a,${O}/b,teleport,x`,
    `${O}/gone,${O}/elsewhere,delete,x`,
    `${O}/gone2,${O}/gone2,delete,ok`,
  ]), 'csv');
  assert.equal(f.rows[0].error_code, 'unknown_action');
  assert.equal(f.rows[1].error_code, 'deleted_target_mismatch');
  assert.equal(f.rows[2].parse_status, 'ok');
  assert.equal(f.rows[2].mapping_type, 'deleted');
});

test('目标不在本地迁移范围：逐行 outside_allowlist', () => {
  const f = parseImportFile(csv([
    `http://example.com/x,${O}/b,migrate,外网旧址`,
    `${O}/a,http://127.0.0.1:9999/b,migrate,其它端口`,
    `${O}/a2,${O}/b2,migrate,本地合法`,
  ]), 'csv');
  assert.equal(f.rows[0].error_code, 'outside_allowlist');
  assert.equal(f.rows[1].error_code, 'outside_allowlist');
  assert.equal(f.rows[2].parse_status, 'ok');
});

test('JSON v1：逐行版本不支持；文件级版本不支持抛批次错误', () => {
  const doc = Buffer.from(JSON.stringify({
    format_version: 'v1',
    rows: [
      { source_raw: `${O}/a`, target_raw: `${O}/b`, action: 'migrate', version: 'v2' },
      { source_raw: `${O}/c`, target_raw: `${O}/d`, action: 'migrate' },
    ],
  }), 'utf8');
  const f = parseImportFile(doc, 'json');
  assert.equal(f.rows[0].error_code, 'version_unsupported');
  assert.equal(f.rows[1].parse_status, 'ok');

  assert.throws(() => parseImportFile(
    Buffer.from(JSON.stringify({ format_version: 'v9', rows: [] })), 'json'),
    /不支持的文件格式版本/);
  assert.throws(() => parseImportFile(
    Buffer.from('{not json'), 'json'), /JSON 解析失败/);
});

test('带引号 CSV：字段内逗号/引号/换行正确，物理行号准确', () => {
  const body = Buffer.from(
    'source_raw,target_raw,action,note\n' +
    `${O}/a,${O}/b,migrate,"备注,含逗号"\n` +
    `${O}/c,${O}/d,migrate,"两行\n备注"\n` +
    `${O}/e,${O}/f,migrate,正常\n`, 'utf8');
  const f = parseImportFile(body, 'csv');
  assert.equal(f.rows.length, 3);
  assert.equal(f.rows[0].note, '备注,含逗号');
  // 字段内含换行：该记录从物理行 3 开始，下一条记录从物理行 5 开始
  assert.equal(f.rows[1].line_no, 3);
  assert.equal(f.rows[1].note, '两行\n备注');
  assert.equal(f.rows[2].line_no, 5);
});

test('空行与 # 注释行跳过，不产生错误行', () => {
  const f = parseImportFile(Buffer.from(
    'source_raw,target_raw,action,note\n' +
    '\n' +
    '# this is a comment\n' +
    `${O}/a,${O}/b,migrate,x\n`, 'utf8'), 'csv');
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].line_no, 4);
});
