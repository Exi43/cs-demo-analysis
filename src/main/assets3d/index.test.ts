// Asset-Bau-Schlange (index.ts): Source 2 Viewer nur einmal laden, Vordergrund hält einen fremden Hintergrund-Bau an (zurück in die
// Schlange), wartet die Vorschau auf den laufenden Hintergrund-Bau selbst, wird er nur hochgeschaltet. utilityProcess ist ein Fake.
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

interface Child extends EventEmitter { msg?: any; got: any[]; killed: boolean; postMessage(m: any): void; kill(): void; stdout: EventEmitter; stderr: EventEmitter }
const children: Child[] = []
let vrfCalls = 0, vrfDone!: () => void
vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\csda-test', on: () => {} },
  net: { fetch: () => {} },
  utilityProcess: {
    fork: () => {
      const c = Object.assign(new EventEmitter(), { got: [] as any[], killed: false, stdout: new EventEmitter(), stderr: new EventEmitter() }) as Child
      c.postMessage = m => { c.msg ??= m; c.got.push(m) }
      c.kill = () => { c.killed = true }
      children.push(c)
      return c
    },
  },
}))
vi.mock('../game.ts', () => ({ gameRunning: async () => false }))
vi.mock('../log.ts', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('./texpack.ts', () => ({ texPackResponse: () => null }))
vi.mock('./cs2.ts', () => ({ findCS2: () => ({ patch: '1' }), ensureVrf: () => { vrfCalls++; return new Promise<string>(r => { vrfDone = () => r('vrf.exe') }) } }))
const { prepareMap, vrfReady } = await import('./index.ts')

const flush = () => new Promise(r => setTimeout(r, 20))
const done = (c: Child) => c.emit('message', { type: 'done', assets: { map: c.msg.map } })

describe('Asset-Bau-Schlange', () => {
  it('lädt VRF einmal für alle, Vordergrund hält fremden Hintergrund-Bau an, eigener wird nur hochgeschaltet', async () => {
    const hud = vrfReady(), a = prepareMap('de_a', true)
    await flush()
    expect(vrfCalls).toBe(1)
    vrfDone(); await hud; await flush()
    expect(children.map(c => [c.msg.map, c.msg.bg])).toEqual([['de_a', true]])

    // Vorschau wartet auf de_b: de_a hält an, de_b baut im Vordergrund, danach de_a weiter
    const b = prepareMap('de_b')
    await flush()
    expect(children[0].killed).toBe(true)
    expect(children.map(c => [c.msg.map, c.msg.bg])).toEqual([['de_a', true], ['de_b', false]])
    done(children[1]); await expect(b).resolves.toEqual({ map: 'de_b' }); await flush()
    expect(children[2].msg).toMatchObject({ map: 'de_a', bg: true })

    // Vorschau wartet auf de_a selbst: kein Abbruch, nur boost
    void prepareMap('de_a')
    await flush()
    expect(children[2].killed).toBe(false)
    expect(children[2].got).toContainEqual({ boost: true })
    done(children[2]); await expect(a).resolves.toEqual({ map: 'de_a' })
    expect(vrfCalls).toBe(1)
  })
})
