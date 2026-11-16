import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import type { Deal, Facet, Page } from '../types'
import { DealCard } from './DealCard'
import { Empty, ErrorBox, Pagination } from './ui'
import { CatalogBrowser } from './CatalogBrowser'

const TIMING_OPTIONS = [
  { value: '', label: 'Current (active, upcoming, unknown dates)' },
  { value: 'active', label: 'Active now' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'expired', label: 'Expired' },
  { value: 'unknown', label: 'Dates unknown or unclear' },
  { value: 'all', label: 'All timing' },
]
const SORTS = [
  { value: '', label: 'Newest' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
]

const FILTER_KEYS = ['category', 'retailer', 'minPrice', 'maxPrice', 'timing', 'type', 'status', 'q'] as const

/** Translates URL params to the API query; "all" timing expands to every state. */
export function apiQuery(sp: URLSearchParams): string {
  const out = new URLSearchParams()
  sp.forEach((v, k) => {
    if (!v) return
    if (k === 'timing' && v === 'all') out.set('timing', 'active,upcoming,expired,unknown')
    else out.set(k, v)
  })
  return out.toString()
}

export function DealsBrowser({ admin = false, fixedParams = {} as Record<string, string> }) {
  return admin ? <AdminDealsBrowser fixedParams={fixedParams} /> : <CatalogBrowser />
}

function AdminDealsBrowser({ fixedParams }: { fixedParams: Record<string, string> }) {
  const admin = true
  const [sp, setSp] = useSearchParams()
  const [data, setData] = useState<Page<Deal> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [cats, setCats] = useState<Facet[]>([])
  const [rets, setRets] = useState<Facet[]>([])
  const [q, setQ] = useState(sp.get('q') ?? '')
  const [min, setMin] = useState(sp.get('minPrice') ?? '')
  const [max, setMax] = useState(sp.get('maxPrice') ?? '')
  const [attempt, setAttempt] = useState(0)
  const [showFilters, setShowFilters] = useState(false)

  const query = useMemo(() => {
    const p = new URLSearchParams(sp)
    Object.entries(fixedParams).forEach(([k, v]) => !p.has(k) && p.set(k, v))
    return apiQuery(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp])

  useEffect(() => {
    setQ(sp.get('q') ?? '')
    setMin(sp.get('minPrice') ?? '')
    setMax(sp.get('maxPrice') ?? '')
  }, [sp])

  useEffect(() => {
    api<Facet[]>('/api/categories').then(setCats).catch(() => {})
    api<Facet[]>('/api/retailers').then(setRets).catch(() => {})
  }, [])

  useEffect(() => {
    const ctl = new AbortController()
    setLoading(true)
    setError(null)
    api<Page<Deal>>(`${admin ? '/api/admin/deals' : '/api/deals'}?${query}`, { admin, signal: ctl.signal })
      .then((d) => {
        setData(d)
        setLoading(false)
      })
      .catch((e) => {
        if ((e as Error).name === 'AbortError') return
        setError(e)
        setLoading(false)
      })
    return () => ctl.abort()
  }, [query, admin, attempt])

  const update = useCallback(
    (changes: Record<string, string>, resetPage = true) => {
      const next = new URLSearchParams(sp)
      Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)))
      if (resetPage) next.delete('page')
      setSp(next)
    },
    [sp, setSp],
  )

  const active = FILTER_KEYS.filter((k) => sp.get(k) && !(k === 'status' && admin && sp.get(k) === fixedParams.status))
  const hasFilters = active.length > 0 || sp.get('sort')
  const page = Number(sp.get('page') ?? '1') || 1

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    update({ q: q.trim(), minPrice: min.trim(), maxPrice: max.trim() })
  }

  return (
    <div>
      <form onSubmit={submit} role="search" aria-label="Search deals" className="card mb-5 p-4">
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1">
            <label htmlFor="q" className="label">Search deals</label>
            <input id="q" type="search" className="field" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Try “headphones”, “air fryer” or a retailer" maxLength={200} />
          </div>
          <div className="sm:self-end">
            <button type="submit" className="btn-accent w-full sm:w-auto">Search</button>
          </div>
        </div>

        <div className="mt-3">
          <button type="button" className="btn-ghost sm:hidden" aria-expanded={showFilters} aria-controls="filter-panel" onClick={() => setShowFilters((v) => !v)}>
            {showFilters ? 'Hide filters' : `Filters & sorting${active.filter((k) => k !== 'q').length ? ` (${active.filter((k) => k !== 'q').length})` : ''}`}
          </button>
          <div id="filter-panel" className={`${showFilters ? 'grid' : 'hidden'} mt-3 grid-cols-1 gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-4`}>
            <div>
              <label htmlFor="category" className="label">Category</label>
              <select id="category" className="field" value={sp.get('category') ?? ''} onChange={(e) => update({ category: e.target.value })}>
                <option value="">All categories</option>
                {cats.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="retailer" className="label">Store</label>
              <select id="retailer" className="field" value={sp.get('retailer') ?? ''} onChange={(e) => update({ retailer: e.target.value })}>
                <option value="">All stores</option>
                {rets.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="timing" className="label">Sale timing</label>
              <select id="timing" className="field" value={sp.get('timing') ?? ''} onChange={(e) => update({ timing: e.target.value })}>
                {TIMING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="type" className="label">Offer type</label>
              <select id="type" className="field" value={sp.get('type') ?? ''} onChange={(e) => update({ type: e.target.value })}>
                <option value="">Product deals and storewide promotions</option>
                <option value="PRODUCT">Product deals</option>
                <option value="STOREWIDE">Storewide promotions</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:col-span-2 lg:col-span-1">
              <div>
                <label htmlFor="minPrice" className="label">Min price ($)</label>
                <input id="minPrice" inputMode="decimal" className="field" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" />
              </div>
              <div>
                <label htmlFor="maxPrice" className="label">Max price ($)</label>
                <input id="maxPrice" inputMode="decimal" className="field" value={max} onChange={(e) => setMax(e.target.value)} placeholder="500" />
              </div>
            </div>
            <div>
              <label htmlFor="sort" className="label">Sort by</label>
              <select id="sort" className="field" value={sp.get('sort') ?? ''} onChange={(e) => update({ sort: e.target.value })}>
                {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {admin && (
              <div>
                <label htmlFor="status" className="label">Status (admin)</label>
                <select id="status" className="field" value={sp.get('status') ?? ''} onChange={(e) => update({ status: e.target.value })}>
                  <option value="">Any status</option>
                  <option value="DRAFT">Draft</option>
                  <option value="PUBLISHED">Published</option>
                  <option value="EXPIRED">Expired</option>
                  <option value="ARCHIVED">Archived</option>
                </select>
              </div>
            )}
            <div className="flex items-end gap-2">
              <button type="submit" className="btn-primary">Apply price range</button>
              {hasFilters && (
                <button type="button" className="btn-ghost" onClick={() => setSp(new URLSearchParams())}>Clear filters</button>
              )}
            </div>
          </div>
          <p className="mt-2 text-xs text-ink-soft">Price filters only include offers with a clearly listed cash price. Offers without one are listed last when sorting by price.</p>
        </div>
      </form>

      <div aria-live="polite" className="mb-3 text-sm text-ink-soft">
        {loading ? 'Loading deals…' : data ? `${data.total.toLocaleString()} ${data.total === 1 ? 'deal' : 'deals'}${admin ? ' (administrator preview — includes drafts)' : ''}` : ''}
      </div>

      {error ? (
        <ErrorBox error={error} onRetry={() => setAttempt((a) => a + 1)} />
      ) : loading && !data ? (
        <Skeleton />
      ) : data && data.items.length === 0 ? (
        hasFilters ? (
          <Empty title="No deals match these filters" action={<button className="btn-primary" onClick={() => setSp(new URLSearchParams())}>Clear all filters</button>}>
            Try removing a filter, widening the price range, or searching for something broader.
          </Empty>
        ) : admin ? (
          <Empty title="No offers found">Import a dataset from the Imports page to start reviewing drafts.</Empty>
        ) : (
          <Empty title="No deals are published yet">
            We're still reviewing offers before they appear here. Nothing is listed until it has been checked, so please check back soon.
          </Empty>
        )
      ) : (
        <div className={loading ? 'opacity-60 transition-opacity' : ''}>
          <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data?.items.map((d) => (
              <li key={d.id} className="flex">
                <div className="flex w-full flex-col"><DealCard deal={d} to={admin ? `/admin/deals/${d.id}` : undefined} /></div>
              </li>
            ))}
          </ul>
          {data && <Pagination page={page} totalPages={data.totalPages} onPage={(p) => { update({ page: p === 1 ? '' : String(p) }, false); window.scrollTo({ top: 0 }) }} />}
        </div>
      )}
    </div>
  )
}

function Skeleton() {
  return (
    <ul className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-hidden="true">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="card h-72 animate-pulse bg-cream-100" />
      ))}
    </ul>
  )
}
