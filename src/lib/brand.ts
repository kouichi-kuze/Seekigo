/**
 * Seekigo ブランド用途の正本。
 * ロゴ画像を1枚使い回さず、用途別にコンポーネント / SVG を分ける。
 */
export const BRAND_COLORS = {
  navy: '#0E2744',
  cyan: '#00A3FF',
  lime: '#A3E635',
  white: '#FFFFFF',
} as const

export const BRAND_ASSETS = {
  logo: '/brand/logo_seekigo.png',
  symbol: '/brand/symbol.svg',
  socialIcon: '/brand/social-icon.svg',
  /** 任意: `npm run brand:export` で生成 */
  socialIconPng1024: '/brand/social-icon-1024.png',
  socialIconSvg1024: '/brand/social-icon-1024.svg',
  favicon: '/brand/icon_seekigo.svg',
  /** iOS は SVG の apple-touch-icon を使わないため、同じ絵の PNG */
  appleTouchIcon: '/brand/icon_seekigo.png',
  iconPng: '/brand/icon_seekigo.png',
  legacyFavicon: '/brand/legacy/favicon.svg',
  legacyWordmark: '/brand/legacy/wordmark.svg',
  ogImage: '/og/default.png',
  ogSvg: '/og/default.svg',
  ogTemplate: '/brand/og-template.svg',
} as const

export const OG_IMAGE_SIZE = {
  width: 1200,
  height: 630,
} as const
