/**
 * Brand asset を SVG → PNG に書き出す（手動実行用。astro build では呼ばない）。
 *
 *   npm run brand:export
 *
 * 出力:
 *   public/og/default.png          (1200x630)
 *   public/brand/social-icon-1024.png (1024x1024)
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadSharp() {
  try {
    return (await import('sharp')).default
  } catch {
    console.error(
      '[brand:export] sharp がありません。先に `npm i -D sharp` を実行してください。',
    )
    process.exit(1)
  }
}

async function exportPng(
  sharp: typeof import('sharp').default,
  inputRel: string,
  outputRel: string,
  width: number,
  height: number,
) {
  const input = path.join(root, inputRel)
  const output = path.join(root, outputRel)
  await mkdir(path.dirname(output), { recursive: true })
  const svg = await readFile(input)
  const png = await sharp(svg, { density: 144 })
    .resize(width, height, { fit: 'fill' })
    .png()
    .toBuffer()
  await writeFile(output, png)
  console.log(`[brand:export] wrote ${outputRel} (${width}x${height})`)
}

async function main() {
  const sharp = await loadSharp()
  await exportPng(sharp, 'public/og/default.svg', 'public/og/default.png', 1200, 630)
  await exportPng(
    sharp,
    'public/brand/social-icon-1024.svg',
    'public/brand/social-icon-1024.png',
    1024,
    1024,
  )
}

main().catch((error) => {
  console.error('[brand:export] failed:', error)
  process.exit(1)
})
