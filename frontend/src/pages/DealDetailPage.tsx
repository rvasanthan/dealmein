import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError } from '../api'
import type { Deal } from '../types'
import { conditionLabel, dateOnly, instant, money, priceView, timingLabel, verificationLabel } from '../format'
import { CategoryPlaceholder, DealCard, SaveButton } from '../components/DealCard'
import { Empty, ErrorBox, Notice, Spinner } from '../components/ui'

export function DealView({ deal, admin = false }: { deal: Deal; admin?: boolean }) {
  const price = priceView(deal)
  const ver = verificationLabel(deal)
  const listing = deal.listingLink ?? deal.sources?.find((s) => s.url)?.url ?? null
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-6">
        <div className="card overflow-hidden">
          <div className="aspect-[16/8] bg-cream-100">
            {deal.imageUrl ? <img src={deal.imageUrl} alt="" className="h-full w-full object-contain" referrerPolicy="no-referrer" /> : <CategoryPlaceholder name={deal.category.name} />}
          </div>
          <div className="space-y-3 p-6">
            <div className="flex flex-wrap gap-2 text-xs">
              <Link to={`/?retailer=${deal.retailer.slug}`} className="chip bg-teal-50 text-teal-800">{deal.retailer.name}</Link>
              <Link to={`/?category=${deal.category.slug}`} className="chip bg-cream-100 text-ink">{deal.category.name}</Link>
              {deal.offerType === 'STOREWIDE' && <span className="chip bg-orange-50 text-accent-700">Storewide promotion</span>}
              {deal.condition !== 'UNKNOWN' && <span className="chip bg-cream-100 text-ink">{conditionLabel[deal.condition]}</span>}
            </div>
            <h1 className="text-2xl font-extrabold leading-tight text-ink">{deal.title}</h1>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {deal.variant && (<><dt className="text-ink-soft">Variant</dt><dd>{deal.variant}</dd></>)}
              {deal.model && (<><dt className="text-ink-soft">Model</dt><dd>{deal.model}</dd></>)}
              <dt className="text-ink-soft">Retailer</dt><dd>{deal.retailer.name}</dd>
              {deal.seller && (<><dt className="text-ink-soft">Seller</dt><dd>{deal.seller}</dd></>)}
            </dl>
          </div>
        </div>

        <section className="card space-y-3 p-6" aria-labelledby="price-h">
          <h2 id="price-h" className="text-lg font-bold text-teal-800">Price and conditions</h2>
          <p className={price.kind === 'cash' ? 'text-3xl font-extrabold text-teal-800' : 'text-lg font-semibold'}>{price.main}</p>
          {price.note && <p className="text-sm text-ink-soft">{price.note}</p>}
          {deal.shippingCost != null && <p className="text-sm">Shipping: {money(deal.shippingCost)}</p>}
          {deal.taxNote && <p className="text-sm">{deal.taxNote}</p>}
          {deal.referencePrice != null && (
            <p className="text-sm text-ink-soft">
              Advertised reference price: {money(deal.referencePrice)}
              {deal.discountPercent != null && ` (${deal.discountPercent}% lower). This is the price the source advertised for comparison, not a verified price history.`}
            </p>
          )}
          {(deal.rewardText || deal.conditionsText) && (
            <div className="rounded-xl bg-orange-50 p-4 text-sm text-accent-700">
              <p className="font-semibold">Conditions that may apply</p>
              {deal.rewardText && <p className="mt-1">{deal.rewardText}</p>}
              {deal.conditionsText && <p className="mt-1">{deal.conditionsText}</p>}
              <p className="mt-2 text-xs">Gift cards, rebates and similar rewards are not subtracted from the price shown. They are not part of what you pay at checkout.</p>
            </div>
          )}
          {deal.rewardAmount != null && <p className="text-sm text-ink-soft">Reward amount reported by source: {money(deal.rewardAmount)}</p>}
        </section>

        <section className="card space-y-2 p-6" aria-labelledby="timing-h">
          <h2 id="timing-h" className="text-lg font-bold text-teal-800">Sale timing</h2>
          <p className="font-medium">{timingLabel(deal)}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {(deal.startsOn || deal.startsAt) && (<><dt className="text-ink-soft">Starts</dt><dd>{deal.startsAt ? instant(deal.startsAt) : dateOnly(deal.startsOn!)}</dd></>)}
            {(deal.endsOn || deal.endsAt) && (<><dt className="text-ink-soft">Ends</dt><dd>{deal.endsAt ? instant(deal.endsAt) : `${dateOnly(deal.endsOn!)} (through the end of the day${deal.retailerTimezone ? `, ${deal.retailerTimezone}` : ''})`}</dd></>)}
            {deal.dateText && (<><dt className="text-ink-soft">Original wording</dt><dd>“{deal.dateText}”</dd></>)}
          </dl>
          {deal.dateStatus === 'CONFLICT' && <Notice tone="warn">Sources disagree about these dates, so we can't confirm the offer is active.</Notice>}
        </section>

        {deal.reviewNotices.length > 0 && (
          <section className="space-y-2" aria-label="Review notices">
            {deal.reviewNotices.map((n) => <Notice key={n} tone="warn">{n}</Notice>)}
          </section>
        )}

        <section className="card space-y-3 p-6" aria-labelledby="src-h">
          <h2 id="src-h" className="text-lg font-bold text-teal-800">Sources</h2>
          <ul className="space-y-2 text-sm">
            {(deal.sources ?? []).map((s) => (
              <li key={s.id} className="rounded-lg bg-cream p-3">
                <p className="font-medium">{s.name ?? 'Source'}{s.collectedAt && <span className="font-normal text-ink-soft"> · collected {instant(s.collectedAt)}</span>}</p>
                {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-teal-700 underline">{s.url}</a> : <span className="text-ink-soft">No link in source ({s.ref})</span>}
              </li>
            ))}
          </ul>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            {deal.collectedAt && (<><dt className="text-ink-soft">Collected</dt><dd>{instant(deal.collectedAt)}</dd></>)}
            <dt className="text-ink-soft">Retailer verification</dt>
            <dd>{deal.retailerVerifiedAt ? instant(deal.retailerVerifiedAt) : 'Not verified with the retailer'}</dd>
            {deal.sourceVerificationStatus && (<><dt className="text-ink-soft">Source status</dt><dd>{deal.sourceVerificationStatus}</dd></>)}
          </dl>
          <p className="text-xs text-ink-soft">The collection time is when the source reported this offer. It is not a retailer check.</p>
        </section>

        {deal.related && deal.related.length > 0 && (
          <section aria-labelledby="rel-h">
            <h2 id="rel-h" className="mb-1 text-lg font-bold text-teal-800">Possibly related offers</h2>
            <p className="mb-3 text-sm text-ink-soft">These are suggestions only. They may differ by retailer, size, color, condition, sale period or conditions. Compare carefully.</p>
            <ul className="grid gap-4 sm:grid-cols-2">
              {deal.related.map((r) => <li key={r.id} className="flex"><div className="flex w-full flex-col"><DealCard deal={r} to={admin ? `/admin/deals/${r.id}` : undefined} /></div></li>)}
            </ul>
          </section>
        )}
      </div>

      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start" aria-label="Actions">
        <div className="card space-y-3 p-5">
          <p className={ver.tone === 'good' ? 'font-semibold text-teal-800' : 'text-sm text-ink-soft'}>{ver.text}</p>
          {deal.retailerLink ? (
            <a className="btn-accent w-full" href={deal.retailerLink} target="_blank" rel="noopener noreferrer nofollow">Go to retailer</a>
          ) : listing ? (
            <>
              <a className="btn-primary w-full" href={listing} target="_blank" rel="noopener noreferrer nofollow">View original listing</a>
              <p className="text-xs text-ink-soft">This links to the publisher that reported the offer, not to the retailer's product page.</p>
            </>
          ) : (
            <p className="text-sm text-ink-soft">No link is available for this offer.</p>
          )}
          <SaveButton id={deal.id} title={deal.title} />
        </div>
        {!admin && <ReportForm id={deal.id} />}
      </aside>
    </div>
  )
}

function ReportForm({ id }: { id: number }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('EXPIRED')
  const [message, setMessage] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)
  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    setState('sending')
    setError(null)
    try {
      await api(`/api/deals/${id}/reports`, { method: 'POST', body: { reason, message: message.trim() || null } })
      setState('done')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send your report.')
      setState('idle')
    }
  }
  if (state === 'done') return <Notice>Thanks. We'll review your report.</Notice>
  return (
    <div className="card p-5">
      {!open ? (
        <button type="button" className="btn-ghost w-full" onClick={() => setOpen(true)}>Report expired or incorrect</button>
      ) : (
        <form onSubmit={send} className="space-y-3">
          <div>
            <label htmlFor="reason" className="label">What's wrong?</label>
            <select id="reason" className="field" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="EXPIRED">The offer has expired</option>
              <option value="WRONG_PRICE">The price is wrong</option>
              <option value="WRONG_LINK">The link is wrong</option>
              <option value="OTHER">Something else</option>
            </select>
          </div>
          <div>
            <label htmlFor="msg" className="label">Details (optional)</label>
            <textarea id="msg" className="field" rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={state === 'sending'}>Send report</button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  )
}

export default function DealDetailPage() {
  const { id } = useParams()
  const [deal, setDeal] = useState<Deal | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    setDeal(null)
    setError(null)
    api<Deal>(`/api/deals/${id}`).then(setDeal).catch(setError)
  }, [id, n])
  if (error instanceof ApiError && error.status === 404) {
    return <Empty title="This deal isn't available" action={<Link to="/" className="btn-primary">Browse all deals</Link>}>It may have been removed, archived, or not published yet.</Empty>
  }
  return (
    <>
      <p className="mb-3"><Link to="/" className="text-sm text-teal-700 underline">← All deals</Link></p>
      {error ? <ErrorBox error={error} onRetry={() => setN((x) => x + 1)} /> : !deal ? <Spinner /> : (
        <>
          {deal.timing === 'expired' && <div className="mb-4"><Notice tone="warn">This offer has ended. It's kept here for reference only.</Notice></div>}
          <DealView deal={deal} />
        </>
      )}
    </>
  )
}
