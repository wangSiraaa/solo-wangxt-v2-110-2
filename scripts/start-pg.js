/**
 * 启动/停止随项目自带的本地 PostgreSQL（无 root 环境下解压的官方 Debian 包）。
 *   node scripts/start-pg.js        启动（如未初始化则先 initdb）
 *   node scripts/start-pg.js stop   停止
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PG = join(ROOT, 'tools', 'pg-debs', 'pg', 'usr', 'lib', 'postgresql', '15');
const BIN = join(PG, 'bin');
const PGDATA = join(ROOT, 'tools', 'pgdata');
const SOCK = '/tmp/pgsock';
const PORT = process.env.PGPORT ?? '55432';
const LOG = join(ROOT, 'tools', 'pg.log');
const env = { ...process.env, LD_LIBRARY_PATH: `${join(PG, 'lib')}:${process.env.LD_LIBRARY_PATH ?? ''}` };

function run(cmd, args) {
  const r = spawnSync(cmd, args, { env, stdio: 'inherit' });
  return r.status ?? 1;
}

if (!existsSync(BIN)) {
  console.error(`PostgreSQL binaries not found at ${BIN}.`);
  console.error('Debian: download postgresql-15 + client debs and extract to tools/pg-debs/pg (见 README).');
  process.exit(1);
}

if (process.argv[2] === 'stop') {
  process.exit(run(join(BIN, 'pg_ctl'), ['-D', PGDATA, '-m', 'fast', 'stop']));
}

mkdirSync(SOCK, { recursive: true });

if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
  if (run(join(BIN, 'initdb'), ['-D', PGDATA, '-U', 'postgres', '-A', 'trust', '--locale=C', '-E', 'UTF8'])) {
    process.exit(1);
  }
  appendFileSync(join(PGDATA, 'postgresql.conf'),
    `\nlisten_addresses='127.0.0.1'\nport=${PORT}\nunix_socket_directories='${SOCK}'\nmax_connections=30\n`);
}

const child = spawn(join(BIN, 'postgres'), ['-D', PGDATA], {
  env, stdio: ['ignore', 'ignore', 'ignore'], detached: true,
});
child.unref();

// 等待就绪
const deadline = Date.now() + 15000;
const ready = () => {
  const r = spawnSync(join(BIN, 'pg_isready'), ['-h', '127.0.0.1', '-p', PORT], { env });
  return r.status === 0;
};
const tick = setInterval(() => {
  if (ready()) {
    clearInterval(tick);
    console.log(`PostgreSQL ready on 127.0.0.1:${PORT} (data: ${PGDATA})`);
  } else if (Date.now() > deadline) {
    clearInterval(tick);
    console.error(`PostgreSQL did not become ready; see ${LOG}`);
    process.exit(1);
  }
}, 300);
