import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { api, getToken, setToken } from '../../api'
import { LogoMark } from '../../components/Logo'

export function AdminLogin() {
  const nav = useNavigate()
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (getToken()) nav('/admin/queue', { replace: true }) }, [nav])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    try {
      const r = await api<{ token: string }>('/api/admin/login', { method: 'POST', body: { username: u, password: p } })
      setToken(r.token)
      nav('/admin/queue', { replace: true })
    } catch (e2) {
      setErr((e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="card mx-auto mt-10 max-w-sm space-y-4 p-6">
      <div className="flex items-center gap-2"><LogoMark /><h1 className="text-xl font-extrabold text-teal-800">Administrator sign-in</h1></div>
      <div><label htmlFor="u" className="label">Username</label><input id="u" className="field" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} required /></div>
      <div><label htmlFor="p" className="label">Password</label><input id="p" type="password" className="field" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} required /></div>
      {err && <p role="alert" className="text-sm text-red-800">{err}</p>}
      <button className="btn-primary w-full" disabled={busy}>Sign in</button>
      <p className="text-center text-sm"><Link to="/" className="text-teal-700 underline">Back to deals</Link></p>
    </form>
  )
}

const links = [
  ['/admin/queue', 'Review queue'],
  ['/admin/preview', 'Preview'],
  ['/admin/imports', 'Imports'],
  ['/admin/reports', 'Reports'],
  ['/admin/stores', 'Stores'],
  ['/admin/audit', 'Audit'],
]

export function AdminShell() {
  const nav = useNavigate()
  const [ok, setOk] = useState(false)
  useEffect(() => {
    const out = () => nav('/admin', { replace: true })
    window.addEventListener('dealmein:signed-out', out)
    if (!getToken()) { out(); return () => window.removeEventListener('dealmein:signed-out', out) }
    api('/api/admin/me', { admin: true }).then(() => setOk(true)).catch(() => {})
    return () => window.removeEventListener('dealmein:signed-out', out)
  }, [nav])
  if (!ok) return <p className="py-10 text-ink-soft" role="status">Checking sign-in…</p>
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-teal-800 p-2 text-white">
        <nav aria-label="Administrator" className="flex flex-wrap gap-1">
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => `flex min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold ${isActive ? 'bg-white text-teal-800' : 'hover:bg-teal-700'}`}>{label}</NavLink>
          ))}
        </nav>
        <button className="rounded-lg px-3 py-2 text-sm font-semibold hover:bg-teal-700" onClick={() => { setToken(null); nav('/admin') }}>Sign out</button>
      </div>
      <Outlet />
    </div>
  )
}
