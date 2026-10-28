// Kamera der Lineup-Bilder (views.ts): Augenhöhe, Richtung wie CS, Positions-Kamera hinter dem Werfer und nie hinter einer Wand
import { describe, expect, it } from 'vitest'
import { along, feetEye, posCamera } from './views'

type V3 = [number, number, number]

describe('capture views', () => {
  it('Auge: z aus dem Lineup, ohne z und ohne Raster 0; geduckt 46 statt 64', () => {
    expect(feetEye({ stand: { x: 1, y: 2, z: -160 }, technique: ['stand'] }, null)).toEqual({ feet: [1, 2, -160], eye: [1, 2, -96] })
    expect(feetEye({ stand: { x: 1, y: 2 }, technique: ['crouch', 'left'] }, null).eye).toEqual([1, 2, 46])
  })

  it('Richtung: yaw 90 = +y, pitch + = nach unten', () => {
    const p = along([0, 0, 64], 30, 90, 100)
    expect(p[0]).toBeCloseTo(0)
    expect(p[1]).toBeCloseTo(100 * Math.cos(Math.PI / 6))
    expect(p[2]).toBeCloseTo(14)
  })

  it('Position: frei = genau hinter dem Werfer, weit und flach; Wand hinter ihm = andere Richtung; alles zu = vor dem Treffer', () => {
    const open = posCamera([0, 0, 64], 0, () => Infinity)
    expect(open.look).toEqual([0, 0, 48])
    expect(open.pos[0]).toBeCloseTo(-260 * Math.cos(Math.PI / 6)) // Blick nach +x → Kamera bei −x
    expect(open.pos[1]).toBeCloseTo(0)
    expect(open.pos[2]).toBeCloseTo(48 + 130)
    // Wand bei x = −50 (hinter dem Werfer): Strahlen nach −x treffen sie
    const wall = (a: V3, b: V3) => (b[0] < -50 ? ((a[0] + 50) / (a[0] - b[0])) * Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) : Infinity)
    const side = posCamera([0, 0, 64], 0, wall)
    expect(side.pos[0]).toBeGreaterThanOrEqual(-50)
    expect(open.behind && side.behind).toBe(true)
    expect(posCamera([0, 0, 64], 0, (a, b) => (b[0] > 0 ? Infinity : 10)).behind).toBe(false) // nur davor frei (Ecke im Rücken)
    const shut = posCamera([0, 0, 64], 0, () => 100) // überall nach 100 u eine Wand
    expect(Math.hypot(shut.pos[0], shut.pos[1], shut.pos[2] - 48)).toBeCloseTo(84)
  })
})
