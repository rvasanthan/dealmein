import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Deal } from '../types'
import { DealCard, SaveButton } from '../components/DealCard'
import { Empty, ErrorBox, Spinner } from '../components/ui'
import { useFavorites } from '../favorites'

export default function SavedPage() {
  const favorites = useFavorites()
  const ids = favorites?.ids ?? []
  const [deals, setDeals] = useState<Deal[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [n, setN] = useState(0)
  const key = ids.join(',')

  useEffect(() => {
    const controller = new AbortController()
    if (!key) {
      setDeals([])
      return () => controller.abort()
    }
    setError(null)
    const groups: number[][] = []
    const allIds = key.split(',').map(Number)
    for (let offset = 0; offset < allIds.length; offset += 100) groups.push(allIds.slice(offset, offset + 100))
    Promise.all(groups.map((group) => api<Deal[]>(`/api/deals/by-ids?ids=${group.join(',')}`, { signal: controller.signal })))
      .then((results) => setDeals(results.flat())).catch((reason) => { if ((reason as Error).name !== 'AbortError') setError(reason) })
    return () => controller.abort()
  }, [key, n])

  return (
    <>
      <h1 className="mb-5 text-2xl font-extrabold text-teal-800">Favorites</h1>
      {favorites?.error ? null
        : error ? <ErrorBox error={error} onRetry={() => setN((x) => x + 1)} /> : favorites?.loading || !deals ? <Spinner /> : deals.length === 0 ? (
        <Empty title="No favorites yet" action={<Link to="/" className="btn-primary">Browse deals</Link>}>Bookmark deals to find them here.</Empty>
      ) : (
        <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {deals.map((d) => (
            <li key={d.id} className="flex">
              {d.unavailable ? (
                <div className="card flex w-full flex-col gap-3 border-dashed p-5">
                  <p className="font-semibold text-ink">This deal is no longer available</p>
                  <p className="text-sm text-ink-soft">It may have been archived or removed. You can remove it from your saved list.</p>
                  <SaveButton id={d.id} title="unavailable deal" />
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
