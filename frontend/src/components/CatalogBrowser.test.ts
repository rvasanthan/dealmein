import { describe, expect, it } from 'vitest'
import type { Deal } from '../types'
import { matchesCatalogSearch } from './CatalogBrowser'

const deal = { title: 'Wireless Headphones', variant: 'Black', model: 'AB100',
  retailer: { name: 'Example Store', slug: 'example' }, category: { name: 'Electronics', slug: 'electronics' }, seller: null } as Deal

describe('catalog search', () => {
  it('matches words across product, retailer, and category regardless of case', () => {
    expect(matchesCatalogSearch(deal, 'HEADPHONES example')).toBe(true)
    expect(matchesCatalogSearch(deal, 'electronics ab100')).toBe(true)
    expect(matchesCatalogSearch(deal, 'black store')).toBe(true)
  })

  it('returns all products for an empty query and excludes unmatched products', () => {
    expect(matchesCatalogSearch(deal, '  ')).toBe(true)
    expect(matchesCatalogSearch(deal, 'headphones television')).toBe(false)
  })
})