import { describe, expect, it } from 'vitest'
import { dateOnly, priceView, timingLabel, verificationLabel } from './format'

describe('priceView', () => {
  it('shows a cash price only when one is listed', () => {
    expect(priceView({ listedCashPrice: 499.99, originalPriceText: null, sourcePriceText: null, offerType: 'PRODUCT' }).kind).toBe('cash')
  })
  it('keeps conditional price text as text, never as a checkout price', () => {
    const v = priceView({ listedCashPrice: null, originalPriceText: '$59.99 after $10 gift card', sourcePriceText: null, offerType: 'PRODUCT' })
    expect(v.kind).toBe('text')
    expect(v.main).toBe('$59.99 after $10 gift card')
  })
  it('does not render zero for unknown prices', () => {
    const v = priceView({ listedCashPrice: null, originalPriceText: null, sourcePriceText: null, offerType: 'PRODUCT' })
    expect(v.kind).toBe('none')
    expect(v.main).not.toContain('$0')
  })
})

describe('dates', () => {
  it('formats date-only values without timezone drift', () => {
    expect(dateOnly('2025-11-28')).toBe('Nov 28, 2025')
  })
  it('does not call unknown timing active', () => {
    const base = { startsOn: null, endsOn: null, startsAt: null, endsAt: null }
    expect(timingLabel({ ...base, timing: 'unknown', dateText: 'Black Friday' })).toContain('unclear')
    expect(timingLabel({ ...base, timing: 'unknown', dateText: null })).toBe('Sale dates not confirmed')
  })
})

describe('verification label', () => {
  it('defaults to not verified', () => {
    expect(verificationLabel({ reviewedAt: null, retailerVerifiedAt: null }).tone).toBe('neutral')
  })
})
