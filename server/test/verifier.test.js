import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from '../src/fixture.js';
import { crawl, judge } from '../src/verifier.js';
import { fixtureOrigin } from '../src/config.js';

const O = fixtureOrigin();
let fixture;

before(async () => { fixture = await startFixture(); });
after(async () => { await fixture.close(); });

test('编码中文路径 + 追踪参数：301 到新页且参数保留', async () => {
  const { verdict, issues, crawl: c } = await judge(
    `${O}/%E9%A2%91%E9%81%93/%E7%A7%91%E6%8A%80/42.html?utm_source=weibo`,
    'manual',
    `${O}/articles/tech/42`,
  );
  assert.equal(c.finalStatus, 200);
  assert.match(c.finalRaw, /utm_source=weibo/);
  assert.equal(c.finalNorm, `${O}/articles/tech/42`, '追踪参数不进归一化键');
  assert.equal(verdict, 'ok', issues.join(';'));
});

test('%2F 编码斜杠可正常访问，解码路径 /files/draft 是另一个资源（404）', async () => {
  const ok = await crawl(`${O}/files%2Fdraft`);
  assert.equal(ok.finalStatus, 200);
  const other = await crawl(`${O}/files/draft`);
  assert.equal(other.finalStatus, 404);
});

test('重定向环被检出', async () => {
  const r = await crawl(`${O}/loop/a`);
  assert.equal(r.loop, `${O}/loop/a`);
  assert.ok(r.hops.at(-1).note === 'loop-repeat');
});

test('超过 5 跳的长链标记 chain_too_long', async () => {
  const { verdict } = await judge(`${O}/chain/0`, 'manual', `${O}/chain/7`);
  assert.equal(verdict, 'chain_too_long');
});

test('已删除栏目 410 判定 deleted_gone_ok', async () => {
  const { verdict } = await judge(`${O}/forum/announce/9`, 'deleted', null);
  assert.equal(verdict, 'deleted_gone_ok');
});

test('大小写错误的路径最终 404', async () => {
  const { verdict } = await judge(`${O}/News/123`, 'manual', `${O}/articles/123`);
  assert.equal(verdict, 'final_status_bad');
});

test('白名单：外网地址直接拒绝，绝不发起请求', async () => {
  const r = await crawl('http://example.com/x');
  assert.equal(r.blocked, true);
  assert.equal(r.hops.length, 0);
});

test('白名单：即便本地站点，其它端口也拒绝（SSRF 防护）', async () => {
  const r = await crawl('http://127.0.0.1:80/');
  assert.equal(r.blocked, true);
});
