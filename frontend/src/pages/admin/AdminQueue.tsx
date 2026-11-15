import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, download } from '../../api'
import type { Deal, Page } from '../../types'
import { Empty, ErrorBox, Pagination, Spinner } from '../../components/ui'
import { money } from '../../format'

const CHECKS = [
  ['missingLink', 'Missing or unverified link'],
  ['unclearPrice', 'Unclear or missing price'],
  ['staleDates', 'Stale dates'],
  ['possibleDuplicates', 'Possible duplicates'],
  ['openReports', 'Open visitor reports'],
] as const

export default function AdminQueue() {
  const [sp, setSp] = useSearchParams()
  const [data, setData] = useState<Page<Deal> | null>(null)
  const [stats, setStats] = useState<Record<string, number> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [n, setN] = useState(0)
  const status = sp.get('status') ?? 'DRAFT'
  const page = Number(sp.get('page') ?? '1') || 1
  const qs = new URLSearchParams(sp)
  if (!qs.has('status')) qs.set('status', 'DRAFT')
  qs.set('sort', 'newest')

  useEffect(() => {
    setError(null)
    api<Page<Deal>>(`/api/admin/deals?${qs.toString()}&timing=active,upcoming,expired,unknown`, { admin: true }).then(setData).catch(setError)
    api<Record<string, number>>('/api/admin/stats', { admin: true }).then(setStats).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp, n])

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(sp)
    if (v) next.set(k, v); else next.delete(k)
    next.delete('page')
    setSp(next)
  }

  return (
    <div>
      <h1 className="mb-4 text-2xl font-extrabold text-teal-800">Draft review queue</h1>
      {stats && (
        <ul className="mb-4 flex flex-wrap gap-2 text-sm">
          {Object.entries(stats).map(([k, v]) => <li key={k} className="chip bg-white text-ink shadow-sm">{k}: <strong className="ml-1">{v}</strong></li>)}
        </ul>
      )}
      <div className="card mb-4 space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor="qs" className="label">Status</label>
            <select id="qs" className="field" value={status} onChange={(e) => set('status', e.target.value)}>
              {['DRAFT', 'PUBLISHED', 'EXPIRED', 'ARCHIVED'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="qq" className="label">Search</label>
            <input id="qq" type="search" className="field" defaultValue={sp.get('q') ?? ''} onKeyDown={(e) => { if (e.key === 'Enter') set('q', (e.target as HTMLInputElement).value) }} placeholder="Press Enter to search" />
          </div>
        </div>
        <fieldset>
          <legend className="label">Needs attention</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-1">
            {CHECKS.map(([k, label]) => (
              <label key={k} className="flex min-h-[32px] items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={sp.get(k) === 'true'} onChange={(e) => set(k, e.target.checked ? 'true' : '')} /> {label}
              </label>
            ))}
          </div>
        </fieldset>
        <button className="btn-ghost" onClick={() => download(`/api/admin/deals/export.csv?${qs.toString()}`, 'deal-me-in-deals.csv').catch((e) => alert(e.message))}>Export CSV</button>
      </div>
      {error ? <ErrorBox error={error} onRetry={() => setN((x) => x + 1)} /> : !data ? <Spinner /> : data.items.length === 0 ? (
        <Empty title="Nothing in this queue">Try another status or clear the filters, or import a dataset.</Empty>
      ) : (
        <>
          <p className="mb-2 text-sm text-ink-soft" aria-live="polite">{data.total} offers</p>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">Offers awaiting review</caption>
              <thead className="bg-cream-100 text-xs uppercase text-ink-soft">
                <tr><th scope="col" className="p-3">Offer</th><th scope="col" className="p-3">Retailer</th><th scope="col" className="p-3">Price</th><th scope="col" className="p-3">Flags</th><th scope="col" className="p-3">Status</th></tr>
              </thead>
              <tbody>
                {data.items.map((d) => (
                  <tr key={d.id} className="border-t border-cream-200 align-top">
                    <td className="p-3"><Link className="font-semibold text-teal-700 underline" to={`/admin/deals/${d.id}`}>{d.title}</Link>{d.variant && <div className="text-xs text-ink-soft">{d.variant}</div>}</td>
                    <td className="p-3">{d.retailer.name}</td>
                    <td className="p-3">{d.listedCashPrice != null ? money(d.listedCashPrice) : <span className="text-ink-soft">{d.originalPriceText ?? d.sourcePriceText ?? 'none'}</span>}</td>
                    <td className="p-3 text-xs">
                      {!d.productUrlVerified && <span className="chip mr-1 bg-orange-50 text-accent-700">link</span>}
                      {d.listedCashPrice == null && <span className="chip mr-1 bg-orange-50 text-accent-700">price</span>}
                      {d.timing === 'expired' && d.status !== 'EXPIRED' && <span className="chip mr-1 bg-red-50 text-red-800">stale</span>}
                      {d.relatedCount > 0 && <span className="chip mr-1 bg-teal-50 text-teal-800">dup?</span>}
                      {(d.openReports ?? 0) > 0 && <span className="chip mr-1 bg-red-50 text-red-800">reports</span>}
                    </td>
                    <td className="p-3">{d.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={data.totalPages} onPage={(p) => { const next = new URLSearchParams(sp); next.set('page', String(p)); setSp(next) }} />
        </>
      )}
    </div>
  )
}

export function AdminPreview() {
  return (
    <>
      <h1 className="mb-1 text-2xl font-extrabold text-teal-800">Administrator preview</h1>
      <p className="mb-4 text-sm text-ink-soft">This is the public browsing interface, including drafts. Visitors never see draft offers.</p>
      <PreviewBrowser />
    </>
  )
}

import { DealsBrowser } from '../../components/DealsBrowser'
function PreviewBrowser() { return <DealsBrowser admin /> }
