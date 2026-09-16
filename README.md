# nonvtuber-live-finder

YouTubeでライブ配信中の**VTuber以外**の配信者のうち、**同時視聴者数が少ない**配信を見つけるためのツールです。
YouTube Data API v3 のみを利用しており、スクレイピング／クローリングは行いません。

## 仕組み（クォータ設計）

YouTube Data API v3 は1日あたり10,000ユニットの無料枠しかなく、`search.list` は1回100ユニットと高コストです。
そのため、次の2フェーズに分けて運用します。

1. **発見フェーズ**（`src/discovery.js`）: 数時間おきに、キーワード（雑談配信・顔出し配信 等、VTuberという単語は使わない）で `search.list`(type=video, eventType=live) を実行し、新しいチャンネル／配信を見つける。見つかった配信者はキーワードベースでVTuber判定し、該当すれば `excluded` として弾く。
2. **監視フェーズ**（`src/monitor.js`）: 10分おきに、発見済みで配信中とマークされている動画IDをまとめて `videos.list`（安価・最大50件/回）で問い合わせ、同時視聴者数を更新し、配信が終了していれば非表示にする。

これにより「新規発見は低頻度・広く」「既知の配信の状態更新は高頻度・安く」という設計になり、1日の無料枠内で運用できます。使用量は `quota_usage` テーブルに記録され、上限（`QUOTA_DAILY_LIMIT`、デフォルト9000）に近づくと発見フェーズが自動的にスキップされます。

VTuber判定は完全自動ではできないため、`src/vtuberFilter.js` のキーワードリストによる簡易判定＋トップページのフォームからの手動申請（誤除外の解除／見逃しの除外）で運用する想定です。

## ローカルでの動かし方

### 1. YouTube Data API キーの取得

1. https://console.cloud.google.com/ にアクセスしてログイン
2. 新しいプロジェクトを作成
3. 「APIとサービス」→「ライブラリ」→ **YouTube Data API v3** を検索して有効化
4. 「認証情報」→「認証情報を作成」→「APIキー」
5. 発行されたキーは「APIとサービスの制限」で "YouTube Data API v3" のみに絞っておくと安全です
6. 無料枠は1日10,000ユニット（`search.list`=100、`videos.list`=1）

### 2. セットアップ

```bash
cd nonvtuber-live-finder
npm install
cp .env.example .env
# .env を開いて YOUTUBE_API_KEY と ADMIN_TOKEN を設定
```

### 3. DBの起動とマイグレーション

```bash
docker compose up -d db
npm run migrate
```

### 4. 起動

```bash
# Web（一覧ページ + API）
npm start
# 別ターミナルでバッチワーカー
npm run cron
```

http://localhost:3000 で一覧ページ、http://localhost:3000/admin.html で管理画面が開けます。

バッチを待たずに動作確認したい場合は、管理画面の「発見バッチを手動実行」「監視バッチを手動実行」ボタン、または以下のAPIを使ってください。

```bash
curl -X POST http://localhost:3000/api/admin/run/discovery -H "x-admin-token: <ADMIN_TOKEN>"
curl -X POST http://localhost:3000/api/admin/run/monitor -H "x-admin-token: <ADMIN_TOKEN>"
```

## 本番デプロイ（Railway / Render）

WebサービスとCronワーカーを**同じPostgres DBを共有する2つのサービス**として立てます（SQLiteはサービス間でファイル共有できないため不採用）。

### Railwayの場合

1. GitHubにこのリポジトリをpushしておく
2. railway.app → 「New Project」→「Deploy from GitHub repo」
3. 「+ New」→「Database」→「PostgreSQL」を追加（`DATABASE_URL` が自動発行される）
4. Webサービス側の環境変数に `YOUTUBE_API_KEY`, `ADMIN_TOKEN`, `DATABASE_URL`（Postgresの接続文字列を参照）を設定。Start Commandは `node src/server.js`
5. 同じプロジェクト内で「+ New」→「GitHub Repo」→同じリポジトリをもう一度追加（Cron用の2つ目のサービス）。Start Commandを `node src/cron.js` に変更し、同じ環境変数を設定
6. 初回のみ、Webサービスの「Shell」機能等で `npm run migrate` を実行してテーブルを作成
7. Webサービスの「Settings」→「Networking」→「Generate Domain」でURLが発行される

### Renderの場合

1. render.com → 「New +」→「Web Service」→ リポジトリを選択（Dockerfileが自動検出される）
2. 「New +」→「PostgreSQL」でDBを作成し、接続文字列をコピー
3. Web Serviceの環境変数に `YOUTUBE_API_KEY`, `ADMIN_TOKEN`, `DATABASE_URL` を設定
4. 「New +」→「Background Worker」で同じリポジトリを追加し、Start Commandを `node src/cron.js` に、同じ環境変数を設定
5. 初回のみどちらかのサービスのShellで `npm run migrate` を実行

## ディレクトリ構成

```
src/
  config.js      環境変数の読み込み
  db.js          Postgres接続・クォータ記録
  migrate.js     migrations/*.sql を適用する
  youtube.js     YouTube Data API v3 のラッパー
  vtuberFilter.js VTuber判定キーワード
  discovery.js   新規チャンネル発見バッチ
  monitor.js     配信状態の監視バッチ
  cron.js        バッチワーカーのエントリポイント
  server.js      Web API + 静的ファイル配信
public/          フロントエンド（一覧ページ・管理画面）
migrations/      DBスキーマ
```

## ピン留めチャンネル

`.env` の `PINNED_CHANNEL_HANDLES`（デフォルト `@matomonaka,@toakun_dayo`）で指定したチャンネルは、
同接数フィルタ（`MAX_CONCURRENT_VIEWERS`）を無視して、ライブ中であれば常に一覧の最上位に表示されます。
cronワーカー起動時に自動でチャンネルを解決・登録し、監視バッチ（10分おき）のたびに
アップロード済みプレイリストを使った安価な方法（1チャンネルあたり約2 units）でライブ中かどうかを確認します。

## 制限事項・注意点

- VTuber判定はキーワードベースの簡易判定です。誤判定はトップページのフォームから申請できます。
- 無料枠（1日10,000ユニット）の範囲で動かす前提のため、発見フェーズのキーワード数・実行頻度を増やしすぎるとすぐに枠を使い切ります。`.env` の `DISCOVERY_KEYWORDS` / `DISCOVERY_CRON` で調整してください。
- 本ツールはYouTube公式APIの利用規約の範囲内で使うことを前提としています。
