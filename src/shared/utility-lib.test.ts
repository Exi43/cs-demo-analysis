// Utility-Bibliothek: Prüfung fremder Dateien, Export-Teilmenge, Abgleich beim Import (neu / doppelt / Konflikt) und Anwenden
import { describe, expect, it } from 'vitest'
import type { Lineup, UtilityLibrary } from './utility.ts'
import { applyImport, chooseAll, emptyLibrary, EXPORT_FORMAT, parseExport, parseLibrary, planImport, subsetLibrary } from './utility-lib.ts'

const L = (id: string, o: Partial<Lineup> = {}): Lineup => ({
  id, map: 'de_dust2', type: 'smoke', side: 'T', title: `Smoke ${id}`, stand: { x: 0, y: 0 }, target: { x: 1000, y: 1000 },
  technique: ['stand', 'left'], steps: [], images: [], tags: [], owner: 'local', createdAt: 1, updatedAt: 1, ...o,
})
const lib = (o: Partial<UtilityLibrary>): UtilityLibrary => ({ ...emptyLibrary(), ...o })
let n = 0
const ids = () => `new${++n}`

describe('parseLibrary', () => {
  it('nimmt gültige Daten, wirft unbekannte Felder weg', () => {
    const l = parseLibrary({ version: 1, lineups: [{ ...L('a'), hack: 1, video: { url: 'https://youtu.be/x', evil: 2 } }], tags: [], playbooks: [], techniques: [], extra: 1 })
    expect(l.lineups[0]).toEqual({ ...L('a'), video: { url: 'https://youtu.be/x' } })
    expect(l).not.toHaveProperty('extra')
  })
  it('kurze Beschreibung: optional, höchstens 200 Zeichen', () => {
    expect(parseLibrary({ ...lib({ lineups: [L('a', { description: 'Blocks window' })] }) }).lineups[0].description).toBe('Blocks window')
    expect(() => parseLibrary(lib({ lineups: [L('a', { description: 'x'.repeat(201) })] }))).toThrow(/description/)
  })
  it('lehnt falsche Werte mit Pfad ab', () => {
    const bad = (x: Partial<Lineup>) => () => parseLibrary(lib({ lineups: [L('a', x)] }))
    expect(bad({ type: 'nuke' as never })).toThrow('library.lineups[0].type')
    expect(bad({ sourceUrl: 'javascript:alert(1)' })).toThrow('library.lineups[0].sourceUrl')
    expect(bad({ video: { url: 'file:///C:/x.mp4' } })).toThrow('video.url')
    expect(bad({ video: { local: '../../evil.exe' } })).toThrow('video.local')
    expect(bad({ images: Array(7).fill('a'.repeat(40)) })).toThrow('images')
    expect(bad({ stand: { x: NaN, y: 0 } })).toThrow('stand.x')
    expect(bad({ id: '../x' })).toThrow('id')
    expect(() => parseLibrary(lib({ lineups: [L('a'), L('a')] }))).toThrow('duplicate id a')
    expect(() => parseLibrary({ ...lib({}), version: 2 })).toThrow('version')
    expect(() => parseLibrary(lib({ tags: [{ id: 't', name: 'x', color: 'red', updatedAt: 1 }] }))).toThrow('tags[0].color')
  })
})

describe('parseExport', () => {
  it('prüft Format und base64', () => {
    const f = { format: EXPORT_FORMAT, version: 1, exportedAt: 1, library: lib({}), images: { ['a'.repeat(40)]: 'AAAA' } }
    expect(parseExport(f, 100, 100).images).toEqual({ ['a'.repeat(40)]: 'AAAA' })
    expect(() => parseExport({ ...f, format: 'x' }, 100, 100)).toThrow('not a CS Demo Analysis utility file')
    expect(() => parseExport({ ...f, images: { ['a'.repeat(40)]: '<script>' } }, 100, 100)).toThrow('images')
    expect(() => parseExport({ ...f, images: { ['a'.repeat(40)]: 'A'.repeat(101) } }, 100, 100)).toThrow('images')
  })
})

