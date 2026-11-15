import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { AuditEvent } from '../../types'
import { Empty, ErrorBox, Notice, Spinner } from '../../components/ui'
import { instant } from '../../format'

function useList<T>(path: string) {
  const [data, setData] = useState<T[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [n, setN] = useState(0)
  useEffect(() => { setError(null); api<T[]>(path, { admin: true }).then(setData).catch(setError) }, [path, n])
  return { data, error, reload: () => setN((x) => x + 1) }
}

export function AdminReports() {
  const [status, setStatus] = useState('OPEN')
  const { data, error, reload } = useList<{ id: number; dealId: number; dealTitle: string; reason: string; message: string | null; status: string; createdAt: string }>(`/api/admin/reports?status=${status}`)
  const resolve = (id: number, s: string) => api(`/api/admin/reports/${id}/resolve`, { method: 'POST', body: { status: s }, admin: true }).then(reload)
  return (
    <div>
      <h1 className="mb-4 text-2xl font-extrabold text-teal-800">Visitor reports</h1>
      <label htmlFor="rs" className="label">Status</label>
      <select id="rs" className="field mb-4 max-w-xs" value={status} onChange={(e) => setStatus(e.target.value)}>{['OPEN', 'RESOLVED', 'DISMISSED'].map((s) => <option key={s}>{s}</option>)}</select>
      {error ? <ErrorBox error={error} onRetry={reload} /> : !data ? <Spinner /> : data.length === 0 ? <Empty title="No reports here" /> : (
        <ul className="space-y-3">
          {data.map((r) => (
            <li key={r.id} className="card space-y-1 p-4 text-sm">
              <p><a className="font-semibold text-teal-700 underline" href={`/admin/deals/${r.dealId}`}>{r.dealTitle}</a> · {r.reason} · {instant(r.createdAt)}</p>
              {r.message && <p className="whitespace-pre-wrap">{r.message}</p>}
              {r.status === 'OPEN' && <div className="flex gap-2 pt-1"><button className="btn-ghost" onClick={() => resolve(r.id, 'RESOLVED')}>Mark resolved</button><button className="btn-ghost" onClick={() => resolve(r.id, 'DISMISSED')}>Dismiss</button></div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function AdminAudit() {
  const { data, error, reload } = useList<AuditEvent>('/api/admin/audit?limit=200')
  return (
    <div>
      <h1 className="mb-4 text-2xl font-extrabold text-teal-800">Audit history</h1>
      {error ? <ErrorBox error={error} onRetry={reload} /> : !data ? <Spinner /> : data.length === 0 ? <Empty title="No events yet" /> : (
        <ul className="space-y-2 text-sm">
          {data.map((a) => (
            <li key={a.id} className="card p-3"><strong>{a.action}</strong> · {a.entityType}{a.entityId ? ` #${a.entityId}` : ''} · {a.actor} · {instant(a.createdAt)}
              <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-ink-soft">{JSON.stringify(a.details, null, 1)}</pre></li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function AdminStores() {
  const { data, error, reload } = useList<{ id: number; name: string; timezone: string | null; deals: number }>('/api/admin/retailers')
  const [tz, setTz] = useState<Record<number, string>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const save = async (id: number, current: string | null) => {
    setMsg(null)
    try {
      await api(`/api/admin/retailers/${id}`, { method: 'PATCH', body: { timezone: tz[id] ?? current }, admin: true })
      setMsg('Saved.')
      reload()
    } catch (e) { setMsg((e as Error).message) }
  }
  return (
    <div>
      <h1 className="mb-2 text-2xl font-extrabold text-teal-800">Retailer time zones</h1>
      <div className="mb-4"><Notice>Date-only sales run from 00:00 on the start date to the end of the end date in the retailer's time zone. Offers with date-only values and no time zone are treated as unknown timing.</Notice></div>
      {msg && <p role="status" className="mb-3 text-sm">{msg}</p>}
      {error ? <ErrorBox error={error} onRetry={reload} /> : !data ? <Spinner /> : (
        <ul className="space-y-2">
          {data.map((r) => (
            <li key={r.id} className="card flex flex-wrap items-end gap-3 p-3">
              <div className="min-w-[10rem] flex-1"><p className="font-semibold">{r.name}</p><p className="text-xs text-ink-soft">{r.deals} offers</p></div>
              <div><label htmlFor={`tz-${r.id}`} className="label">IANA time zone</label><input id={`tz-${r.id}`} className="field" placeholder="America/New_York" value={tz[r.id] ?? r.timezone ?? ''} onChange={(e) => setTz({ ...tz, [r.id]: e.target.value })} /></div>
              <button className="btn-ghost" onClick={() => save(r.id, r.timezone)}>Save</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
