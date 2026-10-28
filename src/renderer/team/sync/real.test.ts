// Team-Sync gegen das ECHTE Supabase-Projekt (zwei anonyme Test-Nutzer A = Admin, B = Spieler). Läuft nur von Hand:
//   $env:CSDA_TEAM_REAL='setup'   (Team, Rechte, Lineups, Strats, Notizen, Clip, offline), danach Clip-Selbsttest der App als B, dann
//   'clip' (A lädt ihn) und 'cleanup' (alles weich löschen, Team verlassen). Jede Anlage erzeugt ein Team + 2 anonyme Nutzer, die nur im Dashboard weggehen.
// Anmeldungen liegen unverschlüsselt in <Profil>/team/session.json (wie im Selbsttest der App), IDs in csda-team-test.json.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Strat } from '../../../shared/team'
import type { Lineup } from '../../../shared/utility'
import { createTeamStore } from '../store'
import { createClient, type Session } from './http'

vi.mock('../../api', () => ({ api: {} }))

const PHASE = process.env.CSDA_TEAM_REAL
const DATA = process.env.CSDA_TEAM_DIR ?? 'F:/Claude main/Daten'
const IDS = join(DATA, 'csda-team-test.json')
const sessionFile = (who: string) => join(DATA, `csda-team-${who}`, 'team', 'session.json')

function user(who: 'a' | 'b') {
  let offline = false
  const f = sessionFile(who)
  const client = createClient({
    fetch: (...a) => (offline ? Promise.reject(new TypeError('fetch failed')) : fetch(...a)),
    load: async () => (existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Session) : null),
    save: async s => { mkdirSync(join(f, '..'), { recursive: true }); if (s) writeFileSync(f, JSON.stringify(s)); else rmSync(f, { force: true }) },
  })
  const mem = new Map<string, Uint8Array>()
  let cache: string | null = null
  const store = createTeamStore({
    client, timers: false,
    ipc: {
      teamLoadCache: async () => cache, teamSaveCache: async s => { cache = s },
      teamClipGet: async n => mem.get(n) ?? null, teamClipPut: async (n, d) => { mem.set(n, d) },
      teamImageGet: async () => null, teamImagePut: async () => {},
    },
  })
  return { store, client, mem, setOffline: (v: boolean) => { offline = v } }
}

const lineup = (title: string): Lineup => ({ id: crypto.randomUUID(), map: 'de_dust2', type: 'smoke', side: 'T', title, stand: { x: -300, y: 1200 }, target: { x: 400, y: 2300 },
  technique: [], steps: [], images: [], tags: [], owner: 'local', createdAt: Date.now(), updatedAt: Date.now() })
const strat = (me: string, p: Partial<Strat>): Strat => ({ id: crypto.randomUUID(), teamId: '', map: 'de_dust2', side: 'T', kind: 'execute', title: 'zz-test strat',
  slots: [{ role: 'entry', lineupIds: [], task: 'go long' }], board: [], tags: [], status: 'proposed', author: me, createdAt: Date.now(), updatedAt: Date.now(), ...p })
const denied = (p: Promise<unknown>) => p.then(() => { throw new Error('should be denied') }, e => console.log('denied:', String(e?.message ?? e)))

