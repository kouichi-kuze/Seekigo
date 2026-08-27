# 主催者向けフォーム — Xserver デプロイ手順

Astro SSG の `dist/` とあわせて、Turnstile Secret と PHP メール送信を Xserver で設定します。

## 1. ビルドとアップロード

```sh
npm run build
```

`dist/` の中身を Xserver の `public_html`（ドキュメントルート）へアップロードします。

これにより以下が本番で利用可能になります:

- `/contact/event-info/` — 静的 HTML（Turnstile Site Key 埋め込み）
- `/api/contact-event.php` — メール送信 API

## 2. Turnstile Site Key（Astro ビルド時）

リポジトリルートの `.env` に公開 Site Key のみ設定し、ビルドします。

```env
PUBLIC_TURNSTILE_SITE_KEY=your-site-key
```

Site Key は公開値のため HTML / JS に出力されます。Secret Key はここに置かないでください。

Cloudflare ダッシュボードで、Turnstile ウィジェットのホスト名に以下を許可してください:

- `seekigo.com`
- `www.seekigo.com`
- `localhost`（ローカル確認用）
- `127.0.0.1`（ローカル確認用）

## 3. Turnstile Secret Key（Xserver — Git 管理外）

Secret Key は **document root の外** に PHP 設定ファイルとして置きます。

### 手順

1. `config/turnstile.example.php` を参考に、サーバー上で `config/turnstile.php` を作成
2. `secret_key` に Cloudflare の Secret Key を記入
3. `public_html` の **1つ上** の `config/` ディレクトリに配置

例（Xserver）:

```text
/home/ユーザー名/seekigo.com/
├── config/
│   └── turnstile.php      ← Secret Key（Git 非管理）
└── public_html/           ← dist の中身
    ├── api/
    │   └── contact-event.php
    └── contact/
        └── event-info/
            └── index.html
```

`turnstile.php` の例:

```php
<?php
return [
    'secret_key' => 'Cloudflare の Secret Key',
];
```

PHP は `dirname(DOCUMENT_ROOT)/config/turnstile.php` を自動的に参照します。

## 4. メール（Xserver）

送信設定（PHP 内で固定）:

| 項目 | 値 |
|------|-----|
| From | `contact@seekigo.com` |
| To | `contact@seekigo.com` |
| Reply-To | フォーム入力者のメールアドレス |

Xserver で `contact@seekigo.com` のメールアカウントを作成し、PHP `mail()` / `mb_send_mail()` が送信できる状態にしてください。

## 5. ローカル確認（用途別）

### A. Turnstile 表示 + フロント validation（astro dev）

```sh
# .env に PUBLIC_TURNSTILE_SITE_KEY を設定
npm run dev
```

`http://localhost:4321/contact/event-info/` でウィジェット表示と入力検証を確認できます。  
**PHP は astro dev では動きません** — 送信は本番 API または下記 B で確認してください。

### B. PHP 単体確認

プロジェクトルートで Secret 設定を作成（Git 管理外）:

```sh
cp config/turnstile.example.php config/turnstile.php
# config/turnstile.php に secret_key を設定
```

PHP ビルトインサーバー:

```sh
php -S localhost:8080 -t public
```

別ターミナルから curl で POST テスト（Turnstile トークンはブラウザで取得した値が必要）:

```sh
curl -X POST http://localhost:8080/api/contact-event.php \
  -H "Origin: http://localhost:8080" \
  -H "Referer: http://localhost:8080/contact/event-info/" \
  -F "name=テスト" \
  -F "email=test@example.com" \
  -F "topic=other" \
  -F "message=テスト送信" \
  -F "cf-turnstile-response=TOKEN_HERE"
```

### C. 本番相当確認

Site Key を `.env` に設定して `npm run build` → `dist/` と `config/turnstile.php` を Xserver へ配置後、  
本番 URL `https://seekigo.com/contact/event-info/` から実送信を確認してください。

## 6. セキュリティチェックリスト

- [ ] Secret Key を Git に commit していない
- [ ] `config/turnstile.php` が `public_html` 外にある
- [ ] `dist/` に Secret Key 文字列が含まれていない
- [ ] Cloudflare Turnstile の hostname 設定が本番 + localhost を含む
