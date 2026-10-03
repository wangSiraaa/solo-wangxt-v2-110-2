-- 旧新映射、爬取结果、迁移方案三类数据，全部带“证据”列。
-- 键的规范化由应用层（WHATWG URL，规则见 config.js）保证，不使用 CITEXT，
-- 因为路径大小写敏感、百分号编码不能随意解码。

-- 导入批次头必须先于 mapping_inputs（后者以其为外键）。
-- 只接收本地文件（见 routes 的上传口），分批暂存、人工预览裁决后原子提交。
-- 任何一行损坏都让整批不可提交，未提交数据绝不触碰生效映射。
CREATE TABLE IF NOT EXISTS import_batches (
  id                BIGSERIAL PRIMARY KEY,
  content_digest    TEXT NOT NULL UNIQUE,   -- sha256(原始字节)，重复文件直接幂等返回
  format            TEXT NOT NULL CHECK (format IN ('csv','json')),
  format_version    INT NOT NULL,           -- 文件自述版本（当前仅支持 1）
  filename          TEXT NOT NULL,
  byte_length       BIGINT NOT NULL,
  raw_content       BYTEA NOT NULL,         -- 原始字节原样留存（审计/重新解析）
  -- staged（可预览/可提交） / rejected（版本不支持或文件无法解析） /
  -- committed（已提交；再次导入同摘要直接返回此批次）
  status            TEXT NOT NULL DEFAULT 'staged'
                    CHECK (status IN ('staged','rejected','committed')),
  parse_errors      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 整批级错误（版本/结构）
  total_lines       INT NOT NULL DEFAULT 0,
  ok_lines          INT NOT NULL DEFAULT 0,
  error_lines       INT NOT NULL DEFAULT 0,
  selected_count    INT NOT NULL DEFAULT 0,
  committed_count   INT,
  committed_by      TEXT,
  committed_at      TIMESTAMPTZ,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS idx_import_batches_created ON import_batches(created_at);

-- 每次录入的原始材料（证据），同一归一化键可能有多个不同写法的来源。
CREATE TABLE IF NOT EXISTS mapping_inputs (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,
  source_norm     TEXT NOT NULL,           -- 归一化后的查表键
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  note            TEXT,
  -- 冲突裁决：被人工判负的原始材料不参与生效映射重算，但作为证据永久保留。
  excluded        BOOLEAN NOT NULL DEFAULT false,
  excluded_reason TEXT,
  excluded_by     TEXT,
  excluded_at     TIMESTAMPTZ,
  -- 来源批次：手工录入为 NULL，批量导入记录批次号，保证可追溯。
  import_batch_id BIGINT REFERENCES import_batches(id) ON DELETE SET NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mapping_inputs_norm ON mapping_inputs(source_norm);

-- 生效映射：source_norm 唯一。同键不同目标的冲突不允许静默覆盖，
-- 由应用层写入并标记（见 ambiguity.js），冲突行 status='conflicted' 不生效。
CREATE TABLE IF NOT EXISTS url_mappings (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,           -- 首次建立该键时的原始地址（证据）
  source_norm     TEXT NOT NULL UNIQUE,
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','conflicted')),
  note            TEXT,
  -- 目标内容代次：任何影响 target_norm / status 的变更都 +1，用于使旧验证证据过期。
  revision        INT NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 歧义（多旧址归一后相同，却指向不同资源）：
-- 以 mapping_inputs 中“未被裁决排除”的原始材料为证据，按归一化键分组，
-- 存在 2 个以上不同 target_norm。判负材料（excluded=true）保留在表中但不参与。
CREATE OR REPLACE VIEW mapping_ambiguities AS
SELECT source_norm,
       count(*) AS input_count,
       count(DISTINCT target_norm) AS target_variants,
       array_agg(DISTINCT source_raw ORDER BY source_raw) AS source_forms,
       array_agg(DISTINCT target_raw ORDER BY target_raw) AS targets
FROM mapping_inputs
WHERE excluded IS FALSE
GROUP BY source_norm
HAVING count(DISTINCT target_norm) > 1;

CREATE TABLE IF NOT EXISTS crawl_results (
  id                  BIGSERIAL PRIMARY KEY,
  source_norm         TEXT NOT NULL,
  hop_index           INT  NOT NULL,           -- 0 = 入口地址
  url_raw             TEXT NOT NULL,           -- 该跳实际请求的原始 URL
  url_norm            TEXT NOT NULL,           -- 该跳规范化形式
  status_code         INT,
  location_raw        TEXT,                    -- 响应 Location（原样保留）
  location_norm       TEXT,
  is_redirect         BOOLEAN NOT NULL DEFAULT false,
  fetch_error         TEXT,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_norm, hop_index)
);

-- 对每个入口地址的最终裁决（最终页面状态必须核实）
CREATE TABLE IF NOT EXISTS verification_verdicts (
  source_norm         TEXT PRIMARY KEY,
  source_raw          TEXT NOT NULL,
  final_url_raw       TEXT,
  final_url_norm      TEXT,
  final_status        INT,
  hops                INT  NOT NULL DEFAULT 0,
  tracker_preserved   BOOLEAN,                 -- 追踪参数是否到达最终 URL
  -- ok / redirect_loop / chain_too_long / fetch_error /
  -- deleted_gone_ok / deleted_not_gone / ambiguity / final_status_bad
  verdict             TEXT NOT NULL,
  issues              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- 证据代次：验证时对应映射的 revision；映射目标/状态变化后 revision 增加，
  -- verified_revision < 当前 revision 即 stale=true，发布闸门要求重新验证。
  mapping_revision    INT,
  stale               BOOLEAN NOT NULL DEFAULT false,
  verified_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 迁移方案：填表只是 pending，验证通过才 allowed 发布。
CREATE TABLE IF NOT EXISTS migration_plans (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','ready','published')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS migration_plan_items (
  id              BIGSERIAL PRIMARY KEY,
  plan_id         BIGINT NOT NULL REFERENCES migration_plans(id) ON DELETE CASCADE,
  mapping_id      BIGINT NOT NULL REFERENCES url_mappings(id),
  -- pending（仅填表） / verified（有验证证据） / blocked（存在问题）
  item_status     TEXT NOT NULL DEFAULT 'pending'
                  CHECK (item_status IN ('pending','verified','blocked')),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (plan_id, mapping_id)
);

-- ===========================================================================
-- 批量导入（批次头 import_batches 已在文件前部定义）
-- ===========================================================================

-- 批次逐行暂存：原始行、字节偏移、解析状态、规范化预览、操作者选择。
CREATE TABLE IF NOT EXISTS import_batch_rows (
  id                BIGSERIAL PRIMARY KEY,
  batch_id          BIGINT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  line_no           INT NOT NULL,           -- 物理起始行（1-based），多物理行 CSV 为首行
  end_line_no       INT NOT NULL,
  record_no         INT NOT NULL,           -- 记录序号（CSV 数据行/JSON rows 下标，1-based）
  raw_line          TEXT NOT NULL,          -- 该行/记录的原始文本（逐字节，不经任何规整）
  source_raw        TEXT,
  target_raw        TEXT,
  action            TEXT,                   -- redirect | delete（原样保留，未知值也存）
  mapping_type      TEXT,                   -- redirect->manual, delete->deleted
  note              TEXT,
  -- parsed（规范化成功） / error（逐行错误，提交时整批阻断）
  parse_status      TEXT NOT NULL CHECK (parse_status IN ('parsed','error')),
  error_code        TEXT,                   -- bad_encoding/bad_csv/unknown_action/
                                            -- bad_source_url/bad_target_url/
                                            -- target_out_of_scope/...
  error_message     TEXT,
  -- WHATWG 规范化预览（解析成功才有）
  source_norm       TEXT,
  target_norm       TEXT,
  norm_detail       JSONB,                  -- pathname/identity_query/tracker_params/href
  -- 文件内冲突组（仅同组 target_norm 不同时非空）；与库冲突存 conflicted_with_current
  conflict_group    INT,
  conflicted_with_current BOOLEAN NOT NULL DEFAULT false,
  -- 操作者选择：是否纳入提交（默认 parsed 行纳入；冲突组需先裁决）
  selected          BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (batch_id, record_no)
);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_batch_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_import_rows_norm ON import_batch_rows(source_norm);

-- 冲突裁决记录：操作者为某个 canonical key 显式选中唯一胜出目标。
-- 仅暂存于批次内，提交时才作用到 mapping_inputs / url_mappings。
CREATE TABLE IF NOT EXISTS import_resolutions (
  id                BIGSERIAL PRIMARY KEY,
  batch_id          BIGINT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_norm       TEXT NOT NULL,
  winner_target_norm TEXT NOT NULL,
  decided_by        TEXT NOT NULL,
  decided_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, source_norm)
);

-- 导入审计：上传、选择、裁决、提交的每一次动作都留痕。
CREATE TABLE IF NOT EXISTS import_audit_log (
  id                BIGSERIAL PRIMARY KEY,
  batch_id          BIGINT REFERENCES import_batches(id) ON DELETE SET NULL,
  event             TEXT NOT NULL,          -- uploaded/updated_selection/resolved/committed
  actor             TEXT NOT NULL,
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
  at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_audit_batch ON import_audit_log(batch_id);
