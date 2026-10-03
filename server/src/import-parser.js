/**
 * 遗留栏目映射文件解析器 —— 只在原始字节上工作，绝不因解析过程改动
 * 百分号编码、尾斜杠或追踪参数：
 *
 *  - 输入是 Buffer（HTTP body 原样字节）；只用 TextDecoder('utf-8', {fatal})
 *    解码，坏字节产生逐行 bad_encoding 错误，绝不“替换字符”蒙混；
 *  - 不使用任何会规范化 URL 的库；URL 字段逐字节透传，归一化交给 normalize.js；
 *  - CSV 用自写的最小 RFC4180 状态机（支持引号、转义引号、CRLF、引号内换行），
 *    不做 trim、不改大小写、不解释 '+'、不解码 %XX；
 *  - 每个数据记录都同时保留物理行号区间、记录序号和 raw 原文。
 *
 * 文件格式（当前仅支持 version=1）：
 *
 * CSV（首行必须是版本标记，第二行固定表头）：
 *   # url-migration-import v1
 *   source,target,action,note
 *   http://127.0.0.1:4568/频道/42.html?utm_source=x,http://127.0.0.1:4568/a,redirect,备注
 *   http://127.0.0.1:4568/forum/9,,delete,栏目已删
 *
 * JSON：
 *   { "format_version": 1,
 *     "rows": [ { "source": "...", "target": "...", "action": "redirect", "note": "..." } ] }
 *
 * action 仅允许 redirect（→ mapping_type=manual，必须有 target）与
 * delete（→ mapping_type=deleted，target 可空，语义=旧址自身消亡）。
 */
import { config } from './config.js';

const SUPPORTED_VERSION = config.import.supportedVersion;
const CSV_HEADER = ['source', 'target', 'action', 'note'];

/**
 * 解码结果：
 *  { format, formatVersion, supported, batchErrors: [{code,message,line_no?}],
 *    records: [{ recordNo, lineNo, endLineNo, raw, fields: {source,target,action,note},
 *                encodingError? }] }
 */
export function parseImportFile(buffer, format) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer required');
  return format === 'json' ? parseJson(buffer) : parseCsv(buffer);
}

/* ------------------------------------------------------------------ CSV */

/** 按物理行切分字节（保留行结束符信息），返回 [{no, bytes}]，行号 1-based */
function splitPhysicalLines(buffer) {
  const lines = [];
  let start = 0;
  let no = 1;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) {
      // 吞掉前面的 CR
      const end = i > start && buffer[i - 1] === 0x0d ? i - 1 : i;
      lines.push({ no, bytes: buffer.subarray(start, end) });
      start = i + 1;
      no++;
    }
  }
  if (start < buffer.length) {
    const end = buffer.length > start && buffer[buffer.length - 1] === 0x0d
      ? buffer.length - 1
      : buffer.length;
    lines.push({ no, bytes: buffer.subarray(start, end) });
  }
  return lines;
}

