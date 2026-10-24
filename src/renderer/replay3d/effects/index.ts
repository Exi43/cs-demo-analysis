// createEffects: Smokes, Molotov/Brandgranaten, Flash, HE, Granaten im Flug, Mündungsfeuer, Tracer, Einschläge/Blut, C4.
// update(tick) ist eine reine Funktion des Ticks (Sprünge ohne Altlasten); einzige Zustände sind Caches (Smoke-/Feuer-Flutung,
// Treffer-Abstände der Schüsse, Flash-Nachbild-Textur). Feste Puffer/Pools, pro Bild keine Objekte (Ausnahme: Generator-Schritt der Flutung).
// Draw-Calls: Sprites 3 + Granaten 1 + C4 2 (Modell; Kiste 1) + Overlays 2 + je sichtbarer Smoke 1; nur wenn an: Flugbahn 2 (X-Ray), Impacts 1.
// Licht: nur der feste Pool aus ctx.lights (Low: alle aus). Optionen liest update() je Bild aus options.ts (aus = nicht in der Szene, 0 Arbeit).
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { EV, FLAG, NADE, flashAt, newSample, roundAt, sampleTrack, upperBound } from '../../../shared/cs3d'
import { floorLayer } from '../../../shared/assets3d'
import { HU, eyeZ, worldToGltf, type CreateEffects } from '../contracts'
import { adopt, type AgentUniforms } from '../engine/agents'
import { decalBatch, hash, lightPool, noiseTexture, overlay, spriteBatch, streakBatch, tracerShots, type Shared } from './gfx'
import { createSmoke } from './smoke'
import { createFire } from './fire'
import { createTrails } from './trails'
import { createImpacts } from './impacts'
import { getOptions } from '../options'

const D2R = Math.PI / 180
// weapon_tracers_assrifle.vpcf: MoveBetweenPoints 20500 u/s, RenderTrails MaxLength 1200 u, LengthFadeInTime 0.08 s
const TRACER_SPEED = 20500, TRACER_LEN = 1200, TRACER_GROW = 0.08 // u/s, u, s
const HE_LIGHT_S = 0.225, HE_LIGHT_R = 160 // s, u (explosion_hegrenade_light.vpcf)
const FLASH_S = 0.25, FLASH_R = 256 // s, u Sprite-Radius (explosion_flashbang.vpcf, Farbe 255/215/197)
const C4_DEF = 49
const NADE_DEF = [45, 43, 44, 46, 48, 47] // NADE-Typ (smoke, flash, he, molotov, incgrenade, decoy) → item_def_idx
const NADE_POOL = 4 // Granaten je Typ gleichzeitig im Flug als Modell, weitere als Drehkörper
const MUZZLE_S = 0.035 // s Mündungsfeuer (≈ 2 Ticks)
const SHOT_WIN = 0.8 // s Rückblick für Schüsse (Tracer, Einschlag, Smoke-Tunnel)
const BOMB_TIME = 40
const NADE_LOOK = 40 // s Rückblick für Granaten (Smoke 22 s + Flug)

