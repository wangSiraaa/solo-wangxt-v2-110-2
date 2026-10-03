/**
 * 批量导入文件解析 —— CSV 与 JSON 两种 v1 格式。
 *
 * 绝对纪律（迁移团队的核心诉求）：
 *  1. 只处理已经读入内存的文件字节（由路由把上传 body 作为 Buffer 交给这里），
 *     绝不根据字节去访问任何路径或 URL；
 *  2. 原始行逐字节保留（只去行终止符），百分号编码不 decode、尾斜杠不动、
 *     追踪参数不删不改、字段不做 trim/大小写折叠；
 *  3. 规范化（WHATWG 规则）只用于生成预览列，绝不回写原始列；
 *  4. 任何损坏都在“行”这一粒度上报错误码，错误行随批次留痕，且阻断提交。
 *
 * CSV（v1）：首行必须是精确表头 source_raw,target_raw,action,note
 *   - 支持 RFC4180 式双引号引用（"" 转义、字段内可含逗号与换行）；
 *   - action ∈ {migrate, delete}；delete 行的目标必须与旧址同一资源；
 *   - 空行与以 # 开头的整行跳过（不占行号语义，但行号仍按物理行计数）。
 * JSON（v1）：{ "format_version": "v1", "rows": [
 *   { "source_raw": "...", "target_raw": "...", "action": "migrate|delete",
 *     "note": "...", "version": "v1" } ] }
 */
import { normalize } from './normalize.js';
import { config } from './config.js';

export const FORMAT_VERSION = 'v1';
export const ACTIONS = new Set(['migrate', 'delete']);

export class BatchFormatError extends Error {
  constructor(message) {
    super(message);
    this.code = 'batch_format_error';
  }
}

/**
 * 校验 URL 字符串中的百分号编码：
 *  - 每个 '%' 后必须紧跟两位十六进制（'%zz'、结尾孤立 '%' 都是坏编码）；
 *  - 所有百分号字节拼起来必须是合法 UTF-8（WHATWG 对非法转义比较宽容，
 *    迁移文件里的坏编码必须在这里显式拦下，而不是被悄悄“修对”）。
 * 仅检查字符串，不发请求。
 * @returns {null | string} 错误描述（null = 通过）
 */
export function checkPercentEncoding(s) {
  if (/%(?![0-9a-fA-F]{2})/.test(s)) {
    return "百分号转义损坏：'%' 后必须紧跟两位十六进制（如 %2F）";
  }
  const bytes = [];
  for (const m of s.matchAll(/%([0-9a-fA-F]{2})/g)) bytes.push(parseInt(m[1], 16));
  if (bytes.length === 0) return null;
  const buf = Buffer.from(bytes);
  const decoded = buf.toString('utf8');
  if (decoded.includes('�') || !Buffer.from(decoded, 'utf8').equals(buf)) {
    return '百分号编码的字节不是合法 UTF-8 序列（坏编码）';
  }
  return null;
}

/** URL 必须落在“随项目启动的本地迁移范围”内（与验证器同一白名单） */
function inMigrationScope(n) {
  return (
    n.ok &&
    (n.host === config.fixture.host) &&
    (n.port === String(config.fixture.port))
  );
}

function validateRow(rec) {
  // 1. 版本（JSON 逐行版本；CSV 行由批级 v1 覆盖）
  if (rec.version !== undefined && rec.version !== FORMAT_VERSION) {
    return { error_code: 'version_unsupported',
             error_message: `不支持的格式版本: ${rec.version}（当前支持 ${FORMAT_VERSION}）` };
  }
  // 2. 动作
  if (!ACTIONS.has(rec.action)) {
    return { error_code: 'unknown_action',
             error_message: `未知动作: ${JSON.stringify(rec.action ?? null)}（仅允许 migrate / delete）` };
  }
  // 3. 空值（空字符串与非字符串都算坏行；不做 trim 是为了保留真实字节）
  if (typeof rec.source_raw !== 'string' || rec.source_raw === '') {
    return { error_code: 'empty_url', error_message: '旧址 URL 为空' };
  }
  if (typeof rec.target_raw !== 'string' || rec.target_raw === '') {
    return { error_code: 'empty_url', error_message: '新址 URL 为空' };
  }
  // 4. 百分号编码显式校验（先于 WHATWG：坏编码必须被看见而不是被原谅）
  const badEnc = checkPercentEncoding(rec.source_raw) || checkPercentEncoding(rec.target_raw);
  if (badEnc) return { error_code: 'bad_percent_encoding', error_message: badEnc };

  const s = normalize(rec.source_raw);
  const t = normalize(rec.target_raw);
  if (!s.ok) return { error_code: 'invalid_url', error_message: `旧址无法解析: ${s.error}` };
  if (!t.ok) return { error_code: 'invalid_url', error_message: `新址无法解析: ${t.error}` };

  // 5. 本地迁移范围（防 SSRF / 防把外站地址混进本地迁移批次）
  if (!inMigrationScope(s)) {
    return { error_code: 'outside_allowlist',
             error_message: `旧址 ${s.normKey} 不在允许的本地迁移范围 127.0.0.1:${config.fixture.port}` };
  }
  if (!inMigrationScope(t)) {
    return { error_code: 'outside_allowlist',
             error_message: `新址 ${t.normKey} 不在允许的本地迁移范围 127.0.0.1:${config.fixture.port}` };
  }

  const mappingType = rec.action === 'delete' ? 'deleted' : 'manual';

  // 6. 已删除行：目标必须声明旧资源自身（不能借删除之名跳到首页/别的页）
  if (mappingType === 'deleted' && s.normKey !== t.normKey) {
    return { error_code: 'deleted_target_mismatch',
             error_message: `delete 行的目标必须与旧址同一资源（${s.normKey} ≠ ${t.normKey}）` };
  }

  return {
    ok: true,
    mapping_type: mappingType,
    source_norm: s.normKey,
    target_norm: t.normKey,
  };
}

