import type { ApiErrorBody } from './types'

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

const TOKEN_KEY = 'dealmein.admin.token'
export const getToken = () => sessionStorage.getItem(TOKEN_KEY)
export const setToken = (t: string | null) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY))

export async function api<T>(path: string, opts: { method?: string; body?: unknown; form?: FormData; admin?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.admin) {
    const t = getToken()
    if (t) headers.Authorization = `Bearer ${t}`
  }
  let body: BodyInit | undefined
  if (opts.form) body = opts.form
  else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(path, { method: opts.method ?? 'GET', headers, body, signal: opts.signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError({ status: 0, code: 'NETWORK', message: "We couldn't reach the server. Check your connection and try again." })
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON error pages */
  }
  if (!res.ok) {
    if (res.status === 401 && opts.admin) {
      setToken(null)
      window.dispatchEvent(new Event('dealmein:signed-out'))
    }
    const b = data as ApiErrorBody | null
    throw new ApiError(b && b.message ? b : { status: res.status, code: 'ERROR', message: 'Something went wrong. Please try again.' })
  }
  return data as T
}

export async function download(path: string, filename: string) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
  if (!res.ok) throw new ApiError({ status: res.status, code: 'ERROR', message: 'Export failed.' })
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
