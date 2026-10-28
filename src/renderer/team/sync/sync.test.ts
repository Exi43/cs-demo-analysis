// Team-Sync: Schlange/Merge (core.ts) und der Store gegen einen nachgebauten Supabase-Server (fetch gemockt): optimistisch, offline,
// Rechte-Fehler, Token-Erneuerung, Cache beim Neustart, Clips.
import { describe, expect, it, vi } from 'vitest'
import type { Lineup } from '../../../shared/utility'
import { createTeamStore, type Deps } from '../store'
import { emptySnapshot, enqueue, merge, opKey, toRequest, view, type Op } from './core'
import { createClient, type Session } from './http'

vi.mock('../../api', () => ({ api: {} })) // Fenster-API gibt es im Test nicht

const T = '11111111-1111-1111-1111-111111111111', ME = 'aaaaaaaa-0000-0000-0000-000000000001', OTHER = 'bbbbbbbb-0000-0000-0000-000000000002'
const L = (id: string, p: Partial<Lineup> = {}): Lineup => ({ id, map: 'de_mirage', type: 'smoke', side: 'T', title: id, stand: { x: 0, y: 0 }, target: { x: 1, y: 1 },
  technique: [], steps: [], images: [], tags: [], owner: { team: T }, createdAt: 1, updatedAt: 1, ...p })
const lineupOp = (id: string, title = id): Op => ({ t: 'lineup', v: L(id, { title }) })

describe('core', () => {
  it('Schlange: gleiche Änderung ersetzt die alte, die gerade gesendete bleibt', () => {
    const a = lineupOp('a', 'eins'), b = lineupOp('a', 'zwei'), c = lineupOp('b')
    expect(enqueue([a, c], b)).toEqual([b, c])
    expect(enqueue([a, c], b, a)).toEqual([a, c, b]) // a ist unterwegs
    expect(opKey({ t: 'vote', v: { stratId: 's', memberId: 'm', value: 1, updatedAt: 1 } })).toBe('vote:s:m')
  })
  it('Anzeige = Server-Stand + Schlange; ohne Team leer', () => {
    const s = merge(emptySnapshot(ME), { now: 'x', team: { id: T, name: 'A', mapPool: [], updatedAt: 1 }, members: [{ id: ME, teamId: T, name: 'me', perm: 'player', roles: [], joinedAt: 1, updatedAt: 1 }] })
    expect(view(s, [lineupOp('a')]).lineups.map(l => l.id)).toEqual(['a'])
    expect(view(emptySnapshot(ME), [lineupOp('a')]).lineups).toEqual([])
  })
  it('Merge: Server gewinnt, kaputte Lineups fallen weg, lokales Video nie, gelöschter Clip weg, team null = raus', () => {
    let s = merge(emptySnapshot(ME), { now: 'x', team: { id: T, name: 'A', mapPool: [], updatedAt: 1 }, lineups: [{ ...L('a'), createdBy: OTHER }],
      clips: [{ lineupId: 'a', path: 'p', bytes: 5, durationS: 3, updatedAt: 1 }] })
    s = merge(s, { now: 'y', team: { id: T, name: 'B', mapPool: [], updatedAt: 2 },
      lineups: [L('a', { title: 'neu', video: { url: 'https://x.y/v', local: 'f'.repeat(40) + '.mp4' } }), { ...L('b'), map: 'BAD MAP' } as Lineup],
      clips: [{ lineupId: 'a', path: 'p', bytes: 5, durationS: 3, updatedAt: 2, deleted: true }] })
    expect(s.team?.name).toBe('B')
    expect(s.lineups.map(l => [l.id, l.title, l.video])).toEqual([['a', 'neu', { url: 'https://x.y/v' }]])
    expect(s.lineupOwner.a).toBe(OTHER)
    expect(s.clips).toEqual({})
    expect(merge(s, { now: 'z', team: null }).lineups).toEqual([])
  })
  it('Anfragen: Ersteller/Autor setzt der Server, Felder in data', () => {
    const r = toRequest(lineupOp('a'), T)
    expect(r.path).toBe('lineups?on_conflict=id')
    expect(r.body).toMatchObject({ id: 'a', team_id: T, deleted: false })
    expect((r.body as any).data.owner).toBeUndefined()
    expect(toRequest({ t: 'member', v: { id: ME, teamId: T, name: 'x', perm: 'player', roles: [], joinedAt: 1, updatedAt: 1 } }, T).method).toBe('PATCH')
  })
})