describe.skipIf(PHASE !== 'setup')('echtes Supabase: Setup + Rechte', { timeout: 120_000 }, () => {
  let A: ReturnType<typeof user>, B: ReturnType<typeof user>
  const ids: Record<string, string> = {}
  const a = () => A.store.state(), b = () => B.store.state()

  it('1. Team erstellen, beitreten, Rollen/Admin nur durch Admin', async () => {
    // nie alte Anmeldungen überschreiben: deren Team ließe sich sonst nicht mehr aufräumen (erst 'cleanup', dann Profile löschen)
    if (['a', 'b'].some(w => existsSync(sessionFile(w)))) throw new Error('Test users exist: run cleanup first, then delete csda-team-a/-b')
    A = user('a'); B = user('b')
    await A.store.create('zz-test (bitte löschen)', 'Tester A')
    expect(a().me?.perm).toBe('admin')
    const code = a().team?.inviteCode
    expect(code).toMatch(/^[0-9A-F]{10}$/)
    await B.store.join(code!.toLowerCase(), 'Tester B')
    expect(b().me?.perm).toBe('player')
    expect(b().team?.inviteCode).toBeUndefined() // Code nur für Admins
    expect(b().members.length).toBe(2)
    const meB = b().me!, meA = a().me!
    await denied(B.store.saveMember({ ...meB, roles: ['awp'] })) // eigene Rolle: nein
    await denied(B.store.saveMember({ ...meB, perm: 'admin' }))
    await denied(B.store.saveMember({ ...b().members.find(m => m.id === meA.id)!, name: 'hacked' }))
    expect(b().me?.roles).toEqual([])
    await B.store.saveMember({ ...b().me!, name: 'Tester B2', steamid: '76561198000000002' }) // eigener Name/SteamID: ja
    await A.store.sync()
    const bInA = a().members.find(m => m.id === meB.id)!
    expect(bInA.name).toBe('Tester B2')
    await A.store.saveMember({ ...bInA, roles: ['entry', 'support'], perm: 'admin' })
    await B.store.sync()
    expect(b().me).toMatchObject({ roles: ['entry', 'support'], perm: 'admin' })
    expect(b().team?.inviteCode).toBe(code) // neuer Admin sieht den Code sofort
    await A.store.saveMember({ ...a().members.find(m => m.id === meB.id)!, perm: 'player' })
    await B.store.sync()
    expect(b().me?.perm).toBe('player')
    expect(b().team?.inviteCode).toBeUndefined()
    ids.team = a().team!.id; ids.a = meA.id; ids.b = meB.id
  })

  it('2. Lineups teilen, eigene ändern/löschen, Admin darf alles', async () => {
    await B.store.shareLineups([lineup('zz B smoke 1'), lineup('zz B smoke 2')])
    const [l1, l2] = b().lineups
    await A.store.sync()
    expect(a().lineups.map(l => l.title).sort()).toEqual(['zz B smoke 1', 'zz B smoke 2'])
    await B.store.saveLineup({ ...l1, title: 'zz B smoke 1 (edit)' })
    await B.store.saveLineup({ ...l2, deleted: true })
    await A.store.shareLineups([lineup('zz A flash')])
    await B.store.sync()
    const la = b().lineups.find(l => l.title === 'zz A flash')!
    expect(B.store.canEdit(la.id)).toBe(false)
    await denied(B.store.saveLineup({ ...la, title: 'hacked' }))
    expect(b().lineups.find(l => l.id === la.id)?.title).toBe('zz A flash') // Anzeige springt zurück
    await A.store.sync()
    expect(a().lineups.find(l => l.id === l1.id)?.title).toBe('zz B smoke 1 (edit)')
    expect(a().lineups.find(l => l.id === l2.id)?.deleted).toBe(true)
    await A.store.saveLineup({ ...a().lineups.find(l => l.id === l1.id)!, description: 'Admin edit' })
    await B.store.sync()
    expect(b().lineups.find(l => l.id === l1.id)?.description).toBe('Admin edit')
    ids.l1 = l1.id; ids.la = la.id
  })

  it('3. Strats: Vorschlag, Änderungsvorschlag, Abstimmung, Freigabe, Admin direkt', async () => {
    const orig = strat(ids.a, { title: 'zz A execute', status: 'approved' })
    await A.store.saveStrat(orig) // Admin direkt ins Stratbook
    await denied(B.store.saveStrat(strat(ids.b, { title: 'zz B direct', status: 'approved' })))
    const prop = strat(ids.b, { title: 'zz B new' })
    await B.store.saveStrat(prop)
    await B.store.sync()
    const change = { ...b().strats.find(s => s.id === orig.id)!, id: crypto.randomUUID(), baseId: orig.id, status: 'proposed' as const, title: 'zz A execute (B change)', author: ids.b }
    await B.store.saveStrat(change)
    await denied(B.store.decide(prop.id, true))
    await A.store.vote(change.id, 1, 'ok'); await B.store.vote(change.id, 1); await B.store.vote(prop.id, -1, 'nah')
    await A.store.sync()
    expect(a().votes.filter(v => v.stratId === change.id).length).toBe(2)
    await A.store.decide(change.id, true)
    await A.store.decide(prop.id, false)
    await B.store.sync()
    expect(b().strats.find(s => s.id === orig.id)).toMatchObject({ title: 'zz A execute (B change)', status: 'approved' })
    expect(b().strats.find(s => s.id === prop.id)?.status).toBe('rejected')
    await denied(B.store.saveStrat({ ...b().strats.find(s => s.id === orig.id)!, title: 'hacked' })) // freigegebene: nur Admin
    ids.orig = orig.id; ids.prop = prop.id; ids.change = change.id
  })

  it('4. Lern-Status, Notiz mit Lesezeichen, Fokus, Map-Pool', async () => {
    await B.store.setProgress({ memberId: ids.b, ref: { strat: ids.orig }, status: 'learning', updatedAt: 0 })
    await B.store.setProgress({ memberId: ids.b, ref: { lineup: ids.l1 }, status: 'ready', updatedAt: 0 })
    const note = { id: crypto.randomUUID(), teamId: '', kind: 'scrim' as const, title: 'zz scrim', date: Date.now(), map: 'de_dust2', result: '13:9', text: 'test',
      bookmarks: [{ demoKey: 'abc', demoName: 'user-demo', round: 3, tick: 12345, label: 'B split' }], author: ids.a, updatedAt: 0 }
    await A.store.saveNote(note)
    await A.store.saveTeam({ ...a().team!, focus: 'zz Fokus: B-Execute', mapPool: [{ map: 'de_dust2', status: 'main' }, { map: 'de_nuke', status: 'permaban' }] })
    await B.store.sync()
    await denied(B.store.saveNote({ ...b().notes[0], text: 'hacked' }))
    await denied(B.store.saveTeam({ ...b().team!, focus: 'hacked' }))
    await A.store.sync()
    expect(a().progress.filter(p => p.memberId === ids.b).map(p => p.status).sort()).toEqual(['learning', 'ready'])
    expect(b().notes[0]).toMatchObject({ title: 'zz scrim', text: 'test', bookmarks: note.bookmarks })
    expect(b().team).toMatchObject({ focus: 'zz Fokus: B-Execute', mapPool: [{ map: 'de_dust2', status: 'main' }, { map: 'de_nuke', status: 'permaban' }] })
    ids.note = note.id
  })

  it('5. Clip: B lädt hoch, A lädt herunter, Speicher, Server-Grenzen', async () => {
    const webm = readFileSync(process.env.CSDA_TEST_WEBM ?? join(DATA, 'team-shots', 'test-clip.webm'))
    const clip = await B.store.uploadClip(ids.l1, new Blob([webm], { type: 'video/webm' }), 3)
    expect(clip.bytes).toBe(webm.length)
    await A.store.sync()
    expect(a().clips[ids.l1]?.path).toBe(clip.path)
    const url = await A.store.clipUrl(a().clips[ids.l1])
    expect(url).toMatch(/^blob:/)
    expect(A.mem.get(clip.path.split('/').pop()!)?.length).toBe(webm.length) // im Cache
    const st = await A.store.storage()
    expect(st).toEqual({ bytes: webm.length, limit: 800 * 2 ** 20 })
    // Datei ohne clips-Eintrag, falscher Typ, zu groß, fremdes Lineup: alles abgelehnt
    await denied(B.client.upload(`${ids.team}/clip/${crypto.randomUUID()}.webm`, new Blob([webm]), 'video/webm'))
    await denied(B.client.write('POST', 'clips?on_conflict=lineup_id', { lineup_id: ids.la, team_id: ids.team, path: `${ids.team}/clip/${crypto.randomUUID()}.webm`, bytes: 10, duration_s: 1 }))
    await denied(B.client.write('POST', 'clips?on_conflict=lineup_id', { lineup_id: ids.l1, team_id: ids.team, path: clip.path.replace(/[0-9a-f]{4}\.webm$/, '0000.webm'), bytes: 17 * 2 ** 20, duration_s: 1 }))
    await denied(B.client.upload(`${ids.team}/img/${'0'.repeat(40)}.webp`, new Blob(['hello']), 'text/plain'))
    expect((await A.store.storage()).bytes).toBe(webm.length)
    ids.clip = clip.path
  })

  it('6. Offline-Änderung kommt nach Wiederverbindung an', async () => {
    B.setOffline(true)
    const l = b().lineups.find(x => x.id === ids.l1)!
    const p = B.store.saveLineup({ ...l, title: 'zz offline edit' })
    await p // bleibt in der Schlange, kein Fehler
    expect(b().online).toBe(false)
    expect(b().lineups.find(x => x.id === ids.l1)?.title).toBe('zz offline edit') // sofort sichtbar
    B.setOffline(false)
    await B.store.sync()
    expect(b().online).toBe(true)
    await A.store.sync()
    expect(a().lineups.find(x => x.id === ids.l1)?.title).toBe('zz offline edit')
    writeFileSync(IDS, JSON.stringify(ids, null, 1))
  })
})

