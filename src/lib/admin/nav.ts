export type AdminNavItem = {
  label: string
  href: string
  /** pathname がこの prefix で始まれば active */
  matchPrefix?: string
}

export type AdminNavSection = {
  title: string
  items: AdminNavItem[]
}

export const ADMIN_NAV: AdminNavSection[] = [
  {
    title: '',
    items: [{ label: 'Dashboard', href: '/admin/events/' }],
  },
  {
    title: 'Events',
    items: [
      { label: 'All Events', href: '/admin/events/all/' },
      { label: 'Draft', href: '/admin/events/draft/' },
      { label: 'Published', href: '/admin/events/published/' },
      { label: 'Hidden', href: '/admin/events/hidden/' },
      { label: 'Ended', href: '/admin/events/ended/' },
    ],
  },
  {
    title: 'Reviews',
    items: [
      {
        label: 'Field Reviews',
        href: '/admin/events/reviews/field/pending/',
        matchPrefix: '/admin/events/reviews/field',
      },
      {
        label: 'Image Reviews',
        href: '/admin/events/reviews/image/',
        matchPrefix: '/admin/events/reviews/image',
      },
    ],
  },
  {
    title: 'Data',
    items: [
      {
        label: 'Sources',
        href: '/admin/events/sources/',
        matchPrefix: '/admin/events/sources',
      },
    ],
  },
]

export function isAdminNavActive(
  pathname: string,
  item: AdminNavItem,
): boolean {
  if (pathname === item.href || pathname === item.href.replace(/\/$/, '')) {
    return true
  }
  const prefix = item.matchPrefix ?? item.href.replace(/\/$/, '')
  if (item.href === '/admin/events/' && pathname === '/admin/events') {
    return true
  }
  if (item.href === '/admin/events/') {
    return false
  }
  return pathname.startsWith(prefix)
}
