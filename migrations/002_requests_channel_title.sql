-- リクエスト一覧で解決済みのチャンネル名を表示できるようにする
ALTER TABLE requests ADD COLUMN IF NOT EXISTS channel_title TEXT;
