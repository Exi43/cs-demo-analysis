// Mini-Demo der Utility-Vorschau (synth.ts): Boden-Höhe aus dem Raster, angenäherte Flugbahn, Rundweg Lineup → CS3D → lineupFromThrow
// (Technik aus Tempo/Luft/Ducken, Stand, Blick, Ziel kommen unverändert zurück) und die Tasten der Technik.
import { describe, expect, it } from 'vitest'
import type { FloorGrid } from '../../../shared/assets3d'
import { BTN, isDown } from '../../../shared/cs3d'
import type { Lineup } from '../../../shared/utility'
import { lineupFromThrow } from '../../../shared/utility-capture'
import { approxPath, groundZ, lookAt, NADE_G, synthLineup } from './synth'

/** Raster 3×1 Zellen à 32 u ab (0, 0) mit Lagen je Zelle */
function grid(cells: number[][]): FloorGrid {
  const offs = new Uint32Array(cells.length + 1)
  cells.forEach((c, i) => (offs[i + 1] = offs[i] + c.length))
  return { cell: 32, minX: 0, minY: 0, W: cells.length, H: 1, surfaces: ['default'], offs, z: Int16Array.from(cells.flat()), sid: new Uint8Array(offs[cells.length]) }
}

describe('groundZ', () => {
  it('niedrigste Lage mit Kopffreiheit, oben auf ihrer Stufe; leere Zelle → Nachbar; außerhalb → undefined', () => {
    expect(groundZ(grid([[-32, 8, 180]]), 5, 5)).toBe(8) // -32 liegt 40 u unter 8: Map-Unterseite
    expect(groundZ(grid([[0, 8, 16, 200]]), 5, 5)).toBe(16) // Treppe: oben auf der Stufe
    expect(groundZ(grid([[29, 230, 416]]), 5, 5)).toBe(29) // Dächer darüber
    expect(groundZ(grid([[], [50]]), 5, 5)).toBe(50)
    expect(groundZ(grid([[1]]), -500, 5)).toBeUndefined()
  })
})

describe('approxPath', () => {
  const from = { x: 0, y: 0, z: 64 }, to = { x: 1200, y: 300, z: 10 }
  it('endet genau im Ziel, 32 Hz, Bogen über Start und Ziel; steilerer Blick = höherer Bogen', () => {
    const p = approxPath(from, to, 500, { pitch: -20 }, 1), [, x, y, z] = p[p.length - 1]
    expect(p[0]).toEqual([500, 0, 0, 64])
    expect([x, y]).toEqual([1200, 300])
    expect(z).toBeCloseTo(10, 6)
    expect(p.slice(1).every((q, i) => q[0] - p[i][0] === 2)).toBe(true)
    const top = (q: typeof p) => Math.max(...q.map(x => x[3]))
    expect(top(p)).toBeGreaterThan(64)
    expect(top(approxPath(from, to, 500, { pitch: -45 }, 1))).toBeGreaterThan(top(p))
  })
  it('ohne Blick: flacher Wurf mit voller Stärke, Flugzeit passt zur Schwerkraft', () => {
    const p = approxPath(from, { x: 1000, y: 0, z: 64 }, 0, undefined, 1), T = p[p.length - 1][0] / 64
    // Wurfweite auf gleicher Höhe: D = v² sin(2θ) / g → T = 2 v sinθ / g
    const v = 675, th = Math.asin((NADE_G * 1000) / (v * v)) / 2
    expect(T).toBeCloseTo((2 * v * Math.sin(th)) / NADE_G, 1)
  })
})

describe('synthLineup', () => {
  const base: Lineup = {
    id: 'x', map: 'de_test', type: 'smoke', side: 'T', title: 'Test', stand: { x: 100, y: 200, z: 30 }, target: { x: 1500, y: 900, z: 0 },
    aim: { pitch: -25, yaw: 30 }, technique: [], steps: [], images: [], tags: [], owner: 'local', createdAt: 0, updatedAt: 0,
  }
  it.each([[['stand', 'left']], [['run', 'left']], [['walk', 'right']], [['crouch', 'both']], [['jump', 'left']], [['run', 'jump', 'left']]])(
    'Rundweg %j: Technik (ohne Taste), Stand, Blick und Ziel', tech => {
      const s = synthLineup({ ...base, technique: tech }, null)
      const c = lineupFromThrow(s.data.d, 0, 'x', 'T')!
      expect(c.tick).toBe(s.throwTick)
      expect(c.lineup.technique.filter(t => !['left', 'right', 'both'].includes(t))).toEqual(tech.filter(t => t !== 'left' && t !== 'right' && t !== 'both'))
      expect(c.lineup.stand).toEqual({ x: 100, y: 200, z: 30 })
      expect(c.lineup.aim).toEqual({ pitch: -25, yaw: 30 })
      expect(c.lineup.target).toEqual({ x: 1500, y: 900, z: 0 })
      expect(s.from).toBeLessThan(s.throwTick)
      expect(s.to).toBeGreaterThan(s.data.d.nade.detTick[0])
    })

  it('W + Jumpthrow = Anlauf mit W und Sprung', () => {
    const s = synthLineup({ ...base, technique: ['wjumpthrow', 'left'] }, null)
    expect(lineupFromThrow(s.data.d, 0, 'x', 'T')!.lineup.technique.filter(t => !['left', 'right', 'both'].includes(t))).toEqual(['run', 'jump'])
  })

  it('Tasten: Pin bis zum Loslassen, Jumpthrow = Space im selben Frame, Ducken, Laufen mit W; Granate 2 Frames danach', () => {
    const s = synthLineup({ ...base, technique: ['run', 'crouch', 'jump', 'right'] }, null), d = s.data.d
    const at = (tick: number) => { const i = Math.floor((tick - d.header.rounds[0].firstTick) / 4); return (b: number) => isDown(d.btnLo[i], d.btnHi[i], b) }
    const before = at(s.throwTick - 12), rel = at(s.throwTick - 8), early = at(s.from + 8)
    expect([before(BTN.ATTACK2), before(BTN.ATTACK), before(BTN.JUMP), before(BTN.DUCK), before(BTN.FORWARD)]).toEqual([true, false, false, true, true])
    expect([rel(BTN.ATTACK2), rel(BTN.JUMP)]).toEqual([false, true])
    expect(early(BTN.ATTACK2) || early(BTN.FORWARD)).toBe(false)
  })

  it('ohne Höhen und ohne Blick: z aus dem Raster, Blick aufs Ziel, Ziel-Markierung am Boden', () => {
    const g: FloorGrid = { ...grid([[]]), W: 64, H: 32 }
    const offs = new Uint32Array(64 * 32 + 1).fill(0), z: number[] = []
    for (let c = 0; c < 64 * 32; c++) { z.push(c % 64 < 10 ? 40 : 0); offs[c + 1] = z.length } // links 40 u höher
    Object.assign(g, { offs, z: Int16Array.from(z), sid: new Uint8Array(z.length) })
    const s = synthLineup({ ...base, stand: { x: 100, y: 200 }, target: { x: 1500, y: 900 }, aim: undefined, technique: ['stand'] }, g)
    expect(s.marks.target).toEqual([1500, 900, 0])
    const c = lineupFromThrow(s.data.d, 0, 'x', 'T')!
    expect(c.lineup.stand.z).toBe(40)
    const look = lookAt({ x: 100, y: 200, z: 104 }, { x: 1500, y: 900, z: 0 })
    expect(c.lineup.aim!.yaw).toBeCloseTo(look.yaw, 1)
    expect(c.lineup.aim!.pitch).toBeCloseTo(look.pitch, 1)
  })
})
