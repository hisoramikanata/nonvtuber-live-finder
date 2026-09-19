#!/usr/bin/env node
// YouTube Shorts風「ランキング切り抜き動画」生成スクリプト
//
// 手持ちの動画クリップ（自分で権利を持っている、または再利用の許可を得た素材）を
// config.json で指定した順番・区間でつなぎ合わせ、
//   - 上部の固定タイトル帯（2行）
//   - 左上に積み上がるメダルランキング表示
//   - 画面下のテロップ（キャプション）
// を焼き込んだ縦動画(mp4)をffmpegで書き出す。
//
// Usage:
//   node ranking-video/generate.js <config.json> <output.mp4> [--keep-temp]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DEFAULT_FONT_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc',
  '/usr/share/fonts/opentype/ipafont-gothic/ipagp.ttf',
  '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
  '/usr/share/fonts/truetype/fonts-japanese-gothic.ttf',
  '/usr/share/fonts/truetype/takao-gothic/TakaoGothic.ttf',
];

const MEDAL_COLORS = {
  1: '0xFFD700', // gold
  2: '0xC0C0C0', // silver
  3: '0xCD7F32', // bronze
};
const MEDAL_COLOR_DEFAULT = '0x4A90D9';

function fail(message) {
  console.error(`[ranking-video] エラー: ${message}`);
  process.exit(1);
}

function checkFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    fail(
      'ffmpeg が見つかりません。`apt-get install ffmpeg` 等でインストールしてください。'
    );
  }
}

function resolveFont(config) {
  if (config.font?.file) {
    if (!existsSync(config.font.file)) {
      fail(`指定されたフォントファイルが見つかりません: ${config.font.file}`);
    }
    return config.font.file;
  }
  const found = DEFAULT_FONT_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    fail(
      '日本語表示用のフォントが見つかりませんでした。config.json の font.file で ' +
        'CJK対応フォント(.ttf/.ttc)のパスを指定するか、`apt-get install fonts-noto-cjk` 等で' +
        'インストールしてください。'
    );
  }
  return found;
}

// ffmpeg drawtext の text= に渡す文字列のエスケープ
// (: ' \ % がフィルタグラフ/drawtext双方で特別な意味を持つため)
function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "'\\\\\\''")
    .replace(/%/g, '\\%');
}

