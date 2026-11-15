import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Facet } from '../types'
import { Empty, ErrorBox, Spinner } from '../components/ui'

export default function FacetPage({ kind }: { kind: 'categories' | 'stores' }) {
  const [items, setItems] = useState<Facet[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    setError(null)
    api<Facet[]>(kind === 'categories' ? '/api/categories' : '/api/retailers').then(setItems).catch(setError)
  }, [kind, n])
  const param = kind === 'categories' ? 'category' : 'retailer'
  const title = kind === 'categories' ? 'Categories' : 'Stores'
  return (
    <>
      <h1 className="mb-4 text-2xl font-extrabold text-teal-800">{title}</h1>
      {error ? <ErrorBox error={error} onRetry={() => setN((x) => x + 1)} /> : !items ? <Spinner /> : items.length === 0 ? (
        <Empty title="Nothing to browse yet">Stores appear here once published deals exist.</Empty>
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((c) => (
            <li key={c.slug}>
              <Link to={`/?${param}=${encodeURIComponent(c.slug)}`} className="card flex min-h-[88px] flex-col justify-center p-5 hover:border-teal-600">
                <span className="text-lg font-bold text-teal-800">{c.name}</span>
                <span className="text-sm text-ink-soft">{c.dealCount === 0 ? 'No published deals yet' : `${c.dealCount} published ${c.dealCount === 1 ? 'deal' : 'deals'}`}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
