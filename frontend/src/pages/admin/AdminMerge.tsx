import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, ApiError } from '../../api'
import { Notice } from '../../components/ui'

interface Diff { field: string; primary: unknown; secondary: unknown; conflict?: boolean }
interface Preview { primary: { id: number; title: string }; secondary: { id: number; title: string }; differences: Diff[]; warnings: string[] }
const show = (v: unknown) => (v == null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export default function AdminMerge() {
  const [sp] = useSearchParams()
  const [p, setP] = useState(sp.get('primary') ?? '')
  const [s, setS] = useState('')
  const [prev, setPrev] = useState<Preview | null>(null)
  const [res, setRes] = useState<Record<string, string>>({})
  const [ack, setAck] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const preview = async (e: React.FormEvent) => {
    e.preventDefault()
    setMsg(null)
    setPrev(null)
    setRes({})
    try {
      setPrev(await api<Preview>(`/api/admin/deals/merge-preview?primaryId=${encodeURIComponent(p)}&secondaryId=${encodeURIComponent(s)}`, { admin: true }))
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }) }
  }
  const merge = async () => {
    try {
      await api('/api/admin/deals/merge', { method: 'POST', admin: true, body: { primaryId: Number(p), secondaryId: Number(s), resolutions: res, acknowledgeWarnings: ack } })
      setMsg({ ok: true, text: 'Merged. The second offer is archived and its sources were kept on the first.' })
      setPrev(null)
    } catch (err) { setMsg({ ok: false, text: err instanceof ApiError ? err.message : 'Merge failed.' }) }
  }
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold text-teal-800">Merge preview</h1>
      <p className="text-sm text-ink-soft">Merging is a manual decision. Candidate groups are only suggestions. Conflicting price or condition values are never resolved automatically: pick one for each.</p>
      <form onSubmit={preview} className="card flex flex-wrap items-end gap-3 p-4">
        <div><label htmlFor="mp" className="label">Primary offer ID (kept)</label><input id="mp" className="field" value={p} onChange={(e) => setP(e.target.value)} required /></div>
        <div><label htmlFor="ms" className="label">Secondary offer ID (archived)</label><input id="ms" className="field" value={s} onChange={(e) => setS(e.target.value)} required /></div>
        <button className="btn-primary">Preview</button>
      </form>
      {msg && <div role={msg.ok ? 'status' : 'alert'}><Notice tone={msg.ok ? 'info' : 'warn'}>{msg.text}</Notice></div>}
      {prev && (
        <div className="space-y-3">
          {prev.warnings.map((w) => <Notice key={w} tone="warn">{w}</Notice>)}
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <caption className="sr-only">Field differences</caption>
              <thead className="bg-cream-100 text-xs uppercase text-ink-soft"><tr><th scope="col" className="p-3">Field</th><th scope="col" className="p-3">#{prev.primary.id}</th><th scope="col" className="p-3">#{prev.secondary.id}</th><th scope="col" className="p-3">Keep</th></tr></thead>
              <tbody>
                {prev.differences.map((d) => (
                  <tr key={d.field} className="border-t border-cream-200 align-top">
                    <th scope="row" className="p-3 font-medium">{d.field}</th>
                    <td className="p-3">{show(d.primary)}</td>
                    <td className="p-3">{show(d.secondary)}</td>
                    <td className="p-3">
                      <label className="sr-only" htmlFor={`r-${d.field}`}>Value to keep for {d.field}</label>
                      <select id={`r-${d.field}`} className="field" value={res[d.field] ?? ''} onChange={(e) => setRes({ ...res, [d.field]: e.target.value })}>
                        <option value="">Keep primary</option><option value="primary">Primary</option><option value="secondary">Secondary</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {prev.warnings.length > 0 && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand these offers differ and still want to merge them</label>}
          <button className="btn-accent" onClick={merge}>Merge offers</button>
        </div>
      )}
      <p><Link to="/admin/queue" className="text-sm text-teal-700 underline">Back to queue</Link></p>
    </div>
  )
}
