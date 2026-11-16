import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api'

type FavoritesState = {
  ids: number[]
  loading: boolean
  error: string | null
  pending: number[]
  retry: () => void
  toggle: (id: number) => Promise<void>
}

const FavoritesContext = createContext<FavoritesState | null>(null)

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<number[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<number[]>([])
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    api<number[]>('/api/favorites', { signal: controller.signal }).then((result) => {
      setIds(result)
      setLoading(false)
    }).catch((reason) => {
      if ((reason as Error).name === 'AbortError') return
      setError(reason instanceof Error ? reason.message : 'Could not load favorites.')
      setLoading(false)
    })
    return () => controller.abort()
  }, [attempt])

  const toggle = async (id: number) => {
    if (pending.includes(id) || loading || error) return
    const removing = ids.includes(id)
    setPending((current) => [...current, id])
    try {
      await api(`/api/favorites/${id}`, { method: removing ? 'DELETE' : 'PUT' })
      setIds((current) => removing ? current.filter((item) => item !== id) : [id, ...current.filter((item) => item !== id)])
    } finally { setPending((current) => current.filter((item) => item !== id)) }
  }
  return <FavoritesContext.Provider value={{ ids, loading, error, pending, retry: () => setAttempt((value) => value + 1), toggle }}>
    {error && <div role="alert" className="card mb-4 p-4 text-sm text-red-800">Favorites could not be loaded: {error} <button type="button" className="btn-ghost ml-2" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>}
    {children}
  </FavoritesContext.Provider>
}

export function useFavorites() { return useContext(FavoritesContext) }