import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, ApiError } from '../../api'
import type { Deal, Facet } from '../../types'
import { ErrorBox, Notice, Spinner } from '../../components/ui'
import { DealView } from '../DealDetailPage'
import { instant } from '../../format'

type Form = Record<string, string>
const TEXT: [string, string][] = [
  ['title', 'Title'], ['variant', 'Variant'], ['model', 'Model'], ['seller', 'Seller'],
  ['sourcePriceText', 'Source price text'], ['originalPriceText', 'Original price text'],
  ['conditionsText', 'Conditions'], ['rewardText', 'Reward text'], ['referencePriceText', 'Reference price text'],
  ['taxNote', 'Tax note'], ['dateText', 'Original date text'],
]
const NUM: [string, string][] = [
  ['listedCashPrice', 'Listed cash price (USD)'], ['sourcePrice', 'Source-reported price (USD)'],
  ['rewardAmount', 'Reward amount (USD)'], ['shippingCost', 'Shipping cost (USD)'], ['referencePrice', 'Advertised reference price (USD)'],
]
const DATES: [string, string, string][] = [
  ['startsOn', 'Starts on', 'date'], ['endsOn', 'Ends on (inclusive)', 'date'],
]

const val = (d: Deal, k: string): string => {
  const v = (d as unknown as Record<string, unknown>)[k]
  return v == null ? '' : String(v)
}

