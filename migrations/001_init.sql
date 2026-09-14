-- チャンネル（配信者）
CREATE TABLE IF NOT EXISTS channels (
  channel_id           TEXT PRIMARY KEY,
  channel_title        TEXT NOT NULL,
  channel_description  TEXT,
  thumbnail_url        TEXT,
  status               TEXT NOT NULL DEFAULT 'active', -- active / excluded / pending
  exclude_reason       TEXT,
  discovered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_live_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);

-- 現在（または直近）のライブ配信状態
CREATE TABLE IF NOT EXISTS live_status (
  video_id             TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  title                TEXT,
  thumbnail_url        TEXT,
  concurrent_viewers   INTEGER,
  started_at           TIMESTAMPTZ,
  last_checked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_live              BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_live_status_is_live ON live_status(is_live);
CREATE INDEX IF NOT EXISTS idx_live_status_channel ON live_status(channel_id);

-- ユーザーからのチャンネル追加/除外リクエスト
CREATE TABLE IF NOT EXISTS requests (
  id            SERIAL PRIMARY KEY,
  channel_id    TEXT,
  channel_url   TEXT,
  type          TEXT NOT NULL, -- add / remove
  status        TEXT NOT NULL DEFAULT 'pending', -- pending / approved / rejected
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

-- YouTube Data API のクォータ使用量（1日単位で記録し、上限超過を防ぐ）
CREATE TABLE IF NOT EXISTS quota_usage (
  day         DATE PRIMARY KEY,
  used_units  INTEGER NOT NULL DEFAULT 0
);
