// @ts-check
import { defineConfig } from 'astro/config';

// 公開サイトは完全 SSG（Xserver へ dist/ を配置）
// /admin は astro dev 専用（本番 build では 404 スタブのみ）
export default defineConfig({
  output: 'static',
  site: 'https://seekigo.com',
});
