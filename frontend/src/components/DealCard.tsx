import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Deal } from '../types'
import { conditionLabel, priceView, timingLabel, verificationLabel } from '../format'
import { useFavorites } from '../favorites'
import { ArrowUpRight, Bookmark } from 'lucide-react'

export function CategoryPlaceholder({ name }: { name: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-teal-50 to-cream-100 text-teal-700" role="img" aria-label={`${name} category placeholder`}>
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.500" aria-hidden="true">
        <path d="M3 12V4h8l10 10-8 8z" strokeLinejoin="round" />
        <circle cx="7.500" cy="8.500" r="1.200" fill="currentColor" />
      </svg>
      <span className="text-xs font-semibold uppercase tracking-wide">{name}</span>
    </div>
  )
}

export function SaveButton({ id, title }: { id: number; title: string }) {
  const favorites = useFavorites()
  const [error, setError] = useState('')
  if (!favorites) return null
  const saved = favorites.ids.includes(id)
  const label = saved ? `Remove ${title} from favorites` : `Add ${title} to favorites`
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" aria-pressed={saved} aria-label={label} title={label}
        disabled={favorites.loading || Boolean(favorites.error) || favorites.pending.includes(id)}
        onClick={() => { setError(''); void favorites.toggle(id).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not update favorites.')) }}
        className={`btn h-11 w-11 border !p-0 ${saved ? 'border-accent-600 bg-orange-50 text-accent-700' : 'border-teal-700/30 bg-white text-teal-800 hover:bg-teal-50'}`}>
        <Bookmark size={19} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" />
      </button>
      {error && <span role="alert" className="text-xs text-red-800">{error}</span>}
    </span>
  )
}

export function DealCard({ deal, to }: { deal: Deal; to?: string }) {
  const price = priceView(deal)
  const ver = verificationLabel(deal)
  const detail = to ?? `/deals/${deal.id}`
  const conditions = [deal.rewardText, deal.conditionsText].filter(Boolean) as string[]
  const timingTone = deal.timing === 'expired' ? 'bg-red-50 text-red-800' : deal.timing === 'active' ? 'bg-teal-50 text-teal-800' : 'bg-cream-100 text-ink-soft'
  return (
    <article className="deal-card card flex flex-col overflow-hidden" aria-labelledby={`deal-${deal.id}-title`}>
      <div className="flex flex-1 flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="chip bg-teal-50 text-teal-800">{deal.retailer.name}</span>
          {deal.offerType === 'STOREWIDE' && <span className="chip bg-orange-50 text-accent-700">Storewide promotion</span>}
          {deal.condition !== 'NEW' && deal.condition !== 'UNKNOWN' && <span className="chip bg-cream-100 text-ink">{conditionLabel[deal.condition]}</span>}
          {deal.status === 'EXPIRED' && <span className="chip bg-red-50 text-red-800">expired</span>}
          {!to && <span className="ml-auto"><SaveButton id={deal.id} title={deal.title} /></span>}
        </div>
        <h3 id={`deal-${deal.id}-title`} className="text-base font-bold leading-snug text-ink">
          {deal.retailerLink && !to ? <a href={deal.retailerLink} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-teal-700/40 underline-offset-2 hover:decoration-teal-700">{deal.title}</a> : <Link to={detail} className="underline decoration-teal-700/40 underline-offset-2 hover:decoration-teal-700">{deal.title}</Link>}
          {deal.variant && <span className="block text-sm font-normal text-ink-soft">{deal.variant}</span>}
        </h3>
        <div>
          <p className={price.kind === 'cash' ? 'text-2xl font-extrabold text-teal-800' : 'text-base font-semibold text-ink'}>{price.main}</p>
          {price.note && <p className="text-xs text-ink-soft">{price.note}</p>}
          {deal.discountPercent != null && deal.referencePrice != null && (
            <p className="mt-1 text-xs text-ink-soft">
              {deal.discountPercent}% below the advertised reference price of ${deal.referencePrice.toFixed(2)}
            </p>
          )}
        </div>
        {conditions.length > 0 && (
          <ul className="space-y-1 text-sm text-accent-700">
            {conditions.map((c, i) => (
              <li key={i} className="line-clamp-2 rounded-lg bg-orange-50 px-2 py-1">
                <span className="font-semibold">Conditions: </span>
                {c}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto space-y-2 pt-1 text-xs text-ink-soft">
          <p><span className={`chip ${timingTone}`}>{timingLabel(deal)}</span></p>
          <p className={ver.tone === 'good' ? 'font-medium text-teal-800' : ''}>{ver.text}</p>
        </div>
        {deal.retailerLink && !to && <a href={deal.retailerLink} target="_blank" rel="noopener noreferrer nofollow" className="btn-primary mt-1">Go to retailer <ArrowUpRight size={16} aria-hidden="true" /><span className="sr-only">: {deal.title}</span></a>}
      </div>
    </article>
  )
}
