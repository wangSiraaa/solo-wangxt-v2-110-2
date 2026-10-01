/**
 * 歧义检测：多个不同“旧址写法”经规则规范化后落到同一个 source_norm，
 * 却声明了不同的 target_norm —— 绝不能静默取其中一个覆盖。
 *
 * 注意区分两种“多对一”：
 *  - 同 source_norm + 同 target_norm：只是书写变体（如 %2f/%2F、
 *    追踪参数有无），属于同一资源，允许；
 *  - 同 source_norm + 不同 target_norm：真正歧义，阻断发布。
 */
import { normalize } from './normalize.js';

export function analyzeInputs(inputs) {
  const groups = new Map();
  for (const row of inputs) {
    const s = normalize(row.source_raw);
    const t = normalize(row.target_raw);
    if (!s.ok || !t.ok) {
      throw new Error(`bad url in input id=${row.id}: ${s.error || t.error}`);
    }
    if (!groups.has(s.normKey)) groups.set(s.normKey, []);
    groups.get(s.normKey).push({ ...row, s, t });
  }
  const ambiguous = [];
  for (const [sourceNorm, items] of groups) {
    const targets = new Set(items.map((i) => i.t.normKey));
    if (targets.size > 1) {
      ambiguous.push({
        source_norm: sourceNorm,
        variants: items.map((i) => ({
          source_raw: i.source_raw,
          target_raw: i.target_raw,
          target_norm: i.t.normKey,
          mapping_type: i.mapping_type,
        })),
        target_norms: [...targets],
      });
    }
  }
  return { groups, ambiguous };
}
