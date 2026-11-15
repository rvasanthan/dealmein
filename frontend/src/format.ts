import type { Deal } from './types'

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
export const money = (n: number) => usd.format(n)

/** Date-only values are formatted from their parts so no timezone shift can move the day. */
export function dateOnly(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function instant(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function dayOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export interface PriceView {
  kind: 'cash' | 'text' | 'none'
  main: string
  note?: string
}

/** Never turns text such as "$59.99 after gift card" into a checkout price. */
export function priceView(d: Pick<Deal, 'listedCashPrice' | 'originalPriceText' | 'sourcePriceText' | 'offerType'>): PriceView {
  if (d.listedCashPrice != null) return { kind: 'cash', main: money(d.listedCashPrice), note: 'Listed price, before tax and shipping' }
  const text = d.originalPriceText ?? d.sourcePriceText
  if (text) return { kind: 'text', main: text, note: 'As reported by the source. No single checkout price confirmed.' }
  return { kind: 'none', main: d.offerType === 'STOREWIDE' ? 'Storewide promotion' : 'Price not listed' }
}

export function timingLabel(d: Pick<Deal, 'timing' | 'startsOn' | 'endsOn' | 'startsAt' | 'endsAt' | 'dateText'>): string {
  const end = d.endsAt ? instant(d.endsAt) : d.endsOn ? dateOnly(d.endsOn) : null
  const start = d.startsAt ? instant(d.startsAt) : d.startsOn ? dateOnly(d.startsOn) : null
  switch (d.timing) {
    case 'active':
      return end ? `Ends ${end}` : start ? `Started ${start}` : 'Active now'
    case 'upcoming':
      return start ? `Starts ${start}` : 'Upcoming'
    case 'expired':
      return end ? `Ended ${end}` : 'Expired'
    default:
      return d.dateText ? `Timing unclear: “${d.dateText}”` : 'Sale dates not confirmed'
  }
}

export function verificationLabel(d: Pick<Deal, 'reviewedAt' | 'retailerVerifiedAt'>): { text: string; tone: 'good' | 'neutral' } {
  if (d.retailerVerifiedAt) return { text: `Verified with retailer ${dayOf(d.retailerVerifiedAt)}`, tone: 'good' }
  if (d.reviewedAt) return { text: `Checked by Deal Me In ${dayOf(d.reviewedAt)}`, tone: 'good' }
  return { text: 'Reported by source · not verified', tone: 'neutral' }
}

export const conditionLabel: Record<string, string> = { NEW: 'New', USED: 'Used', REFURBISHED: 'Refurbished' }
