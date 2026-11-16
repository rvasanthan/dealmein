import { useEffect, useState } from 'react'
import { api } from '../../api'
import { ErrorBox, Spinner } from '../../components/ui'

type Account = { email: string; name: string | null; status: 'pending' | 'approved' | 'revoked' }

export default function AdminAccounts() {
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [email, setEmail] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setError(null)
    api<Account[]>('/api/admin/accounts', { admin: true }).then(setAccounts).catch(setError)
  }, [attempt])

  const update = async (target: string, status: 'approved' | 'revoked') => {
    if (status === 'revoked' && !window.confirm(`Revoke administrator access for ${target}?`)) return
    setBusy(true)
    setMessage('')
    try {
      await api('/api/admin/accounts', { method: 'PUT', admin: true, body: { email: target, status } })
      setEmail('')
      setMessage(`${target}: ${status}.`)
      setAttempt((value) => value + 1)
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Unable to update access.') }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-teal-800">Administrators</h1>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void update(email, 'approved') }}>
        <label className="label flex-1 min-w-[220px]">Google account email
          <input className="field" type="email" value={email} required maxLength={254} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <button className="btn-primary" disabled={busy}>Nominate administrator</button>
      </form>
      {message && <p role="status" className="text-sm">{message}</p>}
      {error ? <ErrorBox error={error} onRetry={() => setAttempt((value) => value + 1)} /> : !accounts ? <Spinner /> : accounts.length === 0 ? (
        <p className="text-sm text-ink-soft">No additional administrator accounts.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr><th className="p-3">Account</th><th className="p-3">Status</th><th className="p-3">Action</th></tr></thead>
            <tbody>{accounts.map((account) => (
              <tr key={account.email} className="border-t border-cream-200">
                <td className="p-3">{account.email}{account.name && <span className="block text-xs text-ink-soft">{account.name}</span>}</td>
                <td className="p-3">{account.status}</td>
                <td className="p-3">{account.status === 'approved' ? (
                  <button className="btn-ghost" disabled={busy} onClick={() => void update(account.email, 'revoked')}>Revoke</button>
                ) : <button className="btn-primary" disabled={busy} onClick={() => void update(account.email, 'approved')}>Approve</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}