/** DEV 専用 admin。本番 build では 404 のみ返す。 */
export function adminDevNotFoundResponse(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  })
}

export function assertAdminDev(): void {
  if (!import.meta.env.DEV) {
    throw adminDevNotFoundResponse()
  }
}
