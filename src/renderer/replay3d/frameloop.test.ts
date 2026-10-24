// Abnahme Bildtakt (frameloop.ts) mit falscher rAF-Uhr: Bildlimit, Fokus, Pause ohne Bilder, dirty, HUD- und Statistik-Takt.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFrameLoop, type FrameLoop } from './frameloop'
import { setOptions } from './options'

let loop: FrameLoop | undefined
afterEach(() => { loop?.stop(); vi.unstubAllGlobals(); setOptions({ fpsCap: 60, fpsCapUnfocused: 30 }) })

/** Monitor mit hz Bildern/s; dirty wie engine.dirty(): bleibt gesetzt, bis ein Bild gezeichnet ist */
function setup(hz: number) {
  let cbs: ((t: number) => void)[] = [], t = 1000, focused = true, dirty = false
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => cbs.push(cb))
  vi.stubGlobal('cancelAnimationFrame', () => { cbs = [] })
  vi.stubGlobal('document', { hasFocus: () => focused })
  const n = { step: 0, hud: 0, stats: [] as number[], dt: [] as number[] }
  loop = createFrameLoop({
    step: (_now, dt) => { n.step++; n.dt.push(dt); dirty = false },
    wantsFrame: () => dirty,
    onHud: () => n.hud++,
    onStats: fps => n.stats.push(fps),
  })
  return {
    n, loop,
    /** ms Uhrzeit vorlaufen lassen, je rAF alle Callbacks */
    run(ms: number) { for (const end = t + ms - 1e-6; t < end;) { t += 1000 / hz; const c = cbs; cbs = []; for (const f of c) f(t) } },
    reset() { Object.assign(n, { step: 0, hud: 0, stats: [], dt: [] }) },
    focus(on: boolean) { focused = on },
    dirty() { dirty = true },
  }
}

describe('frameloop', () => {
  it('240 Hz with cap 60 → 57-63 steps/s, dt ≈ 16.7 ms', () => {
    const c = setup(240)
    c.loop.setPlaying(true); c.run(500); c.reset(); c.run(2000)
    expect(c.n.step / 2).toBeGreaterThanOrEqual(57); expect(c.n.step / 2).toBeLessThanOrEqual(63)
    expect(c.n.dt.reduce((a, b) => a + b, 0) / c.n.dt.length).toBeCloseTo(1000 / 60, 0)
  })

  it('144 Hz with cap 60 still averages 60; cap 0 = every rAF', () => {
    const c = setup(144)
    c.loop.setPlaying(true); c.run(500); c.reset(); c.run(2000)
    expect(c.n.step / 2).toBeGreaterThanOrEqual(57); expect(c.n.step / 2).toBeLessThanOrEqual(63)
    setOptions({ fpsCap: 0 }); c.run(100); c.reset(); c.run(1000)
    expect(c.n.step).toBe(144)
  })

  it('without window focus → fpsCapUnfocused (30)', () => {
    const c = setup(240)
    c.focus(false); c.loop.setPlaying(true); c.run(500); c.reset(); c.run(2000)
    expect(c.n.step / 2).toBeGreaterThanOrEqual(28); expect(c.n.step / 2).toBeLessThanOrEqual(32)
  })

  it('paused without dirty → no frames at all; dirty → the next rAF draws (dt 0)', () => {
    const c = setup(240)
    c.run(100); c.reset(); c.run(3000)
    expect(c.n.step).toBe(0)
    c.dirty(); c.run(1000 / 240)
    expect(c.n.step).toBe(1); expect(c.n.dt).toEqual([0])
    c.run(1000); expect(c.n.step).toBe(1)
  })

  it('jump / invalidate / option change draw once while paused', () => {
    const c = setup(240)
    c.run(100); c.reset()
    c.loop.jump(); c.run(1000 / 240); expect([c.n.step, c.n.hud]).toEqual([1, 1])
    c.run(100); c.loop.invalidate(); c.run(1000 / 240); expect([c.n.step, c.n.hud]).toEqual([2, 1])
    c.run(100); setOptions({ xray: true }); c.run(1000 / 240); expect(c.n.step).toBe(3)
    setOptions({ xray: false })
  })

  it('onHud ≤ 15/s while playing, none while paused; first dt after play is 0', () => {
    const c = setup(240)
    c.loop.setPlaying(true); c.run(1000 / 240); expect(c.n.dt[c.n.dt.length - 1]).toBe(0)
    c.run(500); c.reset(); c.run(2000)
    expect(c.n.hud).toBeLessThanOrEqual(30); expect(c.n.hud).toBeGreaterThanOrEqual(28)
    c.loop.setPlaying(false); c.run(100); c.reset(); c.run(2000)
    expect(c.n.hud).toBe(0)
  })

  it('onStats 2/s with measured fps, also while paused', () => {
    const c = setup(240)
    c.loop.setPlaying(true); c.run(1000); c.reset(); c.run(2000)
    expect(c.n.stats.length).toBe(4)
    for (const f of c.n.stats) expect(Math.abs(f - 60)).toBeLessThanOrEqual(3)
    c.loop.setPlaying(false); c.run(1000); c.reset(); c.run(2000)
    expect(c.n.stats).toEqual([0, 0, 0, 0])
  })
})
