import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Deal } from '../types'
import { DealCard } from '../components/DealCard'
import { Empty, ErrorBox, Notice, Spinner } from '../components/ui'
import { useSaved } from '../saved'

export default function SavedPage() {
  const { ids, toggle } = useSaved()
  const [deals, setDeals] = useState<Deal[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [n, setN] = useState(0)
  const key = ids.join(',')

  useEffect(() => {
    if (!key) {
      setDeals([])
      return
    }
    setError(null)
    api<Deal[]>(`/api/deals/by-ids?ids=${key}`).then(setDeals).catch(setError)
  }, [key, n])

  return (
    <>
      <h1 className="mb-2 text-2xl font-extrabold text-teal-800">Saved Deals</h1>
      <div className="mb-5"><Notice>Saved deals are stored only in this browser on this device. Clearing your browsing data or switching browsers will remove them. No account is needed.</Notice></div>
      {error ? <ErrorBox error={error} onRetry={() => setN((x) => x + 1)} /> : !deals ? <Spinner /> : deals.length === 0 ? (
        <Empty title="You haven't saved any deals" action={<Link to="/" className="btn-primary">Browse deals</Link>}>Use the Save button on a deal to keep it here.</Empty>
      ) : (
        <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {deals.map((d) => (
            <li key={d.id} className="flex">
              {d.unavailable ? (
                <div className="card flex w-full flex-col gap-3 border-dashed p-5">
                  <p className="font-semibold text-ink">This deal is no longer available</p>
                  <p className="text-sm text-ink-soft">It may have been archived or removed. You can remove it from your saved list.</p>
                  <button type="button" className="btn-ghost mt-auto" onClick={() => toggle(d.id)}>Remove from saved</button>
                </div>
              ) : (
                <div className="flex w-full flex-col">
                  {d.timing === 'expired' && <p role="status" className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800">This deal has expired.</p>}
                  <DealCard deal={d} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
