// Team-Sync mit Supabase (TeamApi aus shared/team.ts). Ablauf: eigene Änderungen sofort anzeigen (Schlange, sync/core.ts), dann der Reihe
// nach senden; offline bleiben sie in der Schlange (gespeichert in <userData>/team/cache.json, App startet offline mit letztem Stand).
// Abgleich per RPC sync(since): beim Start, bei Fokus und alle 60 s, nur solange das Fenster sichtbar ist und man in einem Team ist.
// Ohne Team/Anmeldung kein Netzverkehr (angemeldet wird erst beim Erstellen/Beitreten).
import type { Clip, Member, Note, Progress, Strat, Team, TeamApi, TeamState } from '../../shared/team'
import type { Lineup } from '../../shared/utility'
import { api } from '../api'
import { apply, canEditLineup, emptySnapshot, enqueue, merge, opKey, toRequest, view, type Delta, type Op, type Snapshot } from './sync/core'
import { createClient, retryable, type Client, type Session } from './sync/http'

const SYNC_MS = 60_000
/** Überlappung beim Abgleich: Zeilen aus noch nicht abgeschlossenen Transaktionen des Servers nicht verpassen */
const OVERLAP_MS = 30_000
export const STORAGE_LIMIT = 800 * 2 ** 20
const CLIP_PATH = /^[0-9a-f-]{36}\/clip\/[0-9a-f-]{36}\.webm$/

export interface Deps {
  client: Client
  ipc: {
    teamLoadCache(): Promise<string | null>
    teamSaveCache(s: string): Promise<void>
    teamClipGet(name: string): Promise<Uint8Array | null>
    teamClipPut(name: string, data: Uint8Array): Promise<void>
    teamImageGet(hash: string): Promise<Uint8Array | null>
    teamImagePut(hash: string, data: Uint8Array): Promise<void>
  }
  uuid?: () => string
  /** Hintergrund-Abgleich (Fokus, Takt); Tests: false */
  timers?: boolean
  onShown?: (cb: (shown: boolean) => void) => void
}

export interface TeamStore extends TeamApi {
  /** Cache geladen */
  ready: Promise<void>
  /** sofort abgleichen (Schlange senden, Änderungen holen) */
  sync(): Promise<void>
  /** darf ich dieses Team-Lineup ändern/löschen (eigenes oder Admin) */
  canEdit(lineupId: string): boolean
}

interface Cache { v: 1; snap: Snapshot; queue: Op[]; cursor?: string; images: string[] }
const msg = (e: unknown) => String((e as Error)?.message ?? e)
const rows = (d: Delta) => [d.members, d.strats, d.votes, d.progress, d.notes, d.lineups, d.clips].reduce((n, a) => n + (a?.length ?? 0), 0) + (d.invite ? 1 : 0)

