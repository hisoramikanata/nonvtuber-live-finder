-- 同接数に関係なく一覧の上位に固定表示する「ピン留め」チャンネル
ALTER TABLE channels ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false;
