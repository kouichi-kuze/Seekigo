import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveWalkerplusMaxItems,
  resolveWalkerplusMaxListPages,
  WALKERPLUS_DEFAULT_MAX_ITEMS,
  WALKERPLUS_HARD_MAX_ITEMS,
  WALKERPLUS_HARD_MAX_LIST_PAGES,
  WALKERPLUS_PHASE_MAX_ITEMS,
} from './lib/walkerplus-parse'

test('default item limit stays 50', () => {
  assert.equal(WALKERPLUS_DEFAULT_MAX_ITEMS, 50)
  assert.equal(WALKERPLUS_PHASE_MAX_ITEMS, 50)
  assert.equal(resolveWalkerplusMaxItems(undefined), 50)
  assert.equal(resolveWalkerplusMaxItems(''), 50)
  assert.equal(resolveWalkerplusMaxItems('0'), 50)
  assert.equal(resolveWalkerplusMaxItems('abc'), 50)
})

test('env can raise the item limit up to 100', () => {
  assert.equal(WALKERPLUS_HARD_MAX_ITEMS, 100)
  assert.equal(resolveWalkerplusMaxItems('100'), 100)
  assert.equal(resolveWalkerplusMaxItems('101'), 100)
  assert.equal(resolveWalkerplusMaxItems('75'), 75)
})

test('default 50 items keeps the historical 5 list pages', () => {
  assert.equal(resolveWalkerplusMaxListPages(50, undefined), 5)
  assert.equal(resolveWalkerplusMaxListPages(50, ''), 5)
})

test('100 items can walk enough list pages to fill the cap', () => {
  const pages = resolveWalkerplusMaxListPages(100, undefined)
  assert.ok(pages >= 10)
  assert.ok(pages <= WALKERPLUS_HARD_MAX_LIST_PAGES)
})

test('list page env cannot exceed the hard page cap', () => {
  assert.equal(resolveWalkerplusMaxListPages(100, '99'), WALKERPLUS_HARD_MAX_LIST_PAGES)
  assert.equal(resolveWalkerplusMaxListPages(50, '3'), 3)
})