export function createTeamStore(d: Deps): TeamStore {
  const uuid = d.uuid ?? (() => crypto.randomUUID())
  let snap = emptySnapshot(), queue: Op[] = [], cursor: string | undefined, images = new Set<string>()
  let online = true, syncing = false, error: string | undefined, cur: TeamState | undefined
  const subs = new Set<(s: TeamState) => void>()

  const state = (): TeamState => (cur ??= { ...view(snap, queue), online, syncing, error })
  const emit = () => { cur = undefined; const s = state(); for (const cb of subs) cb(s) }
  let saveT: ReturnType<typeof setTimeout> | undefined
  const persist = () => {
    clearTimeout(saveT)
    saveT = setTimeout(() => { d.ipc.teamSaveCache(JSON.stringify({ v: 1, snap, queue, cursor, images: [...images] } satisfies Cache)).catch(() => {}) }, 300)
  }
  /** Netz/Server weg → offline (Schlange bleibt); sonst Fehler anzeigen */
  const fault = (e: unknown) => { if (retryable(e)) online = false; else error = msg(e) }

  let loaded = false
  const ready = (async () => {
    try {
      const c = JSON.parse((await d.ipc.teamLoadCache()) ?? 'null') as Cache | null
      if (c?.v === 1) { snap = c.snap; queue = c.queue; cursor = c.cursor; images = new Set(c.images) }
    } catch {} // kaputter Cache: neu vom Server
    const uid = await d.client.userId()
    if (snap.me !== uid) { snap = emptySnapshot(uid); queue = []; cursor = undefined } // andere Anmeldung als im Cache
    loaded = true; emit()
  })()

  // ---------------------------------------------------------------- senden

  async function uploadImages(l: Lineup, t: string) {
    for (const h of l.images) {
      if (images.has(h)) continue
      const b = await d.ipc.teamImageGet(h)
      if (!b) continue // nicht auf diesem PC: nichts hochzuladen
      try { await d.client.upload(`${t}/img/${h}.webp`, new Blob([b as BlobPart], { type: 'image/webp' }), 'image/webp') } catch (e) { if (retryable(e)) throw e; continue } // z. B. Speicher voll: Lineup trotzdem
      images.add(h)
    }
  }
  /** gelöschtes Team-Lineup: Clip mit weg (sonst zählt er für immer zum 800-MB-Limit, ein gelöschtes Lineup sieht niemand mehr) */
  // shortcut: scheitert das (offline, Clip eines anderen), bleibt der Clip liegen; nachholen erst, wenn der Speicher wirklich voll läuft
  async function dropClip(id: string) {
    const c = snap.clips[id]
    if (!c) return
    try {
      await d.client.write('PATCH', `clips?lineup_id=eq.${id}`, { deleted: true })
      await d.client.remove(c.path)
    } catch { return }
    const { [id]: _, ...clips } = snap.clips
    snap = { ...snap, clips }
  }
  let inflight: Op | undefined, flushing: Promise<Map<string, string>> | undefined
  /** Schlange der Reihe nach senden; Rückgabe: verworfene Änderungen (Schlüssel → Fehler) */
  // .finally erst nach der Zuweisung (eine leere Schlange liefe sonst synchron durch und flushing bliebe für immer gesetzt)
  const flush = () => (flushing ??= (async () => {
    const dropped = new Map<string, string>()
    try {
      while (queue.length) {
        const t = snap.team?.id
        if (!t) { queue = []; break } // nicht mehr im Team
        const op = (inflight = queue[0])
        try {
          if (op.t === 'lineup') await uploadImages(op.v, t)
          const r = toRequest(op, t)
          await d.client.write(r.method, r.path, r.body)
          snap = apply(snap, op)
          if (op.t === 'lineup' && op.v.deleted) await dropClip(op.v.id)
        } catch (e) {
          if (retryable(e)) throw e
          dropped.set(opKey(op), msg(e)); error = msg(e) // Rechte/ungültig: verwerfen, Anzeige springt zurück
        } finally { inflight = undefined }
        queue = queue.filter(x => x !== op)
        persist(); emit()
      }
      online = true
    } catch (e) { fault(e); emit() }
    return dropped
  })().finally(() => { flushing = undefined }))

  async function write(op: Op) {
    if (!loaded) await ready // geladen: ohne await, damit die Änderung im selben Takt sichtbar ist
    if (!snap.team) throw new Error('You are not in a team')
    error = undefined
    queue = enqueue(queue, op, inflight)
    persist(); emit()
    const err = (await flush()).get(opKey(op))
    if (err) throw new Error(err)
  }

  // ---------------------------------------------------------------- abgleichen

  let running: Promise<void> | undefined
  const missing = new Set<string>()
  async function fetchImages() {
    const t = snap.team?.id
    for (const l of snap.lineups) for (const h of l.deleted || !t ? [] : l.images) {
      if (images.has(h) || missing.has(h)) continue
      try {
        if (!(await d.ipc.teamImageGet(h))) await d.ipc.teamImagePut(h, await d.client.download(`${t}/img/${h}.webp`))
        images.add(h)
      } catch (e) { if (retryable(e)) return; missing.add(h) } // nie hochgeladen (z. B. Speicher voll): nicht jede Minute neu fragen
    }
  }
  const sync = () => (running ??= (async () => {
    await ready
    if (!(await d.client.userId())) return
    syncing = true; emit()
    try {
      await flush()
      let since = cursor ? new Date(Date.parse(cursor) - OVERLAP_MS).toISOString() : null
      let delta = await d.client.rpc<Delta>('sync', { since })
      // anderes Team oder gerade Admin geworden (der Einladungscode kommt sonst erst, wenn er sich ändert): alles holen
      const nowAdmin = snap.members.find(m => m.id === snap.me)?.perm !== 'admin' && delta.members?.some(m => m.id === snap.me && m.perm === 'admin' && !m.deleted)
      if (since && (delta.team?.id !== snap.team?.id || nowAdmin)) delta = await d.client.rpc<Delta>('sync', { since: (since = null) })
      const changed = rows(delta) > 0 || delta.team?.updatedAt !== snap.team?.updatedAt || !delta.team !== !snap.team
      snap = merge(snap, { ...delta, clips: delta.clips?.filter(c => CLIP_PATH.test(c.path)) })
      cursor = delta.now; online = true
      if (changed) persist() // sonst nichts schreiben: Abgleich ohne Änderung kostet keine Platte
      void fetchImages()
    } catch (e) { fault(e) } finally { syncing = false; emit() }
  })().finally(() => { running = undefined }))

  const reset = () => { snap = emptySnapshot(snap.me); queue = []; cursor = undefined; persist() }
  /** Aufruf ohne Schlange (braucht eine Antwort vom Server); Fehler auch im State */
  async function call<T>(f: () => Promise<T>): Promise<T> {
    await ready
    error = undefined
    try { const r = await f(); online = true; return r } catch (e) { fault(e); if (retryable(e)) error = `Offline: ${msg(e)}`; emit(); throw e }
  }
  const restart = async () => { await running; reset(); await sync() }

  if (d.timers !== false) {
    let shown = true, last = 0
    const visible = () => shown && document.visibilityState === 'visible'
    const kick = () => { if (visible() && snap.team && Date.now() - last > 10_000) { last = Date.now(); void sync() } }
    setInterval(() => { if (visible() && snap.team) { last = Date.now(); void sync() } }, SYNC_MS)
    addEventListener('focus', kick); addEventListener('online', kick); document.addEventListener('visibilitychange', kick)
    d.onShown?.(v => { shown = v; kick() })
    void ready.then(() => sync())
  }

  const me = () => { const m = state().me; if (!m) throw new Error('You are not in a team'); return m }
  const team = () => { const t = snap.team; if (!t) throw new Error('You are not in a team'); return t }
  const now = Date.now
  const urls = new Map<string, Promise<string>>()
  const leave = () => call(async () => { await d.client.rpc('leave_team'); await running; reset(); emit() })

  return {
    ready, sync,
    state, canEdit: id => canEditLineup(snap, queue, id),
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb) } },

    create: (teamName, myName) => call(async () => {
      const uid = await d.client.signIn()
      if (snap.me !== uid) snap = emptySnapshot(uid)
      await d.client.rpc('create_team', { team_name: teamName.trim(), my_name: myName.trim() })
      await restart()
    }),
    join: (code, myName) => call(async () => {
      const uid = await d.client.signIn()
      if (snap.me !== uid) snap = emptySnapshot(uid)
      await d.client.rpc('join_team', { invite: code.trim(), my_name: myName.trim() })
      await restart()
    }),
    leave,
    newInviteCode: () => call(async () => {
      const code = await d.client.rpc<string>('new_invite_code')
      snap = { ...snap, team: { ...team(), inviteCode: code } }; persist(); emit()
      return code
    }),
    decide: (stratId, ok) => call(async () => { await flush(); await d.client.rpc('decide', { strat: stratId, ok }); await sync() }),

    saveTeam: (t: Team) => write({ t: 'team', v: { ...t, updatedAt: now() } }),
    saveMember: (m: Member) => write({ t: 'member', v: { ...m, updatedAt: now() } }),
    async removeMember(id) {
      if (id === me().id) return leave()
      const m = snap.members.find(x => x.id === id)
      if (m) await write({ t: 'member', v: { ...m, deleted: true, updatedAt: now() } })
    },
    saveStrat: (s: Strat) => write({ t: 'strat', v: { ...s, teamId: team().id, updatedAt: now() } }),
    vote: (stratId, value, comment) => write({ t: 'vote', v: { stratId, memberId: me().id, value, ...(comment?.trim() ? { comment: comment.trim() } : {}), updatedAt: now() } }),
    setProgress: (p: Progress) => write({ t: 'progress', v: { ...p, memberId: me().id, updatedAt: now() } }),
    saveNote: (n: Note) => write({ t: 'note', v: { ...n, teamId: team().id, updatedAt: now() } }),
    saveLineup: (l: Lineup) => write({ t: 'lineup', v: { ...l, owner: { team: team().id }, updatedAt: now() } }),
    async shareLineups(ls) {
      const t = team().id, name = me().name
      // Kopien: neue ID, ohne lokale Tags/Favorit/lokales Video (gibt es auf anderen PCs nicht)
      await Promise.all(ls.map(({ favorite: _f, deleted: _d, tags: _t, video, ...l }) => write({
        t: 'lineup', v: { ...l, id: uuid(), owner: { team: t }, tags: [], ...(video?.url ? { video: { url: video.url } } : {}), author: l.author ?? name, createdAt: now(), updatedAt: now() },
      })))
    },

    uploadClip: (lineupId, data, durationS) => call(async () => {
      const t = team().id
      await flush()
      if (queue.some(o => o.t === 'lineup' && o.v.id === lineupId)) throw new Error('This lineup is not uploaded yet (offline?)')
      const name = `${uuid()}.webm`, old = snap.clips[lineupId]
      const clip: Clip = { path: `${t}/clip/${name}`, bytes: data.size, durationS: Math.round(durationS * 10) / 10 }
      const row = (c: Clip) => ({ lineup_id: lineupId, team_id: t, path: c.path, bytes: c.bytes, duration_s: c.durationS, deleted: false })
      // erst der Eintrag (Server prüft Rechte + 800-MB-Limit), dann die Datei; scheitert die, alten Eintrag zurück
      await d.client.write('POST', 'clips?on_conflict=lineup_id', row(clip))
      try { await d.client.upload(clip.path, data, 'video/webm') } catch (e) {
        await (old ? d.client.write('POST', 'clips?on_conflict=lineup_id', row(old)) : d.client.write('PATCH', `clips?lineup_id=eq.${lineupId}`, { deleted: true })).catch(() => {})
        throw e
      }
      await d.ipc.teamClipPut(name, new Uint8Array(await data.arrayBuffer())).catch(() => {}) // eigener Clip: nicht nochmal herunterladen
      if (old) d.client.remove(old.path).catch(() => {}) // bleibt er liegen, zählt er bis zum Löschen mit
      snap = { ...snap, clips: { ...snap.clips, [lineupId]: { ...clip, lineupId, updatedAt: now() } } }
      persist(); emit()
      return clip
    }),
    clipUrl(c) {
      let p = urls.get(c.path)
      if (!p) {
        p = (async () => {
          const name = c.path.split('/').pop()!
          let b = await d.ipc.teamClipGet(name)
          if (!b) { b = await d.client.download(c.path); await d.ipc.teamClipPut(name, b) }
          return URL.createObjectURL(new Blob([b as BlobPart], { type: 'video/webm' }))
        })()
        p.catch(() => urls.delete(c.path))
        urls.set(c.path, p)
      }
      return p
    },
    async storage() {
      try { return await d.client.rpc<{ bytes: number; limit: number }>('team_storage') } catch {
        return { bytes: Object.values(snap.clips).reduce((n, c) => n + c.bytes, 0), limit: STORAGE_LIMIT } // offline: nur Clips, ohne Bilder
      }
    },
  }
}

let one: TeamStore | undefined
/** der Team-Store des Fensters (einmal je Fenster; weitere Aufrufe liefern denselben) */
export function teamStore(): TeamStore {
  return (one ??= createTeamStore({
    client: createClient({
      load: async () => { try { return JSON.parse((await api.teamSession()) ?? 'null') as Session | null } catch { return null } },
      save: s => api.teamSetSession(s && JSON.stringify(s)),
    }),
    ipc: api,
    onShown: api.onWindowShown,
  }))
}
export const createSupabaseTeam = (): TeamApi => teamStore()
