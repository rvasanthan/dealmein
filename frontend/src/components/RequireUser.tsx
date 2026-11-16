import { useEffect, useState } from 'react'
import { onIdTokenChanged } from 'firebase/auth'
import { Link, Navigate, Outlet } from 'react-router-dom'
import { api, ApiError } from '../api'
import { auth } from '../firebase'
import { Spinner } from './ui'

export function RequireUser() {
  const [status, setStatus] = useState<'loading' | 'allowed' | 'signedOut' | 'denied' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    let sequence = 0
    const unsubscribe = onIdTokenChanged(auth, async (user) => {
      const current = ++sequence
      if (!user) { if (active) setStatus('signedOut'); return }
      setStatus('loading')
      try {
        const token = await user.getIdToken()
        await api('/api/user/session', { headers: { Authorization: `Bearer ${token}` } })
        if (active && current === sequence) setStatus('allowed')
      } catch (error) {
        if (active && current === sequence) setStatus(error instanceof ApiError && (error.status === 401 || error.status === 403) ? 'denied' : 'error')
      }
    })
    const deny = () => { sequence++; setStatus('denied') }
    window.addEventListener('dealmein:access-denied', deny)
    return () => { active = false; unsubscribe(); window.removeEventListener('dealmein:access-denied', deny) }
  }, [attempt])
  if (status === 'loading') return <Spinner label="Checking access" />
  if (status === 'signedOut') return <Navigate to="/signin" replace />
  if (status === 'denied') return <div className="space-y-3"><p>Administrator approval is required to view deals.</p><Link className="btn-primary" to="/signin">Sign in</Link></div>
  if (status === 'error') return <div role="alert" className="space-y-3"><p>Could not check your account access.</p><button className="btn-primary" onClick={() => setAttempt((value) => value + 1)}>Try again</button></div>
  return <Outlet />
}