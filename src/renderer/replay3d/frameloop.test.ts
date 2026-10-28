// Abnahme Bildtakt (frameloop.ts) mit falscher rAF-Uhr: Bildlimit, Fokus, Pause ohne Bilder und ohne rAF, dirty/wake, Minimieren,
// HUD- und Statistik-Takt.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFrameLoop, setWindowShown, type FrameLoop } from './frameloop'
import { setOptions } from './options'

let loop: FrameLoop | undefined
afterEach(() => { loop?.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); setWindowShown(true); setOptions({ fpsCap: 60, fpsCapBackground: 15 }) })

/** Monitor mit hz Bildern/s; dirty wie engine.dirty(): bleibt gesetzt, bis ein Bild gezeichnet ist, und weckt den Takt (Engine.onDirty) */
function setup(hz: number) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] })
  let cbs: ((t: number) => void)[] = [], t = performance.now(), focused = true, dirty = false
  const n = { step: 0, hud: 0, raf: 0, stats: [] as number[], dt: [] as number[] }
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { n.raf++; return cbs.push(cb) })
  vi.stubGlobal('cancelAnimationFrame', () => { cbs = [] })
  vi.stubGlobal('document', { hasFocus: () => focused })
  loop = createFrameLoop({
    step: (_now, dt) => { n.step++; n.dt.push(dt); dirty = false },
    wantsFrame: () => dirty,
    onHud: () => n.hud++,
    onStats: fps => n.stats.push(fps),
  })
  return {
    n, loop,
    /** ms Uhrzeit vorlaufen lassen, je rAF alle Callbacks */
    run(ms: number) { for (const end = t + ms - 1e-6; t < end;) { t += 1000 / hz; vi.advanceTimersByTime(1000 / hz); const c = cbs; cbs = []; for (const f of c) f(t) } },
    reset() { Object.assign(n, { step: 0, hud: 0, raf: 0, stats: [], dt: [] }) },
    focus(on: boolean) { focused = on },
    dirty() { dirty = true; loop!.wake() },
    /** wartende rAF-Callbacks (0 = Takt schläft) */
    waiting: () => cbs.length,
  }
}

describe('frameloop', () => {
  it('no idle rAF between capped frames (240 Hz, unfocused 15 fps → ~15 rAF/s, not 240)', () => {
    const c = setup(240)
    c.focus(false); c.loop.setPlaying(true); c.run(500); c.reset(); c.run(2000)
    expect(c.n.step / 2).toBeGreaterThanOrEqual(14); expect(c.n.raf / 2).toBeLessThanOrEqual(20)
  })
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

  it('without window focus → fpsCapBackground (15)', () => {
    const c = setup(240)
    c.focus(false); c.loop.setPlaying(true); c.run(500); c.reset(); c.run(2000)
    expect(c.n.step / 2).toBeGreaterThanOrEqual(14); expect(c.n.step / 2).toBeLessThanOrEqual(16)
  })

  it('paused without dirty → no frames and no rAF at all; dirty wakes it, the next rAF draws (dt 0)', () => {
    const c = setup(240)
    c.run(100); c.reset(); c.run(3000)
    expect(c.n.step).toBe(0); expect(c.waiting()).toBe(0)
    c.dirty(); c.run(1000 / 240)
    expect(c.n.step).toBe(1); expect(c.n.dt).toEqual([0])
    c.run(1000); expect(c.n.step).toBe(1); expect(c.waiting()).toBe(0)
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

  it('minimized → no frames and no rAF while playing; restored → continues without a clock jump', () => {
    const c = setup(240)
    c.loop.setPlaying(true); c.run(500)
    setWindowShown(false); c.run(1000 / 240); c.reset(); c.run(2000)
    expect(c.n.step).toBe(0); expect(c.waiting()).toBe(0)
    setWindowShown(true); c.run(1000)
    expect(c.n.dt[0]).toBe(0); expect(c.n.step).toBeGreaterThanOrEqual(58)
  })
})
