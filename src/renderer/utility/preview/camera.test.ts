// Kamera-Ablauf der Lineup-Vorschau (camera.ts): Phase je Tick, Zoom nur vor dem Wurf, Außenansicht kreist von oben um die Wirkung.
import { describe, expect, it } from 'vitest'
import { ORBIT_DIST, OUT_S, orbitView, phaseAt, zoomAt } from './camera'

describe('phaseAt / zoomAt', () => {
  it('Ego vor dem Wurf, dann Granate folgen, ab der Wirkung Außenansicht; ohne Folgen immer Ego', () => {
    expect([99, 100, 150, 200, 300].map(t => phaseAt(t, 100, 200, true))).toEqual([0, 1, 1, 2, 2])
    expect([99, 150, 300].map(t => phaseAt(t, 100, 200, false))).toEqual([0, 0, 0])
  })
  it('Zoom bis zum Wurf, in 0,3 s zurück auf 1', () => {
    expect(zoomAt(50, 100, 4, 64)).toBe(4)
    expect(zoomAt(100, 100, 4, 64)).toBe(4)
    expect(zoomAt(100 + 0.15 * 64, 100, 4, 64)).toBeCloseTo(2.5)
    expect(zoomAt(100 + 0.3 * 64, 100, 4, 64)).toBe(1)
  })
})

describe('orbitView', () => {
  it('eine Runde in OUT_S ab der Wirkung, Start hinter dem Werfer', () => {
    const { orbit: o } = orbitView([1000, 0, 0], [0, 0, 64], 500)
    expect(o).toMatchObject({ dist: ORBIT_DIST, turnS: OUT_S, t0: 500, center: [1000, 0, 64] })
    expect(Math.abs(o.yaw0)).toBeCloseTo(180) // Werfer liegt in −x vom Ziel
  })
})
