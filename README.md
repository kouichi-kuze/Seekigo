# Seekigo

**探して、行く。**

Seekigo は、東京を中心としたイベント・おでかけ情報を収集・整理し、「今日どこ行こう？」「今週末何しよう？」から行き先を発見できるサービスです。

イベント情報を複数ソースから取得し、重複判定・情報統合・AI補助・人間確認を経て公開します。

https://seekigo.com/

---

## Concept

Seekigo は単なるイベント検索サイトではなく、

> 「行き先発見サービス」

を目指しています。

主な利用シーン:

- 今日どこ行こう？
- 今週末何しよう？
- 子どもとどこ行く？
- 無料で楽しみたい
- 雨の日でも出かけたい
- 夜から行ける場所を探したい

---

## Tech Stack

### Frontend

- Astro 7
- TypeScript
- Static Site Generation (SSG)

### Database

- Supabase
- PostgreSQL

Supabase project ref:

```text
oodszouakhxqtqsgtxei
```

### AI

- OpenAI API

AI は主に情報整理・補助用途で使用します。

原則:

- 確定情報はソース優先
- 不明な情報を AI で推測しない
- `unknown` / `null` を許容する
- 人間確認を経て公開する

### Hosting

- Xserver

### CI / CD

- GitHub Actions

---

## Project Structure

主要ディレクトリ:

```text
/
├── .github/
│   └── workflows/
│       ├── deploy-site.yml
│       └── sync-events.yml
│
├── docs/
│
├── public/
│   ├── brand/
│   ├── og/
│   ├── api/
│   │   └── contact-event.php
│   └── favicon.svg
│
├── scripts/
│   ├── sync-gotokyo.ts
│   ├── sync-all.ts
│   ├── import-events-supabase.ts
│   ├── import-enjoytokyo-supabase.ts
│   ├── import-walkerplus-supabase.ts
│   └── ...
│
├── src/
│   ├── components/
│   ├── layouts/
│   ├── lib/
│   └── pages/
│
├── astro.config.mjs
├── package.json
└── README.md
```

---

## Local Development

### Requirements

- Node.js 24（CI / 推奨。`package.json` engines は `>=22.12.0`）
- npm

現在の開発環境例:

- Node.js: v24.x
- npm: 11.x

### Install

```sh
npm install
```

### Start Development Server

```sh
npm run dev
```

http://localhost:4321/

### Build

```sh
npm run build
```

生成先: `dist/`

### Preview

```sh
npm run preview
```

---

## Environment Variables

ローカルでは `.env` を使用します。

`.env` は Git に commit しません。

主な環境変数:

```env
PUBLIC_SUPABASE_URL=
PUBLIC_SUPABASE_PUBLISHABLE_KEY=

SUPABASE_SERVICE_ROLE_KEY=

OPENAI_API_KEY=

PUBLIC_TURNSTILE_SITE_KEY=
```

注意:

- `SUPABASE_SERVICE_ROLE_KEY` は絶対にブラウザへ渡さない
- `OPENAI_API_KEY` はブラウザへ渡さない
- Secret は GitHub / Xserver / ローカル環境のみで管理

---

## Database

主要テーブル:

- `public.events`
- `public.event_sources`
- `public.event_field_reviews`
- `public.event_dedupe_reviews`

### events

イベント本体。主な情報:

- `title`
- `slug`
- `status`
- `start_date` / `end_date`
- `start_time` / `end_time`
- `venue` / `area` / `address`
- `price_text`
- `category`
- `summary`
- `official_url` / `source_url`
- `image_url` / `image_usage_status` / `image_credit` / `image_source`

### status

| status | 意味 |
|--------|------|
| `draft` | 自動取得後の確認待ち |
| `published` | 公開中 |
| `hidden` | DB には残すが公開サイトには表示しない |

---

## Event Collection Flow

基本フロー:

```text
取得
↓
詳細解析
↓
正規化
↓
重複判定
↓
複数ソース統合
↓
AI補助
↓
人間確認
↓
Publish
↓
公開
```

---

## Event Sources

現在対応:

| ソース | source key |
|--------|-------------|
| GO TOKYO | `gotokyo` |
| EnjoyTokyo | `enjoytokyo` |
| Walkerplus | `walkerplus` |

イベント本体と取得元は `event_sources` で分離して管理します。1 イベントに複数ソースを紐付け可能です。

---

## Import / Sync

### npm scripts（`package.json`）

