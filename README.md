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

## 快速开始

本仓库在无 root 环境中携带了从 Debian 官方包解压的 PostgreSQL 15（arm64，
位于 `tools/`）。如目录不存在，见文末“自备 PostgreSQL”。

```bash
npm install
npm run pg:start        # 启动 tools/ 下的本地 PostgreSQL（127.0.0.1:55432）
npm run migrate         # 建库 + 建表
npm run seed            # 写入 10 条演示录入（含全部异常场景）

npm test                # 36 项测试：规范化、验证器集成、导入解析字节保真与暂存/提交/冲突/过期
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
| `GET/POST /api/mappings` | 原始录入材料 / 录入一条（自动重算生效与冲突；强制本地范围） |
| `POST /api/imports?format=csv\|json` | **上传本地文件字节到暂存区**（幂等：sha256 相同返回原批次） |
| `GET /api/imports` / `GET /api/imports/:id` | 批次列表 / 批次+原始行+选择+审计（刷新可追溯） |
| `POST /api/imports/:id/rows/:rowId/selection` | 操作者选择：`selected` / `ignored` / `pending`（冲突显式裁决） |
| `POST /api/imports/:id/commit` | **原子提交所选行**；错误行/未裁决冲突 → 409 且零写入 |
| `POST /api/imports/:id/abandon` | 放弃暂存批次（留痕，不可再提交） |
| `POST /api/verify` | 对全部（或指定 `source_norm`）真实验证；证据绑定映射版本 |
| `GET /api/crawl/:key` | 查看某条链接的逐跳证据 |
| `GET/POST /api/plans`、`POST /api/plans/:id/build`、`POST /api/plans/:id/publish` | 方案与发布闸门（过期证据阻断发布） |

## 本地文件批量导入工作流

只接收浏览器在本机读取的**文件字节**（`POST` body 原样字节，不收 URL、不读服务端路径、
不走 multipart 重编码），纪律与手工录入一致：

1. **逐字节留证**：原始行写入 `import_rows.raw_line`（只去行终止符/BOM），
   百分号编码不 decode、尾斜杠保留、utm 等追踪参数不删不改；
   WHATWG 规范化只生成预览列（`source_norm`/`target_norm`），绝不回写原始列。
2. **批次元数据**：`import_batches` 保存格式版本（v1）、文件格式、文件名、
   **内容摘要 sha256**、字节数、内容摘要 JSON、操作者、时间戳。
3. **暂存预览 + 冲突显式化**：文件内或与当前库同 canonical key 不同目标，
   行级标记 `within_file` / `with_library` / `both`，列出全部候选目标，**系统不挑赢家**。
4. **原子提交**：任一行格式损坏（坏编码/未知动作/越界/版本不支持）或冲突未显式裁决，
   整批 409 回滚，逐行列出 `error_code` 与原始行，未提交数据绝不触碰当前生效映射。
5. **幂等**：同一内容摘要（sha256，文件名可不同）重传返回同一批次，不新增任何行/映射。
6. **版本与证据过期**：生效映射带单调 `version`；目标/状态每实质变更 +1，
   旧 `verification_verdicts` 立即置 `stale`、方案条目降为 blocked、发布闸门要求重新验证；
   被裁决取代的旧目标录入标 `superseded_at`（留证据但不再参与推导）。
7. **审计**：暂存/每次选择/提交/拒绝/放弃写 `import_audit_log`，刷新后可追溯
   批次、原始行、操作者选择与提交版本（`committed_mapping_id` 血缘）。

文件格式（v1）：

```csv
source_raw,target_raw,action,note
http://127.0.0.1:4568/%E9%A2%91%E9%81%93/42.html?utm_source=w,http://127.0.0.1:4568/articles/tech/42,migrate,中文+utm
http://127.0.0.1:4568/column/weekly/,http://127.0.0.1:4568/sections/weekly,migrate,尾斜杠保留
http://127.0.0.1:4568/forum/old/9,http://127.0.0.1:4568/forum/old/9,delete,已删除（目标必须同址，期望 410/404）
```
```json
{ "format_version": "v1", "rows": [
  { "source_raw": "http://127.0.0.1:4568/a", "target_raw": "http://127.0.0.1:4568/b",
    "action": "migrate", "note": "...", "version": "v1" } ] }
```

## 环境变量（见 `.env.example`）

`HOST/PORT`（API）、`FIXTURE_HOST/PORT`（本地站点）、`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE`、
`TRAILING_SLASH_MODE`（默认 `keep`）、`MAX_REDIRECTS`（默认 5）、`HTTP_TIMEOUT_MS`、
`FIXTURE_MODE`（`fixed` = 模拟整改后站点）。

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
              ambiguity.js mappings-service.js(diff 重算/版本/证据过期/supersede)
              verify-runner.js(证据绑定映射版本)
              import-parser.js(CSV/JSON 字节保真解析+逐行错误)
              import-service.js(暂存/幂等/冲突裁决/原子提交/审计)
              fixture.js(随项目本地站点) routes.js(Fastify) db.js
server/sql/   schema.sql(导入批次/行/审计 + url_mappings.version + verdicts.stale)
web/          Vue 3 + Vite 工作台（总览/证据/批量导入裁决/方案闸门/规则）
scripts/      start-pg.js remediate.js report.js
docs/         verification-report-before.md / -after.md（真实跑出来的证据）
server/test/  规则 + 验证器集成(19) + 导入解析字节保真(10) + 导入工作流集成(7)
```
