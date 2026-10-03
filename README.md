# URL 迁移验证工作台（Vue 3 + Fastify + PostgreSQL）

内容平台更换栏目结构时，技术负责人需要回答一个问题：**旧链接最终会落到哪里、最终页面状态是什么**。
本项目把“填映射表”和“迁移完成”严格区分开——每条映射只有经过真实 HTTP 请求验证、
拿到逐跳证据并通过发布闸门，才允许发布。

## 它保证了什么

1. **WHATWG URL 规范化**（`server/src/normalize.js`），规则集中、显式：
   - 路径**大小写敏感**：`/News/123` ≠ `/news/123`；
   - 百分号编码只统一十六进制大小写（`%2f→%2F`），**绝不 decode 后合并**；
     原始中文按 UTF-8 编码，`/a%2Fb` 与 `/a/b` 是不同资源；
   - **尾斜杠保留**：`/column/weekly/` ≠ `/column/weekly`；
   - 查询参数：非追踪参数参与资源身份；追踪参数（utm_*、gclid 等）不参与身份，
     但迁移跳转时**原样带到最终 URL**；fragment 丢弃。
2. **只验证随项目启动的本地站点**：白名单 `127.0.0.1:4568`，每一跳的 `Location`
   重新解析并重新过白名单，外网/其它端口一律拒绝（防 SSRF，见 `server/src/verifier.js`）。
3. **检测重定向环、过长链（>5 跳）、多旧址归一后的歧义**：
   - 环：归一化 URL 在同链中重复即停；
   - 长链：超过预算仍给 Location 即 `chain_too_long`；
   - 歧义：多个录入归一到同一键却指向不同目标 → `conflicted`，不挑赢家、阻断发布。
4. **最终页面状态必须核实**：普通迁移期望最终 2xx 且落点严格等于映射目标；
   已删除栏目期望 **410 Gone**（接受 404），不允许 301 到首页蒙混。
5. **PostgreSQL 保存三类数据**：旧新映射（原始材料 `mapping_inputs` + 生效表
   `url_mappings`）、爬取逐跳结果（`crawl_results`）、迁移方案（`migration_plans`
   / `migration_plan_items`），另存每入口最终裁决 `verification_verdicts`。