describe('subsetLibrary', () => {
  it('nimmt nur Gewähltes, Tags in Gebrauch, ganze Playbooks; lokale Videos nur auf Wunsch', () => {
    const src = lib({
      lineups: [L('a', { tags: ['t1'], video: { local: `${'b'.repeat(40)}.mp4`, url: 'https://x.y' } }), L('b'), L('c', { deleted: true }), L('d', { technique: ['own'] })],
      tags: [{ id: 't1', name: 'Exec', color: '#ff0000', updatedAt: 1 }, { id: 't2', name: 'Unused', color: '#00ff00', updatedAt: 1 }],
      playbooks: [{ id: 'p1', name: 'A exec', lineupIds: ['a', 'c'], updatedAt: 1 }, { id: 'p2', name: 'Mix', lineupIds: ['a', 'b'], updatedAt: 1 }],
      techniques: [{ id: 'own', label: 'Own' }],
    })
    const s = subsetLibrary(src, ['a', 'c'], false)
    expect(s.lineups.map(l => l.id)).toEqual(['a'])
    expect(s.lineups[0].video).toEqual({ url: 'https://x.y' })
    expect(s.tags.map(t => t.id)).toEqual(['t1'])
    expect(s.playbooks).toEqual([{ id: 'p1', name: 'A exec', lineupIds: ['a'], updatedAt: 1 }]) // gelöschtes c fällt weg, p2 nur halb → nicht dabei
    expect(subsetLibrary(src, ['a'], true).lineups[0].video?.local).toBe(`${'b'.repeat(40)}.mp4`)
    expect(subsetLibrary(src, ['d'], false).techniques).toEqual([{ id: 'own', label: 'Own' }])
  })
})