function decodeFatal(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * 最小 RFC4180 字段切分（输入为单条记录的已解码文本）。
 * 返回 { fields, error }；error='unterminated_quote' | 'bad_quote'。
 * 不做 trim / 大小写折叠 / '+' 或 %XX 解释。
 */
function splitCsvRecord(text) {
  const fields = [];
  let cur = '';
  let i = 0;
  let state = 'bare'; // bare | quoted | afterQuote
  while (i < text.length) {
    const ch = text[i];
    if (state === 'bare') {
      if (ch === '"' && cur === '') { state = 'quoted'; i++; continue; }
      if (ch === ',') { fields.push(cur); cur = ''; i++; continue; }
      cur += ch;
      i++;
      continue;
    }
    if (state === 'quoted') {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
        state = 'afterQuote';
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    // afterQuote：闭合引号后只能跟逗号或记录结束
    if (ch === ',') { fields.push(cur); cur = ''; state = 'bare'; i++; continue; }
    return { fields: null, error: 'bad_quote' };
  }
  if (state === 'quoted') return { fields: null, error: 'unterminated_quote' };
  fields.push(cur);
  return { fields, error: null };
}

/**
 * 跨物理行的 CSV 记录扫描：逐物理行 fatal 解码（坏编码即按行报错），
 * 维护引号开合以合并引号内换行的记录。
 */
function scanCsvRecords(physicalLines) {
  const records = [];
  const batchErrors = [];
  let pending = null; // { buf, startLine, encodingError }

  const flush = (endLine) => {
    const { fields, error } = splitCsvRecord(pending.buf);
    records.push({
      lineNo: pending.startLine,
      endLineNo: endLine,
      raw: pending.buf,
      fields: error ? null : fields,
      csvError: error ?? null,
      encodingError: pending.encodingError,
    });
    pending = null;
  };

  for (const line of physicalLines) {
    let text;
    let lineEncodingError = null;
    try {
      text = decodeFatal(line.bytes);
    } catch {
      text = ''; // 坏字节不参与引号判定，错误附到所属记录上
      lineEncodingError = 'bad_encoding';
    }

    if (pending === null) {
      if (line.bytes.length === 0) continue; // 跳过空物理行
      pending = { buf: text, startLine: line.no, encodingError: lineEncodingError };
    } else {
      pending.buf += '\n' + text; // 引号内换行（物理 CR 已剥离，保留换行语义）
      if (lineEncodingError && !pending.encodingError) {
        pending.encodingError = lineEncodingError;
      }
    }
    // 引号已闭合 -> 一条记录结束
    if (!isOddQuotes(pending.buf)) flush(line.no);
  }

  if (pending !== null) {
    const unterminatedStart = pending.startLine;
    const lastNo = physicalLines.length ? physicalLines[physicalLines.length - 1].no : unterminatedStart;
    flush(lastNo);
    batchErrors.push({
      code: 'bad_csv',
      message: '存在未闭合的引号字段（最后一条记录跨物理行未结束）',
      line_no: unterminatedStart,
    });
  }
  return { records, batchErrors };
}

/** 统计未被双写转义的引号数量奇偶（用于判断引号字段是否跨行未闭合） */
function countUnescapedQuotes(text) {
  let n = 0;
  for (let i = 0;i < text.length; i++) {
    if (text[i] === '"') { n++; if (text[i + 1] === '"') i++; }
  }
  return n;
}
function isOddQuotes(text) {
  return countUnescapedQuotes(text) % 2 === 1;
}

function parseVersionMarker(text) {
  const m = /^#\s*url-migration-import\s+v(\d+)\s*$/.exec(text.trim());
  return m ? Number(m[1]) : null;
}

function parseCsv(buffer) {
  const physical = splitPhysicalLines(buffer);
  // 定位首条非空物理行作为版本标记
  let idx = physical.findIndex((l) => l.bytes.length > 0);
  const batchErrors = [];
  let version = null;

  if (idx === -1) {
    return {
      format: 'csv', formatVersion: null, supported: false,
      batchErrors: [{ code: 'empty_file', message: '文件为空' }], records: [],
    };
  }
  const markerLine = physical[idx];
  let markerText;
  try {
    markerText = decodeFatal(markerLine.bytes);
  } catch {
    return {
      format: 'csv', formatVersion: null, supported: false,
      batchErrors: [{
        code: 'bad_encoding',
        message: `版本标记行（第 ${markerLine.no} 行）不是合法 UTF-8`,
        line_no: markerLine.no,
      }],
      records: [],
    };
  }
  version = parseVersionMarker(markerText);
  if (version === null) {
    return {
      format: 'csv', formatVersion: null, supported: false,
      batchErrors: [{
        code: 'missing_version',
        message: '首行必须是版本标记，例如 "# url-migration-import v1"',
        line_no: markerLine.no,
      }],
      records: [],
    };
  }
  if (version !== SUPPORTED_VERSION) {
    return {
      format: 'csv', formatVersion: version, supported: false,
      batchErrors: [{
        code: 'unsupported_version',
        message: `不支持的文件版本 v${version}，当前仅支持 v${SUPPORTED_VERSION}`,
        line_no: markerLine.no,
      }],
      records: [],
    };
  }

  // 表头必须紧随其后（允许空行）
  let h = idx + 1;
  while (h < physical.length && physical[h].bytes.length === 0) h++;
  const restPhysical = physical.slice(h);

  if (restPhysical.length === 0) {
    return {
      format: 'csv', formatVersion: version, supported: true,
      batchErrors: [{ code: 'missing_header', message: '缺少表头行 source,target,action,note' }],
      records: [],
    };
  }
  const headerLine = restPhysical[0];
  let headerText;
  try {
    headerText = decodeFatal(headerLine.bytes);
  } catch {
    return {
      format: 'csv', formatVersion: version, supported: true,
      batchErrors: [{
        code: 'bad_encoding',
        message: `表头行（第 ${headerLine.no} 行）不是合法 UTF-8`,
        line_no: headerLine.no,
      }],
      records: [],
    };
  }
  const { fields: headerFields, error: headerErr } = splitCsvRecord(headerText);
  const normalizedHeader = headerFields?.map((f) => f.trim()) ?? null;
  if (headerErr || JSON.stringify(normalizedHeader) !== JSON.stringify(CSV_HEADER)) {
    return {
      format: 'csv', formatVersion: version, supported: true,
      batchErrors: [{
        code: 'bad_header',
        message: `表头必须为 ${CSV_HEADER.join(',')}（第 ${headerLine.no} 行）`,
        line_no: headerLine.no,
      }],
      records: [],
    };
  }

  const { records, batchErrors: scanErrors } = scanCsvRecords(restPhysical.slice(1));
  batchErrors.push(...scanErrors);

  return {
    format: 'csv',
    formatVersion: version,
    supported: true,
    batchErrors,
    records: records.map((r, i) => {
      const recordNo = i + 1;
      const fields = {};
      if (r.fields) {
        const [source, target, action, note, ...extra] = r.fields;
        fields.source = source;
        fields.target = target;
        fields.action = action;
        fields.note = note;
        fields.extraColumns = extra;
      }
      return { recordNo, lineNo: r.lineNo, endLineNo: r.endLineNo, raw: r.raw, fields, csvError: r.csvError, encodingError: r.encodingError };
    }),
  };
}

/* ----------------------------------------------------------------- JSON */

/** 扫描 rows 数组，返回每个元素的 {raw, startLine, endLine}，不做任何值改动 */
function locateJsonRows(text) {
  const rowsIdx = text.indexOf('"rows"');
  if (rowsIdx === -1) return { error: { code: 'missing_rows', message: 'JSON 缺少 "rows" 数组' } };
  let i = rowsIdx + 6;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== ':') return { error: { code: 'bad_structure', message: '"rows" 后应为冒号' } };
  i++;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '[') return { error: { code: 'bad_structure', message: '"rows" 必须是数组' } };

  const lineOf = (pos) => {
    let n = 1;
    for (let k = 0; k < pos; k++) if (text[k] === '\n') n++;
    return n;
  };

  const out = [];
  const arrStart = i;
  i++; // 进入 [
  let depth = 0;
  let elemStart = null;
  let inStr = false;
  for (; i <= text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{' || ch === '[') {
      if (depth === 0 && ch === '{') elemStart = i;
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0 && ch === '}') {
        out.push({
          raw: text.slice(elemStart, i + 1),
          startLine: lineOf(elemStart),
          endLine: lineOf(i),
        });
        elemStart = null;
      }
      if (depth === -1 && ch === ']' && i > arrStart) break;
      continue;
    }
  }
  return { elements: out };
}

