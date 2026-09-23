const TOKEN_KEY = 'agenthub.token'
const DEVICE_KEY = 'agenthub.device'

export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY) ?? '',
  device: () => localStorage.getItem(DEVICE_KEY) ?? '',
  save(token: string, deviceName: string) {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(DEVICE_KEY, deviceName)
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY)
  },
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 调 Hub REST；401 视为 token 失效，清掉后回配对页 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = auth.token()
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await fetch(path, { ...init, headers })
  const body = await res.json().catch(() => ({}))
  if (res.status === 401 && path !== '/api/pair') {
    auth.clear()
    location.hash = '#/pair'
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}
