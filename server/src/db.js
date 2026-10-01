import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  max: 10,
});

export async function query(text, params) {
  return pool.query(text, params);
}

/** 幂等建库 + 执行 schema.sql */
export async function ensureDatabase() {
  const adminPool = new pg.Pool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: 'postgres',
  });
  try {
    const { rows } = await adminPool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [config.db.database],
    );
    if (rows.length === 0) {
      await adminPool.query(`CREATE DATABASE ${config.db.database}`);
    }
  } finally {
    await adminPool.end();
  }
  const sql = await readFile(join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  await pool.query(sql);
}
