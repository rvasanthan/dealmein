import { useEffect, useState } from 'react'
import { api } from '../../api'
import { Empty, ErrorBox, Notice, Spinner } from '../../components/ui'
import { instant } from '../../format'

interface Job { id: number; filename: string; status: string; totalRows: number; created: number; updated: number; unchanged: number; failed: number; warnings: number; createdAt: string; createdBy?: string }
interface Issue { id: number; rowNumber: number | null; recordId: string | null; severity: string; message: string }

export default function AdminImports() {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [preview, setPreview] = useState<Job | null>(null)
  const [issues, setIssues] = useState<{ job: number; items: Issue[] } | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = () => api<Job[]>('/api/admin/imports', { admin: true }).then(setJobs).catch(setError)
  useEffect(() => { load() }, [])

  const upload = async (f: File | undefined) => {
    if (!f) return
    setBusy(true); setMsg(null)
    const fd = new FormData(); fd.append('file', f)
    try { const j = await api<Job>('/api/admin/imports/preview', { method: 'POST', form: fd, admin: true }); setPreview(j); showIssues(j.id); load() }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  const commit = async () => {
    if (!preview) return
    setBusy(true)
    try { const j = await api<Job>(`/api/admin/imports/${preview.id}/commit`, { method: 'POST', admin: true }); setMsg({ ok: true, text: `Imported: ${j.created} created, ${j.updated} updated, ${j.unchanged} unchanged. All new records are drafts.` }); setPreview(null); load() }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  const showIssues = (job: number) => api<Issue[]>(`/api/admin/imports/${job}/issues?limit=200`, { admin: true }).then((items) => setIssues({ job, items })).catch((e) => setMsg({ ok: false, text: e.message }))

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-teal-800">Imports</h1>
      <Notice>Imports are snapshots of source-reported offers, not a live price feed. New records are always created as drafts, and re-importing the same file updates records instead of duplicating them.</Notice>
      <div className="card p-4">
        <label htmlFor="imp" className="label">Dataset file (JSON)</label>
        <input id="imp" type="file" accept=".json,application/json" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
      </div>
      {msg && <div role={msg.ok ? 'status' : 'alert'}><Notice tone={msg.ok ? 'info' : 'warn'}>{msg.text}</Notice></div>}
      {preview && (
        <div className="card space-y-2 p-4">
          <h2 className="text-lg font-bold text-teal-800">Preview: {preview.filename}</h2>
          <p className="text-sm">{preview.totalRows} rows · would create {preview.created}, update {preview.updated}, leave {preview.unchanged} unchanged · {preview.failed} rejected · {preview.warnings} warnings</p>
          <div className="flex gap-2"><button className="btn-accent" disabled={busy || preview.failed >= preview.totalRows} onClick={commit}>Commit import</button><button className="btn-ghost" onClick={() => setPreview(null)}>Discard preview</button></div>
        </div>
      )}
      <h2 className="text-lg font-bold text-teal-800">History</h2>
      {error ? <ErrorBox error={error} onRetry={load} /> : !jobs ? <Spinner /> : jobs.length === 0 ? <Empty title="No imports yet" /> : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">Import history</caption>
            <thead className="bg-cream-100 text-xs uppercase text-ink-soft"><tr>{['File', 'Status', 'Rows', 'New', 'Updated', 'Same', 'Failed', 'Warn', 'When', ''].map((h) => <th key={h} scope="col" className="p-3">{h}</th>)}</tr></thead>
            <tbody>{jobs.map((j) => (
              <tr key={j.id} className="border-t border-cream-200">
                <td className="p-3">{j.filename}</td><td className="p-3">{j.status}</td><td className="p-3">{j.totalRows}</td><td className="p-3">{j.created}</td><td className="p-3">{j.updated}</td><td className="p-3">{j.unchanged}</td><td className="p-3">{j.failed}</td><td className="p-3">{j.warnings}</td><td className="p-3">{instant(j.createdAt)}</td>
                <td className="p-3"><button className="text-teal-700 underline" onClick={() => showIssues(j.id)}>Row issues</button></td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {issues && (
        <div className="card p-4">
          <h2 className="mb-2 text-lg font-bold text-teal-800">Row issues for import #{issues.job}</h2>
          {issues.items.length === 0 ? <p className="text-sm text-ink-soft">No issues recorded.</p> : (
            <ul className="space-y-1 text-sm">{issues.items.map((i) => <li key={i.id}><span className="chip mr-2 bg-cream-100">{i.severity}</span>row {i.rowNumber ?? '?'} {i.recordId && `(${i.recordId})`}: {i.message}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  )
}
