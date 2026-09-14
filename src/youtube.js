import { config } from './config.js';

const BASE_URL = 'https://www.googleapis.com/youtube/v3';

// 公式クォータ表に基づくおおよそのコスト
export const QUOTA_COST = {
  SEARCH_LIST: 100,
  VIDEOS_LIST: 1,
};

async function callApi(endpoint, params) {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set('key', config.youtubeApiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const res = await fetch(url);
  const body = await res.json();

  if (!res.ok) {
    const message = body?.error?.message || res.statusText;
    const err = new Error(`YouTube API エラー (${endpoint}): ${message}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return body;
}

/**
 * 現在ライブ中の動画をキーワード検索する。
 * コスト: 100 units / 呼び出し
 */
export async function searchLive(keyword, { pageToken } = {}) {
  const data = await callApi('search', {
    part: 'snippet',
    q: keyword,
    type: 'video',
    eventType: 'live',
    order: 'date',
    regionCode: 'JP',
    relevanceLanguage: 'ja',
    maxResults: 50,
    pageToken,
  });

  const items = (data.items || []).map((item) => ({
    videoId: item.id.videoId,
    channelId: item.snippet.channelId,
    channelTitle: item.snippet.channelTitle,
    videoTitle: item.snippet.title,
    videoDescription: item.snippet.description,
    thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
    publishedAt: item.snippet.publishedAt,
  }));

  return { items, nextPageToken: data.nextPageToken, quotaUsed: QUOTA_COST.SEARCH_LIST };
}

/**
 * チャンネルの説明文などを取得する（VTuber判定の精度を上げるため）。
 * コスト: 約1 unit / 呼び出し（最大50 id）
 */
export async function getChannelsDetail(channelIds) {
  if (channelIds.length === 0) return { items: [], quotaUsed: 0 };
  const data = await callApi('channels', {
    part: 'snippet',
    id: channelIds.slice(0, 50).join(','),
  });

  const items = (data.items || []).map((item) => ({
    channelId: item.id,
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
  }));

  return { items, quotaUsed: QUOTA_COST.VIDEOS_LIST };
}

/**
 * 動画ID一覧の現在の状態（同時視聴者数・終了有無）を取得する。
 * コスト: 約1 unit / 呼び出し（最大50 id）
 */
export async function getVideosStatus(videoIds) {
  if (videoIds.length === 0) return { items: [], quotaUsed: 0 };
  const data = await callApi('videos', {
    part: 'snippet,liveStreamingDetails',
    id: videoIds.slice(0, 50).join(','),
  });

  const items = (data.items || []).map((item) => ({
    videoId: item.id,
    title: item.snippet.title,
    channelId: item.snippet.channelId,
    thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
    concurrentViewers: item.liveStreamingDetails?.concurrentViewers
      ? Number(item.liveStreamingDetails.concurrentViewers)
      : null,
    startedAt: item.liveStreamingDetails?.actualStartTime || null,
    hasEnded: Boolean(item.liveStreamingDetails?.actualEndTime),
  }));

  return { items, quotaUsed: QUOTA_COST.VIDEOS_LIST };
}