6. **只接收本地文件的批量导入工作流**（`server/src/import-parser.js` +
   `import-service.js`，批次表 `import_batches` / `import_batch_rows` /
   `import_resolutions` / `import_audit_log`）：
   - 上传口只听回环、body 必须是 `application/octet-stream` **原始字节**：
     自写最小 RFC4180 CSV 状态机 + `TextDecoder('utf-8', {fatal})`，
     解析过程绝不 decode `%XX`、不折叠尾斜杠、不解释 `+`、不动追踪参数；
   - 文件须自述版本（首行 `# url-migration-import v1` 或 JSON `format_version`），
     版本不支持/结构无法解析→批次 `rejected`，不产生任何暂存行；
   - 先在**暂存区**按现有 WHATWG 规则逐行预览（原始值与规范化结果并列），
     再原子提交所选行；任一行坏编码/坏 CSV/未知动作/坏 URL/**目标不在允许的本地
     迁移范围**→逐行错误且整批不可提交，未提交数据绝不触碰生效映射；
   - **同 canonical key 不同 target（文件内或与当前库）显式成为冲突**，
     必须人工点选唯一胜出目标；未裁决不会被验证器请求、也不能提交；
   - **相同文件重试幂等**：以 `sha256(原始字节)` 为内容摘要，重复上传直接返回
     既有批次，不新增映射或暂存行；
   - 批次保存**格式版本、内容摘要、原始字节/逐行原文、解析状态、操作者选择**，
     全部动作（上传/改选/裁决/提交）写审计日志，刷新后可追溯；
   - 提交改变某键目标时该映射 `revision+1`，**旧验证证据标 `stale`、方案条目退回
     pending**，发布闸门要求按新版本重新验证（填表不等于迁移完成）。

## 快速开始

本仓库在无 root 环境中携带了从 Debian 官方包解压的 PostgreSQL 15（arm64，
位于 `tools/`）。如目录不存在，见文末“自备 PostgreSQL”。

```bash
npm install
npm run pg:start        # 启动 tools/ 下的本地 PostgreSQL（127.0.0.1:55432）
npm run migrate         # 建库 + 建表
npm run seed            # 写入 10 条演示录入（含全部异常场景）

npm test                # 56 项测试：规范化规则 + 验证器 + 批量导入（解析/工作流/HTTP 闸门）
                        # 各 DB 集成测试使用独立库（pretest 自动建库套 schema）与独立 fixture 端口
npm run verify          # CLI：对全部映射真实请求验证并给出裁决
node scripts/report.js  # 产出 docs/verification-report-before.md 风格的证据报告

npm start               # 本地站点 + API + 已构建的前端
                        # 工作台 http://127.0.0.1:4567 （仅监听 127.0.0.1）
```

前端开发模式：`npm run dev:web`（Vite :5173，`/api` 代理到 4567）。

## 演示场景（`server/src/seed.js` + `server/src/fixture.js`）

| 场景 | 旧址 | 预期 |
|---|---|---|
| 编码中文路径 + 追踪参数 | `/频道/科技/42.html?utm_source=weibo` | 301→新页 200，追踪参数保留 |
| 正确小写路径 | `/news/123` | 通过 |
| 尾斜杠是身份 | `/column/weekly/` | 通过；无斜杠写法 404 |
| 编码斜杠 | `/old-files%2Fdraft` | 通过；`/files/draft` 是另一个资源（404） |
| 已删除栏目 | `/forum/announce/9` | **410 Gone** |
| 重定向环 | `/loop/a ↔ /loop/b` | `redirect_loop` |
| 过长链（7 跳） | `/chain/0 … /chain/7` | `chain_too_long` |
| 归一化歧义 | 同键 `/news/123` 指向 123 与 999 | `ambiguity`，不生效不请求 |
| 外网地址 | `http://example.com/...` | 白名单拒绝，**不发起请求** |
| 大小写错误 | `/News/123` | 最终 404，验证失败 |

## “填完表 ≠ 迁移完成”的完整闭环

```bash
# 1) 整改前：验证失败、报告记录受影响链接与证据（docs/verification-report-before.md）
npm run seed && npm run verify
#  → 共 9 条，通过 4，阻断 5（环/长链/404/歧义/越权）

# 2) 业务与运维修复：
#    - 站点侧打断环、长链改直跳（FIXTURE_MODE=fixed 模拟已上线配置）
#    - scripts/remediate.js：裁决歧义、剔除错误录入和非本站地址、更新映射目标
FIXTURE_MODE=fixed node scripts/remediate.js
FIXTURE_MODE=fixed npm run verify
#  → 共 7 条，全部通过（含 1 条已删除正确 410）

# 3) 整改后证据报告
FIXTURE_MODE=fixed node scripts/report.js
#  → docs/verification-report.md（passed=7 blocked=0）
```

工作台里的“迁移方案”也遵循同样闸门：纳入方案只是 `pending`，
`build` 时按最新裁决标注 `verified/blocked`；`publish` 时只要存在
blocked/pending、未纳入的生效映射或未裁决歧义，就返回 **409 + 受影响链接清单**。

## API 摘要

| 方法/路径 | 作用 |
|---|---|
| `POST /api/normalize` | 规范化试算（不写库） |
| `GET/POST /api/mappings` | 原始录入材料 / 录入一条（自动重算生效与冲突） |
| `POST /api/verify` | 对全部（或指定 `source_norm`）真实验证 |
| `GET /api/crawl/:key` | 查看某条链接的逐跳证据 |
| `GET/POST /api/plans`、`POST /api/plans/:id/build`、`POST /api/plans/:id/publish` | 方案与发布闸门 |
| `GET /api/imports/scope` | 支持版本、字节上限、允许的本地迁移 origin、追踪参数清单 |
| `GET /api/imports`、`GET /api/imports/:id`、`.../:id/audit` | 批次列表 / 暂存详情（含逐行预览、冲突候选、裁决）/ 审计轨迹 |
| `POST /api/imports?format=csv\|json&filename&actor` | **原始字节**上传（仅回环，octet-stream）；201 新批次、200 同摘要幂等、422 含逐行错误或 rejected |
| `POST /api/imports/:id/selection` | 逐行选择/取消选择 `{selections:[{record_no,selected}]}` |
| `POST /api/imports/:id/resolve` | 冲突键显式裁决 `{source_norm, winner_target_norm}`（不自动挑赢家） |
| `POST /api/imports/:id/commit` | 原子提交所选行；坏行→409 `rows_invalid`、未裁决→409 `unresolved_conflicts` |

## 批量导入文件格式（v1）

只接收来自本机工作台的文件，`source`/`target` 的真实写法（百分号编码、尾斜杠、
追踪参数）逐字节保留：

```csv
# url-migration-import v1
source,target,action,note
http://127.0.0.1:4568/%E9%A2%91%E9%81%93/42.html?utm_source=weibo,http://127.0.0.1:4568/articles/tech/42,redirect,中文路径+投放参数
http://127.0.0.1:4568/forum/gone/9,,delete,已删除栏目（target 留空，语义为旧址 410/404）
```

```json
{ "format_version": 1,
  "rows": [
    { "source": "http://127.0.0.1:4568/a?utm_source=x", "target": "http://127.0.0.1:4568/b",
      "action": "redirect", "note": "..." }
  ] }
```

- `action` 仅允许 `redirect`（→ manual，target 必填且必须在本地迁移白名单）与
  `delete`（→ deleted，target 必须为空，表示旧址自身消亡）；
- 示例文件见 `server/fixtures-import/`（合法、文件内冲突、坏编码、未知动作、JSON）。

## 环境变量（见 `.env.example`）

`HOST/PORT`（API）、`FIXTURE_HOST/PORT`（本地站点）、`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`、
`TRAILING_SLASH_MODE`（默认 `keep`）、`MAX_REDIRECTS`（默认 5）、`HTTP_TIMEOUT_MS`、
`FIXTURE_MODE`（`fixed` = 模拟整改后站点）、
`IMPORT_MAX_BYTES`（导入文件字节上限，默认 5MiB）、
`IMPORT_ALLOWED_ORIGINS`（逗号分隔的额外允许迁移目标 origin；默认仅本地 fixture）。

## 自备 PostgreSQL

若 `tools/` 不存在，在 Debian/Ubuntu 上可由无 root 方式取得二进制：

```bash
mkdir -p tools/pg-debs && cd tools/pg-debs
curl -O http://deb.debian.org/debian/pool/main/p/postgresql-15/postgresql-15_15.18-0+deb12u1_arm64.deb
curl -O http://deb.debian.org/debian/pool/main/p/postgresql-15/postgresql-client-15_15.18-0+deb12u1_arm64.deb
mkdir pg && cd pg && ar x ../postgresql-15_*.deb && tar xf data.tar.xz
cd .. && mkdir pg-client && cd pg-client && ar x ../postgresql-client-15_*.deb && tar xf data.tar.xz
cd /workspace && npm run pg:start
```

其它架构（amd64 等）把 deb 文件名中的 `arm64` 替换即可。也可改用系统 PostgreSQL，
用上述 `PG*` 环境变量指向它（脚本不会触碰你已有的实例，只创建 `url_migration` 库）。

## 目录

```
server/src/   normalize.js(规范化规则) verifier.js(白名单/环/长链/最终状态)
              ambiguity.js mappings-service.js(重算/revision/证据过期)
              import-parser.js(字节级 CSV/JSON 解析) import-service.js(暂存/裁决/原子提交/审计)
              verify-runner.js(证据代次)
              fixture.js(随项目本地站点) routes.js(Fastify) db.js
server/sql/   schema.sql（含 import_batches/_rows/_resolutions/_audit_log、revision、stale、excluded）
web/          Vue 3 + Vite 工作台（总览/证据/批量导入/方案闸门/规则）
scripts/      start-pg.js prepare-test-db.js remediate.js report.js
server/fixtures-import/  批量导入示例（合法/冲突/坏编码/未知动作/JSON）
docs/         verification-report-before.md / -after.md（真实跑出来的证据）
server/test/  规则单测 + 验证器 + 导入解析/工作流/HTTP 闸门（56 项）
```
