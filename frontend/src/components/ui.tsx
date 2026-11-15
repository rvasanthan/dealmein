import type { ReactNode } from 'react'
import { ApiError } from '../api'

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 py-10 text-ink-soft">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-teal-700 border-t-transparent" aria-hidden="true" />
      {label}…
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof ApiError ? error.message : 'Something went wrong. Please try again.'
  return (
    <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-4 text-red-900">
      <p className="font-semibold">We couldn't load this.</p>
      <p className="mt-1 text-sm">{msg}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-ghost mt-3">
          Try again
        </button>
      )}
    </div>
  )
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card mx-auto my-6 max-w-xl p-8 text-center">
      <h2 className="text-lg font-bold text-teal-800">{title}</h2>
      {children && <div className="mt-2 text-sm text-ink-soft">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  const cls = tone === 'warn' ? 'border-accent-400 bg-orange-50 text-accent-700' : 'border-teal-200 bg-teal-50 text-teal-900'
  return <div className={`rounded-xl border p-3 text-sm ${cls}`}>{children}</div>
}

export function Pagination({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null
  return (
    <nav aria-label="Pagination" className="mt-8 flex items-center justify-center gap-3">
      <button type="button" className="btn-ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Previous
      </button>
      <span className="text-sm text-ink-soft" aria-current="page">
        Page {page} of {totalPages}
      </span>
      <button type="button" className="btn-ghost" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next →
      </button>
    </nav>
  )
}