// ---------------------------------------------------------------- nachgebauter Server (nur was der Store braucht, Rechte wie team.sql)

function fakeServer() {
  const db = {
    team: undefined as any, members: [] as any[], lineups: [] as any[], clips: [] as any[], objects: new Map<string, Uint8Array>(),
    tokens: new Map<string, string>(), refreshes: 0, down: false, calls: [] as string[],
  }
  let n = 0, clock = 1000
  const tick = () => new Date((clock += 1000)).toISOString()
  const res = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const session = (uid: string) => { const at = `at${++n}`, rt = `rt${n}`; db.tokens.set(at, uid); db.tokens.set(rt, uid); return { access_token: at, refresh_token: rt, expires_in: 3600, user: { id: uid } } }
  const perm = (uid: string) => db.members.find(m => m.user_id === uid && !m.deleted)?.perm
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (db.down) throw new TypeError('Failed to fetch')
    const u = new URL(String(input)), path = u.pathname, body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body
    db.calls.push(`${init.method ?? 'GET'} ${path}`)
    if (path === '/auth/v1/signup') return res(200, session(ME))
    if (path === '/auth/v1/token') { db.refreshes++; const uid = db.tokens.get(body.refresh_token); db.tokens.delete(body.refresh_token); return uid ? res(200, session(uid)) : res(400, { error: 'invalid_grant' }) }
    const uid = db.tokens.get(String((init.headers as any)?.authorization).replace('Bearer ', ''))
    if (!uid) return res(401, { message: 'JWT expired' })
    if (path === '/rest/v1/rpc/create_team') {
      db.team = { id: T, name: body.team_name, mapPool: [], updatedAt: clock }
      db.members.push({ user_id: uid, name: body.my_name, perm: 'admin', roles: [], updated_at: tick() })
      return res(200, T)
    }
    if (path === '/rest/v1/rpc/sync') {
      if (!perm(uid)) return res(200, { now: tick(), team: null })
      const since = body.since ?? ''
      return res(200, {
        now: tick(), team: db.team, invite: since ? null : 'CODE',
        members: db.members.filter(m => m.updated_at > since).map(m => ({ id: m.user_id, teamId: T, name: m.name, perm: m.perm, roles: m.roles, joinedAt: 1, updatedAt: 1, deleted: m.deleted })),
        lineups: db.lineups.filter(l => l.updated_at > since).map(l => ({ ...l.data, id: l.id, owner: { team: l.team_id }, createdBy: l.created_by, updatedAt: 1, deleted: l.deleted })),
        clips: db.clips.filter(c => c.updated_at > since).map(c => ({ lineupId: c.lineup_id, path: c.path, bytes: c.bytes, durationS: c.duration_s, updatedAt: 1, deleted: c.deleted })),
      })
    }
    if (path === '/rest/v1/rpc/team_storage') return res(200, { bytes: [...db.objects.values()].reduce((s, b) => s + b.length, 0), limit: 800 * 2 ** 20 })
    if (path === '/rest/v1/lineups' && init.method === 'POST') {
      const old = db.lineups.find(l => l.id === body.id)
      if (old && old.created_by !== uid && perm(uid) !== 'admin') return res(403, { code: '42501', message: 'new row violates row-level security policy for table "lineups"' })
      const row = { ...body, created_by: old?.created_by ?? uid, updated_at: tick() }
      db.lineups = [...db.lineups.filter(l => l.id !== body.id), row]
      return res(201, [row])
    }
    if (path === '/rest/v1/clips' && init.method === 'PATCH') {
      const c = db.clips.filter(x => x.lineup_id === u.searchParams.get('lineup_id')!.slice(3))
      for (const x of c) Object.assign(x, body, { updated_at: tick() })
      return res(200, c)
    }
    if (path === '/rest/v1/clips' && init.method === 'POST') { db.clips = [...db.clips.filter(c => c.lineup_id !== body.lineup_id), { ...body, updated_at: tick() }]; return res(201, [body]) }
    if (path.startsWith('/storage/v1/object/clips/') && init.method === 'POST') { db.objects.set(path.slice(25), new Uint8Array(await (body as Blob).arrayBuffer())); return res(200, { Key: path }) }
    if (path.startsWith('/storage/v1/object/authenticated/clips/')) { const b = db.objects.get(path.slice(39)); return b ? new Response(b as BlobPart) : res(404, { message: 'not found' }) }
    if (path.startsWith('/storage/v1/object/clips/') && init.method === 'DELETE') { db.objects.delete(path.slice(25)); return res(200, {}) }
    return res(404, { message: `no route ${path}` })
  })
  return { db, fetch }
}

