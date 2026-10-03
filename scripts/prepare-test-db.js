/**
 * 准备并行测试所需的独立数据库（每个测试文件一个），并套用 schema。
 * 幂等：库已存在则只补 schema（schema.sql 全部 IF NOT EXISTS / CREATE OR REPLACE）。
 * 运行：npm run pretest（npm test 会自动先执行）
 */
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../server/src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DBS = ['url_migration_test_verifier', 'url_migration_test_workflow', 'url_migration_test_api'];

const admin = new pg.Pool({
  host: config.db.host, port: config.db.port,
  user: config.db.user, password: config.db.password, database: 'postgres',
});

try {
  for (const name of TEST_DBS) {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
    if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
    const p = new pg.Pool({ ...config.db, database: name });
    const sql = await readFile(join(__dirname, '..', 'server', 'sql', 'schema.sql'), 'utf8');
    await p.query(sql);
    await p.end();
    console.log(`test db ready: ${name}`);
  }
} catch (e) {
  console.error('prepare-test-db failed:', e.message);
  process.exitCode = 1;
} finally {
  await admin.end();
}
