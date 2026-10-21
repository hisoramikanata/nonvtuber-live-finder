-- アプリ全体の設定値（メンテナンスモード等）を保持する汎用テーブル
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
