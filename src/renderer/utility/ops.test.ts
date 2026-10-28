// Utility-Änderungen (ops.ts): eigene Reihenfolge per Ziehen, Duplizieren, weiches Löschen, eigene Techniken
import { describe, expect, it } from 'vitest'
import type { Lineup, UtilityLibrary } from '../../shared/utility'
import { emptyLibrary } from '../../shared/utility-lib'
import { beforeOf } from './cards'
import { addTechnique, deleteLineup, duplicateLineup, moveId, moveLineup } from './ops'

const L = (id: string): Lineup => ({ id, map: 'de_nuke', type: 'smoke', side: 'CT', title: id, stand: { x: 0, y: 0 }, target: { x: 1, y: 1 }, technique: [], steps: [], images: [], tags: [], owner: 'local', createdAt: 1, updatedAt: 1 })
const lib = (...ids: string[]): UtilityLibrary => ({ ...emptyLibrary(), lineups: ids.map(L) })
const order = (l: UtilityLibrary) => l.lineups.map(x => x.id).join('')

describe('Reihenfolge', () => {
  it('nach unten gezogen landet hinter dem Ziel, nach oben davor', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(order(moveLineup(lib(...ids), 'a', beforeOf(ids, 'a', 'c')))).toBe('bcad')
    expect(order(moveLineup(lib(...ids), 'd', beforeOf(ids, 'd', 'b')))).toBe('adbc')
    expect(order(moveLineup(lib(...ids), 'a', beforeOf(ids, 'a', 'd')))).toBe('bcda') // hinter das letzte
    expect(moveId(ids, 'c', 'a')).toEqual(['c', 'a', 'b', 'd'])
  })
  it('gefilterte Ansicht: Nachbar außerhalb des Filters bleibt an seinem Platz', () => {
    expect(order(moveLineup(lib('a', 'x', 'b', 'c'), 'c', 'b'))).toBe('axcb')
  })
})

describe('Duplizieren und Löschen', () => {
  it('Kopie direkt hinter dem Original, neue ID, kein Favorit', () => {
    const src = lib('a', 'b')
    src.lineups[0].favorite = true
    const r = duplicateLineup(src, 'a')
    expect(r.lib.lineups.map(l => l.title)).toEqual(['a', 'a (copy)', 'b'])
    expect(r.id).not.toBe('a')
    expect(r.lib.lineups[1].favorite).toBe(false)
  })
  it('Löschen ist weich', () => expect(deleteLineup(lib('a'), 'a').lineups[0].deleted).toBe(true))
  it('eigene Technik: stabile ID, kein Doppel', () => {
    const r = addTechnique(emptyLibrary(), 'Crouch + Jumpthrow')
    expect(r.id).toBe('custom-crouch-jumpthrow')
    expect(addTechnique(r.lib, 'crouch + jumpthrow').lib.techniques).toHaveLength(1)
    expect(addTechnique(emptyLibrary(), ' w + jumpthrow')).toMatchObject({ id: 'wjumpthrow', lib: { techniques: [] } })
  })
})
