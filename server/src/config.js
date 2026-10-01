/**
 * 全局配置。所有“规范化规则”集中在此处，规则必须显式、可审计，
 * 不允许在代码其它地方临时做 decode 后合并资源。
 */

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  api: {
    host: process.env.HOST ?? '127.0.0.1',
    port: num(process.env.PORT, 4567),
  },
  /** 随项目一起启动的“本地站点”（被迁移的旧站 + 新站模拟） */
  fixture: {
    host: process.env.FIXTURE_HOST ?? '127.0.0.1',
    port: num(process.env.FIXTURE_PORT, 4568),
  },
  db: {
    host: process.env.PGHOST ?? '127.0.0.1',
    port: num(process.env.PGPORT, 55432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.PGDATABASE ?? 'url_migration',
  },
  /**
   * 规范化规则（WHATWG URL 解析器）：
   * 1. scheme / host 小写；默认端口去除（URL 标准行为）
   * 2. 路径大小写敏感，不做大小写折叠
   * 3. 百分号编码：只做大小写规范化（%2f -> %2F），绝不解码；
   *    原始 UTF-8 字符由 WHATWG 解析器以 UTF-8 编码
   * 4. %2F（编码斜杠）不视为路径分隔符，/a%2Fb 与 /a/b 是不同资源
   * 5. 尾斜杠默认保留（strict）；tailSlashMode=ignore 仅影响“查表键”，
   *    因此产生的合并会被标记为 ambiguity，不会静默合并
   * 6. 查询参数：非追踪参数参与资源身份；追踪参数（TRACKER_PARAMS）
   *    不参与身份判定、但在跟随跳转时原样保留到最终 URL
   * 7. fragment 不参与身份，直接丢弃
   */
  rules: {
    scheme: 'http:',
    tailSlashMode: process.env.TRAILING_SLASH_MODE ?? 'keep', // keep | ignore
    dropFragment: true,
    /** 追踪参数：不影响身份，但迁移时必须保留 */
    trackerParams: [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'spm', 'from',
    ],
    /** 未登记的查询参数一律视为资源身份的一部分（保守策略） */
    unknownQueryIsIdentity: true,
  },
  crawl: {
    /** 最长跳转链（超过即标记 chain_too_long，不再继续请求） */
    maxRedirects: num(process.env.MAX_REDIRECTS, 5),
    timeoutMs: num(process.env.HTTP_TIMEOUT_MS, 4000),
  },
};

export function fixtureOrigin() {
  return `http://${config.fixture.host}:${config.fixture.port}`;
}
