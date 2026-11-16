import { useEffect, useState } from 'react'
import { api } from '../../api'
import { ErrorBox, Spinner } from '../../components/ui'

type Role = 'user' | 'admin'
type UserAccount = { email: string; name: string | null; status: 'pending' | 'approved' | 'revoked'; role: Role }

export default function AdminUsers() {
  const [accounts, setAccounts] = useState<UserAccount[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [roles, setRoles] = useState<Record<string, Role>>({})
  useEffect(() => {
    setError(null)
    api<UserAccount[]>('/api/admin/users', { admin: true }).then(setAccounts).catch(setError)
  }, [attempt])

  const update = async (email: string, status: 'approved' | 'revoked', role: Role) => {
    if (status === 'revoked' && !window.confirm(`Revoke account access for ${email}?`)) return
    if (status === 'approved' && role === 'admin' && !window.confirm(`Grant administrator access to ${email}?`)) return
    setBusy(true)
    setMessage('')
    try {
      await api('/api/admin/users', { method: 'PUT', admin: true, body: { email, status, ...(status === 'approved' ? { role } : {}) } })
      setMessage(status === 'approved' ? `${email}: approved as ${role === 'admin' ? 'administrator' : 'user'}.` : `${email}: access revoked.`)
      setRoles((current) => { const next = { ...current }; delete next[email]; return next })
      setAttempt((value) => value + 1)
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Unable to update access.') }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-extrabold text-teal-800">Users</h1>
      {message && <p role="status" className="text-sm">{message}</p>}
      {error ? <ErrorBox error={error} onRetry={() => setAttempt((value) => value + 1)} /> : !accounts ? <Spinner /> : accounts.length === 0 ? (
        <p className="text-sm text-ink-soft">No user requests yet.</p>
      ) : <div className="card overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr><th className="p-3">Account</th><th className="p-3">Status</th><th className="p-3">Role</th><th className="p-3">Action</th></tr></thead>
        <tbody>{accounts.map((account) => <tr key={account.email} className="border-t border-cream-200">
          <td className="p-3">{account.email}{account.name && <span className="block text-xs text-ink-soft">{account.name}</span>}</td>
          <td className="p-3">{account.status}</td>
          <td className="p-3"><select className="field min-w-[150px]" aria-label={`Role for ${account.email}`} disabled={busy}
            value={roles[account.email] ?? account.role} onChange={(event) => setRoles((current) => ({ ...current, [account.email]: event.target.value as Role }))}>
            <option value="user">Normal user</option><option value="admin">Administrator</option>
          </select></td>
          <td className="p-3"><div className="flex flex-wrap gap-2">
            <button className="btn-primary" disabled={busy || (account.status === 'approved' && (roles[account.email] ?? account.role) === account.role)}
              onClick={() => void update(account.email, 'approved', roles[account.email] ?? account.role)}>{account.status === 'approved' ? 'Update role' : 'Approve'}</button>
            {account.status === 'approved' && <button className="btn-ghost" disabled={busy} onClick={() => void update(account.email, 'revoked', account.role)}>Revoke</button>}
          </div></td>
        </tr>)}</tbody>
      </table></div>}
    </div>
  )
}