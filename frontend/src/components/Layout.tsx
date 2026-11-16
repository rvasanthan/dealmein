import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { onIdTokenChanged } from 'firebase/auth'
import { Logo } from './Logo'
import { api } from '../api'
import { auth, signOutFromGoogle } from '../firebase'

const nav = [
  { to: '/', label: 'All Deals', end: true },
  { to: '/stores', label: 'Stores' },
  { to: '/saved', label: 'Favorites' },
]

export function Layout() {
  const [account, setAccount] = useState<{ email: string } | null>(null)
  useEffect(() => {
    let active = true
    let sequence = 0
    const refresh = async () => {
      const current = ++sequence
      const user = auth.currentUser
      if (!user) { setAccount(null); return }
      try {
        const token = await user.getIdToken()
        const result = await api<{ email: string }>('/api/user/session', { headers: { Authorization: `Bearer ${token}` } })
        if (active && current === sequence) setAccount(result)
      } catch { if (active && current === sequence) setAccount(null) }
    }
    const unsubscribe = onIdTokenChanged(auth, () => { void refresh() })
    const onChanged = () => { void refresh() }
    window.addEventListener('dealmein:user-session-changed', onChanged)
    return () => { active = false; unsubscribe(); window.removeEventListener('dealmein:user-session-changed', onChanged) }
  }, [])
  const link = ({ isActive }: { isActive: boolean }) =>
    `site-nav-link ${isActive ? 'site-nav-link-active' : ''}`
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-3">
        Skip to deals
      </a>
      <header className="site-header sticky top-0 z-20">
        <div className="color-ribbon h-1" aria-hidden="true" />
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3">
          <Link to="/" aria-label="Deal Me In home"><Logo /></Link>
          <nav aria-label="Main" className="-mx-1 flex flex-wrap gap-1">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={link}>
                {n.label}
              </NavLink>
            ))}
            {account ? <button type="button" className="site-nav-link" title={`Signed in as ${account.email}`} onClick={() => { void signOutFromGoogle() }}>Sign out</button>
              : <NavLink to="/signin" className={link}>Sign in</NavLink>}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:py-8">
        <Outlet />
      </main>
      <footer className="site-footer">
        <div className="mx-auto max-w-7xl space-y-1 px-4 py-5 text-xs text-ink-soft">
          <p>
            Deal Me In lists offers reported by the sources we collect from. Prices exclude tax and shipping unless stated, can change at any time, and
            are not a live feed. Always confirm the price and conditions with the retailer before buying. We don't cover every retailer.
          </p>
          <p><Link to="/admin" className="underline">Administrator sign-in</Link></p>
        </div>
      </footer>
    </div>
  )
}
