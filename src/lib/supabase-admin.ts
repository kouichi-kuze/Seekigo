import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * サーバー専用 Supabase クライアント（Service Role）。
 * - ブラウザ・PUBLIC_ 付きキーでは使わない
 * - 公開サイトの static build / dist では import しない（admin は DEV 動的 import のみ）
 */
export function createAdminClient(): SupabaseClient {
  const url = import.meta.env.PUBLIC_SUPABASE_URL
  const serviceKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url) {
    throw new Error('PUBLIC_SUPABASE_URL is not set')
  }
  if (!serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set (server-only; never use PUBLIC_ prefix)',
    )
  }
  if (serviceKey === import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Refusing to use publishable key as admin client')
  }

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}
