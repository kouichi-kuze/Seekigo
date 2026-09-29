/**
 * イベント専用イメージ画像を1枚生成し、検証用に public/ へ保存する。
 * API キーはサーバーの環境変数だけを使う。ブラウザへ渡さない。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConceptImagePrompt } from './event-generated-image-prompt'

const LOG = '[generated-image]'

export const GENERATED_IMAGE_STATUSES = [
  'none',
  'pending',
  'approved',
  'rejected',
] as const

export type GeneratedImageStatus = (typeof GENERATED_IMAGE_STATUSES)[number]

type EventRow = {
  id: number
  title: string | null
  summary: string | null
  category: string[] | null
  venue: string | null
  is_kids: boolean | null
  is_indoor: boolean | null
}

function imageModel(): string {
  return process.env.OPENAI_IMAGE_MODEL?.trim() || 'gpt-image-1'
}

function imageQuality(): 'low' | 'medium' | 'high' | 'auto' {
  const value = process.env.OPENAI_IMAGE_QUALITY?.trim() || 'low'
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'auto') {
    return value
  }
  return 'low'
}

function imageSize(): '1024x1024' | '1536x1024' | '1024x1536' | 'auto' {
  const value = process.env.OPENAI_IMAGE_SIZE?.trim() || '1536x1024'
  if (
    value === '1024x1024' ||
    value === '1536x1024' ||
    value === '1024x1536' ||
    value === 'auto'
  ) {
    return value
  }
  return '1536x1024'
}

export const MAX_GENERATED_IMAGE_INSTRUCTION = 800
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

export type GeneratedImageSource = 'openai' | 'upload'

export function generatedImagePublicUrl(eventId: number): string {
  return `/images/event-generated/${eventId}.webp`
}

export function normalizeGeneratedImageInstruction(
  value?: string | null,
): { text: string | null } | { error: string } {
  if (value == null) return { text: null }
  const text = value.replace(/\0/g, '').trim()
  if (!text) return { text: null }
  if (text.length > MAX_GENERATED_IMAGE_INSTRUCTION) {
    return {
      error: `追加指示は${MAX_GENERATED_IMAGE_INSTRUCTION}文字以内にしてください`,
    }
  }
  return { text }
}

function outputFilePath(eventId: number): string {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../public/images/event-generated',
  )
  return path.join(root, `${eventId}.webp`)
}

function isEventRow(value: number | EventRow): value is EventRow {
  return typeof value === 'object' && value !== null && typeof value.id === 'number'
}

async function loadEvent(
  client: SupabaseClient,
  eventOrId: number | EventRow,
): Promise<{ ok: true; event: EventRow } | { ok: false; message: string }> {
  if (isEventRow(eventOrId)) return { ok: true, event: eventOrId }
  const { data, error } = await client
    .from('events')
    .select('id, title, summary, category, venue, is_kids, is_indoor')
    .eq('id', eventOrId)
    .maybeSingle()
  if (error) return { ok: false, message: error.message }
  if (!data) return { ok: false, message: `Event id=${eventOrId} not found` }
  return { ok: true, event: data as EventRow }
}

async function writeWebp(
  eventId: number,
  bytes: Buffer,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const filePath = outputFilePath(eventId)
  try {
    await mkdir(path.dirname(filePath), { recursive: true })
    const sharp = (await import('sharp')).default
    const webp = await sharp(bytes).webp({ quality: 80 }).toBuffer()
    await writeFile(filePath, webp)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(LOG, message)
    return { ok: false, message: '画像を保存できませんでした' }
  }
  return { ok: true, url: generatedImagePublicUrl(eventId) }
}

async function markGeneratedImagePending(
  client: SupabaseClient,
  eventId: number,
  meta: {
    source: GeneratedImageSource
    instruction: string | null
  },
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const url = generatedImagePublicUrl(eventId)
  const base = {
    generated_image_url: url,
    generated_image_status: 'pending',
    updated_at: new Date().toISOString(),
  }
  const full = {
    ...base,
    generated_image_source: meta.source,
    generated_image_instruction: meta.instruction,
  }
  const { error } = await client.from('events').update(full).eq('id', eventId)
  if (!error) return { ok: true, url }
  const missingMeta = /generated_image_source|generated_image_instruction/i.test(
    error.message,
  )
  if (!missingMeta) {
    console.error(LOG, error.message)
    return { ok: false, message: error.message }
  }
  const retry = await client.from('events').update(base).eq('id', eventId)
  if (retry.error) {
    console.error(LOG, retry.error.message)
    return { ok: false, message: retry.error.message }
  }
  console.error(LOG, 'generated image meta columns are missing; image status was saved without source')
  return { ok: true, url }
}

/**
 * イベント専用イメージを1件生成する。
 * 標準生成、追加指示、将来の一括生成はすべてこの関数を呼ぶ。
 * 一括生成は generated_image_status = none の行を順に渡し、customInstruction は付けない。
 */
