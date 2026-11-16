import { renderToStaticMarkup } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom/server'
import { describe, expect, it } from 'vitest'
import type { Deal } from '../types'
import { DealCard } from './DealCard'

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
})