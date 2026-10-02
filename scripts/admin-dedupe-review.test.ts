import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyDedupeCreateSelected,
  applyDedupeReviewAction,
} from '../src/lib/admin-dedupe-review'

type Row = Record<string, unknown>

function createFake(seed: {
  events: Row[]
  reviews: Row[]
  sources?: Row[]
}) {
  let nextEventId = 5000
  const eventsUpdated: number[] = []
  const tables = {
    events: seed.events,
    event_dedupe_reviews: seed.reviews,
    event_sources: seed.sources ?? [],
  }

  function from(table: keyof typeof tables) {
    const filters: Array<[string, unknown]> = []
    let op: 'select' | 'update' | 'insert' = 'select'
    let patch: Row | null = null
    let payload: Row | null = null

    const run = () => {
      const match = (row: Row) =>
        filters.every(([key, value]) => row[key] === value)
      if (op === 'insert' && payload) {
        const row = { ...payload }
        if (row.id == null) {
          row.id = table === 'events' ? nextEventId++ : tables[table].length + 1
        }
        tables[table].push(row)
        return [row]
      }
      const found = tables[table].filter(match)
      if (op === 'update' && patch) {
        if (table === 'events') {
          eventsUpdated.push(...found.map((row) => Number(row.id)))
        }
        for (const row of found) Object.assign(row, patch)
      }
      return found
    }

    const builder = {
      select() {
        return builder
      },
      eq(key: string, value: unknown) {
        filters.push([key, value])
        return builder
      },
      update(value: Row) {
        op = 'update'
        patch = value
        return builder
      },
      insert(value: Row) {
        op = 'insert'
        payload = value
        return builder
      },
      maybeSingle() {
        const list = run()
        return Promise.resolve({ data: list[0] ?? null, error: null })
      },
      single() {
        const list = run()
        return Promise.resolve({ data: list[0] ?? null, error: null })
      },
      then(
        resolve: (value: { data: Row[]; error: null }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve({ data: run(), error: null }).then(resolve, reject)
      },
    }
    return builder
  }

  return { from, tables, eventsUpdated }
}

function review(partial: Row): Row {
  return {
    status: 'pending',
    review_action: null,
    resolved_event_id: null,
    decided_by: null,
    decided_at: null,
    duplicate_status: 'ambiguous',
    candidate_event_id: 10,
    ...partial,
  }
}

function publishedEvent(): Row {
  return {
    id: 10,
    status: 'published',
    title: '既存の公開イベント',
    slug: 'existing-published',
    start_date: '2026-10-01',
    end_date: '2026-10-02',
  }
}

test('Walkerplus dedupe_create saves a draft, source, and created review', async () => {
  const published = publishedEvent()
  const db = createFake({
    events: [published],
    reviews: [
      review({
        id: 1,
        incoming_source_name: 'walkerplus',
        incoming_source_url: 'https://www.walkerplus.com/event/ar0313e615242/',
        incoming_payload: {
          title: '別の催し',
          start_date: '2026-11-01',
          end_date: '2026-11-01',
          venue: '会場A',
          source_url: 'https://www.walkerplus.com/event/ar0313e615242/',
          source_event_id: 'ar0313e615242',
          official_url: 'https://example.com/separate',
        },
      }),
    ],
  })

  const result = await applyDedupeReviewAction(db as never, 'dedupe_create', 1)
  const created = db.tables.events.find((row) => row.id === result.eventId)
  const saved = db.tables.event_dedupe_reviews[0]
  assert.equal(result.kind, 'created')
  assert.equal(created?.status, 'draft')
  assert.equal(created?.title, '別の催し')
  assert.equal(created?.slug, 'walkerplus-615242-2026')
  assert.equal(db.tables.event_sources.length, 1)
  assert.equal(db.tables.event_sources[0].source_name, 'walkerplus')
  assert.equal(db.tables.event_sources[0].source_event_id, 'ar0313e615242')
  assert.equal(db.tables.event_sources[0].event_id, result.eventId)
  assert.equal(saved.status, 'created')
  assert.equal(saved.review_action, 'create_new')
  assert.equal(saved.resolved_event_id, result.eventId)
  assert.equal(saved.decided_by, 'local_admin')
  assert.equal(typeof saved.decided_at, 'string')
  assert.equal(published.title, '既存の公開イベント')
  assert.deepEqual(db.eventsUpdated, [])
})

test('Walkerplus dedupe_link attaches the source and leaves the published event unchanged', async () => {
  const published = publishedEvent()
  const db = createFake({
    events: [published],
    reviews: [
      review({
        id: 2,
        incoming_source_name: 'walkerplus',
        incoming_source_url: 'https://www.walkerplus.com/event/ar0313e610979/',
        incoming_payload: {
          title: '別タイトル',
          start_date: '2026-12-01',
          source_url: 'https://www.walkerplus.com/event/ar0313e610979/',
          source_event_id: 'ar0313e610979',
        },
      }),
    ],
  })

  const result = await applyDedupeReviewAction(db as never, 'dedupe_link', 2)
  const saved = db.tables.event_dedupe_reviews[0]
  assert.equal(result.kind, 'linked')
  assert.equal(result.eventId, 10)
  assert.equal(db.tables.event_sources.length, 1)
  assert.equal(db.tables.event_sources[0].event_id, 10)
  assert.equal(db.tables.event_sources[0].source_event_id, 'ar0313e610979')
  assert.equal(saved.status, 'linked')
  assert.equal(saved.review_action, 'link_existing')
  assert.equal(saved.resolved_event_id, 10)
  assert.equal(saved.decided_by, 'local_admin')
  assert.equal(typeof saved.decided_at, 'string')
  assert.equal(published.title, '既存の公開イベント')
  assert.equal(published.status, 'published')
  assert.deepEqual(db.eventsUpdated, [])
})

test('Walkerplus dedupe_reject only marks the review rejected', async () => {
  const db = createFake({
    events: [publishedEvent()],
    reviews: [
      review({
        id: 3,
        incoming_source_name: 'walkerplus',
        incoming_source_url: 'https://www.walkerplus.com/event/ar0313e600001/',
        incoming_payload: { title: '見送る催し', start_date: '2026-10-10' },
      }),
    ],
  })

  const result = await applyDedupeReviewAction(db as never, 'dedupe_reject', 3)
  assert.equal(result.kind, 'rejected')
  assert.equal(result.eventId, null)
  assert.equal(db.tables.event_dedupe_reviews[0].status, 'rejected')
  assert.equal(db.tables.event_dedupe_reviews[0].review_action, 'reject')
  assert.equal(db.tables.event_dedupe_reviews[0].resolved_event_id, null)
  assert.equal(db.tables.events.length, 1)
  assert.equal(db.tables.event_sources.length, 0)
})

test('gotokyo and enjoytokyo create still save their own drafts', async () => {
  for (const source of ['gotokyo', 'enjoytokyo'] as const) {
    const url =
      source === 'gotokyo'
        ? 'https://www.gotokyo.org/jp/spot/ev321/index.html'
        : 'https://www.enjoytokyo.jp/event/654321/'
    const db = createFake({
      events: [],
      reviews: [
        review({
          id: 4,
          candidate_event_id: null,
          incoming_source_name: source,
          incoming_source_url: url,
          incoming_payload: {
            title: `${source}の別催し`,
            start_date: '2026-10-20',
            source_url: url,
          },
        }),
      ],
    })
    const result = await applyDedupeReviewAction(db as never, 'dedupe_create', 4)
    assert.equal(db.tables.events[0].status, 'draft')
    assert.equal(db.tables.events[0].slug, source === 'gotokyo' ? 'gotokyo-ev321-2026' : 'enjoytokyo-654321-2026')
    assert.equal(db.tables.event_sources[0].source_name, source)
    assert.equal(db.tables.event_dedupe_reviews[0].status, 'created')
    assert.equal(db.tables.event_dedupe_reviews[0].resolved_event_id, result.eventId)
  }
})

test('an already attached Walkerplus source is not inserted twice', async () => {
  const db = createFake({
    events: [publishedEvent()],
    sources: [
      {
        id: 1,
        event_id: 10,
        source_name: 'walkerplus',
        source_url: 'https://www.walkerplus.com/event/ar0313e610979/',
        source_event_id: 'ar0313e610979',
      },
    ],
    reviews: [
      review({
        id: 5,
        incoming_source_name: 'walkerplus',
        incoming_source_url: 'https://www.walkerplus.com/event/ar0313e610979/',
        incoming_payload: {
          title: '別タイトル',
          source_url: 'https://www.walkerplus.com/event/ar0313e610979/',
          source_event_id: 'ar0313e610979',
        },
      }),
    ],
  })

  await applyDedupeReviewAction(db as never, 'dedupe_link', 5)
  assert.equal(db.tables.event_sources.length, 1)
  assert.equal(db.tables.event_dedupe_reviews[0].status, 'linked')
  assert.equal(publishedTitle(db), '既存の公開イベント')
})

test('a failed Walkerplus create leaves the review pending', async () => {
  const db = createFake({
    events: [{ id: 9, status: 'draft', title: '既存draft', slug: 'walkerplus-615242-2026' }],
    reviews: [
      review({
        id: 6,
        incoming_source_name: 'walkerplus',
        incoming_source_url: 'https://www.walkerplus.com/event/ar0313e615242/',
        incoming_payload: {
          title: '別の催し',
          start_date: '2026-11-01',
          source_url: 'https://www.walkerplus.com/event/ar0313e615242/',
          source_event_id: 'ar0313e615242',
        },
      }),
    ],
  })

  await assert.rejects(
    () => applyDedupeReviewAction(db as never, 'dedupe_create', 6),
    /Slug already exists/,
  )
  assert.equal(db.tables.event_dedupe_reviews[0].status, 'pending')
  assert.equal(db.tables.event_dedupe_reviews[0].decided_at, null)
  assert.equal(db.tables.events.length, 1)
  assert.equal(db.tables.event_sources.length, 0)
})

test('a resolved review is not returned to pending', async () => {
  const db = createFake({
    events: [publishedEvent()],
    reviews: [
      review({
        id: 7,
        status: 'rejected',
        review_action: 'reject',
        incoming_source_name: 'walkerplus',
        incoming_source_url: 'https://www.walkerplus.com/event/ar0313e600001/',
        incoming_payload: { title: '見送る催し' },
      }),
    ],
  })

  await assert.rejects(
    () => applyDedupeReviewAction(db as never, 'dedupe_reject', 7),
    /not pending/,
  )
  assert.equal(db.tables.event_dedupe_reviews[0].status, 'rejected')
})

function publishedTitle(db: { tables: { events: Row[] } }): unknown {
  return db.tables.events.find((row) => row.id === 10)?.title
}

function walkerReview(id: number, sourceId: string, title: string): Row {
  const url = `https://www.walkerplus.com/event/${sourceId}/`
  return review({
    id,
    incoming_source_name: 'walkerplus',
    incoming_source_url: url,
    incoming_payload: {
      title,
      start_date: '2026-11-01',
      source_url: url,
      source_event_id: sourceId,
    },
  })
}

test('bulk dedupe_create saves only the selected reviews', async () => {
  const published = publishedEvent()
  const db = createFake({
    events: [published],
    reviews: [
      walkerReview(1, 'ar0313e615242', '催しA'),
      walkerReview(2, 'ar0313e610979', '催しB'),
      walkerReview(3, 'ar0313e600003', '催しC'),
      review({
        id: 4,
        incoming_source_name: 'walkerplus',
        incoming_source_url: 'https://www.walkerplus.com/event/ar0313e600004/',
        incoming_payload: {
          title: '',
          start_date: '2026-11-01',
          source_url: 'https://www.walkerplus.com/event/ar0313e600004/',
          source_event_id: 'ar0313e600004',
        },
      }),
      walkerReview(5, 'ar0313e600005', '未選択'),
    ],
  })

  const results = await applyDedupeCreateSelected(db as never, [1, 2, 4])
  const byId = (id: number) =>
    db.tables.event_dedupe_reviews.find((row) => row.id === id)

  assert.deepEqual(
    results.map((item) => item.ok),
    [true, true, false],
  )
  assert.equal(byId(1)?.status, 'created')
  assert.equal(byId(1)?.review_action, 'create_new')
  assert.equal(byId(1)?.decided_by, 'local_admin')
  assert.equal(typeof byId(1)?.decided_at, 'string')
  assert.equal(byId(2)?.status, 'created')
  assert.equal(byId(2)?.resolved_event_id, results[1] && results[1].ok ? results[1].eventId : null)
  assert.equal(byId(4)?.status, 'pending')
  assert.equal(byId(4)?.decided_at, null)
  assert.equal(byId(5)?.status, 'pending')
  assert.equal(byId(5)?.resolved_event_id, null)

  const drafts = db.tables.events.filter((row) => row.status === 'draft')
  assert.equal(drafts.length, 2)
  assert.deepEqual(
    drafts.map((row) => row.slug),
    ['walkerplus-615242-2026', 'walkerplus-610979-2026'],
  )
  assert.equal(db.tables.event_sources.length, 2)
  assert.deepEqual(
    db.tables.event_sources.map((row) => row.event_id),
    drafts.map((row) => row.id),
  )
  assert.equal(published.title, '既存の公開イベント')
  assert.equal(published.status, 'published')
  assert.deepEqual(db.eventsUpdated, [])
  assert.equal(
    db.tables.event_dedupe_reviews.some((row) => row.status === 'linked'),
    false,
  )
})

test('a second bulk create does not register the same reviews again', async () => {
  const published = publishedEvent()
  const db = createFake({
    events: [published],
    reviews: [
      walkerReview(11, 'ar0313e615242', '催しA'),
      walkerReview(12, 'ar0313e615242', '催しAの重複'),
      walkerReview(13, 'ar0313e610979', '催しB'),
    ],
  })

  const first = await applyDedupeCreateSelected(db as never, [11, 12, 13])
  assert.equal(first[0].ok, true)
  assert.equal(first[1].ok, false)
  assert.equal(first[2].ok, true)
  assert.equal(db.tables.events.filter((row) => row.status === 'draft').length, 2)
  assert.equal(db.tables.event_sources.length, 2)
  assert.equal(db.tables.event_dedupe_reviews.find((row) => row.id === 12)?.status, 'pending')

  const again = await applyDedupeCreateSelected(db as never, [11, 13])
  assert.equal(again[0].ok, false)
  assert.equal(again[1].ok, false)
  assert.equal(db.tables.events.filter((row) => row.status === 'draft').length, 2)
  assert.equal(db.tables.event_sources.length, 2)
  assert.equal(published.title, '既存の公開イベント')
  assert.deepEqual(db.eventsUpdated, [])
})
