// Electron-Testseite für replay3d/engine (gebaut von engine-build.mjs, gesteuert von engine-main.cjs über window.step).
// Echte Assets aus prepare3d (cs3d://test/assets.json), Match + CS3D gzip (cs3d://test/match.json.gz, test.3d.bin.gz).
// Zeiten: tick direkt oder round (1-basiert) + sec ab Freeze-Ende wie der Selbsttest-Hash; Spieler per Name oder steamid.
// Optionen über setOptions (options.ts), Fehler der Seite sammelt 'errors'. Ergebnis-Bilder als PNG (Data-URL → engine-main).
// Posen-Modus (Paket B): load mit a.map (MapAssetManifest einer anderen Map, z. B. L-Testcache) + 'pose' (point_camera der CS2-Ladebilder:
// Source-origin/angles, vertikales FOV) zeigt nur die Map (Agenten, Schilder, Effekte aus) für den Vergleich mit dem Ladebild.
import { EV, FLAG, NADE, decode3d, newSample, roundAt, sampleTrack } from '../../src/shared/cs3d'
import type { Assets3D } from '../../src/shared/assets3d'
import type { MatchData } from '../../src/shared/model'
import type { Engine, LabelInfo, OverlayState, Replay3DData } from '../../src/renderer/replay3d/contracts'
import { createEngine } from '../../src/renderer/replay3d/engine'
import { hitAge } from '../../src/renderer/replay3d/engine/xray'
import { actionsOf } from '../../src/renderer/replay3d/actions'
import { getOptions, setOptions, type OptionsPatch } from '../../src/renderer/replay3d/options'
import { getHotkeys } from '../../src/renderer/replay3d/hotkeys'
import * as THREE from 'three'

const W = window as any
const raf = () => new Promise<number>(r => requestAnimationFrame(r))
const D2R = Math.PI / 180, HU = 0.0254

// ---- Fehler der Seite und neue GL-Programme (Shader-Bau beim Umschalten) zählen
const errors: string[] = []
const cerr = console.error.bind(console)
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ').slice(0, 300)); cerr(...a) }
addEventListener('error', e => errors.push(String(e.message)))
addEventListener('unhandledrejection', e => errors.push('rejection ' + String(e.reason)))
let programs = 0
const cp = WebGL2RenderingContext.prototype.createProgram
WebGL2RenderingContext.prototype.createProgram = function () { programs++; return cp.call(this) }
/** Namen der neuen Programme (three: '#define SHADER_NAME' im Vertex-Shader) für die Diagnose; names(seit) = Namen ab Programm Nr. seit */
const progNames: string[] = []
const ss = WebGL2RenderingContext.prototype.shaderSource
WebGL2RenderingContext.prototype.shaderSource = function (sh: WebGLShader, src: string) {
  if (/\bgl_Position\b/.test(src)) progNames.push(/#define SHADER_NAME (.*)/.exec(src)?.[1] ?? '?')
  return ss.call(this, sh, src)
}
const names = (since: number) => progNames.slice(progNames.length - (programs - since)).join(',')
/** Bild-Kopien (captureFrame → copyTexSubImage2D) und GL-Fehler danach */
const copies = { n: 0, errors: 0 }
const ct = WebGL2RenderingContext.prototype.copyTexSubImage2D
WebGL2RenderingContext.prototype.copyTexSubImage2D = function (...a: Parameters<typeof ct>) { ct.apply(this, a); copies.n++; if (this.getError()) copies.errors++ }

const gunzip = async (url: string) => new Response((await fetch(url)).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()

let engine: Engine | undefined, data: Replay3DData, assets: Assets3D, canvas: HTMLCanvasElement
const log: string[] = []
const P = () => data.d.header.players
/** Name (match.players), steamid oder Index (header.players, wie der Selbsttest-Hash) → steamid */
const sid = (x: string | number) => typeof x === 'number' ? P()[x].steamid : data.match.players.find(p => p.name === x)?.steamid ?? x
const pIdx = (x: string) => P().findIndex(p => p.steamid === sid(x))
const tickOf = (a: any): number => a.tick ?? data.match.rounds[a.round - 1].freezeEndTick + a.sec * 64

/** Pixel des gerade gerenderten Bildes (gleiche Aufgabe wie setTime, Puffer noch nicht getauscht) */
function pixels() {
  const gl = canvas.getContext('webgl2')!, w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, b = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b)
  return b
}
/** Anteil Pixel mit Abweichung > 8 in einem Kanal */
const diff = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return 1
  let n = 0
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 || Math.abs(a[i + 2] - b[i + 2]) > 8) n++
  return n / (a.length / 4)
}
/** Schadens-Rot (220/0/0, ausgeblendet dunkler) */
const reds = (b: Uint8Array) => { let n = 0; for (let i = 0; i < b.length; i += 4) if (b[i] > 90 && b[i + 1] < 25 && b[i + 2] < 25) n++; return n }

