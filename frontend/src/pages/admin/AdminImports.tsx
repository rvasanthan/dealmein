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
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)
  const [product, setProduct] = useState({ title: '', retailer: '', category: '', product_url: '', listed_cash_price: '' })

  const load = () => api<Job[]>('/api/admin/imports', { admin: true }).then(setJobs).catch(setError)
  useEffect(() => { load() }, [])

  const upload = async (f: File | undefined) => {
    if (!f) return
    setBusy(true); setMsg(null)
    setUploadProgress(null)
    try {
      if (!f.size || f.size > 25 * 1024 * 1024) throw new Error('Choose a JSON file between 1 byte and 25 MB.')
      let job: Job
      {
        const chunkSize = 256 * 1024
        const totalChunks = Math.ceil(f.size / chunkSize)
        const sessionId = crypto.randomUUID()
        for (let index = 0; index < totalChunks; index++) {
          setUploadProgress(`Uploading part ${index + 1} of ${totalChunks}…`)
          await api('/api/admin/imports/upload-chunk', {
            method: 'POST',
            raw: f.slice(index * chunkSize, Math.min(f.size, (index + 1) * chunkSize)),
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Upload-Session': sessionId,
              'X-Upload-Index': String(index),
              'X-Upload-Total': String(totalChunks),
            },
            admin: true,
          })
        }
        setUploadProgress('Preparing preview…')
        job = await api<Job>('/api/admin/imports/preview-chunks', { method: 'POST', admin: true,
          body: { sessionId, totalChunks, filename: f.name } })
      }
      if (job.failed >= job.totalRows) {
        setPreview(job); showIssues(job.id); load()
        throw new Error('No valid products were found in this file.')
      }
      setUploadProgress('Adding products…')
      const result = await api<Job>(`/api/admin/imports/${job.id}/commit`, { method: 'POST', admin: true })
      setMsg({ ok: true, text: `Imported ${result.created} new and ${result.updated} updated products; ${result.unchanged} unchanged, ${result.failed} rejected.` })
      if (result.failed || result.warnings) showIssues(job.id)
      load()
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false); setUploadProgress(null) }
  }
  const commit = async () => {
    if (!preview) return
    setBusy(true)
    try { const j = await api<Job>(`/api/admin/imports/${preview.id}/commit`, { method: 'POST', admin: true }); setMsg({ ok: true, text: `Imported: ${j.created} created, ${j.updated} updated, ${j.unchanged} unchanged.` }); setPreview(null); load() }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setBusy(false) }
  }
  const showIssues = (job: number) => api<Issue[]>(`/api/admin/imports/${job}/issues?limit=200`, { admin: true }).then((items) => setIssues({ job, items })).catch((e) => setMsg({ ok: false, text: e.message }))

  const addProduct = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true); setMsg(null)
    try {
      await api('/api/admin/deals', { method: 'POST', admin: true, body: product })
      setProduct({ title: '', retailer: '', category: '', product_url: '', listed_cash_price: '' })
      setMsg({ ok: true, text: 'Product added.' })
    } catch (error) { setMsg({ ok: false, text: (error as Error).message }) } finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-teal-800">Imports</h1>
      <Notice>Re-importing the same source records updates them instead of creating duplicates.</Notice>
      <div className="card p-4">
        <label htmlFor="imp" className="label">Dataset file (JSON)</label>
        <input id="imp" type="file" accept=".json,application/json" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
        {uploadProgress && <p className="mt-2 text-sm text-ink-soft" role="status">{uploadProgress}</p>}
      </div>
      <form className="card space-y-3 p-4" onSubmit={addProduct}>
        <h2 className="text-lg font-bold text-teal-800">Add product</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            ['title', 'Product name', 'text', true], ['retailer', 'Retailer', 'text', true],
            ['category', 'Category', 'text', false], ['listed_cash_price', 'Price', 'number', false],
            ['product_url', 'Retailer product URL', 'url', false],
          ] as const).map(([field, label, type, required]) => (
            <label key={field} className="label">{label}
              <input className="field" type={type} required={required} min={type === 'number' ? '0' : undefined} step={type === 'number' ? '0.01' : undefined}
                value={product[field]} onChange={(event) => setProduct({ ...product, [field]: event.target.value })} />
            </label>
          ))}
        </div>
        <button className="btn-primary" disabled={busy}>Add product</button>
      </form>
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
