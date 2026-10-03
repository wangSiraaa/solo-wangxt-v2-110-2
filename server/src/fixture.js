/**
 * 随项目启动的本地站点：同时模拟“旧站”和“新站”，
 * 绑定 127.0.0.1，仅供验证器访问（外网地址由 verifier 的白名单拒绝）。
 *
 * 路由全部在 catch-all 中按 req.raw.url 自行匹配，避免 Web 框架
 * 隐式解码/大小写折叠，保证演示的就是真实线上行为：
 *  - 路径大小写敏感（/News 与 /news 不同）
 *  - 尾斜杠有意义（/column/weekly 与 /column/weekly/ 不同）
 *  - %2F 不是分隔符（/files%2Fdraft 与 /files/draft 不同）
 *  - 跳转时查询参数（含追踪参数）原样透传
 */
import Fastify from 'fastify';
import { config, fixtureOrigin } from './config.js';

export function buildFixtureApp() {
  const app = Fastify({ logger: { name: 'fixture', level: 'warn' } });

  // FIXTURE_MODE=fixed 模拟“运维按整改单修复旧站配置后”的线上状态：
  // 长链改直跳、环被打断。默认模式保留全部缺陷用于演示检测能力。
  const fixed = process.env.FIXTURE_MODE === 'fixed';

  // 新站正文页
  const newPages = new Set([
    '/articles/tech/42',
    '/articles/tech/77',
    '/articles/123',
    '/sections/weekly',
    '/sections/monday',
    '/files%2Fdraft',
    '/chain/7',
  ]);
  const pageTitles = {
    '/articles/tech/42': '科技频道文章 42',
    '/articles/tech/77': '科技频道文章 77（批量导入新增）',
    '/articles/123': '文章 123（小写 /news 迁入）',
    '/sections/weekly': '周刊栏目',
    '/sections/monday': '周一栏目（尾斜杠旧址迁入）',
    '/files%2Fdraft': '文件名中带斜杠字符的草稿页（编码斜杠是合法文件名）',
    '/chain/7': '长链终点页',
  };

  /**
   * 旧站跳转表：键 = pathname（保留百分号编码原样），值 = 新 pathname。
   * 用原生 onRequest 钩子匹配 req.url，绕过框架路由的解码与大小写处理，
   * 查询串统一透传，确保 utm 等追踪参数不丢。
   */
  const redirects = new Map([
    ['/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html', '/articles/tech/42'],
    ['/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/77.html', '/articles/tech/77'],
    ['/news/123', '/articles/123'],
    ['/column/weekly/', '/sections/weekly'],
    ['/column/monday/', '/sections/monday'],
    ['/old-files%2Fdraft', '/files%2Fdraft'],
    // 修复模式：长链改直跳、环打断；默认模式保留缺陷
    ...(fixed
      ? [
          ['/chain/0', '/chain/7'],
          ['/loop/a', '/articles/tech/42'],
        ]
      : [
          ['/chain/0', '/chain/1'],
          ['/chain/1', '/chain/2'],
          ['/chain/2', '/chain/3'],
          ['/chain/3', '/chain/4'],
          ['/chain/4', '/chain/5'],
          ['/chain/5', '/chain/6'],
          ['/chain/6', '/chain/7'],
          ['/loop/a', '/loop/b'],
        ]),
    ['/loop/b', '/loop/a'],
  ]);

  /** 已删除栏目：永久消失，正确状态是 410 Gone（不是 301 到首页） */
  const gone = new Set(['/forum/announce/9', '/forum/announce/8']);

  function send(res, status, body, extraHeaders = {}) {
    const payload = Buffer.from(body, 'utf8');
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'content-length': payload.length,
      ...extraHeaders,
    });
    res.end(payload);
  }

  app.addHook('onRequest', (req, reply, done) => {
    const raw = req.raw.url ?? '/';
    let u;
    try {
      u = new URL(raw, fixtureOrigin());
    } catch {
      return done();
    }
    const path = u.pathname;       // WHATWG: 保留 %2F 等转义
    const search = u.search;       // 原样透传，含 utm 等追踪参数
    const res = reply.raw;

    if (gone.has(path)) {
      return send(res, 410, `410 Gone: 栏目已删除 (${path})`);
    }
    if (redirects.has(path)) {
      return send(res, path.startsWith('/loop') ? 302 : 301,
        `redirecting to ${redirects.get(path)}${search}`,
        { location: redirects.get(path) + search });
    }
    if (newPages.has(path)) {
      return send(res, 200, `200 OK: ${pageTitles[path]} | query=${search || '(none)'}`);
    }
    // /News/123、/column/weekly（无尾斜杠）、/files/draft 等均落到此：
    // 用来证明大小写、尾斜杠、编码斜杠的差异会得到不同结果。
    return send(res, 404, `404 Not Found: ${path}`);
  });

  // 兜底路由（请求已在钩子中终结）
  app.all('/*', async () => {});

  return app;
}

export async function startFixture() {
  const app = buildFixtureApp();
  await app.listen({ host: config.fixture.host, port: config.fixture.port });
  return app;
}