export default function AdminDeal() {
  const { id } = useParams()
  const nav = useNavigate()
  const [deal, setDeal] = useState<Deal | null>(null)
  const [cats, setCats] = useState<Facet[]>([])
  const [form, setForm] = useState<Form>({})
  const [error, setError] = useState<unknown>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({})
  const [chk, setChk] = useState({ identity: false, link: false, price: false, conditions: false, timing: false })
  const [productVerified, setProductVerified] = useState(false)
  const [imgAuth, setImgAuth] = useState(false)
  const [archiveReason, setArchiveReason] = useState('')

  const load = () => {
    api<Deal>(`/api/admin/deals/${id}`, { admin: true }).then((d) => {
      setDeal(d)
      const f: Form = {}
      for (const [k] of [...TEXT, ...NUM]) f[k] = val(d, k)
      f.productUrl = d.productUrl ?? ''
      f.imageUrl = d.imageUrlRaw ?? ''
      f.condition = d.condition
      f.offerType = d.offerType
      f.dateStatus = d.dateStatus
      f.category = d.category.slug
      f.startsOn = d.startsOn ?? ''
      f.endsOn = d.endsOn ?? ''
      f.startsAt = d.startsAt ?? ''
      f.endsAt = d.endsAt ?? ''
      setForm(f)
      setProductVerified(!!d.productUrlVerified)
      setImgAuth(!!d.imageAuthorized)
    }).catch(setError)
  }
  useEffect(() => { load(); api<Facet[]>('/api/categories').then(setCats).catch(() => {}) }, [id]) // eslint-disable-line

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null)
    setFieldErr({})
    try {
      await fn()
      setMsg({ ok: true, text: ok })
      load()
    } catch (e) {
      if (e instanceof ApiError) {
        setMsg({ ok: false, text: e.message })
        if (e.details) setFieldErr(Object.fromEntries(Object.entries(e.details).map(([k, v]) => [k, String(v)])))
      } else setMsg({ ok: false, text: 'Something went wrong.' })
    }
  }

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (!deal) return
    const body: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(form)) {
      const orig = k === 'category' ? deal.category.slug : k === 'imageUrl' ? deal.imageUrlRaw ?? '' : k === 'productUrl' ? deal.productUrl ?? '' : val(deal, k)
      if (v !== orig) body[k] = v === '' ? null : v
    }
    if (productVerified !== !!deal.productUrlVerified || 'productUrl' in body) { body.productUrl = form.productUrl || null; body.productUrlVerified = productVerified }
    if (imgAuth !== !!deal.imageAuthorized || 'imageUrl' in body) { body.imageUrl = form.imageUrl || null; body.imageAuthorized = imgAuth }
    if (Object.keys(body).length === 0) { setMsg({ ok: true, text: 'No changes to save.' }); return }
    run(() => api(`/api/admin/deals/${id}`, { method: 'PATCH', body, admin: true }), 'Saved.')
  }

  const upload = (f: File | undefined) => {
    if (!f) return
    const fd = new FormData()
    fd.append('file', f)
    run(() => api(`/api/admin/deals/${id}/image`, { method: 'POST', form: fd, admin: true }), 'Image uploaded. Confirm it is authorized, then save.')
  }

  if (error) return <ErrorBox error={error} onRetry={load} />
  if (!deal) return <Spinner />
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value })
  const E = (k: string) => fieldErr[k] && <p role="alert" className="mt-1 text-sm text-red-800">{fieldErr[k]}</p>
  const allChecked = Object.values(chk).every(Boolean)

  return (
    <div className="space-y-6">
      <p><Link to="/admin/queue" className="text-sm text-teal-700 underline">← Review queue</Link></p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-extrabold text-teal-800">Edit offer #{deal.id}</h1>
        <span className="chip bg-white shadow-sm">{deal.status}</span>
        {deal.featured && <span className="chip bg-orange-50 text-accent-700">Featured</span>}
      </div>
      {msg && <div role={msg.ok ? 'status' : 'alert'}><Notice tone={msg.ok ? 'info' : 'warn'}>{msg.text}</Notice></div>}
      {(deal.reviewFlags?.length ?? 0) > 0 && <Notice tone="warn">Review flags: {deal.reviewFlags!.join(', ')}</Notice>}

      <form onSubmit={save} className="card space-y-4 p-5">
        <h2 className="text-lg font-bold text-teal-800">Details</h2>
        <p className="text-sm text-ink-soft">Source ID: {deal.sourceRecordId}. Imported values are kept separately; edits here are recorded as corrections and are not overwritten by re-imports.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {TEXT.map(([k, label]) => (
            <div key={k} className={k === 'title' || k === 'conditionsText' ? 'sm:col-span-2' : ''}>
              <label htmlFor={`f-${k}`} className="label">{label}{deal.overrides?.[k] ? ' (corrected)' : ''}</label>
              <input id={`f-${k}`} className="field" value={form[k] ?? ''} onChange={set(k)} />{E(k)}
            </div>
          ))}
          {NUM.map(([k, label]) => (
            <div key={k}>
              <label htmlFor={`f-${k}`} className="label">{label}</label>
              <input id={`f-${k}`} className="field" inputMode="decimal" value={form[k] ?? ''} onChange={set(k)} />{E(k)}
            </div>
          ))}
          <div>
            <label htmlFor="f-category" className="label">Category</label>
            <select id="f-category" className="field" value={form.category} onChange={set('category')}>{cats.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>{E('category')}
          </div>
          <div>
            <label htmlFor="f-condition" className="label">Condition</label>
            <select id="f-condition" className="field" value={form.condition} onChange={set('condition')}>{['NEW', 'USED', 'REFURBISHED', 'UNKNOWN'].map((c) => <option key={c}>{c}</option>)}</select>
          </div>
          <div>
            <label htmlFor="f-offerType" className="label">Offer type</label>
            <select id="f-offerType" className="field" value={form.offerType} onChange={set('offerType')}><option value="PRODUCT">Product deal</option><option value="STOREWIDE">Storewide promotion</option></select>
          </div>
          <div>
            <label htmlFor="f-dateStatus" className="label">Date status</label>
            <select id="f-dateStatus" className="field" value={form.dateStatus} onChange={set('dateStatus')}>{['KNOWN', 'UNKNOWN', 'CONFLICT'].map((c) => <option key={c}>{c}</option>)}</select>{E('dateStatus')}
          </div>
          {DATES.map(([k, label, type]) => (
            <div key={k}><label htmlFor={`f-${k}`} className="label">{label}</label><input id={`f-${k}`} type={type} className="field" value={form[k] ?? ''} onChange={set(k)} />{E(k)}</div>
          ))}
          <div className="sm:col-span-2">
            <label htmlFor="f-endsAt" className="label">Exact end time (ISO 8601 with offset, optional)</label>
            <input id="f-endsAt" className="field" placeholder="2025-11-30T23:59:59-05:00" value={form.endsAt ?? ''} onChange={set('endsAt')} />{E('endsAt')}
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="f-startsAt" className="label">Exact start time (ISO 8601 with offset, optional)</label>
            <input id="f-startsAt" className="field" value={form.startsAt ?? ''} onChange={set('startsAt')} />{E('startsAt')}
          </div>
        </div>

        <fieldset className="space-y-3 rounded-xl bg-cream p-4">
          <legend className="px-1 font-semibold">Retailer product link</legend>
          <div>
            <label htmlFor="f-productUrl" className="label">Product URL (http or https)</label>
            <input id="f-productUrl" className="field" value={form.productUrl} onChange={set('productUrl')} />{E('productUrl')}{E('productUrlVerified')}
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={productVerified} onChange={(e) => setProductVerified(e.target.checked)} /> I opened this link and it is the retailer's page for this exact product</label>
        </fieldset>

        <fieldset className="space-y-3 rounded-xl bg-cream p-4">
          <legend className="px-1 font-semibold">Image</legend>
          <div>
            <label htmlFor="f-imageUrl" className="label">Image URL</label>
            <input id="f-imageUrl" className="field" value={form.imageUrl} onChange={set('imageUrl')} />{E('imageUrl')}{E('imageAuthorized')}
          </div>
          <div>
            <label htmlFor="f-upload" className="label">Or upload (JPEG, PNG or WebP, up to 2 MB)</label>
            <input id="f-upload" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => upload(e.target.files?.[0])} />
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={imgAuth} onChange={(e) => setImgAuth(e.target.checked)} /> We are authorized to show this image publicly</label>
        </fieldset>
        <button className="btn-primary">Save changes</button>
      </form>

      <section className="card space-y-4 p-5" aria-labelledby="pub-h">
        <h2 id="pub-h" className="text-lg font-bold text-teal-800">Publishing and status</h2>
        {deal.status === 'DRAFT' && (
          <fieldset className="space-y-1">
            <legend className="mb-1 text-sm text-ink-soft">Confirm each item was checked before publishing.</legend>
            {([['identity', 'Product identity (title, variant, condition)'], ['link', 'Retailer link'], ['price', 'Price'], ['conditions', 'Conditions (coupon, membership, rebate, gift card)'], ['timing', 'Timing']] as const).map(([k, label]) => (
              <label key={k} className="flex min-h-[32px] items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={chk[k]} onChange={(e) => setChk({ ...chk, [k]: e.target.checked })} /> {label}</label>
            ))}
            <button type="button" className="btn-accent mt-2" disabled={!allChecked} onClick={() => run(() => api(`/api/admin/deals/${id}/publish`, { method: 'POST', body: chk, admin: true }), 'Published.')}>Publish</button>
          </fieldset>
        )}
        <div className="flex flex-wrap items-end gap-3">
          {deal.status === 'PUBLISHED' && <button type="button" className="btn-ghost" onClick={() => run(() => api(`/api/admin/deals/${id}/status`, { method: 'POST', body: { status: 'DRAFT' }, admin: true }), 'Moved back to draft.')}>Unpublish to draft</button>}
          {deal.status === 'PUBLISHED' && <button type="button" className="btn-ghost" onClick={() => run(() => api(`/api/admin/deals/${id}/status`, { method: 'POST', body: { status: 'EXPIRED' }, admin: true }), 'Marked expired.')}>Mark expired</button>}
          {deal.status !== 'ARCHIVED' && (
            <>
              <div><label htmlFor="arch" className="label">Archive reason</label><input id="arch" className="field" value={archiveReason} onChange={(e) => setArchiveReason(e.target.value)} /></div>
              <button type="button" className="btn-ghost" onClick={() => run(() => api(`/api/admin/deals/${id}/status`, { method: 'POST', body: { status: 'ARCHIVED', reason: archiveReason || null }, admin: true }), 'Archived.')}>Archive</button>
            </>
          )}
          {deal.status === 'ARCHIVED' && <button type="button" className="btn-ghost" onClick={() => run(() => api(`/api/admin/deals/${id}/status`, { method: 'POST', body: { status: 'DRAFT' }, admin: true }), 'Restored to draft.')}>Restore to draft</button>}
          {deal.status === 'PUBLISHED' && (
            <button type="button" className="btn-ghost" onClick={() => run(() => api(`/api/admin/deals/${id}/featured`, { method: 'POST', body: { featured: !deal.featured }, admin: true }), deal.featured ? 'Removed from featured.' : 'Featured.')}>{deal.featured ? 'Remove from featured' : 'Feature this deal'}</button>
          )}
          <button type="button" className="btn-ghost" onClick={() => nav(`/admin/merge?primary=${deal.id}`)}>Merge with another offer…</button>
        </div>
        {deal.archiveReason && <p className="text-sm text-ink-soft">Archive reason: {deal.archiveReason}</p>}
      </section>

      <section className="card p-5" aria-labelledby="aud-h">
        <h2 id="aud-h" className="mb-2 text-lg font-bold text-teal-800">History</h2>
        {(deal.audit ?? []).length === 0 ? <p className="text-sm text-ink-soft">No changes recorded yet.</p> : (
          <ul className="space-y-2 text-sm">
            {deal.audit!.map((a) => (
              <li key={a.id} className="rounded-lg bg-cream p-3"><strong>{a.action}</strong> by {a.actor} · {instant(a.createdAt)}<pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-ink-soft">{JSON.stringify(a.details, null, 1)}</pre></li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="prev-h">
        <h2 id="prev-h" className="mb-3 text-lg font-bold text-teal-800">How visitors will see it</h2>
        <DealView deal={deal} admin />
      </section>
    </div>
  )
}
