/** 建库 + 应用 schema：npm run migrate */
import { ensureDatabase, pool } from './db.js';

try {
  await ensureDatabase();
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' ORDER BY table_name`);
  console.log('schema applied. tables:', rows.map((r) => r.table_name).join(', '));
} catch (e) {
  console.error('migrate failed:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
