import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  bulkImageExclusionReasons,
  isBulkImageCandidate,
  type BulkImageEvent,
} from '../src/lib/event-generated-image-eligibility'

function event(overrides: Partial<BulkImageEvent> = {}): BulkImageEvent {
  return {
    id: 1,
    title: 'example',
    status: 'published',
    start_date: '2026-10-01',
    end_date: '2026-10-02',
    image_url: null,
    image_usage_status: 'unknown',
    generated_image_url: null,
    generated_image_status: 'none',
    generated_image_source: null,
    generated_image_instruction: null,
    ...overrides,
  }
}

test('a normal run does not accept an active draft', () => {
  assert.equal(isBulkImageCandidate(event({ status: 'draft' }), 'upcoming'), false)
  assert.deepEqual(bulkImageExclusionReasons(event({ status: 'draft' }), 'upcoming'), [
    'not_active',
  ])
})

test('an explicit draft allowance accepts an active draft', () => {
  assert.equal(
    isBulkImageCandidate(event({ status: 'draft' }), 'today', { allowDraft: true }),
    true,
  )
})

test('an ended draft stays excluded even when drafts are allowed', () => {
  assert.equal(
    isBulkImageCandidate(event({ status: 'draft' }), 'ended', { allowDraft: true }),
    false,
  )
})

test('draft allowance does not bypass a rights-cleared image or a pending image', () => {
  const licensed = event({
    status: 'draft',
    image_url: 'https://example.test/official.jpg',
    image_usage_status: 'licensed',
  })
  const pending = event({
    status: 'draft',
    generated_image_status: 'pending',
    generated_image_url: '/images/event-generated/1.webp',
    generated_image_source: 'openai',
  })
  assert.equal(isBulkImageCandidate(licensed, 'upcoming', { allowDraft: true }), false)
  assert.equal(isBulkImageCandidate(pending, 'upcoming', { allowDraft: true }), false)
  assert.ok(
    bulkImageExclusionReasons(licensed, 'upcoming', { allowDraft: true }).includes(
      'official_image',
    ),
  )
})
