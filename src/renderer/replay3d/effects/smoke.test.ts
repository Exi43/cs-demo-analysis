import { describe, expect, it } from 'vitest'
import { heInner, heRefill } from './smoke'

// HE-Loch nach CS2 smoke_volume: zu bei der Detonation, nach ~0.2 s offen (200 u), Nachfüllen 0.5 → 5 s
describe('HE-Loch in der Smoke', () => {
  it('öffnet sich mit der Druckwelle', () => {
    expect(heInner(0)).toBeCloseTo(-50)
    expect(heInner(0.1)).toBeGreaterThan(90)
    expect(heInner(0.2)).toBeGreaterThan(190)
    expect(heInner(0.3)).toBeGreaterThan(199)
  })
  it('füllt sich gleichmäßig von 0.5 bis 5 s', () => {
    expect(heRefill(0.5)).toBe(0)
    expect(heRefill(2)).toBeLessThan(0.1)
    expect(heRefill(3.2)).toBeGreaterThan(0.4)
    expect(heRefill(5)).toBe(1)
    for (let t = 0.5; t < 5; t += 0.25) expect(heRefill(t + 0.25)).toBeGreaterThanOrEqual(heRefill(t))
  })
})
