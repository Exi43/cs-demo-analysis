// Schadens-Rot: Alter des jüngsten Treffers (nur HP-Schaden) und Blinken (Berat 22.10.: blinkt, nur einige Sekunden).
import { describe, expect, it } from 'vitest'
import { EV, type CS3D } from '../../../shared/cs3d'
import { DAMAGE_S, damagePulse, hitAge } from './xray'

const R = 64
const d = {
  header: { tickrate: R },
  // Spieler 3: Treffer 30 HP bei 1000, Rüstung ohne HP-Schaden bei 1100, Treffer bei 1200; Spieler 4 bei 1150
  evt: {
    tick: Uint32Array.from([1000, 1100, 1150, 1200]), type: Uint8Array.from([EV.player_hurt, EV.player_hurt, EV.player_hurt, EV.player_hurt]),
    player: Uint8Array.from([3, 3, 4, 3]), arg: Uint16Array.from([30, 512, 20, 25]),
  },
} as unknown as CS3D

describe('damage flash', () => {
  it('hitAge: newest hit of that player with HP damage, -1 before/after the window', () => {
    expect(hitAge(d, 3, 999)).toBe(-1)
    expect(hitAge(d, 3, 1100 + R / 2)).toBeCloseTo((100 + R / 2) / R) // 1100 ohne HP-Schaden zählt nicht
    expect(hitAge(d, 3, 1200)).toBe(0)
    expect(hitAge(d, 3, 1200 + DAMAGE_S * R)).toBe(-1)
    expect(hitAge(d, 4, 1200)).toBeCloseTo(50 / R)
  })
  it('damagePulse: full at the hit, blinks, gone after DAMAGE_S', () => {
    expect(damagePulse(-1)).toBe(0)
    expect(damagePulse(0)).toBeCloseTo(0.9)
    expect(damagePulse(0.2)).toBeLessThan(0.15) // halbe Periode: fast aus
    expect(damagePulse(0.4)).toBeCloseTo(0.9)
    expect(damagePulse(DAMAGE_S)).toBe(0)
  })
})