export async function generateEventImage(
  client: SupabaseClient,
  eventOrId: number | EventRow,
  customInstruction?: string | null,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const instruction = normalizeGeneratedImageInstruction(customInstruction)
  if ('error' in instruction) return { ok: false, message: instruction.error }

  const apiKey =
    import.meta.env.OPENAI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    return { ok: false, message: 'OPENAI_API_KEY が未設定です' }
  }

  const loaded = await loadEvent(client, eventOrId)
  if (!loaded.ok) return loaded
  const event = loaded.event

  const prompt = buildConceptImagePrompt(event, instruction.text)
  const openai = new OpenAI({ apiKey })
  const model = imageModel()
  const quality = imageQuality()
  const size = imageSize()

  let b64: string | undefined
  try {
    const image = await openai.images.generate({
      model,
      prompt,
      n: 1,
      size,
      quality,
      output_format: 'webp',
    })
    b64 = image.data?.[0]?.b64_json
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(LOG, message)
    return { ok: false, message }
  }
  if (!b64) {
    return { ok: false, message: 'OpenAI image response had no image data' }
  }

  const saved = await writeWebp(event.id, Buffer.from(b64, 'base64'))
  if (!saved.ok) return saved
  return markGeneratedImagePending(client, event.id, {
    source: 'openai',
    instruction: instruction.text,
  })
}

/** @deprecated generateEventImage を使う */
export async function generateEventConceptImage(
  client: SupabaseClient,
  eventId: number,
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  return generateEventImage(client, eventId)
}

export async function saveUploadedEventImage(
  client: SupabaseClient,
  eventId: number,
  file: Blob & { name?: string; type?: string },
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  if (!file || file.size <= 0) {
    return { ok: false, message: '画像ファイルを選択してください' }
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: '画像ファイルは8MB以下にしてください' }
  }
  const name = (file.name ?? '').toLowerCase()
  const type = (file.type ?? '').toLowerCase()
  const extOk = /\.(jpe?g|png|webp)$/.test(name)
  const typeOk =
    type === '' ||
    type === 'image/jpeg' ||
    type === 'image/jpg' ||
    type === 'image/png' ||
    type === 'image/webp'
  if (!extOk || !typeOk) {
    return { ok: false, message: 'jpg / jpeg / png / webp のみアップロードできます' }
  }

  const loaded = await loadEvent(client, eventId)
  if (!loaded.ok) return loaded

  const bytes = Buffer.from(await file.arrayBuffer())
  let format: string | undefined
  try {
    const sharp = (await import('sharp')).default
    format = (await sharp(bytes).metadata()).format
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(LOG, message)
    return { ok: false, message: '画像を読み取れませんでした' }
  }
  if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
    return { ok: false, message: 'jpg / jpeg / png / webp のみアップロードできます' }
  }

  const saved = await writeWebp(eventId, bytes)
  if (!saved.ok) return saved
  return markGeneratedImagePending(client, eventId, {
    source: 'upload',
    instruction: null,
  })
}

export async function setGeneratedImageStatus(
  client: SupabaseClient,
  eventId: number,
  status: 'approved' | 'rejected',
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: existing, error: selectError } = await client
    .from('events')
    .select('id, generated_image_url')
    .eq('id', eventId)
    .maybeSingle()
  if (selectError) return { ok: false, message: selectError.message }
  if (!existing) return { ok: false, message: `Event id=${eventId} not found` }
  if (status === 'approved' && !String(existing.generated_image_url ?? '').trim()) {
    return { ok: false, message: '生成画像がありません' }
  }

  const { error } = await client
    .from('events')
    .update({
      generated_image_status: status,
      updated_at: new Date().toISOString(),
    })
    .eq('id', eventId)
  if (error) return { ok: false, message: error.message }
  return { ok: true }
}