function parseJson(buffer) {
  let text;
  try {
    text = decodeFatal(buffer);
  } catch {
    return {
      format: 'json', formatVersion: null, supported: false,
      batchErrors: [{ code: 'bad_encoding', message: '文件不是合法 UTF-8 字节' }],
      records: [],
    };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return {
      format: 'json', formatVersion: null, supported: false,
      batchErrors: [{ code: 'bad_json', message: `JSON 无法解析：${e.message}` }],
      records: [],
    };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return {
      format: 'json', formatVersion: null, supported: false,
      batchErrors: [{ code: 'bad_structure', message: 'JSON 根必须是对象 { format_version, rows }' }],
      records: [],
    };
  }
  const version = doc.format_version;
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return {
      format: 'json', formatVersion: null, supported: false,
      batchErrors: [{ code: 'missing_version', message: 'JSON 缺少整数 format_version' }],
      records: [],
    };
  }
  if (version !== SUPPORTED_VERSION) {
    return {
      format: 'json', formatVersion: version, supported: false,
      batchErrors: [{
        code: 'unsupported_version',
        message: `不支持的文件版本 v${version}，当前仅支持 v${SUPPORTED_VERSION}`,
      }],
      records: [],
    };
  }
  if (!Array.isArray(doc.rows)) {
    return {
      format: 'json', formatVersion: version, supported: true,
      batchErrors: [{ code: 'missing_rows', message: 'JSON 缺少 "rows" 数组' }],
      records: [],
    };
  }

  const located = locateJsonRows(text);
  const elements = located.elements ?? [];

  const records = doc.rows.map((row, i) => {
    const loc = elements[i];
    const recordNo = i + 1;
    const base = {
      recordNo,
      lineNo: loc?.startLine ?? null,
      endLineNo: loc?.endLine ?? null,
      raw: loc?.raw ?? JSON.stringify(row),
    };
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return { ...base, fields: null, shapeError: 'row_not_object' };
    }
    return {
      ...base,
      fields: {
        source: typeof row.source === 'string' ? row.source : undefined,
        target: typeof row.target === 'string' ? row.target : undefined,
        action: typeof row.action === 'string' ? row.action : undefined,
        note: typeof row.note === 'string' ? row.note : undefined,
      },
    };
  });

  return {
    format: 'json',
    formatVersion: version,
    supported: true,
    batchErrors: located.error ? [located.error] : [],
    records,
  };
}
