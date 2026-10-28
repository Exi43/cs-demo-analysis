// Kamera-Ablauf der Lineup-Vorschau (camera.ts): Phase je Tick, Zoom nur vor dem Wurf, Außenansicht kreist von oben um die Wirkung.
import { describe, expect, it } from 'vitest'
import { ORBIT_DIST, OUT_S, marksAt, orbitView, phaseAt, zoomAt } from './camera'

describe('phaseAt / zoomAt', () => {
  it('Ego vor dem Wurf, dann Granate folgen, ab der Wirkung Außenansicht; ohne Folgen immer Ego', () => {
    expect([99, 100, 150, 200, 300].map(t => phaseAt(t, 100, 200, true))).toEqual([0, 1, 1, 2, 2])
    expect([99, 150, 300].map(t => phaseAt(t, 100, 200, false))).toEqual([0, 0, 0])
  })
  it('Folgen erst nach der Wurfbewegung (followAt), kurzer Flug direkt Außenansicht', () => {
    expect([99, 110, 120, 199, 200].map(t => phaseAt(t, 120, 200, true))).toEqual([0, 0, 1, 1, 2])
    expect(phaseAt(115, 120, 110, true)).toBe(2)
  })
  it('Flugbahn erst ab dem Wurf (vorher nur das Ziel), beim Folgen keine; echte Bahn nur außen', () => {
    expect([99, 110, 150, 200].map(t => marksAt(phaseAt(t, 120, 200, true), t, 100, true, true))).toEqual([1, 1, 0, 2])
    expect([99, 100, 300].map(t => marksAt(phaseAt(t, 120, 200, false), t, 100, true, false))).toEqual([1, 2, 2])
    expect([99, 150, 200].map(t => marksAt(phaseAt(t, 120, 200, true), t, 100, false, true))).toEqual([0, 0, 2])
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
