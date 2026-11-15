import { Link, NavLink, Outlet } from 'react-router-dom'
import { Logo } from './Logo'
import { useSaved } from '../saved'

const nav = [
  { to: '/', label: 'All Deals', end: true },
  { to: '/categories', label: 'Categories' },
  { to: '/stores', label: 'Stores' },
  { to: '/saved', label: 'Saved Deals' },
]

export function Layout() {
  const { ids } = useSaved()
  const link = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-[44px] items-center rounded-lg px-3 text-sm font-semibold ${isActive ? 'bg-teal-700 text-white' : 'text-teal-800 hover:bg-teal-50'}`
  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:p-3">
        Skip to deals
      </a>
      <header className="sticky top-0 z-20 border-b border-cream-200 bg-cream/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2">
          <Link to="/" aria-label="Deal Me In home"><Logo /></Link>
          <nav aria-label="Main" className="-mx-1 flex flex-wrap gap-1">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={link}>
                {n.label}
                {n.to === '/saved' && ids.length > 0 && <span className="ml-1.5 rounded-full bg-accent-600 px-1.5 text-xs text-white" aria-label={`${ids.length} saved`}>{ids.length}</span>}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-5">
        <Outlet />
      </main>
      <footer className="border-t border-cream-200 bg-white/60">
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
