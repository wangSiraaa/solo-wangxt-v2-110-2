/**
 * 测试环境隔离：node:test 默认并行运行各测试文件，每个需要 fixture/DB 的
 * 文件必须使用各自的本地站点端口与数据库。
 *
 * 本模块只做一件事：在 config.js 被求值之前设置环境变量。
 * 必须作为测试文件的【第一行导入】，例如：
 *   import './use-test-env-api.js';
 *   import { test } from 'node:test';
 *
 * 数据库由 scripts/prepare-test-db.js 预先创建并套用 schema。
 */
process.env.FIXTURE_PORT = '46083';
process.env.PGDATABASE = 'url_migration_test_api';
process.env.PGPORT = process.env.PGPORT ?? '55432';
process.env.PGHOST = process.env.PGHOST ?? '127.0.0.1';
