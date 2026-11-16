import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { signInWithGoogle, signOutFromGoogle } from '../firebase'
import { LogoMark } from '../components/Logo'
import { ArrowRight, Sparkles, Tag } from 'lucide-react'

export default function UserLogin() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const signIn = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    let signedIn = false
    try {
      const credential = await signInWithGoogle()
      signedIn = true
      const token = await credential.user.getIdToken()
      const result = await api<{ status: string }>('/api/user/access-request', {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      if (result.status !== 'approved') {
        await signOutFromGoogle()
        signedIn = false
        setMessage(result.status === 'revoked' ? 'Your account access has been revoked. Contact an administrator.' : 'Your request was submitted. An administrator must approve your account before you can sign in.')
        return
      }
      await api('/api/user/session', { headers: { Authorization: `Bearer ${token}` } })
      window.dispatchEvent(new Event('dealmein:user-session-changed'))
      navigate('/', { replace: true })
    } catch (reason) {
      if (signedIn) await signOutFromGoogle().catch(() => {})
      const code = (reason as { code?: string }).code
      setError(code === 'auth/popup-blocked' ? 'Your browser blocked the Google sign-in popup. Allow popups for this site and try again.' : reason instanceof Error ? reason.message : 'Unable to sign in.')
    } finally { setBusy(false) }
  }

  return (
    <section className="auth-stage page-enter">
      <div className="auth-intro">
        <span className="auth-eyebrow"><Sparkles size={16} aria-hidden="true" /> THE GOOD DEAL CLUB</span>
        <h1>Deal Me In<span className="auth-period">.</span></h1>
        <p>Great deals. Count me in.</p>
        <div className="auth-ticket ticket-sway" aria-hidden="true">
          <Tag size={25} strokeWidth={2.2} />
          <span>GOOD FINDS<br /><strong>GOOD TIMES</strong></span>
          <Sparkles size={20} />
        </div>
        <div className="auth-dashes" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      </div>
      <div className="auth-panel">
        <div className="auth-panel-heading"><LogoMark className="h-12 w-12" /><span>YOUR SEAT IS WAITING</span></div>
        <h2>Come on in<span>.</span></h2>
        <p className="auth-panel-copy">Sign in to your Deal Me In account.</p>
        {message && <p role="status" className="auth-message">{message}</p>}
        {error && <p role="alert" className="auth-error">{error}</p>}
        <button type="button" className="google-button" disabled={busy} onClick={signIn}>
          <span className="google-mark" aria-hidden="true">G</span><span>{busy ? 'Signing in...' : 'Continue with Google'}</span><ArrowRight size={18} aria-hidden="true" />
        </button>
        <Link to="/" className="auth-back">Back to deals <ArrowRight size={15} aria-hidden="true" /></Link>
      </div>
    </section>
  )
}