/** Füße (three) eines Spielers bei tick */
function feet(steamid: string, tick: number) {
  const d = data.d, p = P().findIndex(x => x.steamid === steamid), r = roundAt(d, tick), k = d.header.rounds[r].tracks.indexOf(p)
  const s = sampleTrack(d, r, k, tick, newSample())
  return { x: s.y * HU, y: s.z * HU, z: s.x * HU, yaw: s.yaw, alive: k >= 0 }
}
/** feste Kamera (über den Effekte-Wrapper nach dem Kamera-Update der Engine) */
function camAt(c: { pos: number[]; at: number[]; fov?: number } | undefined) { W.__cam = c }
/** Kamera auf eine Spielergruppe: von vorn-rechts (side) bzw. hinten, Blick auf die Körpermitte */
function groupCam(names: string[], tick: number, a: any) {
  const ps = names.map(n => feet(sid(n), tick)), c = new THREE.Vector3(), f = new THREE.Vector3()
  for (const p of ps) { c.add(new THREE.Vector3(p.x, p.y, p.z)); f.add(new THREE.Vector3(Math.sin(p.yaw * D2R), 0, Math.cos(p.yaw * D2R))) }
  c.divideScalar(ps.length); f.normalize()
  const right = new THREE.Vector3(-f.z, 0, f.x)
  camAt({
    pos: c.clone().addScaledVector(f, -(a.back ?? 4)).addScaledVector(right, a.side ?? 0).add(new THREE.Vector3(0, a.up ?? 1.6, 0)).toArray(),
    at: c.clone().add(new THREE.Vector3(0, a.lookUp ?? 1, 0)).addScaledVector(f, a.ahead ?? 0).toArray(), fov: a.fov,
  })
}
/** Bilder bis tick laufen lassen, dann nachgeladene Assets abwarten (dirty), bis 0.8 s ruhig */
async function settle(tick: number, n = 24) {
  for (let i = n; i >= 0; i--) { await raf(); engine!.setTime(tick - i * 2) }
  let quiet = performance.now()
  for (const end = performance.now() + 6000; performance.now() < end && performance.now() - quiet < 800;) {
    await raf()
    if (engine!.dirty()) { engine!.setTime(tick); quiet = performance.now() }
  }
  engine!.setTime(tick)
}

/** Test-Overlay wie Bild 2: AK, Flash + Smoke, Bombe beim ersten T, Defuse beim ersten CT; Icons aus dem HUD-Manifest */
async function testOverlay(): Promise<OverlayState> {
  const icons = new Map<string, CanvasImageSource>()
  const man = await fetch('cs3d://test/hud.json').then(r => r.ok ? r.json() : null).catch(() => null)
  for (const k of ['eq/ak47', 'eq/m4a1_silencer', 'eq/flashbang', 'eq/smokegrenade', 'eq/hegrenade', 'eq/c4', 'ui/defuser_white']) {
    const url = man?.icons?.[k]
    if (!url) continue
    const img = new Image(), src = URL.createObjectURL(new Blob([await (await fetch(url)).blob()], { type: 'image/svg+xml' }))
    img.src = src; await img.decode()
    icons.set(k, await createImageBitmap(img, { resizeWidth: Math.round(64 * img.naturalWidth / img.naturalHeight), resizeHeight: 64 }))
    URL.revokeObjectURL(src)
  }
  const labels: Record<string, LabelInfo> = {}
  let bomb = false, def = false
  data.match.rounds[0].tracks.forEach(t => {
    const T = t.side === 'T'
    labels[t.steamid] = { weapon: T ? 'eq/ak47' : 'eq/m4a1_silencer', utility: ['eq/flashbang', 'eq/smokegrenade'], bomb: T && !bomb, defusing: !T && !def }
    if (T) bomb = true; else def = true
  })
  return { labels, icons }
}

