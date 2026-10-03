-- 旧新映射、爬取结果、迁移方案三类数据，全部带“证据”列。
-- 键的规范化由应用层（WHATWG URL，规则见 config.js）保证，不使用 CITEXT，
-- 因为路径大小写敏感、百分号编码不能随意解码。

-- 每次录入的原始材料（证据），同一归一化键可能有多个不同写法的来源。
CREATE TABLE IF NOT EXISTS mapping_inputs (
  id              BIGSERIAL PRIMARY KEY,
  source_raw      TEXT NOT NULL,
  source_norm     TEXT NOT NULL,           -- 归一化后的查表键
  target_raw      TEXT NOT NULL,
  target_norm     TEXT NOT NULL,
  mapping_type    TEXT NOT NULL CHECK (mapping_type IN ('manual','deleted')),
  note            TEXT,
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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 歧义（多旧址归一后相同，却指向不同资源）：
-- 以 mapping_inputs 为证据，按归一化键分组，存在 2 个以上不同 target_norm。
-- 已被新裁决取代（superseded_at 非空，如批量导入显式改目标）的录入只留审计，
-- 不再参与生效推导与歧义判定。列先于视图幂等就绪（import 表在文件末尾创建，
-- 故此处的外键延迟到 import_batches 创建后再补）。
ALTER TABLE mapping_inputs
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by_batch BIGINT;
DO $$
BEGIN
  EXECUTE $view$
CREATE OR REPLACE VIEW mapping_ambiguities AS
SELECT source_norm,
       count(*) AS input_count,
       count(DISTINCT target_norm) AS target_variants,
       array_agg(DISTINCT source_raw ORDER BY source_raw) AS source_forms,
       array_agg(DISTINCT target_raw ORDER BY target_raw) AS targets
FROM mapping_inputs
WHERE superseded_at IS NULL
GROUP BY source_norm
HAVING count(DISTINCT target_norm) > 1
$view$;
END $$;

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
  mapping_id      BIGINT NOT NULL REFERENCES url_mappings(id) ON DELETE CASCADE,
  -- pending（仅填表） / verified（有验证证据） / blocked（存在问题）
  item_status     TEXT NOT NULL DEFAULT 'pending'
                  CHECK (item_status IN ('pending','verified','blocked')),
  evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (plan_id, mapping_id)
);

-- ---- 批量本地文件导入 -----------------------------------------------------
-- 纪律：只接收浏览器在本机读取的文件字节（API 不收 URL/服务端路径）；
-- 原始行逐字节留证；规范化只在暂存预览阶段做，绝不回写改写原始字节。
-- content_sha256 是幂等键：同一文件重复导入返回同一批次，不新增任何行。
CREATE TABLE IF NOT EXISTS import_batches (
  id              BIGSERIAL PRIMARY KEY,
  format_version  TEXT NOT NULL,                 -- 当前仅 'v1'
  file_format     TEXT NOT NULL CHECK (file_format IN ('csv','json')),
  filename        TEXT,
  content_sha256  TEXT NOT NULL UNIQUE,
  raw_bytes       BIGINT NOT NULL,
  row_count       INT NOT NULL DEFAULT 0,
  -- staged（暂存待提交）/ committed（已原子提交）/ abandoned（操作者放弃）
  status          TEXT NOT NULL DEFAULT 'staged'
                  CHECK (status IN ('staged','committed','abandoned')),
  summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at    TIMESTAMPTZ,
  committed_by    TEXT
);

