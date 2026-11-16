import type { ApiErrorBody } from './types'
import { getIdToken } from './firebase'

export class ApiError extends Error {
  status: number
  code: string
  details?: Record<string, unknown>
  constructor(body: ApiErrorBody) {
    super(body.message)
    this.status = body.status
    this.code = body.code
    this.details = body.details
  }
}

export function needsApprovedSession(path: string) {
  return /^\/api\/(?:deals|categories|retailers)(?:[/?]|$)/.test(path)
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; form?: FormData; raw?: BodyInit; headers?: Record<string, string>; admin?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { ...opts.headers }
  const protectedDealRequest = needsApprovedSession(path)
  if (opts.admin || protectedDealRequest) {
    const t = await getIdToken()
    if (t) headers.Authorization = `Bearer ${t}`
  }
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.raw !== undefined) body = opts.raw
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(path, { method: opts.method ?? 'GET', headers, body, signal: opts.signal, ...(protectedDealRequest ? { cache: 'no-store' } : {}) })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError({ status: 0, code: 'NETWORK', message: "We couldn't reach the server. Check your connection and try again." })
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = null
  let parsedJson = false
  try {
    if (text) {
      data = JSON.parse(text)
      parsedJson = true
    }
  } catch {
    /* non-JSON error pages */
  }
  if (!res.ok) {
    if (res.status === 401 && opts.admin) {
      window.dispatchEvent(new Event('dealmein:signed-out'))
    }
    if ((res.status === 401 || res.status === 403) && protectedDealRequest) {
      window.dispatchEvent(new Event('dealmein:access-denied'))
    }
    const b = data as ApiErrorBody | null
    throw new ApiError(b && b.message ? b : { status: res.status, code: 'ERROR', message: 'Something went wrong. Please try again.' })
  }
  if (text && !parsedJson) {
    throw new ApiError({ status: res.status, code: 'INVALID_RESPONSE', message: 'The server returned an unexpected response. Please try again.' })
  }
  return data as T
}

export async function download(path: string, filename: string) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${await getIdToken() ?? ''}` } })
  if (!res.ok) throw new ApiError({ status: res.status, code: 'ERROR', message: 'Export failed.' })
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