W.step = async (name: string, a: any = {}) => {
  if (a.opts) setOptions(a.opts as OptionsPatch)
  if (name === 'load') {
    const t0 = performance.now()
    const [m, buf, as] = await Promise.all([
      gunzip('cs3d://test/match.json.gz').then(b => JSON.parse(new TextDecoder().decode(b)) as MatchData),
      gunzip('cs3d://test/test.3d.bin.gz'), fetch('cs3d://test/assets.json').then(r => r.json() as Promise<Assets3D>),
    ])
    data = { match: m, d: decode3d(buf) }; assets = a.map ? { ...as, map: a.map } : as
    const tData = performance.now() - t0
    if (!canvas) { // zweiter load nutzt denselben Canvas (Kontext-Wiederherstellung nach dispose)
      canvas = document.createElement('canvas')
      document.body.appendChild(canvas)
    }
    const [cw, ch] = a.size ?? [1280, 720]
    canvas.style.cssText = `width:${cw}px;height:${ch}px;display:block`
    const t1 = performance.now(), seen = new Set<string>()
    engine = await createEngine(canvas, assets, data, p => { if (!seen.has(p.msg)) { seen.add(p.msg); log.push(`${Math.round(performance.now() - t1)}ms ${p.stage} ${p.pct.toFixed(0)} ${p.msg}`) } })
    // sofort nach dem ersten Bild: Raycast muss schon Wände treffen (await rayP)
    const ray0 = await W.step('ray')
    engine.resize(cw, ch)
    return { dataMs: Math.round(tData), ray0, programs, stats: engine.stats(), progress: log, heapMB: Math.round((performance as any).memory?.usedJSHeapSize / 1048576) }
  }
  if (name === 'ray') {
    // 1000 Strahlen von Schuss-Positionen in Schussrichtung (Wände in Blickrichtung)
    const fx = W.__fx, d = data.d, o = new THREE.Vector3(), dir = new THREE.Vector3()
    let hits = 0, sum = 0
    const t0 = performance.now()
    for (let i = 0; i < 1000; i++) {
      const s = i % d.shot.tick.length
      o.set(d.shot.y[s] * HU, d.shot.z[s] * HU, d.shot.x[s] * HU)
      const p = d.shot.pitch[s] * D2R, y = d.shot.yaw[s] * D2R
      dir.set(Math.cos(p) * Math.sin(y), -Math.sin(p), Math.cos(p) * Math.cos(y))
      const h = fx.raycast(o, dir, 200); if (h < Infinity) { hits++; sum += h }
    }
    return { ms1000: +(performance.now() - t0).toFixed(1), hits, meanDistM: +(sum / Math.max(1, hits)).toFixed(2) }
  }
  if (name === 'overlay') { engine!.setOverlay(a.off ? { labels: {} } : await testOverlay()); return { dirty: engine!.dirty() } }
  if (name === 'shot') {
    // a: { tick | round+sec, mode, player?, group?: names, cam?, opts?, settle?, pix? }
    const tick = tickOf(a)
    camAt(a.cam)
    engine!.setCamera(a.mode ?? 'free', a.player ? sid(a.player) : undefined)
    if (a.group) groupCam(a.group, tick, a)
    const p0 = programs
    await settle(tick, a.settle ?? 24)
    const px = pixels()
    if (a.keep) (W.__px ??= {})[a.keep] = px
    const cmp = a.cmp ? +(diff(W.__px[a.cmp], px) * 100).toFixed(3) : undefined
    const png = canvas.toDataURL('image/png')
    camAt(undefined)
    return { png, tick, stats: engine!.stats(), newPrograms: programs - p0, newNames: names(p0), reds: reds(px), diffPct: cmp }
  }
  if (name === 'pose') {
    // a: { origin: Source-u, angles: [pitch, yaw, roll], vfov, round?, sec? } → Bild nur mit Map (Ladebild-Vergleich), Zeichenpuffer muss volle Größe haben
    const g = new THREE.Vector3(a.origin[1] * HU, a.origin[2] * HU, a.origin[0] * HU)
    W.__cam = { pos: g.toArray(), rot: [-a.angles[0] * D2R, a.angles[1] * D2R + Math.PI, -(a.angles[2] ?? 0) * D2R], fov: a.vfov, mapOnly: true }
    engine!.setCamera('free')
    const p0 = programs
    await settle(tickOf({ round: a.round ?? 1, sec: a.sec ?? 5 }), a.settle ?? 8)
    const gl = canvas.getContext('webgl2')!, size = [gl.drawingBufferWidth, gl.drawingBufferHeight]
    const png = canvas.toDataURL('image/png')
    camAt(undefined)
    return { png, size, stats: engine!.stats(), newPrograms: programs - p0, newNames: names(p0), ...(size[0] !== canvas.clientWidth ? { error: `scaled render ${size}` } : {}) }
  }
  if (name === 'flash') {
    // Ego-Flash (echte Effekte): a.nth-ter player_blind (Dauer >= a.minDur s) ab Runde a.round, Bild a.after s nach Beginn (Standard 1,5 s vor
    // Ende, Weiß halb) → eingefrorenes Bild unter dem Weiß; pngStart = Bild im Flash-Beginn (ohne Weiß = Inhalt des Nachbilds). Spieler muss bis dahin leben.
    const E = data.d.evt, s = newSample(), after = (j: number) => E.tick[j] + (a.after ?? Math.max(0.4, E.arg[j] / 100 - 1.5)) * 64 // 1,5 s vor Ende: Weiß halb
    const alive = (j: number) => { const r = roundAt(data.d, after(j)), k = r < 0 ? -1 : data.d.header.rounds[r].tracks.indexOf(E.player[j]); return k >= 0 && (sampleTrack(data.d, r, k, after(j), s).flags & FLAG.alive) !== 0 }
    let i = -1, n = a.nth ?? 0
    for (let j = 0; j < E.tick.length; j++) if (E.type[j] === EV.player_blind && E.arg[j] >= (a.minDur ?? 2.5) * 100 && E.tick[j] >= (a.round ? data.match.rounds[a.round - 1].freezeEndTick : 0) && roundAt(data.d, E.tick[j]) >= 0 && alive(j) && n-- === 0) { i = j; break }
    if (i < 0) return { error: 'no player_blind' }
    const who = P()[E.player[i]], dur = E.arg[i] / 100, tick = after(i)
    engine!.setCamera('ego', who.steamid)
    await settle(E.tick[i] - 32, 4) // vor dem Flash eingeschwungen (Viewmodel/Skins nachgeladen), dann hinein abspielen wie die App
    let t = E.tick[i] - 32, p0 = programs, pngStart = ''
    for (; t <= tick; t += 1.07) {
      if (t < E.tick[i] - 2) p0 = programs
      await raf(); engine!.setTime(t)
      if (!pngStart && t >= E.tick[i]) pngStart = canvas.toDataURL('image/png')
    }
    const png = canvas.toDataURL('image/png')
    return { png, pngStart, copies: { ...copies }, player: who.name, dur, tick: Math.round(tick), newPrograms: programs - p0, newNames: names(p0) } // Programme ab 2 Ticks vor dem Flash
  }
  if (name === 'dmgcheck') {
    // hitAge gegen die Demo: a.expect = [[Name, round, sec, Sekunden seit dem letzten Treffer | null], …] (±0,05 s: Tick-Raster)
    const bad = (a.expect as [string, number, number, number | null][]).map(([n, round, sec, want]) => {
      const age = hitAge(data.d, pIdx(n), tickOf({ round, sec })), got = age < 0 ? null : +age.toFixed(2)
      return got === want || (got != null && want != null && Math.abs(got - want) <= 0.05) ? null : `${n} R${round} ${sec}s: ${got} != ${want}`
    }).filter(Boolean)
    return bad.length ? { error: bad.join('; ') } : { ok: a.expect.length }
  }
  if (name === 'xtoggle') {
    // gleiche Szene (vorher eingeschwungen), nur X-Ray umschalten: neue GL-Programme und Draw-Calls je Zustand
    const t = tickOf(a), p0 = programs, calls: number[] = []
    for (const v of [false, true, false, true]) { setOptions({ xray: v }); for (let i = 0; i < 3; i++) { await raf(); engine!.setTime(t) } calls.push(engine!.stats().calls) }
    setOptions({ xray: false })
    return { calls, newPrograms: programs - p0, newNames: names(p0) }
  }
  if (name === 'opttoggle') {
    // alle Schalter-Optionen nacheinander an/aus (je 3 Bilder, Szene vorher eingeschwungen): neue GL-Programme je Option
    const t = tickOf(a), per: Record<string, number | string> = {}
    const p00 = programs
    for (const k of ['xray', 'damage', 'impacts', 'nadeTrails', 'nadeCam', 'showKeys', 'hideAll'] as const) {
      const p0 = programs, was = getOptions()[k]
      for (const v of [!was, was, !was, was]) { setOptions({ [k]: v }); for (let i = 0; i < 3; i++) { await raf(); engine!.setTime(t) } }
      per[k] = programs - p0
      if (programs > p0) per[k + ':names'] = names(p0)
    }
    return { newPrograms: programs - p00, per }
  }
  if (name === 'act') {
    // Oberkörper-Clip im Free-Cam-Bild (a.ego: Ego-Sicht des Spielers): längste Aktion der Art kind (a.def: nur diese Waffe), Bild bei frac bzw. at s
    const X = actionsOf(data.d, assets.weapons)
    let best: { p: number; t0: number; end: number } | null = null
    P().forEach((_, p) => { for (const x of X.list(p)) if (x.kind === a.kind && (a.def ? x.def === a.def : assets.weapons[x.def]?.world) && (!best || x.end - x.t0 > best.end - best.t0) && x.end - x.t0 < 64 * 4) best = { p, t0: x.t0, end: x.end } })
    if (!best) return { error: 'no action ' + a.kind }
    const b = best as { p: number; t0: number; end: number }, tick = a.at !== undefined ? b.t0 + a.at * 64 : b.t0 + (b.end - b.t0) * (a.frac ?? 0.5), who = P()[b.p]
    engine!.setCamera(a.ego ? 'ego' : 'free', who.steamid)
    // Kamera um den Spieler (Brusthöhe) dort, wo der Raycast am meisten Platz lässt; vorn-seitlich bevorzugt (Arme sichtbar)
    const f = feet(who.steamid, tick), chest = new THREE.Vector3(f.x, f.y + 1.1, f.z), dir = new THREE.Vector3()
    let pos = chest.clone(), score = -1
    for (let i = 0; i < 16; i++) {
      const ang = f.yaw * D2R + (i / 16) * Math.PI * 2
      dir.set(Math.sin(ang), 0.15, Math.cos(ang)).normalize()
      const dist = Math.min(2.6, W.__fx.raycast(chest, dir, 3) - 0.3), sc = dist + 0.4 * Math.cos((i / 16) * Math.PI * 2 - 0.6)
      if (sc > score) { score = sc; pos = chest.clone().addScaledVector(dir, Math.max(0.5, dist)) }
    }
    if (!a.ego) camAt({ pos: pos.toArray(), at: chest.toArray(), fov: 55 })
    await settle(tick)
    const png = canvas.toDataURL('image/png')
    camAt(undefined)
    return { png, player: who.name, tick: Math.round(tick), dur: +((b.end - b.t0) / 64).toFixed(2) }
  }
  if (name === 'bench') {
    // a: { tick | round+sec, seconds, mode, player?, speed (0 = Standbild), group? }
    const from = tickOf(a)
    engine!.setCamera(a.mode ?? 'free', a.player ? sid(a.player) : undefined)
    if (a.group) groupCam(a.group, from, a)
    await settle(from)
    const ms: number[] = [], cpu: number[] = [], gpu: number[] = [], nCalls: number[] = [], by: Record<string, number> = {}, p0 = programs
    let calls = 0, tris = 0, last = await raf(), tick = from
    const end = last + a.seconds * 1000
    while (true) {
      const now = await raf()
      if (now > end) break
      tick += ((now - last) / 1000) * 64 * (a.speed ?? 1); ms.push(now - last); last = now
      const c0 = performance.now(); engine!.setTime(tick); cpu.push(performance.now() - c0)
      const s = engine!.stats(); calls = Math.max(calls, s.calls); tris = Math.max(tris, s.triangles); gpu.push(s.frameMs); nCalls.push(s.calls)
      for (const [k, v] of Object.entries(s.callsBy ?? {})) by[k] = (by[k] ?? 0) + v
    }
    camAt(undefined)
    const q = (arr: number[], p: number) => +[...arr].sort((x, y) => x - y)[Math.floor(p * (arr.length - 1))].toFixed(2)
    const mean = (arr: number[]) => +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(2)
    // gpuMean: Mittel von stats().frameMs (GPU-Zeit je Bild, EMA der Timer-Query); callsBy: Mittel je Bild
    return { frames: ms.length, fps: +(1000 * ms.length / ms.reduce((s, x) => s + x, 0)).toFixed(1), frameP95: q(ms, 0.95), cpuMean: mean(cpu), cpuP95: q(cpu, 0.95), cpuMax: q(cpu, 1), gpuMean: mean(gpu), callsMean: mean(nCalls), callsBy: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +(v / ms.length).toFixed(1)])), maxCalls: calls, maxTris: tris, newPrograms: programs - p0, stats: engine!.stats() }
  }
  if (name === 'nade') {
    // Smoke im Flug (0.6 s nach dem Wurf): erster Einsatz der Granaten-Kamera (Ruckler), Bild, Kosten an/aus
    const N = data.d.nade
    let i = -1
    for (let j = 0; j < N.type.length; j++) if (N.type[j] === NADE.smoke && N.detTick[j] - N.throwTick[j] > 64 * 1.2 && roundAt(data.d, N.throwTick[j]) >= 0) { i = j; break }
    if (i < 0) return { error: 'no smoke' }
    const tick = N.throwTick[i] + 0.6 * 64, who = P()[N.player[i]]
    engine!.setCamera('free'); groupCam([who.steamid], N.throwTick[i], { back: 3, up: 1.4 })
    setOptions({ nadeCam: false }); await settle(tick)
    await new Promise(r => setTimeout(r, 1500)); engine!.setTime(tick) // Skins setzen sich asynchron zusammen (eigene Programme), nicht mitzählen
    const off = engine!.stats().calls, p0 = programs
    setOptions({ nadeCam: true })
    const c0 = performance.now(); engine!.setTime(tick); const first = performance.now() - c0
    const on = engine!.stats().calls, png = canvas.toDataURL('image/png'), firstPrograms = programs - p0
    // CPU je Bild (Standbild im Flug), abwechselnd je 60 Bilder an/aus (Last von außen trifft beide gleich), Mittel über 4 Runden
    const sum = { on: 0, off: 0, pOn: 0, pOff: 0 }, blocks: number[] = []
    for (let rep = 0; rep < 4; rep++) for (const v of [false, true]) {
      setOptions({ nadeCam: v }); const p1 = programs
      for (let f = 0; f < 60; f++) { await raf(); const c = performance.now(); engine!.setTime(tick); sum[v ? 'on' : 'off'] += performance.now() - c }
      sum[v ? 'pOn' : 'pOff'] += programs - p1; blocks.push(programs - p1)
    }
    camAt(undefined)
    return { png, thrower: who.name, tick, firstMs: +first.toFixed(1), firstPrograms, callsOff: off, callsOn: on, cpuOn: +(sum.on / 240).toFixed(2), cpuOff: +(sum.off / 240).toFixed(2), programsOn: sum.pOn, programsOff: sum.pOff, programsPerBlock: blocks.join(',') }
  }
  if (name === 'rounds') {
    // alle Runden: Ego (erster lebender Spieler) und Frei bei Freeze-Ende + sec, je bis nachgeladen ist
    const out: string[] = [], e0 = errors.length
    for (const [ri, R] of data.match.rounds.entries()) {
      const tick = R.freezeEndTick + (a.sec ?? 20) * 64, r = roundAt(data.d, tick)
      if (r < 0) { out.push(`R${ri + 1} no 3D`); continue }
      const k = data.d.header.rounds[r].tracks.findIndex((_, kk) => feet(P()[data.d.header.rounds[r].tracks[kk]].steamid, tick).alive)
      const p = data.d.header.rounds[r].tracks[Math.max(0, k)]
      engine!.setCamera('ego', P()[p].steamid); await settle(tick, 8)
      const ego = engine!.stats().calls
      engine!.setCamera('free'); await settle(tick, 4)
      out.push(`R${ri + 1} ${P()[p].name} ego ${ego} free ${engine!.stats().calls}`)
    }
    return { rounds: out, newErrors: errors.slice(e0) }
  }
  if (name === 'idle') {
    // Pause: ohne Eingabe dirty() = false; gehaltene Free-Cam-Taste → true; Optionswechsel → true
    engine!.setCamera('free'); await settle(tickOf(a))
    let n = 0, frames = 0
    for (const end = performance.now() + 1000; performance.now() < end; frames++) { await raf(); if (engine!.dirty()) n++ }
    const code = getHotkeys().camForward!
    canvas.dispatchEvent(new KeyboardEvent('keydown', { code }))
    const held = engine!.dirty()
    canvas.dispatchEvent(new KeyboardEvent('keyup', { code }))
    const released = engine!.dirty()
    setOptions({ impacts: true }); const opt = engine!.dirty(); setOptions({ impacts: false })
    return { idleFrames: frames, idleDirty: n, held, released, afterOption: opt }
  }
  if (name === 'errors') return { errors: errors.splice(0) }
  if (name === 'dispose') { engine!.dispose(); const s = engine!.stats(); engine = undefined; return { geometries: s.geometries, textures: s.textures } }
  if (name === 'fly') {
    // Free-Cam: camForward (hotkeys.ts) für a.ms halten, dann Maus ziehen (a.dx, a.dy Pixel)
    engine!.setCamera('free')
    const before = engine!.listener(), codes = (a.keys ?? ['camForward']).map((k: 'camForward') => getHotkeys()[k])
    for (const code of codes) canvas.dispatchEvent(new KeyboardEvent('keydown', { code }))
    const end = performance.now() + (a.ms ?? 500)
    while (performance.now() < end) { await raf(); engine!.setTime(tickOf(a)) }
    for (const code of codes) canvas.dispatchEvent(new KeyboardEvent('keyup', { code }))
    canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 }))
    canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: a.dx ?? 0, clientY: a.dy ?? 0, pointerId: 1 }))
    canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    const moved = engine!.dirty()
    await raf(); engine!.setTime(tickOf(a))
    return { before, after: engine!.listener(), dirtyAfterDrag: moved }
  }
  if (name === 'wait') { await new Promise(r => setTimeout(r, a.ms ?? 2000)); return { heapMB: Math.round((performance as any).memory?.usedJSHeapSize / 1048576) } }
  throw new Error('unknown step ' + name)
}
console.log('engine page ready')
