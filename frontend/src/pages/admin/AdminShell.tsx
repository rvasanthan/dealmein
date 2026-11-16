import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { auth, getIdToken, signInWithGoogle, signOutFromGoogle } from '../../firebase'
import { LogoMark } from '../../components/Logo'
import { ArrowRight, ShieldCheck, Sparkles } from 'lucide-react'

export function AdminLogin() {
  const nav = useNavigate()
  const [err, setErr] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    setErr(null)
    setMessage(null)
    try {
      await signInWithGoogle()
      const result = await api<{ status: string }>('/api/access/request', { method: 'POST', admin: true })
      if (result.status === 'approved') nav('/admin/imports', { replace: true })
      else {
        await signOutFromGoogle()
        setMessage(result.status === 'revoked' ? 'Administrator access has been revoked. Contact an administrator.' : 'Your request has been submitted. An administrator must approve your access.')
      }
    } catch (e2) {
      const code = (e2 as { code?: string }).code
      setErr(code === 'auth/popup-blocked' ? 'Your browser blocked the Google sign-in popup. Allow popups for this site and try again.' : (e2 as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="auth-stage page-enter">
      <div className="auth-intro">
        <span className="auth-eyebrow"><Sparkles size={16} aria-hidden="true" /> THE GOOD DEAL CLUB</span>
        <h1>Deal Me In<span className="auth-period">.</span></h1>
        <p>Great deals. Count me in.</p>
        <div className="auth-ticket ticket-sway" aria-hidden="true"><ShieldCheck size={25} /><span>THE DEAL CLUB<br /><strong>BACKSTAGE PASS</strong></span><Sparkles size={20} /></div>
        <div className="auth-dashes" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      </div>
      <div className="auth-panel">
        <div className="auth-panel-heading"><LogoMark className="h-12 w-12" /><span>BACKSTAGE PASS</span></div>
        <h2>Admin sign-in<span>.</span></h2>
        {err && <p role="alert" className="auth-error">{err}</p>}
        {message && <p role="status" className="auth-message">{message}</p>}
        <p className="auth-panel-copy">Sign in to your administrator account.</p>
        <button type="button" className="google-button" disabled={busy} onClick={submit}><span className="google-mark" aria-hidden="true">G</span><span>{busy ? 'Signing in...' : 'Sign in with Google'}</span><ArrowRight size={18} aria-hidden="true" /></button>
        <Link to="/" className="auth-back">Back to deals <ArrowRight size={15} aria-hidden="true" /></Link>
      </div>
    </section>
  )
}

const links = [
  ['/admin/imports', 'Add products'],
  ['/admin/queue', 'Manage deals'],
  ['/admin/preview', 'Preview'],
  ['/admin/reports', 'Reports'],
  ['/admin/stores', 'Stores'],
  ['/admin/audit', 'Audit'],
  ['/admin/accounts', 'Administrators'],
  ['/admin/users', 'Users'],
]

export function AdminShell() {
  const nav = useNavigate()
  const [ok, setOk] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const out = () => nav('/admin', { replace: true })
    window.addEventListener('dealmein:signed-out', out)
    let active = true
    getIdToken().then((token) => {
      if (!token) { out(); return }
      return api('/api/admin/me', { admin: true }).then(() => { if (active) setOk(true) })
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to verify access.') })
    const unsubscribe = auth.onAuthStateChanged((user) => { if (!user && active) out() })
    return () => { active = false; unsubscribe(); window.removeEventListener('dealmein:signed-out', out) }
  }, [nav])
  if (error) return <div role="alert" className="py-10 text-red-800">{error} <button className="btn-ghost" onClick={() => { void signOutFromGoogle().then(() => nav('/admin')) }}>Sign out</button></div>
  if (!ok) return <p className="py-10 text-ink-soft" role="status">Checking sign-in…</p>
  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-teal-800 p-2 text-white">
        <nav aria-label="Administrator" className="flex flex-wrap gap-1">
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} className={({ isActive }) => `flex min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold ${isActive ? 'bg-white text-teal-800' : 'hover:bg-teal-700'}`}>{label}</NavLink>
          ))}
        </nav>
        <button className="rounded-lg px-3 py-2 text-sm font-semibold hover:bg-teal-700" onClick={() => { void signOutFromGoogle().then(() => nav('/admin')) }}>Sign out</button>
      </div>
      <Outlet />
    </div>
  )
}
