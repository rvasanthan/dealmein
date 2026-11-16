import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Deal } from '../types'
import { DealCard } from './DealCard'
import * as favorites from '../favorites'

const deal = {
  id: 12, title: 'Desk lamp', variant: null, condition: 'NEW', retailer: { name: 'Store', slug: 'store' },
  offerType: 'PRODUCT', listedCashPrice: null, originalPriceText: null, sourcePriceText: null, referencePrice: null,
  discountPercent: null, rewardText: null, conditionsText: null, timing: 'unknown', startsOn: null, endsOn: null,
  startsAt: null, endsAt: null, dateText: null, reviewedAt: null, retailerVerifiedAt: null, retailerLink: null, status: 'DRAFT',
} as Deal

function renderCard(item: Deal, to?: string) {
  return renderToStaticMarkup(<StaticRouter location="/"><DealCard deal={item} to={to} /></StaticRouter>)
}

describe('deal card links', () => {
  afterEach(() => vi.restoreAllMocks())
  it('links to the retailer when a product URL exists, without save or detail buttons', () => {
    const markup = renderCard({ ...deal, retailerLink: 'https://store.example/lamp' })
    expect(markup).toContain('href="https://store.example/lamp"')
    expect(markup).toContain('Go to retailer')
    expect(markup).not.toContain('View details')
    expect(markup).not.toContain('>Save<')
  })
  it('keeps the title clickable when no retailer URL is available', () => {
    const markup = renderCard(deal)
    expect(markup).toContain('href="/deals/12"')
    expect(markup).not.toContain('View details')
    expect(markup).not.toContain('<button')
  })
  it('preserves the administrator title link', () => {
    expect(renderCard(deal, '/admin/deals/12')).toContain('href="/admin/deals/12"')
  })
  it('shows an accessible bookmark reflecting the account favorite state', () => {
    const state = { ids: [] as number[], loading: false, error: null, pending: [], retry: () => {}, toggle: async () => {} }
    vi.spyOn(favorites, 'useFavorites').mockReturnValue(state)
    expect(renderCard(deal)).toContain('aria-label="Add Desk lamp to favorites"')
    state.ids = [12]
    const markup = renderCard(deal)
    expect(markup).toContain('aria-label="Remove Desk lamp from favorites"')
    expect(markup).toContain('aria-pressed="true"')
    expect(renderCard(deal, '/admin/deals/12')).not.toContain('favorites')
  })
})