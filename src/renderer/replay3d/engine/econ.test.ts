import { describe, expect, it } from 'vitest'
import { charmPos, stickerParams } from './econ'

const space = { u: [], v: [], s: [], mask: '', slots: [{ x: 0.148, y: -0.434, scale: 14.1, rot: 0 }, { x: 0.061, y: -0.434, scale: 14.1, rot: 0.25 }] }

describe('econ (Renderer)', () => {
  it('Platz: Markup des Platzes, mit Versatz relativ zu Markup[schema]; Drehung Grad → Umdrehungen', () => {
    const [a, wa] = stickerParams({ slot: 1, id: 1, wear: 0.3 }, space, [0.4, -0.3], 0.75, true)
    expect(a.toArray()).toEqual([0.061, -0.434, 14.1, 0.25])
    expect(wa.toArray()).toEqual([0.3, 0.4, -0.3, 0.75])
    const [b, wb] = stickerParams({ slot: 0, id: 1, x: -0.05, y: 0.01, schema: 1, rot: 90 }, space, [1, 1], 1, false)
    expect(b.toArray().map(v => +v.toFixed(4))).toEqual([0.011, -0.424, 14.1, 0.5])
    expect(wb.w).toBe(-1) // kein Papier-Rücken
  })
  it('Anhänger-Ort: Zoll (Source) → glTF-Meter (y, z, x)', () => {
    expect(charmPos({ id: 1, x: 9.847, y: 0.5787, z: 4.182 })!.toArray().map(v => +v.toFixed(4))).toEqual([0.0147, 0.1062, 0.2501])
    expect(charmPos({ id: 1 })).toBeNull()
  })
})
