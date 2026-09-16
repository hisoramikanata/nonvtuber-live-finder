import { assertYoutubeKey } from './config.js';
import { query, addQuotaUsage } from './db.js';
import { getVideosStatus } from './youtube.js';
import { checkPinnedChannelsLive } from './pinnedChannels.js';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 監視フェーズ。既にis_live=trueとして記録済みの動画について、
 * videos.list（安価）で同時視聴者数を更新し、終了していれば is_live=false にする。
 */
export async function runMonitor() {
  assertYoutubeKey();

  const pinnedResult = await checkPinnedChannelsLive();

  const { rows } = await query('SELECT video_id FROM live_status WHERE is_live = true');
  const videoIds = rows.map((r) => r.video_id);

  if (videoIds.length === 0) {
    console.log('[monitor] 監視対象なし');
    return { checked: 0, ended: 0, quotaUsed: pinnedResult.quotaUsed, pinned: pinnedResult };
  }

  let checked = 0;
  let ended = 0;
  let totalQuota = pinnedResult.quotaUsed;
  const seenIds = new Set();

  for (const batch of chunk(videoIds, 50)) {
    const { items, quotaUsed } = await getVideosStatus(batch);
    totalQuota += quotaUsed;
    await addQuotaUsage(quotaUsed);

    for (const item of items) {
      seenIds.add(item.videoId);
      checked += 1;

      if (item.hasEnded) {
        ended += 1;
        await query('UPDATE live_status SET is_live = false, last_checked_at = now() WHERE video_id = $1', [
          item.videoId,
        ]);
        continue;
      }

      await query(
        `UPDATE live_status
         SET concurrent_viewers = $2, started_at = COALESCE($3, started_at), last_checked_at = now()
         WHERE video_id = $1`,
        [item.videoId, item.concurrentViewers, item.startedAt]
      );
    }
  }

  // APIが返さなかった動画（削除／非公開化された等）も終了扱いにする
  for (const videoId of videoIds) {
    if (!seenIds.has(videoId)) {
      ended += 1;
      await query('UPDATE live_status SET is_live = false, last_checked_at = now() WHERE video_id = $1', [videoId]);
    }
  }

  console.log(`[monitor] done. checked=${checked} ended=${ended} quota=${totalQuota}`);
  return { checked, ended, quotaUsed: totalQuota, pinned: pinnedResult };
}
