import { config } from './config.js';
import { query, addQuotaUsage } from './db.js';
import { resolveChannel, getRecentUploads, getVideosStatus } from './youtube.js';

// チャンネルIDからアップロード済み動画プレイリストIDを機械的に求める（"UC" → "UU"）。
function uploadsPlaylistId(channelId) {
  return channelId?.startsWith('UC') ? `UU${channelId.slice(2)}` : null;
}

/**
 * config.pinnedChannelHandles で指定されたチャンネルを、同接数に関係なく
 * 常に上位表示するピン留めチャンネルとして channels テーブルに登録しておく。
 * cron起動時に1回呼び出す想定（channel_idは変わらないため何度呼んでも安全＝冪等）。
 */
export async function ensurePinnedChannels() {
  for (const handle of config.pinnedChannelHandles) {
    try {
      const { item, quotaUsed } = await resolveChannel(handle);
      if (quotaUsed) await addQuotaUsage(quotaUsed);

      if (!item?.channelId) {
        console.warn(`[pinned] チャンネルを解決できませんでした: ${handle}`);
        continue;
      }

      await query(
        `INSERT INTO channels (channel_id, channel_title, thumbnail_url, status, is_pinned)
         VALUES ($1, $2, $3, 'active', true)
         ON CONFLICT (channel_id) DO UPDATE SET
           status = 'active',
           exclude_reason = NULL,
           is_pinned = true,
           channel_title = EXCLUDED.channel_title,
           thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, channels.thumbnail_url)`,
        [item.channelId, item.title || handle, item.thumbnailUrl || null]
      );
      console.log(`[pinned] ${handle} -> ${item.channelId} (${item.title}) を登録しました`);
    } catch (err) {
      console.error(`[pinned] ${handle} の登録に失敗:`, err.message);
    }
  }
}

/**
 * ピン留めチャンネルが現在ライブ中かどうかを確認し、live_status に反映する。
 * 発見フェーズのキーワード検索（search.list=100 units）に頼らず、
 * アップロード済みプレイリストの最新動画を安価に確認する（1チャンネルあたり2 units）。
 */
export async function checkPinnedChannelsLive() {
  const { rows } = await query('SELECT channel_id FROM channels WHERE is_pinned = true');
  let totalQuota = 0;
  let liveFound = 0;

  for (const row of rows) {
    const channelId = row.channel_id;
    const playlistId = uploadsPlaylistId(channelId);
    if (!playlistId) continue;

    try {
      const { items: recentVideoIds, quotaUsed: q1 } = await getRecentUploads(playlistId, 3);
      totalQuota += q1;
      await addQuotaUsage(q1);
      if (recentVideoIds.length === 0) continue;

      const { items, quotaUsed: q2 } = await getVideosStatus(recentVideoIds);
      totalQuota += q2;
      await addQuotaUsage(q2);

      const liveItem = items.find((v) => v.channelId === channelId && v.startedAt && !v.hasEnded);
      if (!liveItem) continue;

      liveFound += 1;
      await query(
        `INSERT INTO live_status (video_id, channel_id, title, thumbnail_url, started_at, is_live, last_checked_at)
         VALUES ($1, $2, $3, $4, $5, true, now())
         ON CONFLICT (video_id) DO UPDATE SET
           title = EXCLUDED.title,
           thumbnail_url = EXCLUDED.thumbnail_url,
           is_live = true,
           last_checked_at = now()`,
        [liveItem.videoId, channelId, liveItem.title, liveItem.thumbnailUrl, liveItem.startedAt]
      );
    } catch (err) {
      console.error(`[pinned] ライブチェックに失敗 (${channelId}):`, err.message);
    }
  }

  return { checked: rows.length, liveFound, quotaUsed: totalQuota };
}
