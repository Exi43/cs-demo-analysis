// Abnahme Paket V: Optionen-Store (options.ts) und Tastenbelegung (hotkeys.ts). Module lesen Speicher/Hash beim Laden → je Test frisch importieren.
import { afterEach, describe, expect, it, vi } from 'vitest'

const OPT = 'csda.replay3d.options.v1', HK = 'csda.replay3d.hotkeys.v1'
function mem(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init))
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}
async function fresh(storage: unknown, hash = '') {
  vi.resetModules()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('location', { hash })
  return { ...(await import('./options')), ...(await import('./hotkeys')) }
}
const key = (code: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => ({ code, ctrlKey: false, shiftKey: false, altKey: false, ...mods })
const UI = ['scoreboard', 'teams', 'minimap', 'killfeed', 'panel', 'labels', 'crosshair'] as const
afterEach(() => vi.unstubAllGlobals())

describe('options', () => {
  it('defaults: keys, impacts, x-ray, grenade cam off; trails on; 60 fps; all UI shown', async () => {
    const o = await fresh(mem())
    expect(o.getOptions()).toMatchObject({ showKeys: false, impacts: false, xray: false, nadeTrails: true, nadeCam: false, fpsCap: 60, fpsCapBackground: 15, hideAll: false })
    expect(o.getOptions().ui.demobarAutoHide).toBe(false)
    for (const el of UI) expect(o.shown(el)).toBe(true)
  })

  it('missing or broken storage → defaults, writing never throws', async () => {
    const throwing = { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('QuotaExceeded') } }
    for (const s of [undefined, mem({ [OPT]: '{nope' }), mem({ [OPT]: 'null' }), throwing]) {
      const o = await fresh(s)
      expect(o.getOptions()).toEqual(o.DEFAULT_OPTIONS)
      expect(() => o.setOptions({ xray: true })).not.toThrow()
      expect(o.getOptions().xray).toBe(true)
    }
  })

  it('unknown keys and wrong values are ignored', async () => {
    const o = await fresh(mem({ [OPT]: JSON.stringify({ xray: 'yes', fpsCap: 45, volume: 3, foo: 1, impacts: true, ui: { minimap: false, bar: true } }) }))
    expect(o.getOptions()).toMatchObject({ xray: false, fpsCap: 60, volume: 0.8, impacts: true })
    expect('foo' in o.getOptions() || 'bar' in o.getOptions().ui).toBe(false)
    expect(o.shown('minimap')).toBe(false)
  })

  it('setOptions saves, notifies and survives a restart; hideAll hides everything', async () => {
    const s = mem()
    let o = await fresh(s)
    const seen: boolean[] = []
    const off = o.onOptions(x => seen.push(x.xray))
    o.setOptions({ xray: true, ui: { killfeed: false } })
    off()
    o.setOptions({ xray: false })
    expect(seen).toEqual([true])
    o.setOptions({ hideAll: true })
    for (const el of UI) expect(o.shown(el)).toBe(false)
    o = await fresh(s)
    expect(o.getOptions()).toMatchObject({ xray: false, hideAll: true, ui: { killfeed: false, minimap: true } })
  })

  it("hash segment 'xray,impacts' sets both for the session without saving", async () => {
    const s = mem()
    const o = await fresh(s, '#auto/replay3d/15/72.4/ego/0/xray,impacts')
    expect(o.getOptions()).toMatchObject({ xray: true, impacts: true })
    expect(s.m.size).toBe(0)
    o.setOptions({ voice: false })
    expect(JSON.parse(s.m.get(OPT)!)).toMatchObject({ voice: false, xray: false, impacts: false })
    expect(o.getOptions()).toMatchObject({ voice: false, xray: true, impacts: true })
    const p = await fresh(mem(), '#auto/replay3d/15/4/free/3/nadeCam,fpsCap=0,minimap=0,lowQuality')
    expect(p.getOptions()).toMatchObject({ nadeCam: true, fpsCap: 0, lowQuality: true })
    expect(p.shown('minimap')).toBe(false)
    expect((await fresh(mem(), '#auto/replay3d/15/4/free/3')).getOptions()).toEqual(p.DEFAULT_OPTIONS)
  })

  it("old 'damage' option (now part of X-Ray) is dropped from storage on the next save", async () => {
    const s = mem({ [OPT]: JSON.stringify({ damage: false, xray: true }) })
    const o = await fresh(s)
    expect(o.getOptions().xray).toBe(true)
    expect('damage' in o.getOptions()).toBe(false)
    o.setOptions({ volume: 0.5 })
    expect(JSON.parse(s.m.get(OPT)!)).not.toHaveProperty('damage')
  })
})

describe('hotkeys', () => {
  it('default map: unique actions, 0 conflicts', async () => {
    const h = await fresh(mem())
    expect(new Set(h.HOTKEYS.map(x => x.action)).size).toBe(h.HOTKEYS.length)
    expect(h.conflicts()).toEqual([])
  })

  it('same key on two actions → both reported; reset restores defaults', async () => {
    const s = mem()
    const h = await fresh(s)
    h.setHotkey('xray', 'KeyC')
    expect(h.conflicts()).toEqual([{ code: 'KeyC', actions: ['camToggle', 'xray'] }])
    expect((await fresh(s)).getHotkeys().xray).toBe('KeyC') // pro PC gespeichert
    h.resetHotkeys()
    expect(h.getHotkeys()).toEqual(h.DEFAULT_HOTKEYS)
    expect(h.conflicts()).toEqual([])
  })

  it('matchAction: Space = playPause, free-cam keys = null, Shift falls back, removed key = null', async () => {
    const h = await fresh(mem())
    expect(h.matchAction(key('Space'))).toBe('playPause')
    expect(h.matchAction(key('KeyW'))).toBeNull()
    expect(h.matchAction(key('ShiftLeft', { shiftKey: true }))).toBeNull()
    expect(h.matchAction(key('KeyX', { shiftKey: true }))).toBe('xray')
    expect(h.matchAction(key('KeyX', { ctrlKey: true }))).toBeNull()
    h.setHotkey('hideAll', 'Ctrl+KeyH')
    expect(h.matchAction(key('KeyH', { ctrlKey: true }))).toBe('hideAll')
    h.setHotkey('xray', null)
    expect(h.matchAction(key('KeyX'))).toBeNull()
    expect(h.comboOf(key('ShiftLeft', { shiftKey: true }))).toBe('ShiftLeft')
  })

  it('broken stored entries → default for that action', async () => {
    const h = await fresh(mem({ [HK]: JSON.stringify({ xray: 5, voice: 'Ctrl+KeyB', labels: null, nadeCam: 'x y' }) }))
    expect(h.getHotkeys()).toMatchObject({ xray: 'KeyX', voice: 'Ctrl+KeyB', labels: null, nadeCam: 'KeyG', playPause: 'Space' })
    expect((await fresh(mem({ [HK]: '{broken' }))).getHotkeys()).toEqual(h.DEFAULT_HOTKEYS)
  })
})