function escapePath(p) {
  // フィルタグラフ内でファイルパスに使うためのエスケープ(コロンのみ想定)
  return String(p).replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

function drawtextFilter({ font, text, fontsize, fontcolor, x, y, box, boxcolor, boxborderw, enable }) {
  const parts = [
    `fontfile='${escapePath(font)}'`,
    `text='${escapeDrawtext(text)}'`,
    `fontsize=${fontsize}`,
    `fontcolor=${fontcolor}`,
    `x=${x}`,
    `y=${y}`,
  ];
  if (box) {
    parts.push('box=1', `boxcolor=${boxcolor}`, `boxborderw=${boxborderw ?? 16}`);
  }
  if (enable) {
    parts.push(`enable='${enable}'`);
  }
  return `drawtext=${parts.join(':')}`;
}

function buildSegmentFilter({ entry, index, font, width, height, titleH, title, medalSlots, medalRanks, fps }) {
  const filters = [];

  // 1. 画面いっぱいにクロップ
  filters.push(
    `scale=${width}:${height}:force_original_aspect_ratio=increase`,
    `crop=${width}:${height}`
  );

  // 2. 上部タイトル帯(常時表示)
  filters.push(`drawbox=x=0:y=0:w=${width}:h=${titleH}:color=black@1:t=fill`);
  filters.push(
    drawtextFilter({
      font,
      text: title.line1,
      fontsize: title.line1Size ?? Math.round(height * 0.045),
      fontcolor: title.line1Color ?? 'white',
      x: '(w-text_w)/2',
      y: Math.round(titleH * 0.12),
    })
  );
  if (title.line2) {
    filters.push(
      drawtextFilter({
        font,
        text: title.line2,
        fontsize: title.line2Size ?? Math.round(height * 0.05),
        fontcolor: title.line2Color ?? 'yellow',
        x: '(w-text_w)/2',
        y: Math.round(titleH * 0.52),
      })
    );
  }

  // 3. 左上のメダルランキング(累積表示)
  const chipH = Math.round(height * 0.052);
  const chipGap = Math.round(height * 0.012);
  const chipX = Math.round(width * 0.03);
  medalSlots.forEach((slot, slotIdx) => {
    const y = titleH + chipGap + slotIdx * (chipH + chipGap);
    const reached = slot.entryIndex <= index;
    const color = MEDAL_COLORS[slot.rank] ?? MEDAL_COLOR_DEFAULT;
    // 順位バッジ(番号)
    filters.push(
      drawtextFilter({
        font,
        text: `${slot.rank}`,
        fontsize: Math.round(chipH * 0.6),
        fontcolor: 'black',
        x: chipX + Math.round(chipH * 0.35),
        y: y + Math.round(chipH * 0.18),
        box: true,
        boxcolor: `${color}@1`,
        boxborderw: Math.round(chipH * 0.3),
      })
    );
    // 到達済みならラベルを表示
    if (reached && slot.medalLabel) {
      filters.push(
        drawtextFilter({
          font,
          text: slot.medalLabel,
          fontsize: Math.round(chipH * 0.55),
          fontcolor: 'white',
          x: chipX + chipH + Math.round(width * 0.04),
          y: y + Math.round(chipH * 0.18),
          box: true,
          boxcolor: 'black@0.6',
          boxborderw: Math.round(chipH * 0.25),
        })
      );
    }
  });

  // 4. 画面下部のテロップ(この区間内のタイムコードで切り替え)
  // end側は次のテロップの開始と1フレーム分の余裕を空けて、境界で二重表示されないようにする
  const captions = entry.captions ?? [];
  const frameGap = 1 / (fps || 30);
  captions.forEach((cap) => {
    const capEnd = Math.max(cap.start + frameGap, cap.end - frameGap);
    filters.push(
      drawtextFilter({
        font,
        text: cap.text,
        fontsize: cap.fontsize ?? Math.round(height * 0.038),
        fontcolor: cap.fontcolor ?? 'white',
        x: '(w-text_w)/2',
        y: Math.round(height * (cap.yRatio ?? 0.82)),
        box: true,
        boxcolor: 'black@0.65',
        boxborderw: Math.round(height * 0.016),
        enable: `between(t,${cap.start},${capEnd})`,
      })
    );
  });

  return filters.join(',');
}

function renderSegment({ entry, index, config, font, width, height, titleH, medalSlots, tmpDir, ffmpegLog }) {
  const src = path.resolve(config.baseDir ?? '.', entry.source);
  if (!existsSync(src)) {
    fail(`素材が見つかりません(entries[${index}].source): ${src}`);
  }

  const args = ['-y'];
  if (entry.start != null) args.push('-ss', String(entry.start));
  args.push('-i', src);
  if (entry.start != null && entry.end != null) {
    args.push('-t', String(entry.end - entry.start));
  } else if (entry.duration != null) {
    args.push('-t', String(entry.duration));
  }

  const vf = buildSegmentFilter({
    entry,
    index,
    font,
    width,
    height,
    titleH,
    title: config.title,
    medalSlots,
    medalRanks: config.medalRanks ?? 3,
    fps: config.output?.fps ?? 30,
  });

  const outFile = path.join(tmpDir, `segment_${String(index).padStart(3, '0')}.mp4`);
  args.push(
    '-vf', vf,
    '-r', String(config.output?.fps ?? 30),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    '-preset', config.output?.preset ?? 'veryfast',
    '-crf', String(config.output?.crf ?? 20)
  );

  if (entry.mute) {
    args.push('-an');
  } else {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  }

  args.push(outFile);

  console.log(`[ranking-video] segment ${index + 1}: ${path.basename(src)} -> ${path.basename(outFile)}`);
  execFileSync('ffmpeg', args, { stdio: ffmpegLog ? 'inherit' : ['ignore', 'ignore', 'pipe'] });
  return outFile;
}

function concatSegments(segmentFiles, tmpDir, ffmpegLog) {
  const listPath = path.join(tmpDir, 'concat_list.txt');
  writeFileSync(
    listPath,
    segmentFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n'
  );
  const concatOut = path.join(tmpDir, 'concatenated.mp4');
  execFileSync(
    'ffmpeg',
    ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', concatOut],
    { stdio: ffmpegLog ? 'inherit' : ['ignore', 'ignore', 'pipe'] }
  );
  return concatOut;
}

function applyBgm(concatOut, config, tmpDir, outputPath, ffmpegLog) {
  const bgmPath = path.resolve(config.baseDir ?? '.', config.bgm.file);
  if (!existsSync(bgmPath)) {
    fail(`BGMファイルが見つかりません: ${bgmPath}`);
  }
  const volume = config.bgm.volume ?? 0.25;
  const args = [
    '-y',
    '-i', concatOut,
    '-stream_loop', '-1',
    '-i', bgmPath,
    '-filter_complex',
    `[1:a]volume=${volume}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
    '-map', '0:v',
    '-map', '[aout]',
    '-shortest',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    outputPath,
  ];
  execFileSync('ffmpeg', args, { stdio: ffmpegLog ? 'inherit' : ['ignore', 'ignore', 'pipe'] });
}

function main() {
  const [, , configPathArg, outputPathArg, ...rest] = process.argv;
  if (!configPathArg || !outputPathArg) {
    console.error('Usage: node ranking-video/generate.js <config.json> <output.mp4> [--keep-temp] [--verbose]');
    process.exit(1);
  }
  const keepTemp = rest.includes('--keep-temp');
  const ffmpegLog = rest.includes('--verbose');

  checkFfmpeg();

  const configPath = path.resolve(configPathArg);
  if (!existsSync(configPath)) fail(`config が見つかりません: ${configPath}`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.baseDir = config.baseDir ? path.resolve(path.dirname(configPath), config.baseDir) : path.dirname(configPath);

  if (!Array.isArray(config.entries) || config.entries.length === 0) {
    fail('config.entries は1件以上必要です');
  }
  if (!config.title?.line1) {
    fail('config.title.line1 は必須です');
  }

  const font = resolveFont(config);
  const width = config.output?.width ?? 1080;
  const height = config.output?.height ?? 1920;
  const titleH = config.title.bandHeight ?? Math.round(height * 0.16);
  const medalRanks = config.medalRanks ?? 3;

  const medalSlots = config.entries
    .map((e, entryIndex) => ({ entryIndex, rank: e.rank, medalLabel: e.medalLabel }))
    .filter((s) => s.rank != null && s.rank <= medalRanks)
    .sort((a, b) => a.rank - b.rank);

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'ranking-video-'));
  console.log(`[ranking-video] 作業ディレクトリ: ${tmpDir}`);

  try {
    const segmentFiles = config.entries.map((entry, index) =>
      renderSegment({ entry, index, config, font, width, height, titleH, medalSlots, tmpDir, ffmpegLog })
    );

    const concatOut = concatSegments(segmentFiles, tmpDir, ffmpegLog);

    const outputPath = path.resolve(outputPathArg);
    mkdirSync(path.dirname(outputPath), { recursive: true });

    if (config.bgm?.file) {
      console.log('[ranking-video] BGMをミックス中...');
      applyBgm(concatOut, config, tmpDir, outputPath, ffmpegLog);
    } else {
      copyFileSync(concatOut, outputPath);
    }

    console.log(`[ranking-video] 完成: ${outputPath}`);
  } finally {
    if (!keepTemp) {
      rmSync(tmpDir, { recursive: true, force: true });
    } else {
      console.log(`[ranking-video] --keep-temp指定のため作業ファイルを残します: ${tmpDir}`);
    }
  }
}

main();