// nach dem Clip-Selbsttest der App als B (#utility/de_dust2/lineup/<l1>/clip): A sieht den neuen Clip, der alte ist weg, Speicher stimmt
describe.skipIf(PHASE !== 'clip')('echtes Supabase: Clip aus der App', { timeout: 60_000 }, () => {
  it('A lädt den ersetzten Clip, Speicher = neuer Clip', async () => {
    const ids = JSON.parse(readFileSync(IDS, 'utf8')) as Record<string, string>, A = user('a')
    await A.store.ready; await A.store.sync()
    const c = A.store.state().clips[ids.l1]
    expect(c.path).not.toBe(ids.clip)
    const url = await A.store.clipUrl(c)
    expect(url).toMatch(/^blob:/)
    expect(A.mem.get(c.path.split('/').pop()!)?.length).toBe(c.bytes)
    expect(await A.store.storage()).toEqual({ bytes: c.bytes, limit: 800 * 2 ** 20 })
    await expect(A.client.download(ids.clip)).rejects.toThrow() // alte Datei gelöscht
    console.log('clip', c)
    await A.store.saveTeam({ ...A.store.state().team!, name: 'zz-test (bitte löschen)' }) // Admin benennt um
  })
})

describe.skipIf(PHASE !== 'cleanup')('echtes Supabase: aufräumen', { timeout: 120_000 }, () => {
  it('alles weich löschen, Clip-Dateien weg, beide verlassen das Team', async () => {
    const A = user('a'), B = user('b')
    await Promise.all([A.store.ready, B.store.ready])
    await A.store.sync()
    const s = A.store.state()
    if (!s.team) return
    for (const l of s.lineups.filter(x => !x.deleted)) await A.store.saveLineup({ ...l, deleted: true })
    for (const st of s.strats.filter(x => !x.deleted)) await A.store.saveStrat({ ...st, deleted: true })
    for (const n of s.notes.filter(x => !x.deleted)) await A.store.saveNote({ ...n, deleted: true })
    await A.store.saveTeam({ ...A.store.state().team!, focus: undefined, mapPool: [] })
    await A.store.sync()
    expect(A.store.state().clips).toEqual({})
    expect((await A.store.storage()).bytes).toBe(0)
    await B.store.leave()
    await A.store.leave()
    expect(A.store.state().team).toBeUndefined()
  })
})
