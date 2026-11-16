import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth'

const app = initializeApp({
  apiKey: 'AIzaSyA_vDaIc27hTU6NEj7YqcDkyYI05hvclpU',
  authDomain: 'lifestyle-101.firebaseapp.com',
  projectId: 'lifestyle-101',
  appId: '1:666543360691:web:861c5676967307989cbec6',
})

export const auth = getAuth(app)

export function signInWithGoogle() { return signInWithPopup(auth, new GoogleAuthProvider()) }

export async function signOutFromGoogle() { await signOut(auth) }

export async function getIdToken() {
  await auth.authStateReady()
  return auth.currentUser?.getIdToken() ?? null
}