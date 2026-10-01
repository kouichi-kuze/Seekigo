export type ListedEventGroupKey = 'today' | 'upcoming' | 'other'

export type ListedEventGroup<T> = {
  key: ListedEventGroupKey
  events: T[]
}

/** 並び順は維持したまま、状態が変わったところで区切る。 */
export function groupListedEvents<T>(
  events: T[],
  statusOf: (event: T) => string | null,
): ListedEventGroup<T>[] {
  const groups: ListedEventGroup<T>[] = []

  for (const event of events) {
    const status = statusOf(event)
    const key: ListedEventGroupKey =
      status === 'today' || status === 'upcoming' ? status : 'other'
    const last = groups[groups.length - 1]
    if (!last || last.key !== key) {
      groups.push({ key, events: [event] })
    } else {
      last.events.push(event)
    }
  }

  return groups
}

export function listGroupLabel(key: ListedEventGroupKey): string | null {
  if (key === 'today') return '本日開催'
  if (key === 'upcoming') return 'これから開催'
  return null
}
