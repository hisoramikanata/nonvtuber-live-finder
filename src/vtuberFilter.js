// VTuber系配信者・除外コンテンツを弾くためのキーワードフィルタ。
// 完全な自動判定はできないため、キーワードによる粗い絞り込み＋
// requestsテーブル経由の手動申請（誤除外の解除／見逃しの除外）で運用する想定。

const VTUBER_KEYWORDS = [
  'vtuber',
  'v-tuber',
  'ぶいちゅーばー',
  'バーチャルライバー',
  'バーチャルユーチューバー',
  'vsinger',
  'vsinger',
  'ai vtuber',
  'aiバーチャル',
  'live2d',
  'ライブ2d',
  '2dモデル',
  '3dモデル',
  'にじさんじ',
  'ホロライブ',
  'hololive',
  'nijisanji',
  '個人勢バーチャル',
  'バ美肉',
  'バーチャル美少女受肉',
  'アバター配信',
];

// VTuberかどうかに関わらず一覧から除外したいコンテンツ種別
const CONTENT_EXCLUDE_KEYWORDS = [
  'ライブカメラ',
  '監視カメラ',
  '定点カメラ',
  '定点観測',
  '24時間配信 無人',
  '無人配信',
  'bgm 配信',
  '作業用bgm',
  '再放送',
  'アーカイブ配信',
];

function normalize(text) {
  return (text || '').toLowerCase();
}

function matchesAny(haystack, keywords) {
  const normalized = normalize(haystack);
  return keywords.find((kw) => normalized.includes(normalize(kw))) || null;
}

/**
 * チャンネル・動画の情報からVTuber/除外対象かどうかを判定する。
 * @returns {{excluded: boolean, reason: string|null}}
 */
export function classify({ channelTitle, channelDescription, videoTitle }) {
  const fields = [channelTitle, channelDescription, videoTitle];

  for (const field of fields) {
    const hit = matchesAny(field, VTUBER_KEYWORDS);
    if (hit) {
      return { excluded: true, reason: `VTuber関連キーワード: "${hit}"` };
    }
  }

  for (const field of fields) {
    const hit = matchesAny(field, CONTENT_EXCLUDE_KEYWORDS);
    if (hit) {
      return { excluded: true, reason: `除外コンテンツ: "${hit}"` };
    }
  }

  return { excluded: false, reason: null };
}

export { VTUBER_KEYWORDS, CONTENT_EXCLUDE_KEYWORDS };
