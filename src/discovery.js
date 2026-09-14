import { config, assertYoutubeKey } from './config.js';
import { query, getTodayQuotaUsage, addQuotaUsage } from './db.js';
import { searchLive, QUOTA_COST } from './youtube.js';
import { classify } from './vtuberFilter.js';

async function upsertChannel({ channelId, channelTitle, channelDescription, thumbnailUrl, status, excludeReason }) {
  await query(
    `INSERT INTO channels (channel_id, channel_title, channel_description, thumbnail_url, status, exclude_reason, last_seen_live_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (channel_id) DO UPDATE SET
       channel_title = EXCLUDED.channel_title,
       thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, channels.thumbnail_url),
       last_seen_live_at = now()
       -- 既存チャンネルのstatusは上書きしない（手動で除外/復活させたものを尊重する）`,
    [channelId, channelTitle, channelDescription || null, thumbnailUrl || null, status, excludeReason || null]
  );
}

async function upsertLiveStatus({ videoId, channelId, title, thumbnailUrl, startedAt }) {
  await query(
    `INSERT INTO live_status (video_id, channel_id, title, thumbnail_url, started_at, is_live, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, true, now())
     ON CONFLICT (video_id) DO UPDATE SET
       title = EXCLUDED.title,
       thumbnail_url = EXCLUDED.thumbnail_url,
       is_live = true,
       last_checked_at = now()`,
    [videoId, channelId, title, thumbnailUrl || null, startedAt || null]
  );
}

async function getChannelStatus(channelId) {
  const { rows } = await query('SELECT status FROM channels WHERE channel_id = $1', [channelId]);
  return rows[0]?.status || null;
}

/**
 * 新規チャンネル発見フェーズ。
 * キーワードごとにsearch.listを1回だけ叩き（ページングはしない＝コスト抑制）、
 * VTuber判定にかけて active/excluded を振り分ける。
 */
export async function runDiscovery({ keywords = config.discoveryKeywords } = {}) {
  assertYoutubeKey();

  const used = await getTodayQuotaUsage();
  const estimatedCost = keywords.length * QUOTA_COST.SEARCH_LIST;
  if (used + estimatedCost > config.quotaDailyLimit) {
    console.warn(
      `[discovery] クォータ上限に近いためスキップ (used=${used}, estimated=${estimatedCost}, limit=${config.quotaDailyLimit})`
    );
    return { skipped: true, used };
  }

  let found = 0;
  let excluded = 0;
  let totalQuota = 0;

  for (const keyword of keywords) {
    try {
      const { items, quotaUsed } = await searchLive(keyword);
      totalQuota += quotaUsed;
      await addQuotaUsage(quotaUsed);

      for (const item of items) {
        const existingStatus = await getChannelStatus(item.channelId);

        if (existingStatus === 'excluded') {
          continue; // 既に除外済みチャンネルはスキップ
        }

        if (existingStatus === null) {
          // 初めて見るチャンネル → 判定
          const result = classify({
            channelTitle: item.channelTitle,
            channelDescription: item.videoDescription,
            videoTitle: item.videoTitle,
          });

          if (result.excluded) {
            excluded += 1;
            await upsertChannel({
              channelId: item.channelId,
              channelTitle: item.channelTitle,
              thumbnailUrl: item.thumbnailUrl,
              status: 'excluded',
              excludeReason: result.reason,
            });
            continue;
          }

          await upsertChannel({
            channelId: item.channelId,
            channelTitle: item.channelTitle,
            thumbnailUrl: item.thumbnailUrl,
            status: 'active',
          });
          found += 1;
        }

        // active（既存 or 今回active化）なチャンネルのライブ状態を記録
        await upsertLiveStatus({
          videoId: item.videoId,
          channelId: item.channelId,
          title: item.videoTitle,
          thumbnailUrl: item.thumbnailUrl,
          startedAt: item.publishedAt,
        });
      }
    } catch (err) {
      console.error(`[discovery] keyword="${keyword}" failed:`, err.message);
    }
  }

  console.log(`[discovery] done. found=${found} excluded=${excluded} quota=${totalQuota}`);
  return { skipped: false, found, excluded, quotaUsed: totalQuota };
}
