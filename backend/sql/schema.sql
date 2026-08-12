-- Pulse ATL warehouse schema (design spec §3).
-- Idempotent: safe to run at the start of every ingest.

CREATE TABLE IF NOT EXISTS INCIDENTS (
  ID           STRING PRIMARY KEY,      -- source_prefix + native id
  SOURCE       STRING NOT NULL,         -- 'apd_crime' | 'atl311' | ...
  CATEGORY     STRING NOT NULL,         -- normalized: 'crime' | 'blight' | 'infrastructure'
  SUBCATEGORY  STRING,                  -- raw offense/case type
  OCCURRED_AT  TIMESTAMP_NTZ NOT NULL,
  RESOLVED_AT  TIMESTAMP_NTZ,           -- null = open
  STATUS       STRING,                  -- 'open' | 'closed' | 'unknown'
  LAT          FLOAT,
  LON          FLOAT,
  NPU          STRING NOT NULL          -- 'A'..'Z' (joined at ingest)
);
