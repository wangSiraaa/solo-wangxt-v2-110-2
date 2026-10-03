/**
 * 测试环境隔离（workflow 槽位）：必须作为测试文件的第一行导入。
 * 数据库由 scripts/prepare-test-db.js 预先创建并套用 schema。
 */
process.env.FIXTURE_PORT = '46082';
process.env.PGDATABASE = 'url_migration_test_workflow';
process.env.PGPORT = process.env.PGPORT ?? '55432';
process.env.PGHOST = process.env.PGHOST ?? '127.0.0.1';
