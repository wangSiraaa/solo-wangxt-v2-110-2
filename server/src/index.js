/**
 * 工作台服务入口：
 *  1. 先启动随项目的本地模拟站点（127.0.0.1:4568）
 *  2. 确保数据库 schema 就绪
 *  3. 启动 Fastify API（127.0.0.1:4567），并托管 web 构建产物
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { ensureDatabase, pool } from './db.js';
import { startFixture } from './fixture.js';
import apiRoutes from './routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const fixture = await startFixture();
  await ensureDatabase();

  const app = Fastify({ logger: { name: 'workbench', level: 'info' } });
  await app.register(apiRoutes);
  const dist = join(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'api not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ host: config.api.host, port: config.api.port });
  app.log.info(`API:  http://${config.api.host}:${config.api.port}/api/health`);
  app.log.info(`本地站点（唯一允许验证的目标）: http://${config.fixture.host}:${config.fixture.port}`);

  const shutdown = async () => {
    await app.close();
    await fixture.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('startup failed:', e);
  process.exit(1);
});