function setup(server = fakeServer(), files: Record<string, string | null> = {}) {
  let ids = 0
  const disk = { session: null as string | null, cache: null as string | null, clips: new Map<string, Uint8Array>(), ...files }
  const client = createClient({
    fetch: server.fetch as typeof fetch,
    load: async () => (disk.session ? (JSON.parse(disk.session) as Session) : null),
    save: async s => { disk.session = s && JSON.stringify(s) },
  })
  const ipc: Deps['ipc'] = {
    teamLoadCache: async () => disk.cache, teamSaveCache: async s => { disk.cache = s },
    teamClipGet: async n => disk.clips.get(n) ?? null, teamClipPut: async (n, b) => { disk.clips.set(n, b) },
    teamImageGet: async () => null, teamImagePut: async () => {},
  }
  const store = createTeamStore({ client, ipc, timers: false, uuid: () => `00000000-0000-0000-0000-${String(++ids).padStart(12, '0')}` })
  return { store, server, disk }
}
const settle = () => new Promise(r => setTimeout(r, 400)) // Cache wird 300 ms verzögert geschrieben

describe('Store', () => {
  it('Team erstellen, Lineup speichern: sofort sichtbar, danach auf dem Server', async () => {
    const { store, server } = setup()
    await store.create('Alpha', 'Exi')
    expect(store.state().team?.name).toBe('Alpha')
    expect(store.state().team?.inviteCode).toBe('CODE')
    expect(store.state().me?.perm).toBe('admin')
    const p = store.saveLineup(L('00000000-0000-0000-0000-00000000aaaa'))
    expect(store.state().lineups).toHaveLength(1) // optimistisch, vor der Antwort
    await p
    expect(server.db.lineups[0].created_by).toBe(ME)
    expect(store.canEdit('00000000-0000-0000-0000-00000000aaaa')).toBe(true)
  })

  it('offline: Änderung bleibt in der Schlange (auch über Neustart) und geht später raus', async () => {
    const { store, server, disk } = setup()
    await store.create('Alpha', 'Exi')
    server.db.down = true
    await store.saveLineup(L('00000000-0000-0000-0000-00000000bbbb', { title: 'offline' }))
    expect(store.state().online).toBe(false)
    expect(store.state().lineups.map(l => l.title)).toEqual(['offline'])
    expect(server.db.lineups).toHaveLength(0)
    await settle()
    // Neustart offline: gleicher Stand aus dem Cache
    const again = setup(server, { session: disk.session, cache: disk.cache })
    await again.store.ready
    expect(again.store.state().team?.name).toBe('Alpha')
    expect(again.store.state().lineups.map(l => l.title)).toEqual(['offline'])
    server.db.down = false
    await again.store.sync()
    expect(server.db.lineups.map(l => l.data.title)).toEqual(['offline'])
    expect(again.store.state().online).toBe(true)
  })

  it('Rechte-Fehler: fremdes Lineup als Spieler → abgelehnt, Anzeige springt zurück, Fehler im State', async () => {
    const { store, server } = setup()
    await store.create('Alpha', 'Exi')
    server.db.members[0].perm = 'player'
    server.db.lineups.push({ id: 'cccccccc-0000-0000-0000-000000000000', team_id: T, created_by: OTHER, data: { ...L('x'), id: undefined, owner: undefined, title: 'fremd' }, updated_at: 'z', deleted: false })
    server.db.members[0].updated_at = 'z'
    await store.sync()
    const l = store.state().lineups[0]
    expect(l.title).toBe('fremd')
    expect(store.canEdit(l.id)).toBe(false)
    await expect(store.saveLineup({ ...l, title: 'geändert' })).rejects.toThrow(/Not allowed/)
    expect(store.state().lineups[0].title).toBe('fremd')
    expect(store.state().error).toMatch(/Not allowed/)
  })

  it('abgelaufener Token: einmal erneuern, neuer Refresh-Token sofort gespeichert', async () => {
    const { store, server, disk } = setup()
    await store.create('Alpha', 'Exi')
    const before = JSON.parse(disk.session!) as Session
    server.db.tokens.delete(before.access_token) // Server lehnt den alten Access-Token ab (401)
    await store.sync()
    expect(server.db.refreshes).toBe(1)
    const after = JSON.parse(disk.session!) as Session
    expect(after.refresh_token).not.toBe(before.refresh_token)
    expect(store.state().online).toBe(true)
  })

  it('ohne Team kein Netzverkehr', async () => {
    const { store, server } = setup()
    await store.sync()
    expect(server.fetch).not.toHaveBeenCalled()
  })

  it('Clip: Eintrag, Datei, lokal gecacht; Ersetzen löscht den alten', async () => {
    const { store, server, disk } = setup()
    await store.create('Alpha', 'Exi')
    const id = '00000000-0000-0000-0000-00000000dddd'
    await store.saveLineup(L(id))
    const c1 = await store.uploadClip(id, new Blob([new Uint8Array(1000)], { type: 'video/webm' }), 12.34)
    expect(c1).toMatchObject({ bytes: 1000, durationS: 12.3 })
    expect(store.state().clips[id]?.path).toBe(c1.path)
    expect(disk.clips.size).toBe(1)
    const c2 = await store.uploadClip(id, new Blob([new Uint8Array(500)]), 5)
    await settle()
    expect([...server.db.objects.keys()]).toEqual([c2.path])
    expect(await store.storage()).toEqual({ bytes: 500, limit: 800 * 2 ** 20 })
    // anderer PC: einmal herunterladen, danach aus dem Cache
    const other = setup(server, { session: disk.session })
    await other.store.sync()
    const before = server.fetch.mock.calls.length
    expect(await other.store.clipUrl(other.store.state().clips[id]!)).toMatch(/^blob:/)
    expect(other.disk.clips.size).toBe(1)
    expect(server.fetch.mock.calls.length).toBe(before + 1)
  })

  it('gerade Admin geworden: Einladungscode kommt sofort (nicht erst, wenn er sich ändert)', async () => {
    const { store, server } = setup()
    await store.create('Alpha', 'Exi')
    Object.assign(server.db.members[0], { perm: 'player', updated_at: 'y' })
    await store.sync()
    expect(store.state().team?.inviteCode).toBeUndefined()
    Object.assign(server.db.members[0], { perm: 'admin', updated_at: 'z' })
    await store.sync()
    expect(store.state().team?.inviteCode).toBe('CODE')
  })

  it('Lineup löschen: Clip-Eintrag und Datei mit weg (zählen sonst für immer zum Limit)', async () => {
    const { store, server } = setup()
    await store.create('Alpha', 'Exi')
    const id = '00000000-0000-0000-0000-00000000eeee'
    await store.saveLineup(L(id))
    await store.uploadClip(id, new Blob([new Uint8Array(800)]), 3)
    await store.saveLineup({ ...store.state().lineups[0], deleted: true })
    expect(server.db.objects.size).toBe(0)
    expect(server.db.clips[0].deleted).toBe(true)
    expect(store.state().clips).toEqual({})
  })
})
