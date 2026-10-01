/**
 * 验证器：真实发起 HTTP 请求，只允许访问随项目启动的本地站点。
 *
 * 安全边界：
 *  - allowlist 为 fixture 的 host:port（127.0.0.1:固定端口）；
 *  - 每一跳拿到 Location 后都用 WHATWG URL 重新解析并再次过白名单，
 *    防止跳转到内网其它端口或外网（SSRF 防护）；
 *  - DNS 不参与：主机名必须就是字面 IP，不做解析、不跟随重定向到主机名。
 *
 * 检测项：
 *  - redirect_loop：规范化后的 URL 在本链中重复出现；
 *  - chain_too_long：跳数达到 maxRedirects 仍未终结；
 *  - fetch_error：连接/超时错误；
 *  - final_status_bad：最终页不是 2xx；
 *  - deleted_gone_ok / deleted_not_gone：已删除栏目必须 410（也接受 404）；
 *  - tracker_preserved：入口上的追踪参数必须出现在最终 URL。
 */
import http from 'node:http';
import { config, fixtureOrigin } from './config.js';
import { normalize, splitQuery } from './normalize.js';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function allowed(u) {
  return (
    u.protocol === 'http:' &&
    u.hostname === config.fixture.host &&
    u.port === String(config.fixture.port)
  );
}

function fetchOnce(rawUrl) {
  return new Promise((resolve) => {
    const req = http.get(
      rawUrl,
      { timeout: config.crawl.timeoutMs, headers: { connection: 'close' } },
      (res) => {
        res.resume(); // 丢弃响应体，只关心状态与头
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            location: res.headers.location ?? null,
            error: null,
          }),
        );
        res.on('error', (e) => resolve({ status: null, location: null, error: e.message }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: null, location: null, error: e.message }));
  });
}

/**
 * 跟随跳转链。
 * @param {string} entryRaw 入口原始 URL
 * @returns {Promise<object>} hops / loop / chainTooLong / final* / sourceTrackers
 */
export async function crawl(entryRaw) {
  const entry = new URL(entryRaw);
  if (!allowed(entry)) {
    return {
      blocked: true,
      hops: [],
      issues: [`refused: ${entry.host} 不在随项目启动的本地站点白名单内`],
      sourceTrackers: [...new Set(splitQuery(entry.search).trackers.keys())],
    };
  }

  const sourceTrackers = new Set(splitQuery(entry.search).trackers.keys());
  const hops = [];
  const seen = new Set();
  let currentRaw = entryRaw;
  let loop = null;
  let chainTooLong = false;
  let blocked = false;

  // 最多发起 maxRedirects+1 次请求（入口 + N 跳）
  for (let i = 0; i <= config.crawl.maxRedirects; i++) {
    const curNorm = normalize(currentRaw);
    const key = curNorm.ok ? curNorm.normKey : currentRaw;
    if (seen.has(key)) {
      loop = key;
      hops.push({
        index: i,
        url_raw: currentRaw,
        url_norm: key,
        status: null,
        location_raw: null,
        is_redirect: true,
        note: 'loop-repeat',
      });
      break;
    }
    seen.add(key);

    const res = await fetchOnce(currentRaw);
    const isRedirect = res.status != null && REDIRECT_STATUSES.has(res.status);
    let locNorm = null;
    if (res.location != null) {
      try {
        locNorm = new URL(res.location, currentRaw);
      } catch {
        locNorm = null;
      }
    }

    hops.push({
      index: i,
      url_raw: currentRaw,
      url_norm: key,
      status: res.status,
      location_raw: res.location ?? null,
      location_norm: locNorm ? normalize(locNorm.toString()).normKey : null,
      is_redirect: isRedirect,
      fetch_error: res.error,
    });

    if (res.error) break;
    if (!isRedirect || !res.location) break; // 链终结

    // 下一跳：重新过白名单（防 SSRF 跳到外网/其它内网服务）
    if (!locNorm || !allowed(locNorm)) {
      blocked = true;
      hops[hops.length - 1].note = 'redirect target refused by allowlist';
      break;
    }
    currentRaw = locNorm.toString();

    if (i === config.crawl.maxRedirects) {
      chainTooLong = true;
    }
  }

  // 在预算的最后一跳仍收到 Location：链过长（未在上面的循环里标记时兜底）
  const last = hops[hops.length - 1];
  if (!loop && !blocked && last?.is_redirect && last.location_raw && !last.note) {
    chainTooLong = true;
  }

  return {
    hops,
    loop,
    chainTooLong,
    blocked,
    finalRaw: loop ? null : last?.is_redirect ? null : last?.url_raw ?? null,
    finalNorm: loop ? null : last?.url_norm ?? null,
    finalStatus: loop || last?.is_redirect ? null : last?.status ?? null,
    sourceTrackers: [...sourceTrackers],
  };
}

