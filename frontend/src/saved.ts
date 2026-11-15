import { useCallback, useEffect, useState } from 'react'

const KEY = 'dealmein.saved.v1'

export function readSaved(): number[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : []
  } catch {
    return []
  }
}

/** Saved deal ids live only in this browser's localStorage. */
export function useSaved() {
  const [ids, setIds] = useState<number[]>(readSaved)
  useEffect(() => {
    const sync = () => setIds(readSaved())
    window.addEventListener('storage', sync)
    window.addEventListener('dealmein:saved', sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener('dealmein:saved', sync)
    }
  }, [])
  const toggle = useCallback((id: number) => {
    const cur = readSaved()
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* storage unavailable (private mode); ignore */
    }
    window.dispatchEvent(new Event('dealmein:saved'))
  }, [])
  return { ids, isSaved: (id: number) => ids.includes(id), toggle }
}
