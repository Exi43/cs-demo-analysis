// Supabase per fetch (kein npm-Paket): anonyme Anmeldung + Refresh, PostgREST, RPC, Storage. Nur der öffentliche Publishable Key.
// Supabase tauscht den Refresh-Token bei jeder Erneuerung aus: der neue wird sofort gespeichert (sonst ist die Team-Mitgliedschaft weg).

export const SUPABASE_URL = 'https://uwtphpbziwbesozkoxfb.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_0jDekaXXG8vZpnjSasCSuQ_CA7KTf19'

export interface Session { access_token: string; refresh_token: string; expires_at: number; user_id: string }

/** Antwort mit Fehlerstatus; status 0 gibt es nicht (Netzfehler bleiben TypeError) */
export class HttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}
/** später nochmal versuchen (offline, Server-Problem) statt verwerfen (Rechte, ungültige Daten) */
export const retryable = (e: unknown) => !(e instanceof HttpError) || e.status >= 500 || e.status === 408 || e.status === 429
export const isPermission = (e: unknown) => e instanceof HttpError && (e.status === 401 || e.status === 403 || e.code === '42501')

export interface ClientOpts {
  fetch?: typeof fetch
  load(): Promise<Session | null>
  save(s: Session | null): Promise<void>
  url?: string
  key?: string
  now?: () => number
}

async function fail(r: Response): Promise<never> {
  let body: any
  try { body = await r.json() } catch {}
  const msg = body?.message ?? body?.msg ?? body?.error_description ?? body?.error ?? r.statusText ?? `HTTP ${r.status}`
  const code = body?.code ?? (typeof body?.statusCode === 'string' ? body.statusCode : undefined)
  throw new HttpError(r.status === 403 || code === '42501' ? `Not allowed: ${msg}` : String(msg), r.status, code)
}

export function createClient(o: ClientOpts) {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a)), url = o.url ?? SUPABASE_URL, key = o.key ?? SUPABASE_KEY
  const now = o.now ?? Date.now
  let session: Session | null | undefined // undefined = noch nicht geladen
  let refreshing: Promise<Session> | undefined

  const loaded = async () => (session === undefined ? (session = await o.load()) : session)
  const store = async (s: Session | null) => { session = s; await o.save(s) }
  const fromAuth = (j: any): Session => {
    if (!j?.access_token || !j?.refresh_token || !j?.user?.id) throw new HttpError('Unexpected sign-in answer', 500)
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at ? j.expires_at * 1000 : now() + (j.expires_in ?? 3600) * 1000, user_id: j.user.id }
  }
  const auth = async (path: string, body: unknown) => {
    const r = await f(`${url}/auth/v1/${path}`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) await fail(r)
    return fromAuth(await r.json())
  }
  // nur ein Refresh zur Zeit (zwei gleichzeitige würden denselben Token zweimal einlösen). Scheitert er, bleibt die Sitzung gespeichert
  // und der Fehler gilt als „später nochmal“ (503): Änderungen bleiben in der Schlange statt verworfen zu werden
  const refresh = (old: Session) => (refreshing ??= auth('token?grant_type=refresh_token', { refresh_token: old.refresh_token })
    .then(async s => { await store(s); return s }, e => { throw e instanceof HttpError ? new HttpError(`Team sign-in failed: ${e.message}`, 503, 'auth') : e })
    .finally(() => { refreshing = undefined }))

  async function token(): Promise<string> {
    const s = await loaded()
    if (!s) throw new HttpError('Not signed in', 401)
    return (s.expires_at - now() < 60_000 ? await refresh(s) : s).access_token
  }

  /** Anfrage mit Anmeldung; 401 → einmal erneuern und wiederholen */
  async function call(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const r = await f(`${url}${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${await token()}`, ...(init.headers as Record<string, string>) } })
    if (r.status === 401 && !retried && session) { await refresh(session); return call(path, init, true) }
    if (!r.ok) await fail(r)
    return r
  }
  const json = (body: unknown, prefer?: string): RequestInit => ({ body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(prefer ? { prefer } : {}) } })

  return {
    /** gespeicherte Anmeldung vorhanden (ohne Netz) */
    async userId() { return (await loaded())?.user_id },
    /** anonym anmelden, falls noch nicht geschehen (erst beim Erstellen/Beitreten, damit nicht jede Installation einen Nutzer anlegt) */
    async signIn() {
      const s = await loaded()
      if (s) return s.user_id
      const n = await auth('signup', { data: {} })
      await store(n)
      return n.user_id
    },
    async rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
      const r = await call(`/rest/v1/rpc/${fn}`, { method: 'POST', ...json(args) })
      const t = await r.text()
      return (t ? JSON.parse(t) : null) as T
    },
    /** Upsert/Update; 0 betroffene Zeilen = keine Rechte (RLS filtert Updates stumm) */
    async write(method: 'POST' | 'PATCH', path: string, body: unknown) {
      const r = await call(`/rest/v1/${path}`, { method, ...json(body, method === 'POST' ? 'resolution=merge-duplicates,return=representation' : 'return=representation') })
      const rows = await r.json().catch(() => [])
      if (Array.isArray(rows) && !rows.length) throw new HttpError('Not allowed: you cannot change this', 403, '42501')
    },
    /** Datei in den privaten Bucket; vorhandenes Bild (gleicher Hash) zählt als Erfolg */
    async upload(path: string, data: Blob, type: string) {
      try {
        await call(`/storage/v1/object/clips/${path}`, { method: 'POST', body: data, headers: { 'content-type': type, 'x-upsert': 'false', 'cache-control': '31536000' } })
      } catch (e) {
        if (e instanceof HttpError && (e.status === 409 || e.code === '409' || /duplicate|already exists/i.test(e.message))) return
        throw e
      }
    },
    async download(path: string) { return new Uint8Array(await (await call(`/storage/v1/object/authenticated/clips/${path}`)).arrayBuffer()) },
    async remove(path: string) { await call(`/storage/v1/object/clips/${path}`, { method: 'DELETE' }) },
  }
}
export type Client = ReturnType<typeof createClient>