/** 引号感知的 CSV 切分：返回字段数组；未闭合引号抛 Error */
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let quoted = false;
  let fieldStart = true;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === '"' && fieldStart) { quoted = true; i++; continue; }
    if (ch === ',') { fields.push(cur); cur = ''; fieldStart = true; i++; continue; }
    if (ch !== '"') fieldStart = false;
    cur += ch; i++;
  }
  if (quoted) throw new Error('引号未闭合');
  fields.push(cur);
  return fields;
}

/**
 * 解析上传字节。
 * @param {Buffer} bytes 文件原始字节
 * @param {'csv'|'json'} fileFormat
 * @returns {{
 *   formatVersion: string,
 *   rows: Array<{
 *     line_no:number, raw_line:string, parse_status:'ok'|'error',
 *     error_code?:string, error_message?:string,
 *     source_raw?:string, target_raw?:string, mapping_type?:'manual'|'deleted',
 *     source_norm?:string, target_norm?:string, note?:string|null,
 *     version?:string
 *   }>,
 *   header: string[]
 * }}
 */
export function parseImportFile(bytes, fileFormat) {
  // 文件字节按 UTF-8 解码；非法序列以 U+FFFD 保留可见性（随后在 URL 校验中失败），
  // 不做任何静默替换后再“修复”。
  const text = bytes.toString('utf8').replace(/^﻿/, ''); // 去 BOM（若有），仅此一个前缀字符

  if (fileFormat === 'json') return parseJson(text);
  return parseCsv(text);
}

const CSV_HEADER = ['source_raw', 'target_raw', 'action', 'note'];

function parseCsv(text) {
  // 用扫描器得到“物理行 + 引号字段”，同时得到每条记录的起始物理行号。
  // （scanCsv 为保证行号正确处理字段内换行；普通文件退化为逐行。）
  const scanned = scanCsvRecords(text);
  if (!scanned.length) throw new BatchFormatError('CSV 为空：需要表头行 source_raw,target_raw,action,note');

  const headerFields = splitCsvLine(scanned[0].raw.replace(/\r$/, ''));
  if (headerFields.length !== 4 || headerFields.some((h, i) => h !== CSV_HEADER[i])) {
    throw new BatchFormatError(
      `CSV 表头必须是 ${CSV_HEADER.join(',')}（实际: ${headerFields.join(',') || '（空）'}）`);
  }

  const rows = [];
  for (const rec of scanned.slice(1)) {
    const rawLine = rec.raw.replace(/\r$/, ''); // 去行尾 CR（LF 已由扫描器消费），其余字节不动
    if (rawLine === '' || rawLine.startsWith('#')) continue;
    let fields;
    try {
      fields = splitCsvLine(rawLine);
    } catch (e) {
      rows.push(errRow(rec.startLine, rawLine, 'malformed_row', `CSV 行解析失败: ${e.message}`));
      continue;
    }
    if (fields.length !== 4) {
      rows.push(errRow(rec.startLine, rawLine, 'malformed_row',
        `需要 4 列 source_raw,target_raw,action,note，实际 ${fields.length} 列`));
      continue;
    }
    const [source_raw, target_raw, action, note] = fields;
    rows.push(buildRow(rec.startLine, rawLine,
      { source_raw, target_raw, action, note: note === '' ? null : note, version: FORMAT_VERSION }));
  }
  return { formatVersion: FORMAT_VERSION, rows, header: CSV_HEADER };
}

