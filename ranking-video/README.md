# ranking-video

手持ちの動画クリップから、YouTube Shorts でよくある「ランキング形式の切り抜き動画」を
自動生成するCLIツールです。

- 画面上部に固定のタイトル帯(2行)
- 画面左上に積み上がっていくメダルランキング(金/銀/銅 + ラベル)
- 画面下部に区間ごとのテロップ(キャプション)
- 任意でBGMをミックス

を焼き込んだ縦動画(9:16, mp4)を ffmpeg で書き出します。

**このツールは動画のダウンロードやスクレイピングは一切行いません。**
入力として渡す動画クリップは、自分で権利を持っている素材、または権利者から
二次利用の許可を得た素材のみを使用してください。他者の配信・動画を無断で
切り抜いて再アップロードすることは著作権侵害になり得ます。

## 前提条件

- Node.js 18以上
- `ffmpeg` (`apt-get install ffmpeg` などでインストール)
- 日本語(CJK)を表示できるフォント
  - 例: `apt-get install fonts-noto-cjk` または `fonts-ipafont-gothic`
  - `config.json` の `font.file` でフォントファイルのパスを明示することも可能
    (未指定の場合、よくあるインストール先を自動探索します)

## 使い方

```bash
cd ranking-video
cp config.example.json config.json
# clips/ に自分の素材(clip1.mp4 など)を配置し、config.json を編集する

node generate.js config.json out/ranking.mp4
```

オプション:

- `--keep-temp`: セグメントごとの中間ファイルを削除せずに残す(デバッグ用)
- `--verbose`: ffmpegの出力をそのまま表示する

## config.json のスキーマ

```jsonc
{
  "title": {
    "line1": "1行目(白)",
    "line2": "2行目(黄色)",       // 省略可
    "line1Color": "white",       // 省略可(ffmpegの色名/#RRGGBB)
    "line2Color": "yellow",
    "bandHeight": 280             // 省略可。タイトル帯の高さ(px)
  },
  "medalRanks": 3,                 // 何位までメダル表示するか(既定3)
  "output": {
    "width": 1080, "height": 1920, // 既定 1080x1920 (9:16)
    "fps": 30, "crf": 20, "preset": "veryfast"
  },
  "font": { "file": null },        // 省略/null で自動検出
  "bgm": { "file": "bgm.mp3", "volume": 0.25 }, // 省略可
  "baseDir": ".",                  // source/bgmの相対パス基準(既定: config.jsonのある場所)
  "entries": [
    {
      "rank": 3,                  // メダル対象の場合のみ左上に表示される
      "medalLabel": "外カリ中ふわ", // メダルの横に出す短いラベル(任意)
      "source": "clips/clip1.mp4",
      "start": 0, "end": 6,        // 素材からの切り出し区間(秒)
      "mute": false,                // trueで元音声をミュート
      "captions": [
        { "text": "テロップ1", "start": 0, "end": 3 },
        { "text": "テロップ2", "start": 3, "end": 6, "yRatio": 0.82 }
      ]
    }
  ]
}
```

- `entries` は**再生される順番そのまま**の配列です。ランキングを何位から
  発表するかは自由に決められます(降順カウントダウンでも、圏外→上位でも可)。
- `rank <= medalRanks` のエントリだけが左上のメダル欄に表示されます。
  該当エントリの再生回になった時点でラベルが表示され、以降のセグメントでも
  表示され続けます(それまでは順位バッジのみ表示)。
- `medalRanks` 対象外(例: 4位以降)のエントリは、メダル欄には出ず、
  そのセグメントの映像・テロップのみが流れます。

## 動作確認

素材を用意していない状態でもパイプライン自体を試したい場合は、
ffmpeg の `lavfi` (`color=` / `testsrc`) でダミークリップを生成してから
`generate.js` を実行すると、書き出しまでの一連の流れを確認できます。
