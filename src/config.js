import 'dotenv/config';

function splitCsv(value, fallback) {
  const raw = value ?? fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/nonvtuber_live',
  port: Number(process.env.PORT || 3000),
  adminToken: process.env.ADMIN_TOKEN || '',
  quotaDailyLimit: Number(process.env.QUOTA_DAILY_LIMIT || 9000),
  discoveryCron: process.env.DISCOVERY_CRON || '0 */2 * * *',
  discoveryKeywords: splitCsv(
    process.env.DISCOVERY_KEYWORDS,
    '雑談配信,顔出し配信,ゲーム実況 ライブ,歌枠 生放送,ライブ配信中,フリートーク 配信'
  ),
  monitorCron: process.env.MONITOR_CRON || '*/10 * * * *',
  // 同時視聴者数がこの人数以上の配信は「同接少なめ」の対象外として一覧から除外する
  maxConcurrentViewers: Number(process.env.MAX_CONCURRENT_VIEWERS || 10),
  // 配信開始からこの時間数（時間）を超えて続いている配信（耐久配信等）は一覧・件数から除外する
  maxLiveHours: Number(process.env.MAX_LIVE_HOURS || 48),
  // 同接数フィルタを無視して常に一覧の上位に固定表示するチャンネル（@handle または チャンネルURL/ID、カンマ区切り）
  pinnedChannelHandles: splitCsv(
    process.env.PINNED_CHANNEL_HANDLES,
    '@matomonaka,@toakun_dayo,@zeropure5,@tongudesuyo,@shihuyu.24,@hquru_kun,https://youtube.com/channel/UC9tW9r5gO2aLJQgA7T12M2g,@hamab_uta,@os25tama'
  ),
};

export function assertYoutubeKey() {
  if (!config.youtubeApiKey) {
    throw new Error(
      'YOUTUBE_API_KEY が設定されていません。.env に YouTube Data API v3 のAPIキーを設定してください（README参照）。'
    );
  }
}