/** 追踪参数是否全部到达最终 URL */
export function checkTrackers(finalRaw, wantedKeys) {
  if (!wantedKeys.length) return { ok: true, detail: '入口无追踪参数' };
  if (!finalRaw) return { ok: false, detail: '没有可达最终页，追踪参数无法保留' };
  const got = new Set(splitQuery(new URL(finalRaw).search).trackers.keys());
  const missing = wantedKeys.filter((k) => !got.has(k));
  return {
    ok: missing.length === 0,
    detail: missing.length ? `最终页丢失追踪参数: ${missing.join(', ')}` : '追踪参数已保留',
  };
}

/** 针对一条映射给出裁决；mappingType=deleted 时期望 410/404 */
export function judge(entryRaw, mappingType, expectedTargetNorm) {
  return crawl(entryRaw).then((r) => {
    const issues = [];
    let verdict;

    if (r.blocked) {
      verdict = 'fetch_error';
      for (const h of r.hops) if (h.note) issues.push(h.note);
      for (const m of r.issues ?? []) issues.push(m);
    } else if (r.loop) {
      verdict = 'redirect_loop';
      issues.push(`重定向环：${r.loop} 在链中重复`);
    } else if (r.chainTooLong) {
      verdict = 'chain_too_long';
      issues.push(`跳转链超过上限 ${config.crawl.maxRedirects} 跳仍未终结`);
    } else if (r.finalStatus == null) {
      verdict = 'fetch_error';
      issues.push('未能取得最终状态码（连接错误/超时）');
    } else if (mappingType === 'deleted') {
      if (r.finalStatus === 410 || r.finalStatus === 404) {
        verdict = 'deleted_gone_ok';
      } else {
        verdict = 'deleted_not_gone';
        issues.push(`已删除栏目最终状态为 ${r.finalStatus}，期望 410/404`);
      }
    } else {
      const statusOk = r.finalStatus >= 200 && r.finalStatus < 300;
      // 落点必须与映射目标严格一致（含尾斜杠、编码形式、身份查询参数）
      const targetOk = expectedTargetNorm ? r.finalNorm === expectedTargetNorm : true;
      const tracker = checkTrackers(r.finalRaw, r.sourceTrackers);
      if (!statusOk) {
        verdict = 'final_status_bad';
        issues.push(`最终页面状态 ${r.finalStatus} 非 2xx`);
      } else if (!targetOk) {
        verdict = 'final_status_bad';
        issues.push(`最终落点 ${r.finalNorm} 与映射目标 ${expectedTargetNorm} 不一致`);
      } else if (!tracker.ok) {
        verdict = 'final_status_bad';
        issues.push(tracker.detail);
      } else {
        verdict = 'ok';
      }
      if (tracker.detail && verdict === 'ok') issues.push(tracker.detail);
      return { verdict, issues, crawl: r, tracker };
    }

    return {
      verdict,
      issues,
      crawl: r,
      tracker: checkTrackers(r.finalRaw, r.sourceTrackers),
    };
  });
}

export { fixtureOrigin };
