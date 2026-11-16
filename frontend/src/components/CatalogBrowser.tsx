import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import type { Deal } from '../types'
import { DealCard } from './DealCard'
import { Empty, ErrorBox, Pagination, Spinner } from './ui'
import { Search } from 'lucide-react'

const PAGE_SIZE = 24

export function matchesCatalogSearch(deal: Deal, query: string) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const text = [deal.title, deal.variant, deal.model, deal.retailer?.name, deal.seller, deal.category?.name]
    .filter(Boolean).join(' ').toLocaleLowerCase()
  return terms.every((term) => text.includes(term))
}

export function CatalogBrowser() {
  const [params] = useSearchParams()
  const [deals, setDeals] = useState<Deal[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [page, setPage] = useState(1)
  const [attempt, setAttempt] = useState(0)
  const category = params.get('category')
  const retailer = params.get('retailer')

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    api<Deal[]>('/api/deals/catalog', { signal: controller.signal }).then(setDeals).catch((err) => {
      if ((err as Error).name !== 'AbortError') setError(err)
    })
    return () => controller.abort()
  }, [attempt])

  useEffect(() => { setPage(1) }, [category, retailer])

  const matches = (deals ?? []).filter((deal) => (!category || deal.category?.slug === category)
    && (!retailer || deal.retailer?.slug === retailer) && matchesCatalogSearch(deal, query))
  const totalPages = Math.ceil(matches.length / PAGE_SIZE)
  const items = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  return (
    <div>
      <div role="search" className="catalog-search mb-5">
        <label htmlFor="catalog-search" className="sr-only">Search deals</label>
        <Search className="catalog-search-icon" size={21} aria-hidden="true" />
        <input id="catalog-search" type="search" className="field" value={query} maxLength={200}
          onChange={(event) => { setQuery(event.target.value); setPage(1) }} placeholder="Find your next great deal..." />
      </div>
      {error ? <ErrorBox error={error} onRetry={() => setAttempt((value) => value + 1)} /> : !deals ? <Spinner label="Loading deals" /> : (
        <>
          <p aria-live="polite" className="mb-3 text-sm text-ink-soft">{matches.length.toLocaleString()} {matches.length === 1 ? 'deal' : 'deals'}</p>
          {matches.length === 0 ? <Empty title={query ? 'No matching deals' : 'No deals found'} /> : (
            <>
              <ul className="deal-grid grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {items.map((deal) => <li key={deal.id} className="flex"><div className="flex w-full flex-col"><DealCard deal={deal} /></div></li>)}
              </ul>
              <Pagination page={page} totalPages={totalPages} onPage={(value) => { setPage(value); window.scrollTo({ top: 0 }) }} />
            </>
          )}
        </>
      )}
    </div>
  )
}