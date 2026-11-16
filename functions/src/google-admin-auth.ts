import { createHash } from 'node:crypto'
import { getAuth } from 'firebase-admin/auth'
import type { DecodedIdToken } from 'firebase-admin/auth'
import { db } from './firestore-api.js'

export type GoogleIdentity = { uid: string; email: string; name: string | null }

export function googleIdentity(token: DecodedIdToken): GoogleIdentity | null {
  if (token.firebase?.sign_in_provider !== 'google.com' || token.email_verified !== true || typeof token.email !== 'string') return null
  const email = token.email.trim().toLowerCase()
  if (!email || !token.uid) return null
  return { uid: token.uid, email, name: typeof token.name === 'string' ? token.name : null }
}

export function adminRef(email: string) {
  return db.collection('dealmein_adminAccounts').doc(createHash('sha256').update(email.trim().toLowerCase()).digest('hex'))
}

export function userRef(email: string) {
  return db.collection('dealmein_userAccounts').doc(createHash('sha256').update(email.trim().toLowerCase()).digest('hex'))
}

export function isBootstrapAdmin(email: string) {
  const configured = process.env.APP_ADMIN_USERNAME?.trim().toLowerCase()
  return Boolean(configured && email === configured)
}

export async function verifyGoogleToken(header: string | undefined) {
  if (!header?.startsWith('Bearer ')) return null
  try { return googleIdentity(await getAuth().verifyIdToken(header.slice(7), true)) } catch { return null }
}

export async function isApprovedAdmin(identity: GoogleIdentity) {
  if (isBootstrapAdmin(identity.email)) return true
  const account = await adminRef(identity.email).get()
  return account.exists && account.get('status') === 'approved'
}