export const createEffects: CreateEffects = ctx => {
  const { scene, camera } = ctx
  const d = ctx.data.d, N = d.nade, S = d.shot, E = d.evt, rate = d.header.tickrate
  const shared: Shared = { uNoise: { value: noiseTexture() }, uClock: { value: 0 } }
  const glow = spriteBatch('glow', 2048, shared), puff = spriteBatch('puff', 1024, shared), streak = streakBatch(256, shared)
  const lights = lightPool(ctx.lights, () => getOptions().lowQuality)
  // Rauch-Grau in der Welt (Waffe bleibt im Rauch sichtbar), Blend-Weiß + Nachbild in eigener Szene nach dem Viewmodel (deckt alles außer dem HUD)
  const ov = overlay(), fl = overlay(), post = new THREE.Scene().add(fl.mesh)
  const smoke = createSmoke(ctx, shared)
  const fire = createFire(ctx, glow, puff, lights)

  // Granaten-Modelle (eine Drehform je Typ über Skalierung) und C4: geteiltes Material → ein Programm
  const prof = [[0, -0.5], [0.85, -0.5], [1, -0.42], [1, 0.32], [0.62, 0.42], [0.55, 0.62], [0, 0.62]].map(([x, y]) => new THREE.Vector2(x, y))
  const nadeMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 })
  const nades = new THREE.InstancedMesh(new THREE.LatheGeometry(prof, 10), nadeMat, 24)
  const c4 = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.075, 0.2), nadeMat, 1)
  for (const m of [nades, c4]) { m.count = 0; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage) }
  c4.setColorAt(0, new THREE.Color(0.2, 0.18, 0.11))
  // Typ → [Radius, Länge] (m), Farbe (sRGB)
  const NADE_DIM = [[0.032, 0.15], [0.03, 0.13], [0.036, 0.11], [0.034, 0.24], [0.03, 0.15], [0.03, 0.13]]
  const NADE_COL = [[0.42, 0.47, 0.44], [0.7, 0.7, 0.68], [0.24, 0.3, 0.17], [0.3, 0.38, 0.16], [0.52, 0.52, 0.56], [0.4, 0.34, 0.28]].map(c => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace))
  nades.setColorAt(0, NADE_COL[0])

  for (const m of [glow.mesh, puff.mesh, streak.mesh, nades, c4, ov.mesh]) scene.add(m)

  // Modelle aus weapons/*.glb mit Agenten-Licht (Ambient-Cube + Sonne aus den Sonden, wie Agent.light, ungeglättet): gelegte C4 und
  // Granaten im Flug (dasselbe Modell wie in der Hand, je Typ ein Pool von Klonen); bis geladen bzw. ohne Modell Kiste/Drehkörper
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  const newU = (): AgentUniforms => ({ csdaCube: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0.5, 0.5, 0.5)) }, csdaSunVis: { value: 1 } })
  /** Licht an (x,y,z) Source aus probes.bin; false = keine Sonde (Werte bleiben) */
  const probeLight = (u: AgentUniforms, x: number, y: number, z: number) => {
    const g = smoke.grid(), l = g?.probes ? floorLayer(g, x, y, z, 300) : -1
    if (l < 0) return false
    const pr = g!.probes!, o = l * 19, c = u.csdaCube.value
    for (let k = 0; k < 6; k++) c[k].set((pr[o + k * 3] / 255) ** 2 * 4 * Math.PI, (pr[o + k * 3 + 1] / 255) ** 2 * 4 * Math.PI, (pr[o + k * 3 + 2] / 255) ** 2 * 4 * Math.PI)
    u.csdaSunVis.value = pr[o + 18] / 255
    return true
  }
  const c4u = newU(), c4Led = new THREE.Vector3()
  let c4m: THREE.Object3D | null = null, c4emit: THREE.MeshStandardMaterial | null = null, c4lit = -1, disposed = false
  const c4url = ctx.assets.weapons[C4_DEF]?.glb
  if (c4url) loader.loadAsync(c4url).then(g => {
    if (disposed) return
    adopt(g.scene, c4u)
    g.scene.traverse(o => {
      const m = o as THREE.Mesh, mt = m.material as THREE.MeshStandardMaterial
      if (!m.isMesh) return
      if (mt.name === 'c4_panorama_control_panel') m.visible = false // Panorama-Anzeige: im Export Testgitter mit Alpha 0
      else if (mt.emissiveMap) c4emit = mt // LED = Self-Illum-Maske (c4_led_selfillum), Stärke setzt das Blinken
    })
    const box = new THREE.Box3().setFromObject(g.scene)
    g.scene.position.y = -box.min.y // Unterseite auf den Boden
    // LED-Mitte im Modell (Maske → UV → Dreieck, F/led.mjs), Schein knapp darüber
    c4Led.set(0.0048, 0.0295 + 0.004 - box.min.y, 0.0002)
    c4m = new THREE.Group().add(g.scene)
    c4m.visible = false
    scene.add(c4m)
  }).catch(e => console.warn('c4 model', e))
  const nadeModels: ({ obj: THREE.Object3D; u: AgentUniforms }[] | null)[] = NADE_DEF.map(() => null)
  const nadeTop = new Float32Array(NADE_DEF.length), nadeUsed = new Uint8Array(NADE_DEF.length) // Mitte → Oberkante (m); Klone im Bild
  NADE_DEF.forEach((def, type) => {
    const url = ctx.assets.weapons[def]?.glb
    if (url) loader.loadAsync(url).then(g => {
      if (disposed) return
      const box = new THREE.Box3().setFromObject(g.scene), c = box.getCenter(new THREE.Vector3())
      g.scene.position.sub(c) // um die Mitte drehen wie der Drehkörper
      nadeTop[type] = box.max.y - c.y
      nadeModels[type] = Array.from({ length: NADE_POOL }, () => {
        const u = newU(), obj = new THREE.Group().add(g.scene.clone())
        adopt(obj, u); obj.visible = false; scene.add(obj)
        return { obj, u }
      })
    }).catch(e => console.warn('grenade model', def, e))
  })

  const tracer = tracerShots(S, ctx.assets.weapons, rate)

  // Flash-Nachbild: beim Flash-Beginn bzw. nach einem Sprung in einen Flash EIN Bild der Szene holen (ctx.captureFrame). Im
  // Anforderungsbild bleibt das Weiß aus (die Kopie soll die Szene zeigen), ab dem nächsten Bild: Weiß über dem Nachbild
  let flashEv = -1, flashAsk = 0, flashFresh = false, flashTex: THREE.Texture | null = null
  /** letztes player_blind von p im 10-s-Fenster wie flashAt, −1 = keins */
  const blindEvent = (p: number, tick: number) => {
    for (let i = upperBound(E.tick, tick) - 1; i >= 0 && tick - E.tick[i] < 10 * rate; i--) if (E.type[i] === EV.player_blind && E.player[i] === p) return i
    return -1
  }

  // Bombe je CS3D-Runde aus v1 (Position nur dort)
  const bomb = d.header.rounds.map(H => {
    const R = ctx.data.match.rounds.find(q => q.num === H.num)
    return R?.plant ? { tick: R.plant.tick, pos: R.plant.pos, defused: R.defuse?.tick ?? Infinity, exploded: R.exploded ?? Infinity } : null
  })
  // Spur-Index je Runde und Spieler (Blut am Opfer, Ego-Erkennung)
  const trackOf = d.header.rounds.map(H => { const a = new Int16Array(d.header.players.length).fill(-1); H.tracks.forEach((p, k) => (a[p] = k)); return a })
  const hitU = new Float32Array(S.tick.length).fill(NaN) // Treffer-Abstand je Schuss (u), lazy per raycast
  const rayO = new THREE.Vector3(), rayD = new THREE.Vector3()
  /** Abstand (u) von Schuss i bis zur Map, Infinity = kein Treffer; einmal gerechnet (Tracer, Smoke-Tunnel, Impacts) */
  const hitOf = (i: number) => {
    if (Number.isNaN(hitU[i])) {
      const pi = S.pitch[i] * D2R, ya = S.yaw[i] * D2R
      rayD.set(Math.cos(pi) * Math.sin(ya), -Math.sin(pi), Math.cos(pi) * Math.cos(ya))
      hitU[i] = ctx.raycast(worldToGltf(S.x[i], S.y[i], S.z[i], rayO), rayD, 4096 * HU) / HU
    }
    return hitU[i]
  }
  const trails = createTrails(scene, d), impacts = createImpacts(scene, d, hitU, hitOf)

  // Decals: Einschusslöcher (Schuss mit Map-Treffer) und Blut (player_hurt durch Schuss: Wand bis 160 u hinter dem Opfer, sonst Boden),
  // Funktion des Ticks über die Runde: Ringpuffer je Art (Platz = laufende Nummer % Größe), vorwärts nur anhängen, bei Sprung zurück oder
  // Rundenwechsel die letzten Plätze neu füllen (Treffer/Normalen gecacht). Brandflecken zeichnen HE und Feuer als flache Sprites.
  const HOLES = 192, BLOODS = 64 // ein Instanz-Draw-Call, auch in Low (live umschaltbar, kaum GPU-Last)
  const decals = decalBatch(HOLES + BLOODS, shared)
  scene.add(decals.mesh)
  const hurts = Int32Array.from(E.type.keys()).filter(j => E.type[j] === EV.player_hurt), hurtT = Uint32Array.from(hurts, j => E.tick[j])
  const hitN = new Float32Array(S.tick.length * 3).fill(NaN), heGround = new Float32Array(N.type.length).fill(NaN)
  let decR = -1, decT = -Infinity, holeAt = 0, bloodAt = 0, decBehind = false
  const dO = new THREE.Vector3(), dD = new THREE.Vector3(), dP = new THREE.Vector3(), dN = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), dT = new THREE.Vector3()
  const UPV = new THREE.Vector3(0, 1, 0), XV = new THREE.Vector3(1, 0, 0)
  /** Flächennormale am Treffer h (m) des Strahls o + d·t: zwei parallele Nachbarstrahlen im Abstand 2 u; Kante/Ecke → Gegenrichtung */
  function normalAt(o: THREE.Vector3, dir: THREE.Vector3, h: number, out: THREE.Vector3) {
    e1.crossVectors(dir, Math.abs(dir.y) < 0.9 ? UPV : XV).normalize(); e2.crossVectors(dir, e1)
    const k = 2 * HU, h1 = ctx.raycast(dT.copy(o).addScaledVector(e1, k), dir, h + 0.5), h2 = ctx.raycast(dT.copy(o).addScaledVector(e2, k), dir, h + 0.5)
    if (!(Math.abs(h1 - h) < 0.3 && Math.abs(h2 - h) < 0.3)) return out.copy(dir).negate()
    e1.multiplyScalar(k).addScaledVector(dir, h1 - h); e2.multiplyScalar(k).addScaledVector(dir, h2 - h)
    out.crossVectors(e1, e2).normalize()
    return out.dot(dir) > 0 ? out.negate() : out
  }
  function hole(i: number) {
    const slot = i % HOLES, h = hitOf(i)
    if (!(h < 4096)) return decals.off(slot)
    const pi = S.pitch[i] * D2R, ya = S.yaw[i] * D2R
    dD.set(Math.cos(pi) * Math.sin(ya), -Math.sin(pi), Math.cos(pi) * Math.cos(ya))
    worldToGltf(S.x[i], S.y[i], S.z[i], dO)
    if (Number.isNaN(hitN[i * 3])) normalAt(dO, dD, h * HU, dN).toArray(hitN, i * 3); else dN.fromArray(hitN, i * 3)
    decals.set(slot, dP.copy(dO).addScaledVector(dD, h * HU), dN, 0.09 + 0.03 * hash(i * 13), hash(i) * 6.3, 0, hash(i * 7))
  }
  function blood(k: number) {
    const slot = HOLES + (k % BLOODS), j = hurts[k], te = E.tick[j], v = E.player[j], r = roundAt(d, te), tk = r >= 0 ? trackOf[r][v] : -1
    decals.off(slot)
    if (!(tk >= 0)) return
    sampleTrack(d, r, tk, te, smp2)
    const cz = smp2.z + 40 - 14 * smp2.duck
    // Schuss, der das Opfer traf: bis 4 Ticks vorher, Strahl höchstens 40 u am Körper vorbei
    let best = -1
    for (let i = upperBound(S.tick, te) - 1; i >= 0 && S.tick[i] >= te - 4 && best < 0; i--) {
      if (S.player[i] === v) continue
      const pi = S.pitch[i] * D2R, ya = S.yaw[i] * D2R, dx = Math.cos(pi) * Math.cos(ya), dy = Math.cos(pi) * Math.sin(ya), dz = -Math.sin(pi)
      const vx = smp2.x - S.x[i], vy = smp2.y - S.y[i], vz = cz - S.z[i], t = vx * dx + vy * dy + vz * dz
      if (t > 0 && vx * vx + vy * vy + vz * vz - t * t < 40 * 40) best = i
    }
    if (best < 0) return
    const pi = S.pitch[best] * D2R, ya = S.yaw[best] * D2R
    dD.set(Math.cos(pi) * Math.sin(ya), -Math.sin(pi), Math.cos(pi) * Math.cos(ya))
    worldToGltf(smp2.x, smp2.y, cz, dO)
    let h = ctx.raycast(dO, dD, 160 * HU)
    if (h < Infinity) normalAt(dO, dD, h, dN)
    else { dD.set(0, -1, 0); h = ctx.raycast(dO, dD, 120 * HU); if (h === Infinity) return; dN.set(0, 1, 0) }
    decals.set(slot, dP.copy(dO).addScaledVector(dD, h), dN, (0.5 + 0.6 * Math.min(1, (E.arg[j] & 255) / 60)) * (0.8 + 0.4 * hash(j * 3)), hash(j) * 6.3, 1, hash(j * 5))
  }
  const shotSeg = new Float32Array(7 * 64)

  // Temporäre Objekte (einmal angelegt)
  const P = new THREE.Vector3(), Q = new THREE.Vector3(), M = new THREE.Vector3(), Dg = new THREE.Vector3(), cam = new THREE.Vector3()
  const mat = new THREE.Matrix4(), quat = new THREE.Quaternion(), scl = new THREE.Vector3(), axis = new THREE.Vector3()
  const smp = newSample(), smp2 = newSample()
  const camS: [number, number, number] = [0, 0, 0]
  const smokeOut = { dens: 0, light: 0 }
  const heList = new Int32Array(16)

  const smooth = (t: number) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t) }
  /** Position von Granate i auf der Flugbahn (Catmull-Rom über die Pfadpunkte), Source-Units */
  function nadeAt(i: number, tick: number, out: number[]) {
    const s = N.pathStart[i], e = N.pathStart[i + 1], T = d.path.tick
    if (e - s < 2 || tick <= T[s]) { out[0] = d.path.x[s] ?? N.x[i]; out[1] = d.path.y[s] ?? N.y[i]; out[2] = d.path.z[s] ?? N.z[i]; return }
    let lo = s, hi = e - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= tick) lo = m; else hi = m }
    const t = Math.min(1, (tick - T[lo]) / Math.max(1, T[hi] - T[lo]))
    const a = Math.max(s, lo - 1), b = Math.min(e - 1, hi + 1)
    const X = d.path.x, Y = d.path.y, Z = d.path.z
    out[0] = cr(X[a], X[lo], X[hi], X[b], t); out[1] = cr(Y[a], Y[lo], Y[hi], Y[b], t); out[2] = cr(Z[a], Z[lo], Z[hi], Z[b], t)
  }
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) => { const t2 = t * t; return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t2 * t) }
  const np = [0, 0, 0], np2 = [0, 0, 0]

  function explode(x: number, y: number, z: number, age: number, sc: number, seed: number) {
    worldToGltf(x, y, z, P)
    if (age < 0.4) {
      const k = (1 - age / 0.4) ** 2
      for (let j = 0; j < 7; j++) { // Feuerball aus mehreren verrauschten Kugeln, die auseinanderfliegen
        const u = hash(seed * 41 + j) * 6.283, r = j ? 30 * sc * (0.4 + age * 5) : 0, s = hash(seed * 43 + j)
        worldToGltf(x + Math.cos(u) * r, y + Math.sin(u) * r, z + (j ? 6 + 20 * s : 0) + age * 50, Q)
        glow.add(Q, (j ? 0.9 + 0.6 * s : 1.6) * sc * (0.6 + 1.6 * Math.sqrt(age / 0.4)), 0.6, 0.32, 0.15, k, 4, u, s, 0)
      }
      if (age < 0.06) glow.add(P, 3 * sc, 4, 3.6, 3, 1 - age / 0.06, 0, 0, 0)
    }
    if (age < HE_LIGHT_S) lights.want(P, 1, 0.6, 0.3, 90 * sc * (1 - age / HE_LIGHT_S), HE_LIGHT_R * HU * sc)
    for (let j = 0; j < 14 && age < 0.7; j++) { // Funken mit Schweif
      const u = hash(seed * 51 + j) * 6.283, v = hash(seed * 53 + j) * 0.9 + 0.1, sp = (420 + 300 * hash(seed * 57 + j)) * sc
      const cu = Math.cos(u) * v * sp, su = Math.sin(u) * v * sp, up = Math.sqrt(1 - v * v) * sp, t0 = Math.max(0, age - 0.05)
      worldToGltf(x + cu * t0, y + su * t0, z + up * t0 - 400 * t0 * t0, Q)
      streak.add(Q, worldToGltf(x + cu * age, y + su * age, z + up * age - 400 * age * age, M), 0.03, 5, 3, 1, 0, 0)
    }
    if (age < 2.2 * sc) for (let j = 0; j < 14; j++) { // Staubwolke
      const u = hash(seed * 61 + j) * 6.283, v = hash(seed * 67 + j) - 0.3, s = hash(seed * 71 + j)
      const r = 100 * sc * (1 - Math.exp(-age * 5))
      worldToGltf(x + Math.cos(u) * r, y + Math.sin(u) * r, z + 20 + v * r * 0.6 + age * 15, Q)
      const a = 0.95 * (1 - smooth((age - 0.3) / (1.9 * sc))) * Math.min(1, age * 10)
      puff.add(Q, (50 + 80 * (1 - Math.exp(-age * 3))) * sc * (0.7 + 0.6 * s) * HU, 0.3, 0.26, 0.21, a, 0, s * 6, s, 0)
    }
  }

  return {
    post,
    update(tick) {
      const clock = tick / rate
      shared.uClock.value = clock
      cam.copy(camera.position)
      camS[0] = cam.z / HU; camS[1] = cam.x / HU; camS[2] = cam.y / HU
      smoke.begin()
      smokeOut.dens = 0; decBehind = false
      let nades_n = 0, c4_n = 0, flash = 0, c4vis = false, c4on = false
      const r = roundAt(d, tick)
      if (r >= 0) {
        const R = d.header.rounds[r], firstTick = R.firstTick

        // Spieler: Augenpunkte (Ego-Erkennung)
        let ego = -1, side = 5 // Ego-Mündung rechts (u), Linkshänder (cl_righthand 0) links wie das gespiegelte Viewmodel
        for (let k = 0; k < R.tracks.length; k++) {
          sampleTrack(d, r, k, tick, smp)
          if (smp.flags & FLAG.alive && worldToGltf(smp.x, smp.y, eyeZ(smp.z, smp.duck), P).distanceToSquared(cam) < 0.15 * 0.15) { ego = R.tracks[k]; side = smp.flags & FLAG.lefthand ? -5 : 5 }
        }
        if (ego >= 0) flash = flashAt(d, ego, tick)
        const ev = flash > 0 ? blindEvent(ego, tick) : -1
        if (ev !== flashEv) { flashEv = ev; flashTex = null; flashAsk = ev >= 0 && ctx.captureFrame ? 3 : 0 }

        // Schüsse: Mündungsfeuer, Tracer, Einschlag; Segmente für Smoke-Tunnel
        let nSeg = 0
        for (let i = upperBound(S.tick, Math.max(firstTick, tick - SHOT_WIN * rate)); i < S.tick.length && S.tick[i] <= tick; i++) {
          const age = (tick - S.tick[i]) / rate, p = S.player[i]
          const pi = S.pitch[i] * D2R, ya = S.yaw[i] * D2R
          const dx = Math.cos(pi) * Math.cos(ya), dy = Math.cos(pi) * Math.sin(ya), dz = -Math.sin(pi)
          Dg.set(dy, dz, dx)
          const hit = Math.min(hitOf(i), 4096)
          const own = p === ego
          // eigene Waffe in der Ego-Sicht bzw. kein Modell: seitlich unter dem Auge (wie das Viewmodel)
          const lr = own ? side : 5
          if (own || !ctx.muzzle(p, M)) worldToGltf(S.x[i] + dx * 40 + Math.sin(ya) * lr, S.y[i] + dy * 40 - Math.cos(ya) * lr, S.z[i] + dz * 40 - 6, M)
          const sil = S.silenced[i] === 1
          if (age < MUZZLE_S) {
            const k = 1 - age / MUZZLE_S, sd = hash(i)
            if (!own) {
              glow.add(M, (sil ? 0.1 : 0.34 + 0.12 * sd) * (0.7 + 0.3 * k), 5, 3.6, 1.8, sil ? 0.4 : 1, 1, sd * 6.3, sd, 0)
              if (!sil) streak.add(M, Q.copy(Dg).multiplyScalar((0.35 + 0.2 * sd) * k).add(M), 0.13, 4, 2.6, 1.1, sd, 1)
            }
            // CS2-Mündungspartikel haben kein Licht: nur ein schwacher Schein am Lauf
            if (!sil) lights.want(Q.copy(Dg).multiplyScalar(0.15).add(M), 1, 0.72, 0.42, 3 * k, 3)
          }
          const head = TRACER_SPEED * age, tail = head - TRACER_LEN * Math.min(1, age / TRACER_GROW)
          if (tracer[i] && tail < hit && head > 30) {
            P.copy(Dg).multiplyScalar(Math.max(30, tail) * HU).add(M); Q.copy(Dg).multiplyScalar(Math.min(head, hit) * HU).add(M)
            streak.add(P, Q, 0.025, 7, 5, 2.6, 0, 0)
          }
          const ia = age - hit / TRACER_SPEED // Einschlag
          if (hitU[i] < 4096 && ia >= 0 && ia < 0.5) {
            worldToGltf(S.x[i] + dx * (hit - 2), S.y[i] + dy * (hit - 2), S.z[i] + dz * (hit - 2), P)
            const sd = hash(i * 3 + 1)
            puff.add(P, (0.12 + 0.5 * Math.sqrt(ia / 0.5)) * (0.8 + 0.4 * sd), 0.32, 0.28, 0.22, 0.95 * (1 - ia / 0.5), 0, sd * 6, sd, 0)
            if (ia < 0.06) glow.add(P, 0.14, 5, 3.4, 1.4, 1 - ia / 0.06, 0, 0, 0)
          }
          if (age < SHOT_WIN && nSeg < 64) {
            const o = nSeg++ * 7
            worldToGltf(S.x[i], S.y[i], S.z[i], P)
            shotSeg[o] = P.x; shotSeg[o + 1] = P.y; shotSeg[o + 2] = P.z
            shotSeg[o + 3] = P.x + Dg.x * hit * HU; shotSeg[o + 4] = P.y + Dg.y * hit * HU; shotSeg[o + 5] = P.z + Dg.z * hit * HU; shotSeg[o + 6] = age
          }
        }

        // Blut: player_hurt der letzten 0.4 s am Opfer
        for (let i = upperBound(E.tick, Math.max(firstTick, tick - 0.4 * rate)); i < E.tick.length && E.tick[i] <= tick; i++) {
          if (E.type[i] !== EV.player_hurt) continue
          const k = trackOf[r][E.player[i]] // 255 = unbekannt → undefined
          if (!(k >= 0)) continue
          sampleTrack(d, r, k, E.tick[i], smp)
          const age = (tick - E.tick[i]) / rate, head = (E.arg[i] & 256) !== 0, sd = hash(i * 5 + 2)
          worldToGltf(smp.x, smp.y, head ? eyeZ(smp.z, smp.duck) - 2 : smp.z + 40 - 14 * smp.duck, P)
          puff.add(P, (0.18 + 0.45 * Math.sqrt(age / 0.4)) * (0.8 + 0.4 * sd), 0.2, 0.01, 0.008, 1 - age / 0.4, 0, sd * 6, sd, 0)
        }

        // Decals bis tick (siehe oben)
        const iEnd = upperBound(S.tick, tick), kEnd = upperBound(hurtT, tick)
        if (r !== decR || tick < decT) {
          decals.clear(); decR = r
          holeAt = upperBound(S.tick, firstTick - 1); bloodAt = upperBound(hurtT, firstTick - 1)
        }
        // Nachfüllen nach einem Sprung (je Loch 3 Strahlen) auf ~0.5 ms je Bild verteilt; Abspielen: 0–2 neue je Bild
        holeAt = Math.max(holeAt, iEnd - HOLES); bloodAt = Math.max(bloodAt, kEnd - BLOODS)
        for (const tEnd = performance.now() + 0.5; (holeAt < iEnd || bloodAt < kEnd) && performance.now() < tEnd;) if (holeAt < iEnd) hole(holeAt++); else blood(bloodAt++)
        decBehind = holeAt < iEnd || bloodAt < kEnd
        decT = tick

        // Granaten: zuerst HE sammeln (Löcher in Smokes), dann alles zeichnen
        const i0 = upperBound(N.throwTick, tick) - 1
        let nHe = 0
        for (let i = i0; i >= 0 && N.throwTick[i] > tick - NADE_LOOK * rate; i--) {
          if (N.throwTick[i] < firstTick) break
          if (N.type[i] === NADE.he && tick >= N.detTick[i] && nHe < 16) heList[nHe++] = i
        }
        for (let i = i0; i >= 0 && N.throwTick[i] > tick - NADE_LOOK * rate; i--) {
          if (N.throwTick[i] < firstTick) break
          const type = N.type[i], det = N.detTick[i], age = (tick - det) / rate
          const rests = type === NADE.decoy && tick < N.endTick[i]
          if (tick <= det || rests) { // im Flug (Decoy liegt danach bis zum Ende)
            const pool = nadeModels[type]
            if (pool ? nadeUsed[type] < NADE_POOL : nades_n < 24) {
              const tt = Math.min(tick, det)
              nadeAt(i, tt, np); nadeAt(i, tt - 2, np2)
              worldToGltf(np[0], np[1], np[2], P)
              const vx = np[0] - np2[0], vy = np[1] - np2[1], vz = np[2] - np2[2], fly = tick <= det && Math.hypot(vx, vy, vz) > 0.5
              axis.set(vx, 0, -vy).normalize() // senkrecht zur Flugrichtung (three: x=Source y, z=Source x)
              if (!fly || axis.lengthSq() < 0.5) axis.set(1, 0, 0)
              quat.setFromAxisAngle(axis, fly ? (tick - N.throwTick[i]) / rate * 11 : Math.PI / 2)
              let top: number
              if (pool) {
                const nm = pool[nadeUsed[type]++]
                nm.obj.position.copy(P); nm.obj.quaternion.copy(quat); nm.obj.visible = true
                probeLight(nm.u, np[0], np[1], np[2])
                top = nadeTop[type]
              } else {
                const dim = NADE_DIM[type] ?? NADE_DIM[0]
                mat.compose(P, quat, scl.set(dim[0], dim[1], dim[0]))
                nades.setMatrixAt(nades_n, mat); nades.setColorAt(nades_n++, NADE_COL[type] ?? NADE_COL[0])
                top = dim[1] * 0.62
              }
              if ((type === NADE.molotov || type === NADE.incgrenade) && tick <= det) { // brennender Lappen
                Q.set(0, top, 0).applyQuaternion(quat).add(P)
                glow.add(Q, 0.16 + 0.04 * Math.sin(clock * 40 + i), 3, 1.5, 0.5, 1, 0, 0, 0)
              }
            }
            // Flutung schon während des Flugs rechnen
            if (type === NADE.smoke) smoke.prepare(i)
            else if (type === NADE.molotov || type === NADE.incgrenade) fire.prepare(i)
            if (tick <= det) continue
          }
          if (type === NADE.smoke) {
            if (tick < N.endTick[i]) smoke.draw(i, tick, heList, nHe, shotSeg, nSeg, cam, camS, smokeOut)
          } else if (type === NADE.flash && age < FLASH_S) {
            worldToGltf(N.x[i], N.y[i], N.z[i] + 6, P)
            const k = (1 - age / FLASH_S) ** 2
            glow.add(P, 2 * FLASH_R * HU * (0.5 + 0.5 * age / FLASH_S), 6, 4.1, 3.3, k, 0, 0, 0) // warm wie CS2 (255/215/197)
            glow.add(P, 0.6, 12, 12, 12, k, 1, hash(i) * 6.3, hash(i), 0)
            lights.want(P, 1, 0.68, 0.56, 120 * k, 16)
          } else if (type === NADE.he) {
            explode(N.x[i], N.y[i], N.z[i] + 8, age, 1, i)
          } else if ((type === NADE.molotov || type === NADE.incgrenade) && tick <= Math.max(N.endTick[i], det + 0.25 * rate)) {
            fire.draw(i, tick, clock)
          }
        }

        // Brandflecken bis Rundenende: HE am Boden unter der Detonation (explosion_hegrenade_decal r 30–40 u), Feuer je zweiter Zelle
        for (let i = i0; i >= 0 && N.throwTick[i] >= firstTick; i--) {
          const type = N.type[i], det = N.detTick[i]
          if (tick < det) continue
          if (type === NADE.he) {
            if (Number.isNaN(heGround[i])) heGround[i] = N.z[i] + 8 - ctx.raycast(worldToGltf(N.x[i], N.y[i], N.z[i] + 8, dO), dD.set(0, -1, 0), 120 * HU) / HU
            if (heGround[i] === -Infinity) continue // in der Luft
            const sd = hash(i * 3 + 7)
            puff.add(worldToGltf(N.x[i], N.y[i], heGround[i] + 0.8, P), 75 * HU, 0.02, 0.018, 0.016, 0.85 * Math.min(1, (tick - det) / rate / 0.2), 0, sd * 6.3, sd, 1)
          } else if ((type === NADE.molotov || type === NADE.incgrenade) && N.endTick[i] > det) fire.scorch(i, tick)
        }

        // C4: liegt ab bomb_planted, LED blinkt immer schneller; Explosion
        const b = bomb[r]
        if (b && tick >= b.tick) {
          const t = (tick - b.tick) / rate
          if (tick < b.exploded) {
            quat.setFromAxisAngle(axis.set(0, 1, 0), hash(b.tick) * 6.3)
            if (c4m) {
              worldToGltf(b.pos[0], b.pos[1], b.pos[2], P)
              c4m.position.copy(P); c4m.quaternion.copy(quat); c4m.visible = c4vis = true
              if (c4lit !== b.tick && probeLight(c4u, b.pos[0], b.pos[1], b.pos[2])) c4lit = b.tick // einmal je Plant
            } else {
              worldToGltf(b.pos[0], b.pos[1], b.pos[2] + 1.5, P)
              mat.compose(P, quat, scl.set(1, 1, 1)); c4.setMatrixAt(0, mat); c4_n = 1
            }
            if (tick < b.defused) {
              const k = 0.85 / BOMB_TIME, tc = Math.min(t, BOMB_TIME - 0.05), ph = -Math.log(1 - k * tc) / k
              if (ph % 1 < 0.22 || t > BOMB_TIME - 1) {
                if (c4m) Q.copy(c4Led); else Q.set(0.08, 0.06, 0.05)
                Q.applyQuaternion(quat).add(P)
                glow.add(Q, c4m ? 0.04 : 0.09, 8, 0.4, 0.3, 1, 0, 0, 0)
                c4on = true
              }
            }
          } else explode(b.pos[0], b.pos[1], b.pos[2] + 20, (tick - b.exploded) / rate, 2.6, b.tick)
        }
      }

      // Overlay: Rauch von innen (grau), darüber Blend-Weiß des Ego-Spielers über dem Nachbild
      const s = Math.min(1, smokeOut.dens ** 0.8 * 1.05) * 0.97, g = 0.85 * (1 - Math.exp(-smokeOut.light * 1.1)) ** 0.45
      ov.color.set(g, g, g, s); ov.mesh.visible = s > 0.002
      flashFresh = false
      if (flash <= 0) { flashEv = -1; flashTex = null; flashAsk = 0 } else if (flashAsk > 0) { flashAsk--; flashTex = ctx.captureFrame!(); if (flashTex) flashAsk = 0; flashFresh = true }
      // Nachbild klingt langsamer ab als das Weiß (Annahme: Kurven stehen im Spielcode, nicht in Dateien)
      const shotA = flashTex && !flashFresh ? Math.sqrt(flash) : 0
      fl.color.set(1, 1, 1, flashFresh ? 0 : flash); fl.tex.value = flashTex; fl.shot.value = shotA
      post.visible = !flashFresh && (flash > 0.002 || shotA > 0.002)
      if (c4m) c4m.visible = c4vis
      if (c4emit) c4emit.emissive.setRGB(c4on ? 6 : 0, c4on ? 0.3 : 0, c4on ? 0.2 : 0)
      for (let t = 0; t < nadeModels.length; t++) { const pool = nadeModels[t]; if (pool) for (let k = nadeUsed[t]; k < NADE_POOL; k++) pool[k].obj.visible = false }
      nadeUsed.fill(0)

      nades.count = nades_n; c4.count = c4_n
      if (nades_n) { nades.instanceMatrix.needsUpdate = true; nades.instanceColor!.needsUpdate = true }
      if (c4_n) c4.instanceMatrix.needsUpdate = true
      glow.flush(); puff.flush(); streak.flush(); decals.flush()
      lights.flush(cam)
      smoke.end()
      smoke.work(3); fire.work(1)
      const o = getOptions()
      trails.update(tick, o.xray && o.nadeTrails, camera)
      impacts.update(tick, o.impacts, camera)
    },
    pending: () => smoke.pending() || fire.pending() || impacts.pending() || flashFresh || decBehind,
    dispose() {
      disposed = true
      smoke.dispose(); fire.dispose(); trails.dispose(); impacts.dispose()
      for (const o of [c4m, ...nadeModels.flat().map(x => x?.obj)]) o?.removeFromParent()
      for (const o of [c4m, ...nadeModels.flat().map(x => x?.obj)]) o?.traverse(o => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        m.geometry.dispose()
        for (const x of [m.material].flat()) { for (const v of Object.values(x)) if (v instanceof THREE.Texture) v.dispose(); x.dispose() }
      })
      for (const m of [glow.mesh, puff.mesh, streak.mesh, decals.mesh, nades, c4, ov.mesh, fl.mesh]) {
        m.removeFromParent(); m.geometry.dispose(); (m.material as THREE.Material).dispose()
      }
      shared.uNoise.value.dispose()
      for (const l of ctx.lights) l.intensity = 0
    },
  }
}