CREATE TABLE IF NOT EXISTS import_rows (
  id                  BIGSERIAL PRIMARY KEY,
  batch_id            BIGINT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  line_no             INT NOT NULL,             -- 文件物理行号（1 起，含表头偏移）
  raw_line            TEXT NOT NULL,            -- 文件原始行（去掉行终止符，其余逐字节）
  parse_status        TEXT NOT NULL CHECK (parse_status IN ('ok','error')),
  -- version_unsupported / unknown_action / malformed_row / empty_url /
  -- invalid_url / bad_percent_encoding / outside_allowlist / deleted_target_mismatch
  error_code         TEXT,
  error_message       TEXT,
  source_raw          TEXT,
  source_norm         TEXT,
  target_raw          TEXT,
  target_norm         TEXT,
  mapping_type        TEXT CHECK (mapping_type IN ('manual','deleted')),
  note                TEXT,
  -- 操作者选择：pending（未决定）/ selected（提交此行）/ ignored（显式放弃）
  selection           TEXT NOT NULL DEFAULT 'pending'
                      CHECK (selection IN ('pending','selected','ignored')),
  -- 冲突：within_file（批内同键不同目标）/ with_library（与当前生效库同键不同目标）/ both
  conflict            TEXT CHECK (conflict IS NULL
                      OR conflict IN ('within_file','with_library','both')),
  conflict_targets    JSONB NOT NULL DEFAULT '[]'::jsonb,
  library_target_norm TEXT,
  committed_mapping_id BIGINT REFERENCES url_mappings(id) ON DELETE SET NULL,
  UNIQUE (batch_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id);

-- 导入操作审计：暂存/提交/拒绝/放弃都落痕，可按批次追溯操作者与选择。
CREATE TABLE IF NOT EXISTS import_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  batch_id    BIGINT REFERENCES import_batches(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN
              ('staged','selection','committed','commit_rejected','abandoned')),
  actor       TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_audit_batch ON import_audit_log(batch_id);

-- 旧库兼容：把 action 约束升级为含 'selection' 的版本（新库已含，跳过）。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'import_audit_log_action_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%selection%'
  ) THEN
    ALTER TABLE import_audit_log DROP CONSTRAINT import_audit_log_action_check;
    ALTER TABLE import_audit_log
      ADD CONSTRAINT import_audit_log_action_check
      CHECK (action IN ('staged','selection','committed','commit_rejected','abandoned'));
  END IF;
END $$;

-- 生效映射版本号：目标/状态每被实际改动一次 +1；验证证据绑定取得证据时的版本。
ALTER TABLE url_mappings
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 验证证据过期标记：映射在取证之后被改动即置 true，发布闸门要求重新验证。
ALTER TABLE verification_verdicts
  ADD COLUMN IF NOT EXISTS stale BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mapping_version BIGINT;

-- 录入材料的导入血缘（手工单条录入为 NULL）。
ALTER TABLE mapping_inputs ADD COLUMN IF NOT EXISTS import_row_id BIGINT;
-- 裁决取代：批量导入显式选择新目标后，同键旧目标录入不删除（留证据），
-- 但 superseded_at 置时戳，不再参与 url_mappings 推导与歧义分组。
-- 列已在文件前部（视图之前）幂等添加；此处只补对 import_batches 的外键。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='mapping_inputs'
       AND constraint_name='mapping_inputs_superseded_by_batch_fkey'
  ) THEN
    ALTER TABLE mapping_inputs
      ADD CONSTRAINT mapping_inputs_superseded_by_batch_fkey
      FOREIGN KEY (superseded_by_batch) REFERENCES import_batches(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name='mapping_inputs' AND constraint_name='mapping_inputs_import_row_fkey'
  ) THEN
    ALTER TABLE mapping_inputs
      ADD CONSTRAINT mapping_inputs_import_row_fkey
      FOREIGN KEY (import_row_id) REFERENCES import_rows(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 旧库迁移：mapping_plan_items.mapping_id 改为 ON DELETE CASCADE（新库建表时已是）。
DO $$
DECLARE cname TEXT;
BEGIN
  SELECT tc.constraint_name INTO cname
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
   WHERE tc.table_name = 'migration_plan_items'
     AND tc.constraint_type = 'FOREIGN KEY'
     AND kcu.column_name = 'mapping_id';
  IF cname IS NOT NULL AND cname <> 'migration_plan_items_mapping_id_fkey' THEN
    EXECUTE format('ALTER TABLE migration_plan_items DROP CONSTRAINT %I', cname);
    EXECUTE 'ALTER TABLE migration_plan_items ADD CONSTRAINT migration_plan_items_mapping_id_fkey
             FOREIGN KEY (mapping_id) REFERENCES url_mappings(id) ON DELETE CASCADE';
  END IF;
END $$;