| script | 用途 |
|--------|------|
| `npm run sync:gotokyo` | GO TOKYO 同期 |
| `npm run sync:all` | GO TOKYO + EnjoyTokyo 一括同期（Walkerplus は含まない） |
| `npm run fetch:gotokyo` | GO TOKYO 一覧取得 |
| `npm run fetch:gotokyo:details` | GO TOKYO 詳細 |
| `npm run import:gotokyo` | GO TOKYO import |
| `npm run enrich:gotokyo:ai` | GO TOKYO AI enrichment |
| `npm run fetch:enjoytokyo` | EnjoyTokyo 一覧 |
| `npm run fetch:enjoytokyo:details` | EnjoyTokyo 詳細 |
| `npm run dedupe:enjoytokyo` | EnjoyTokyo 重複判定 |
| `npm run import:enjoytokyo` | EnjoyTokyo import |
| `npm run enrich:enjoytokyo:ai` | EnjoyTokyo AI enrichment |
| `npm run import:walkerplus` | Walkerplus 手動 import |
| `npm run brand:export` | brand / OGP PNG 書き出し（任意・build 非連動） |

### GO TOKYO

```sh
npm run sync:gotokyo
```

### sync:all

```sh
npm run sync:all
```

`DRY_RUN` のデフォルトは `true`（DB 書き込みなし）です。書き込む場合は PowerShell で:

```powershell
$env:DRY_RUN="false"
npm run sync:all
```

### Walkerplus

手動 import（自動同期 `sync:all` には未組み込み）:

```powershell
$env:WALKERPLUS_IMPORT_MAX="10"
$env:DRY_RUN="false"
npm run import:walkerplus
```

画像は「取得できること」と「利用許諾」を別問題として扱います。

---

## Deduplication

重複判定:

| status | 挙動 |
|--------|------|
| `exact` | 既存イベントに `event_sources` を追加。published 本体は自動上書きしない |
| `likely` | 管理画面で人間確認 |
| `ambiguous` | 管理画面で人間確認 |
| `none` | 新しい `draft` イベントとして登録 |

---

## Field Review

published イベントに新しい情報が取得された場合、本体を直接上書きせず `event_field_reviews` に差分を保存します。

- `current_value`
- `proposed_value`

管理画面（`/admin/events/reviews/field/pending/`）から Accept / Reject が可能です。

status: `pending` / `accepted` / `rejected` / `expired`

---

## Image Policy

外部画像は `image_usage_status` で利用可否を管理します。

| status | 意味 |
|--------|------|
| `unknown` | 許諾不明 |
| `licensed` | 利用可 |
| `organizer_granted` | 主催者許諾 |
| `own` | 自社素材 |
| `forbidden` | 利用不可 |

公開表示:

- `licensed` / `organizer_granted` / `own` かつ `image_url` あり → 外部画像
- それ以外（`unknown` / `forbidden` / URL なし）→ Seekigo category fallback

画像表示は原則 `resolveEventDisplayImage()` を利用し、ロジックを重複させません。

### Category Fallback Images

主なカテゴリ画像スラグ:

`festival` / `exhibition` / `food` / `kids` / `seasonal` / `nightlife` / `market` / `sports` / `workshop` / `music` / `generic`

---

## Admin

管理画面は **ローカル開発環境（`astro dev`）専用** です。

```text
/admin/events/
```

本番 build では管理画面を公開しません。

### Admin Menu

```text
Dashboard

Events
├── All Events
├── Draft
├── Published
├── Hidden
└── Ended

Reviews
├── Field Reviews
└── Image Reviews

Data
└── Sources
```

### Admin Features

- Event 一覧
- Draft 確認 / 一括 Publish
- `image_usage_status` 一括変更
- 個別イベント編集
- Hidden / Published 切替
- 重複候補レビュー
- Field Review 承認 / 却下
- Source 確認
- 開催終了判定

### Admin Event Edit

```text
/admin/events/[id]/
```

DEV 時のみイベント ID を `getStaticPaths()` で生成します。dev 起動後に新しいイベントを追加した場合は Astro dev server を再起動してください。

```sh
npx astro dev stop
npm run dev
```

---

## Brand

Seekigo brand:

- Seekigo
- 探して、行く。

カラー:

| 名前 | Hex |
|------|-----|
| Navy | `#0E2744` |
| Cyan | `#00A3FF` |
| Lime | `#A3E635` |

主な brand asset:

```text
/public/brand/symbol.svg
/public/brand/social-icon.svg
/public/brand/social-icon-1024.png
/public/favicon.svg
/public/og/default.png
```

用途: symbol / horizontal logo（コンポーネント） / social icon / favicon / hero visual / OGP

旧資産のバックアップ:

```text
/public/brand/legacy/
```

PNG 再生成（任意）:

```sh
npm run brand:export
```

---

