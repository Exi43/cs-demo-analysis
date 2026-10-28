// Startpaket-Bündelung (utility-pack.ts): wiederkehrende Würfe → ein Lineup, Einzelwürfe/ein Spieler/wackelige Technik fallen raus.
import { describe, expect, it } from 'vitest'
import { parseLibrary } from './utility-lib'
import { clusterThrows, packLineups, packTechnique, type PackThrow } from './utility-pack'

let n = 0
/** Wurf auf de_mirage: Stand T spawn → Ziel, dx verschiebt den Stand, tech = Technik aus techniqueAt */
function t(o: { player?: string; match?: string; dx?: number; tech?: string[]; yaw?: number; type?: PackThrow['type']; sec?: number; plantSec?: number } = {}): PackThrow {
  const stand = { x: 1136 + (o.dx ?? 0), y: -1160, z: -160 }, target = { x: -380, y: -1330, z: -168 }, type = o.type ?? 'smoke'
  return {
    matchId: o.match ?? 'm1', tick: ++n, steamid: o.player ?? 'p1', player: o.player ?? 'p1', round: 1, map: 'de_mirage', type, side: 'T', similar: 0,
    sec: o.sec ?? 10, plantSec: o.plantSec,
    lineup: { map: 'de_mirage', type, side: 'T', title: '', stand, target, aim: { pitch: -30, yaw: o.yaw ?? 180 }, technique: o.tech ?? ['stand', 'jump', 'left'], steps: [], images: [], tags: [] },
  }
}

describe('utility-pack', () => {
  it('Technik: Sprung im Stand = jumpthrow, mit Anlauf = wjumpthrow', () => {
    expect(packTechnique(['jump', 'left'])).toEqual(['jumpthrow', 'left'])
    expect(packTechnique(['run', 'jump', 'left'])).toEqual(['wjumpthrow', 'left'])
    expect(packTechnique(['stand', 'right'])).toEqual(['stand', 'right'])
  })

  it('bündelt nahe Würfe, anderer Blick = eigenes Bündel', () => {
    const c = clusterThrows([t(), t({ dx: 20 }), t({ dx: -20 }), t({ yaw: 150 })])
    expect(c.map(x => x.length).sort()).toEqual([1, 3])
  })

  it('Paket: nur wiederkehrend über Spieler/Matches mit stabiler Technik; Titel, Beschreibung, Tags, gültig', () => {
    const good = [t({ player: 'a' }), t({ player: 'b', match: 'm2', dx: 10 }), t({ player: 'c', match: 'm2', dx: -10, plantSec: 20 }), t({ player: 'a', match: 'm3', tech: ['stand', 'left'] })]
    const onePlayer = [1, 2, 3, 4].map(i => t({ match: `m${i}`, yaw: 90, type: 'flash' }))
    const shaky = [t({ player: 'a', yaw: 0, type: 'molotov', tech: ['run', 'left'] }), t({ player: 'b', match: 'm2', yaw: 0, type: 'molotov', tech: ['stand', 'left'] }), t({ player: 'c', match: 'm3', yaw: 0, type: 'molotov', tech: ['walk', 'right'] })]
    const out = packLineups([...good, ...onePlayer, ...shaky], 5)
    expect(out).toHaveLength(1)
    const l = out[0]
    expect(l).toMatchObject({ type: 'smoke', side: 'T', technique: ['jumpthrow', 'left'], tags: ['pro', 'default'], owner: 'local', images: [], createdAt: 5 })
    expect(l.stand).toEqual(good[0].lineup.stand) // Repräsentant = Median-Wurf, Werte exakt aus der Demo
    expect(l.title).toMatch(/smoke from /)
    expect(l.description).toMatch(/thrown 4× by 3 pro players$/)
    expect(l.steps).toContain('Jumpthrow with left click')
    expect(l.demo).toBeUndefined()
    expect(packLineups([...good, ...onePlayer, ...shaky], 6)[0].id).toBe(l.id) // stabile ID
    expect(() => parseLibrary({ version: 1, lineups: out, tags: [], playbooks: [] })).not.toThrow()
  })
})