function parseJson(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new BatchFormatError(`JSON 解析失败: ${e.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new BatchFormatError('JSON 顶层必须是对象 {format_version, rows:[...]}');
  }
  if (doc.format_version !== FORMAT_VERSION) {
    throw new BatchFormatError(`不支持的文件格式版本: ${JSON.stringify(doc.format_version ?? null)}（当前支持 ${FORMAT_VERSION}）`);
  }
  if (!Array.isArray(doc.rows)) throw new BatchFormatError('JSON 缺少 rows 数组');

  const rows = doc.rows.map((r, idx) => {
    const lineNo = idx + 1; // JSON 无物理行语义，使用记录序号（1 起）
    const rawLine = JSON.stringify(r);
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return errRow(lineNo, rawLine, 'malformed_row', 'rows 中的每条记录必须是对象');
    }
    return buildRow(lineNo, rawLine, {
      source_raw: r.source_raw,
      target_raw: r.target_raw,
      action: r.action,
      note: typeof r.note === 'string' && r.note !== '' ? r.note : null,
      version: r.version,
    });
  });
  return { formatVersion: FORMAT_VERSION, rows, header: CSV_HEADER };
}

function buildRow(lineNo, rawLine, rec) {
  const v = validateRow(rec);
  if (!v.ok) return errRow(lineNo, rawLine, v.error_code, v.error_message);
  return {
    line_no: lineNo,
    raw_line: rawLine,
    parse_status: 'ok',
    source_raw: rec.source_raw,
    source_norm: v.source_norm,
    target_raw: rec.target_raw,
    target_norm: v.target_norm,
    mapping_type: v.mapping_type,
    note: rec.note,
  };
}

function errRow(lineNo, rawLine, error_code, error_message) {
  return {
    line_no: lineNo, raw_line: rawLine, parse_status: 'error',
    error_code, error_message,
  };
}

/**
 * CSV 物理记录扫描（引号内允许逗号与换行），返回带起始物理行号的记录。
 * 与 scanCsv 的区别：这里直接实现正确的行号簿记。
 */
function scanCsvRecords(text) {
  const records = [];
  let i = 0;
  let line = 1;
  let recStartLine = 1;
  let recStartIdx = 0;
  // quoted = 当前是否处在引号字段内；fieldStart = 当前字符是否位于一个字段的起点
  // （只有字段起点处的 " 才开启引用，闭合引号不会被误当成重新进入引用）。
  let quoted = false;
  let fieldStart = true;
  let hasContent = false;

  // 统一按“换行符”计数：CRLF 与孤立 CR 各算一行，避免 CRLF 被数两次。
  const atLineBreak = (idx) => {
    if (text[idx] === '\n') return 1;
    if (text[idx] === '\r') return text[idx + 1] === '\n' ? 2 : 1;
    return 0;
  };

  while (i < text.length) {
    const ch = text[i];

    // 在引号字段内：只认转义 ""、闭合 "、以及（计入行号的）换行
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { i += 2; continue; }
        // 闭合引号：退出引用后落到下方同一位置的“字段/终止”判定，
        // 使 "…"\n 中的换行在本轮即被识别为记录终止（而不是漏数）。
        quoted = false;
      } else {
        const brIn = atLineBreak(i);
        if (brIn) { line += 1; i += brIn; continue; }
      }
      i += 1; continue;
    }

    // 字段起始处的 " 开启引用（闭合引号不在字段起始，不会再被当作开启）
    if (ch === '"' && fieldStart) {
      quoted = true; fieldStart = false; hasContent = true; i += 1; continue;
    }

    const br = atLineBreak(i);
    if (br) {
      const endIdx = i;
      if (hasContent || text.slice(recStartIdx, endIdx).includes(',')) {
        records.push({ startLine: recStartLine, startIdx: recStartIdx, endIdx });
      }
      i += br;
      line += 1;
      recStartLine = line;
      recStartIdx = i;
      fieldStart = true;
      hasContent = false;
      continue;
    }

    if (ch === ',') { fieldStart = true; hasContent = true; i += 1; continue; }
    if (ch !== '"') fieldStart = false;
    hasContent = true;
    i += 1;
  }
  if (recStartIdx < text.length && (hasContent || text.slice(recStartIdx).includes(','))) {
    records.push({ startLine: recStartLine, startIdx: recStartIdx, endIdx: text.length });
  }
  return records.map((r) => ({ startLine: r.startLine, raw: text.slice(r.startIdx, r.endIdx) }));
}