## SEO / OGP

`Layout.astro` から以下を出力:

- `canonical`
- `og:title` / `og:description` / `og:type` / `og:url` / `og:image`
- `twitter:card`（`summary_large_image`） / `twitter:image`

標準 OGP:

```text
/public/og/default.png
```

size: 1200 × 630

---

## Contact Form

主催者向け問い合わせ:

```text
/contact/event-info/
```

Cloudflare Turnstile + Xserver PHP で処理します。

- PHP: `/public/api/contact-event.php`
- 本番 Turnstile Secret: `public_html` 外の `config/turnstile.php`（例: `/home/kuzeya/seekigo.com/config/turnstile.php`）
- 問い合わせメール: `contact@seekigo.com`

詳細: [docs/contact-form-deploy.md](docs/contact-form-deploy.md)

---

## Production Server

Hosting: Xserver

| 項目 | 値 |
|------|-----|
| SSH Host | `sv14097.xserver.jp` |
| SSH User | `kuzeya` |
| SSH Port | `10022` |
| Deploy Path | `/home/kuzeya/seekigo.com/public_html/` |

重要: 秘密鍵・パスワード・Secret の値は README に記載しません。GitHub Actions Secrets で管理します。

---

## Deployment

### Normal Code Deploy

`main` へ push すると:

```text
git push origin main
↓
Deploy Site
↓
npm ci
↓
npm run build
↓
Xserver へ rsync
```

workflow: `.github/workflows/deploy-site.yml`

イベント収集は実行しません。

### Event Sync

workflow: `.github/workflows/sync-events.yml`

実行:

- 毎日 JST 05:00（cron: UTC 20:00）
- または GitHub Actions から手動 Run

処理:

```text
Sync Events（npm run sync:all）
↓
Build
↓
Deploy
```

### Deployment Concurrency

両 workflow は同じ group を使用します。

```yaml
concurrency:
  group: seekigo-production-deploy
  cancel-in-progress: false
```

Deploy Site と Sync Events が同時に Xserver へ deploy しないようにします。

---

## Git Workflow

```sh
git status
git diff
git add .
git status
git commit -m "..."
git push origin main
```

`main` push 後は Deploy Site が自動実行されます。

---

## PowerShell Notes

Windows PowerShell では bash 形式の環境変数指定は使えません。

使わない例:

```sh
DRY_RUN=false npm run sync:all
```

PowerShell:

```powershell
$env:DRY_RUN="false"
npm run sync:all
```

解除:

```powershell
Remove-Item Env:DRY_RUN
```

同様に:

```powershell
$env:WALKERPLUS_IMPORT_MAX="10"
$env:DRY_RUN="false"
npm run import:walkerplus
```

---

## Important Rules

- `.env` を commit しない
- Service Role Key を browser へ渡さない
- published イベントを sync で直接上書きしない
- `image_usage_status=unknown` の外部画像を公開表示しない
- source 取得文章をそのまま大量転載しない
- admin を production 公開しない
- 本番 DB migration をコードから自動実行しない
- production event をテスト目的で無断変更しない

---

## Development Principles

### 1. Source First

公式・取得元の事実を優先します。AI が確定情報を作らない。

### 2. Unknown is Valid

不明な情報は `null` / `unknown` として扱います。

### 3. Human Publish

自動取得イベントは原則 `draft`。人間確認後に `published`。

### 4. Protect Published Data

公開済みイベントは自動 sync で直接上書きしません。差分は `event_field_reviews` へ送ります。

### 5. Image Permission

画像 URL が取得できても、利用許諾があるとは限りません。許諾不明は `image_usage_status = unknown` → Seekigo fallback を使用。

### 6. Secrets Stay Server-Side

Service Role / OpenAI / Turnstile Secret 等はクライアントコードへ含めません。

---

## Current Development Direction

現在:

```text
複数イベントソース
↓
dedupe
↓
field review
↓
image permission
↓
admin review
↓
publish
↓
static build
↓
Xserver deploy
```

今後:

```text
Web / SNS反応要約
↓
Seekigo独自リアクション
↓
アニメ・ポップカルチャー
↓
英語 / inbound
↓
全国展開
```

---

## SNS

Official accounts:

- Instagram: [@seekigo](https://www.instagram.com/seekigo)
- X: [@seekigo_jp](https://x.com/seekigo_jp)

メール:

- SNS: `social@seekigo.com`
- 一般問い合わせ: `contact@seekigo.com`

---

## Notes

Seekigo は現在 Tokyo-first で開発しています。

将来的には:

```text
Tokyo
↓
Japan
↓
English / inbound
```

へ拡張予定です。
