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

function normalizeChannelItem(item) {
  if (!item) return null;
  return {
    channelId: item.id,
    title: item.snippet.title,
    description: item.snippet.description,
    thumbnailUrl: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url,
  };
}

function normalizeForCompare(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

// あいまい検索結果のタイトルとクエリが、大まかにでも関係していそうかを判定する
function isLooselyRelated(title, query) {
  const a = normalizeForCompare(title);
  const b = normalizeForCompare(query);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// URL中の "/@" や "/c/" などの直後にあるセグメントを、区切り文字（/ ? & # 空白）の手前まで
// 過不足なく取り出す。[\w.-] のようなASCII限定の文字クラスだと日本語ハンドル名・カスタムURL名を
// 取りこぼし、結果としてURL文字列全体が検索クエリに使われて無関係なチャンネルがヒットしてしまうため。
function extractSegmentAfter(input, marker) {
  const idx = input.indexOf(marker);
  if (idx === -1) return null;
  const rest = input.slice(idx + marker.length);
  const stopIdx = rest.search(/[/?&#\s]/);
  const raw = stopIdx === -1 ? rest : rest.slice(0, stopIdx);
  return raw ? safeDecodeURIComponent(raw) : null;
}

/**
 * チャンネルURL・ハンドル名・チャンネルID・チャンネル名などの入力から
 * チャンネル情報（channelId等）を解決する。
 * コスト: 通常1 unit、URL/ハンドルから特定できない場合のみ検索(100 units)にフォールバックする。
 * URLの形式が認識できない場合は、無関係なチャンネルを誤って返さないよう null を返す
 * （URL文字列そのものをあいまい検索にかけることはしない）。
 */
export async function resolveChannel(rawInput) {
  const input = (rawInput || '').trim();
  if (!input) return { item: null, quotaUsed: 0 };

  // https://www.youtube.com/channel/UCxxxx 形式、またはID単体
  const idMatch = input.match(/\/channel\/(UC[\w-]{10,})/);
  if (idMatch || /^UC[\w-]{10,}$/.test(input)) {
    const channelId = idMatch ? idMatch[1] : input;
    const { items, quotaUsed } = await getChannelsDetail([channelId]);
    return { item: items[0] || { channelId, title: null, description: null, thumbnailUrl: null }, quotaUsed };
  }

  // https://www.youtube.com/@handle 形式、または @handle 単体
  const handleSeg = extractSegmentAfter(input, '/@') ?? (input.startsWith('@') ? input.slice(1) : null);
  if (handleSeg) {
    const handle = `@${handleSeg}`;
    const data = await callApi('channels', { part: 'snippet', forHandle: handle });
    return { item: normalizeChannelItem(data.items?.[0]), quotaUsed: QUOTA_COST.VIDEOS_LIST };
  }

  // https://www.youtube.com/user/Username 形式（旧レガシーユーザー名）
  const usernameSeg = extractSegmentAfter(input, '/user/');
  if (usernameSeg) {
    const data = await callApi('channels', { part: 'snippet', forUsername: usernameSeg });
    return { item: normalizeChannelItem(data.items?.[0]), quotaUsed: QUOTA_COST.VIDEOS_LIST };
  }

  // https://www.youtube.com/c/CustomName 形式（新しめのカスタムURL、forHandle/forUsernameでは引けない）
  const customSeg = extractSegmentAfter(input, '/c/');

  // URLらしい形なのにここまでのどのパターンにも一致しなかった場合、URL文字列そのものを
  // 検索クエリに使うと無関係なチャンネルがヒットしやすいため、解決不能として扱う。
  const looksLikeUrl = /^https?:\/\//i.test(input) || input.includes('youtube.com') || input.includes('youtu.be');
  if (looksLikeUrl && !customSeg) {
    return { item: null, quotaUsed: 0 };
  }

  // それ以外（/c/CustomName の中身、またはチャンネル名そのもの）はキーワード検索でフォールバック
  const query = customSeg || input;
  const data = await callApi('search', { part: 'snippet', q: query, type: 'channel', maxResults: 1 });
  const found = data.items?.[0];
  if (!found) return { item: null, quotaUsed: QUOTA_COST.SEARCH_LIST };

  // あいまい検索は無関係なチャンネルを拾うことがあるため、見つかったチャンネル名がクエリと
  // 全く関係なさそうな場合は誤って別チャンネルを操作しないよう解決不能として扱う
  if (!isLooselyRelated(found.snippet.title, query)) {
    return { item: null, quotaUsed: QUOTA_COST.SEARCH_LIST };
  }

  return {
    item: {
      channelId: found.id.channelId,
      title: found.snippet.title,
      description: found.snippet.description,
      thumbnailUrl: found.snippet.thumbnails?.medium?.url || found.snippet.thumbnails?.default?.url,
    },
    quotaUsed: QUOTA_COST.SEARCH_LIST,
  };
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
