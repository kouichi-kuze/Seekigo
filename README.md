# Astro Starter Kit: Basics

```sh
npm create astro@latest -- --template basics
```

> 🧑‍🚀 **Seasoned astronaut?** Delete this file. Have fun!

## 🚀 Project Structure

Inside of your Astro project, you'll see the following folders and files:

```text
/
├── public/
│   └── favicon.svg
├── src
│   ├── assets
│   │   └── astro.svg
│   ├── components
│   │   └── Welcome.astro
│   ├── layouts
│   │   └── Layout.astro
│   └── pages
│       └── index.astro
└── package.json
```

To learn more about the folder structure of an Astro project, refer to [our guide on project structure](https://docs.astro.build/en/basics/project-structure/).

## 🧞 Commands

All commands are run from the root of the project, from a terminal:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Installs dependencies                            |
| `npm run dev`             | Starts local dev server at `localhost:4321`      |
| `npm run build`           | Build your production site to `./dist/`          |
| `npm run preview`         | Preview your build locally, before deploying     |
| `npm run astro ...`       | Run CLI commands like `astro add`, `astro check` |
| `npm run astro -- --help` | Get help using the Astro CLI                     |

## 主催者向けフォーム（Turnstile + Xserver PHP）

`/contact/event-info/` からの問い合わせ送信は、Cloudflare Turnstile と Xserver 上の PHP（`/api/contact-event.php`）で処理します。

- ビルド時: `.env` の `PUBLIC_TURNSTILE_SITE_KEY`（`.env.example` 参照）
- 本番 Secret: `public_html` 外の `config/turnstile.php`（Git 非管理）

詳細は [docs/contact-form-deploy.md](docs/contact-form-deploy.md) を参照してください。

## 👀 Want to learn more?

Feel free to check [our documentation](https://docs.astro.build) or jump into our [Discord server](https://astro.build/chat).



git add .
git status


npm run sync:gotokyo


取得 → 詳細解析 → 重複判定 → 複数ソース統合 → AI整形 → 人間承認 → 公開