describe('planImport', () => {
  const local = lib({
    lineups: [L('same'), L('changed'), L('pos', { stand: { x: 500, y: 500 }, target: { x: 2000, y: 2000 } }), L('gone', { deleted: true, stand: { x: -3000, y: 0 }, target: { x: -3000, y: 900 } }), L('twin', { title: 'Twin' })],
    tags: [{ id: 't1', name: 'Exec', color: '#ff0000', updatedAt: 1 }, { id: 't2', name: 'Retake', color: '#00ff00', updatedAt: 1 }],
    playbooks: [{ id: 'p1', name: 'A exec', lineupIds: ['same'], updatedAt: 1 }],
  })
  const incoming = lib({
    lineups: [
      L('same', { updatedAt: 99, favorite: true }), // nur Zeit/Favorit anders → doppelt
      L('changed', { title: 'Other title' }), // gleiche ID, anderer Inhalt
      L('pos2', { stand: { x: 510, y: 495 }, target: { x: 1990, y: 2012 }, title: 'Better pos' }), // gleiche Stelle → Konflikt
      L('gone', { stand: { x: -3000, y: 0 }, target: { x: -3000, y: 900 } }), // lokal gelöscht → neu
      L('copy', { title: 'Twin' }), // andere ID, gleicher Inhalt → doppelt
      L('fresh', { map: 'de_mirage' }),
    ],
    tags: [{ id: 'x1', name: 'exec', color: '#FF0000', updatedAt: 5 }, { id: 'x2', name: 'Retake', color: '#0000ff', updatedAt: 5 }, { id: 'x3', name: 'New', color: '#123456', updatedAt: 5 }],
    playbooks: [{ id: 'p1', name: 'A exec', lineupIds: ['same'], updatedAt: 9 }, { id: 'p9', name: 'A exec', lineupIds: ['fresh'], updatedAt: 9 }],
  })
  const plan = planImport(local, incoming)
  const st = (kind: string, id: string) => plan.find(i => i.kind === kind && i.id === id)

  it('erkennt neu, doppelt und Konflikt', () => {
    expect(st('lineup', 'same')).toMatchObject({ status: 'duplicate', localId: 'same', choice: 'skip' })
    expect(st('lineup', 'changed')).toMatchObject({ status: 'conflict', reason: 'Same ID, different content', choice: 'skip' })
    expect(st('lineup', 'pos2')).toMatchObject({ status: 'conflict', localId: 'pos' })
    expect(st('lineup', 'gone')).toMatchObject({ status: 'new', choice: 'add' })
    expect(st('lineup', 'copy')).toMatchObject({ status: 'duplicate', localId: 'twin' })
    expect(st('lineup', 'fresh')).toMatchObject({ status: 'new' })
    expect(st('tag', 'x1')).toMatchObject({ status: 'duplicate', localId: 't1' }) // Name ohne Groß/klein, Farbe ohne Groß/klein
    expect(st('tag', 'x2')).toMatchObject({ status: 'conflict', localId: 't2', reason: 'Same name, different color' })
    expect(st('tag', 'x3')).toMatchObject({ status: 'new' })
    expect(st('playbook', 'p1')).toMatchObject({ status: 'duplicate' })
    expect(st('playbook', 'p9')).toMatchObject({ status: 'conflict', localId: 'p1', reason: 'Same name, different content' })
  })

  it('wendet Entscheidungen an und schreibt IDs um', () => {
    let items = chooseAll(plan, 'conflict', 'both')
    items = items.map(i => (i.kind === 'lineup' && i.id === 'changed' ? { ...i, choice: 'replace' as const } : i))
    items = items.map(i => (i.kind === 'tag' && i.id === 'x2' ? { ...i, choice: 'replace' as const } : i))
    items = items.map(i => (i.kind === 'lineup' && i.id === 'fresh' ? { ...i, choice: 'skip' as const } : i))
    const withTags = { ...incoming, lineups: incoming.lineups.map(l => (l.id === 'pos2' ? { ...l, tags: ['x1', 'x2', 'x3'] } : l)) }
    const out = applyImport(local, withTags, items, 777, ids)
    const get = (id: string) => out.lineups.find(l => l.id === id)!

    expect(get('changed')).toMatchObject({ title: 'Other title', createdAt: 1, updatedAt: 777 }) // ersetzt, ID bleibt
    expect(out.lineups.filter(l => l.id === 'gone')).toHaveLength(1) // gelöscht → wieder da, nicht doppelt
    expect(get('gone')).toMatchObject({ updatedAt: 777 })
    expect(get('gone').deleted).toBeUndefined()
    expect(out.lineups.some(l => l.id === 'fresh')).toBe(false)
    const both = out.lineups.find(l => l.title === 'Better pos')!
    expect(both.id).toMatch(/^new/)
    expect(both.tags.sort()).toEqual(['t1', 't2', 'x3']) // doppelt → lokaler Tag, ersetzt → lokale ID, neu → eigene ID
    expect(out.tags.find(t => t.id === 't2')).toMatchObject({ color: '#0000ff', updatedAt: 777 })
    expect(out.tags.find(t => t.id === 'x3')).toMatchObject({ name: 'New' })
    // Playbook „beide behalten“: neue ID, Name markiert, übersprungenes Lineup fällt raus
    expect(out.playbooks.find(p => p.id !== 'p1')).toMatchObject({ name: 'A exec (imported)', lineupIds: [] })
    expect(local.lineups.find(l => l.id === 'changed')!.title).toBe('Smoke changed') // Eingabe unverändert
  })

  it('ersetzt ein Lineup ohne den lokalen Favoriten zu verlieren', () => {
    const loc = lib({ lineups: [L('a', { favorite: true })] })
    const inc = lib({ lineups: [L('a', { title: 'New', favorite: false })] })
    const out = applyImport(loc, inc, chooseAll(planImport(loc, inc), 'conflict', 'replace'), 5, ids)
    expect(out.lineups).toEqual([{ ...L('a', { title: 'New', favorite: true }), updatedAt: 5 }])
  })
})
