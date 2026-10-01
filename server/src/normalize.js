/**
 * URL 规范化 —— 基于 WHATWG URL（Node 的全局 URL），不手写解析。
 *
 * 关键纪律（对应 config.rules）：
 *  - 绝不 decodeURIComponent 后再比较/合并路径段；
 *    /café、/caf%C3%A9 经 WHATWG 解析后 pathname 均为 /caf%C3%A9，
 *    而 /a%2Fb 的 %2F 不会被当作分隔符。
 *  - 路径大小写敏感：/News 与 /news 是不同键。
 *  - 尾斜杠默认保留；仅在 tailSlashMode='ignore' 时从“查表键”去掉，
 *    且因此产生的合并不静默处理，由歧义检测负责。
 *  - 查询参数按字节身份：追踪参数剥离后再排序比较，其它参数（含值的
 *    百分号编码形式）原样保留，顺序仅用于生成稳定键。
 *  - fragment 不参与身份。
 */
import { config } from './config.js';

const TRACKERS = new Set(config.rules.trackerParams);

/** 百分号三元组的十六进制位统一大写（%2f -> %2F），其余字节不动 */
function canonicalizePercentEscapes(str) {
  return str.replace(/%[0-9a-fA-F]{2}/g, (m) => '%' + m.slice(1).toUpperCase());
}

function normalizePathname(pathname, mode) {
  // WHATWG URL 已把原始 UTF-8 字符百分号编码、保留已有转义；只统一大小写。
  let p = canonicalizePercentEscapes(pathname);
  if (p === '') p = '/';
  if (mode === 'ignore' && p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p;
}

/**
 * 拆分查询串：返回 { identity: [[k,v],...], trackers: Map<k, v[]> }
 * 不做任何解码；'+' 不视为空格；只按 '=' 切一次。
 */
export function splitQuery(search, trackerSet = TRACKERS) {
  const identity = [];
  const trackers = new Map();
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (raw === '') return { identity, trackers };
  for (const part of raw.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? '' : part.slice(eq + 1);
    if (trackerSet.has(k)) {
      if (!trackers.has(k)) trackers.set(k, []);
      trackers.get(k).push(v);
    } else {
      identity.push([k, v]);
    }
  }
  return { identity, trackers };
}

function stableIdentityQuery(identity) {
  return identity
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('&');
}

/**
 * 规范化一个绝对 URL。
 * @param {string} raw
 * @param {{base?: string}} [opts] base 仅用于校验/相对补全，默认 fixtureOrigin
 * @returns {{
 *   ok: boolean, error?: string, href: string, normKey: string,
 *   pathname: string, identityQuery: string, trackerParams: [string,string[]][],
 *   trackerRaw: string, host: string, port: string
 * }}
 */
export function normalize(rawInput, opts = {}) {
  if (typeof rawInput !== 'string' || rawInput.trim() === '') {
    return { ok: false, error: 'empty url' };
  }
  let u;
  try {
    u = new URL(rawInput, opts.base);
  } catch (e) {
    return { ok: false, error: `parse error: ${e.message}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `unsupported scheme: ${u.protocol}` };
  }

  const mode = opts.tailSlashMode ?? config.rules.tailSlashMode;
  const pathname = normalizePathname(u.pathname, mode);
  const fullPathname = normalizePathname(u.pathname, 'keep');

  const { identity, trackers } = splitQuery(u.search);
  const idq = stableIdentityQuery(identity);

  // 完整规范化 href：保留所有原始（非归一化大小写）形式的证据用 u.href 另存；
  // 这里生成“规范 href”——身份查询 + 追踪查询，全部保留。
  const normHref =
    `${u.protocol}//${u.host}${fullPathname}` +
    (u.search ? u.search : '');

  // 查表键：host + 规则化路径 + 排序后的身份查询；不含追踪参数/fragment。
  const normKey =
    `${u.protocol}//${u.host.toLowerCase()}${pathname}` +
    (idq ? `?${idq}` : '');

  return {
    ok: true,
    href: normHref,
    normKey,
    pathname,
    identityQuery: idq,
    trackerParams: [...trackers.entries()],
    trackerRaw: u.search, // 含全部参数的原始查询（跟随跳转时保留追踪参数）
    host: u.hostname.toLowerCase(),
    port: u.port,
  };
}

/**
 * 将“追踪参数”从旧 URL 合并到目标 URL 上（迁移跳转必须保留追踪参数）。
 * 不触碰目标上已有的非追踪参数；同名追踪参数以源侧为准。
 */
export function carryTrackers(sourceRaw, targetRaw) {
  const s = new URL(sourceRaw);
  const t = new URL(targetRaw);
  const { trackers } = splitQuery(s.search);
  const existing = splitQuery(t.search);
  const keptTrackers = new Map(existing.trackers);
  for (const [k, vals] of trackers) keptTrackers.set(k, vals);
  const parts = [
    ...existing.identity.map(([k, v]) => `${k}=${v}`),
    ...[...keptTrackers.entries()].flatMap(([k, vals]) => vals.map((v) => `${k}=${v}`)),
  ];
  t.search = parts.length ? `?${parts.join('&')}` : '';
  return t.toString();
}
