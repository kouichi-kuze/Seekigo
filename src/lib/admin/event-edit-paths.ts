/**
 * DEV: admin イベント編集ページ用 getStaticPaths。
 * 本番 build (import.meta.env.DEV === false) では常に [] を返し dist に含めない。
 */
export async function getAdminEventEditStaticPaths(): Promise<
  { params: { id: string } }[]
> {
  if (!import.meta.env.DEV) {
    return []
  }

  try {
    const { createAdminClient } = await import('../supabase-admin')
    const admin = createAdminClient()
    const { data, error } = await admin
      .from('events')
      .select('id')
      .order('id', { ascending: true })

    if (error) throw error

    return (data ?? []).map((row) => ({
      params: { id: String(row.id) },
    }))
  } catch (err) {
    console.warn(
      '[admin] getStaticPaths: event id 一覧の取得に失敗しました（編集 URL は 404 になります）:',
      err instanceof Error ? err.message : err,
    )
    return []
  }
}
