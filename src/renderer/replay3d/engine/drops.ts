// Liegende Waffen (CS3D v6 drop.*, parse3d dropsOf): Weltmodell der Waffe mit Skin, Flug aus der Hand bis zum ersten Aufprall, kurzer
// Hüpfer zum Liegeplatz, dort flach auf der Seite (C4/Set flach), bis jemand sie aufhebt oder die Runde endet.
// Aufprall/Liegeplatz kommen meist aus dem Aufprall-Sound der Demo; sonst Flug mit der geschätzten Abwurf-Geschwindigkeit gegen
// Boden-Raster und Raycast. Modelle teilen Geometrie/Texturen mit den Vorlagen (Klon wie Agent.setWeapon), Licht aus den Sonden am
// Liegeplatz. Gebaut wird erst beim ersten Sichtbarwerden; je Bild nur die Abwürfe der letzten ROUND_MAX s.
import * as THREE from 'three'
import { upperBound, type CS3D } from '../../../shared/cs3d'
import { floorLayer, type FloorGrid } from '../../../shared/assets3d'
import { HU, worldToGltf } from '../contracts'
import { adopt, SkinSlot, type AgentUniforms, type WeaponTemplate } from './agents'
import type { Raycast } from './raycast'
import type { SkinCache } from './skins'

const D2R = Math.PI / 180
/** sv_gravity (u/s²) */
const G = 800
/** Hüpfer vom ersten Aufprall zum Liegeplatz (s) */
const HOP = 0.3
/** längste Runde (s): ältere Abwürfe liegen sicher nicht mehr */
const ROUND_MAX = 200
/** glTF-Waffenmodell → Source-Achsen (agents.ts WEAPON_Q); invers: Source → three-Welt */
const WEAPON_Q = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5), SRC_TO_THREE = WEAPON_Q.clone().invert()
const C4 = 49, DEFUSER = 55
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _b = new THREE.Box3()

interface Item {
  root: THREE.Group; tpl: WeaponTemplate; u: AgentUniforms
  /** Klone je Schlüssel def (hd) bzw. −def (Legacy-Mesh für Legacy-Skins) */
  objs: Map<number, { obj: THREE.Object3D; slot: SkinSlot }>
  key: number
  /** Flug: Abwurf o (Source), Startgeschwindigkeit v, Zeit bis zum ersten Aufprall t1 (s), Aufprall i, Liegeplatz r (Füße am Boden) */
  o: THREE.Vector3; v: THREE.Vector3; t1: number; i: THREE.Vector3; r: THREE.Vector3
  q0: THREE.Quaternion; q1: THREE.Quaternion
  /** Versatz (three) am Liegeplatz, damit das Modell mittig auf dem Boden liegt; null = noch nicht gemessen */
  lift: THREE.Vector3 | null
}

export interface Drops { update(tick: number): void }

/** group liegt in der Szene; die Engine räumt Materialien/Geometrie beim dispose über die Szene ab */
export function createDrops(scene: THREE.Scene, d: CS3D, templates: Map<number, WeaponTemplate>, skins: SkinCache, grid: FloorGrid, ray: Raycast): Drops {
  const D = d.drop, n = D.tick.length, rate = d.header.tickrate, R = d.header.rounds
  const group = new THREE.Group()
  group.name = 'drops'
  scene.add(group)
  const items: (Item | null | undefined)[] = new Array(n) // undefined = noch nicht gebaut, null = kein Modell
  // Ende = Aufheben, sonst letzter Frame der Runde des Abwurfs
  const ends = Float64Array.from(D.tick, (t, i) => {
    if (D.end[i]) return D.end[i]
    let r = R.length - 1
    while (r > 0 && R[r].firstTick > t) r--
    return R[r].firstTick + R[r].nFrames * d.header.frameStep
  })
  let shown: Item[] = []

  /** Boden (Source-z) unter (x,y) ab Höhe z, sonst z */
  const floorZ = (x: number, y: number, z: number) => { const l = floorLayer(grid, x, y, z + 8, 400); return l < 0 ? z : grid.z[l] }

  function build(i: number): Item | null {
    const def = D.def[i], tpl = templates.get(def)
    if (!tpl?.scene) return null
    const o = new THREE.Vector3(D.x[i], D.y[i], D.z[i]), v = new THREE.Vector3(D.vx[i], D.vy[i], D.vz[i])
    let t1: number, imp: THREE.Vector3, rest: THREE.Vector3
    if (D.land[i] > D.tick[i]) {
      // Aufprall aus der Demo: Parabel durch Abwurf und ersten Aufprall
      t1 = (D.land[i] - D.tick[i]) / rate
      imp = new THREE.Vector3(D.ix[i], D.iy[i], D.iz[i]); rest = new THREE.Vector3(D.rx[i], D.ry[i], D.rz[i])
      v.subVectors(imp, o).divideScalar(t1); v.z += 0.5 * G * t1
    } else {
      ;[t1, imp] = fly(o, v)
      rest = imp.clone()
    }
    rest.z = floorZ(rest.x, rest.y, rest.z)
    // liegt auf der Seite (Seite je Abwurf fest), C4/Set flach; Richtung = Flug, sonst je Abwurf fest gestreut
    const yaw = Math.hypot(v.x, v.y) > 30 ? Math.atan2(v.y, v.x) : ((D.tick[i] * 7919 + def * 104729) % 360) * D2R
    const roll = def === C4 || def === DEFUSER ? 0 : (i & 1 ? 90 : -90) * D2R
    const q0 = new THREE.Quaternion().setFromEuler(_e.set(0, 0, yaw, 'ZYX'))
    const q1 = new THREE.Quaternion().setFromEuler(_e.set(roll, 0, yaw + ((i * 37) % 40 - 20) * D2R, 'ZYX'))
    const root = new THREE.Group(), u: AgentUniforms = { csdaCube: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0.5, 0.5, 0.5)) }, csdaSunVis: { value: 1 } }
    root.matrixAutoUpdate = false
    light(grid, rest, u)
    group.add(root)
    return { root, tpl, u, objs: new Map(), key: NaN, o, v, t1, i: imp, r: rest, q0, q1, lift: null }
  }

  /** ohne Aufprall-Sound: Flug mit v gegen Boden-Raster (Boden) und Raycast (Wände) → [Flugzeit, Aufprallpunkt] */
  function fly(o: THREE.Vector3, v0: THREE.Vector3): [number, THREE.Vector3] {
    const p = o.clone(), v = v0.clone(), dt = 1 / 64, a = new THREE.Vector3(), dir = new THREE.Vector3()
    for (let t = dt; t < 3; t += dt) {
      const nx = p.x + v.x * dt, ny = p.y + v.y * dt, h = Math.hypot(v.x, v.y) * dt
      if (h > 0.01) {
        worldToGltf(p.x, p.y, p.z, a); worldToGltf(v.x, v.y, 0, dir).normalize()
        if (ray(a, dir, (h + 4) * HU) < Infinity) { v.x = v.y = 0; continue } // Wand: fällt senkrecht weiter
      }
      const fz = floorZ(nx, ny, p.z)
      p.set(nx, ny, p.z + v.z * dt); v.z -= G * dt
      if (p.z <= fz) { p.z = fz; return [t, p] }
    }
    return [3, p]
  }

  function place(it: Item, tick: number, i: number) {
    const T = (tick - D.tick[i]) / rate, hop = T - it.t1, r = it.root
    if (T < it.t1) {
      _v.set(it.o.x + it.v.x * T, it.o.y + it.v.y * T, it.o.z + it.v.z * T - 0.5 * G * T * T)
      _q.slerpQuaternions(it.q0, it.q1, T / (it.t1 + HOP))
    } else if (hop < HOP) {
      const k = hop / HOP
      _v.lerpVectors(it.i, it.r, k); _v.z += Math.sin(k * Math.PI) * Math.min(12, it.i.distanceTo(it.r) * 0.3)
      _q.slerpQuaternions(it.q0, it.q1, (it.t1 + hop) / (it.t1 + HOP))
    } else { _v.copy(it.r); _q.copy(it.q1) }
    worldToGltf(_v.x, _v.y, _v.z, r.position)
    r.quaternion.copy(SRC_TO_THREE).multiply(_q)
    if (hop >= HOP) {
      // am Liegeplatz: einmal messen, dann mittig mit der Unterseite auf den Boden
      r.updateMatrix(); r.updateMatrixWorld(true)
      if (!it.lift) {
        _b.setFromObject(it.objs.get(it.key)?.obj ?? r)
        it.lift = new THREE.Vector3(r.position.x - (_b.min.x + _b.max.x) / 2, r.position.y - _b.min.y, r.position.z - (_b.min.z + _b.max.z) / 2)
      }
      r.position.add(it.lift)
    }
    r.updateMatrix()
  }

  /** Modell (hd bzw. Legacy für Legacy-Skins) mit Skin; wie Agent.setWeapon */
  function dress(it: Item, i: number) {
    let sk = skins.weapon(D.skin[i], D.def[i])
    if (sk?.legacy && !it.tpl.legacy) sk = null // Legacy-Modell fehlt: Vanilla statt Skin auf falschen UVs
    const key = sk?.legacy ? -D.def[i] : D.def[i]
    if (key !== it.key) {
      let m = it.objs.get(key)
      const src = key < 0 ? it.tpl.legacy : it.tpl.scene
      if (!m && src) {
        const obj = src.clone()
        obj.position.set(-it.tpl.asset.root[0], -it.tpl.asset.root[1], -it.tpl.asset.root[2])
        adopt(obj, it.u)
        obj.traverse(o => { if ((o as THREE.Mesh).isMesh) o.frustumCulled = true })
        const w = new THREE.Group(); w.quaternion.copy(WEAPON_Q); w.add(obj); it.root.add(w)
        it.objs.set(key, (m = { obj: w, slot: SkinSlot.weapon(obj, it.u) }))
      }
      for (const [k, o] of it.objs) o.obj.visible = k === key
      it.key = key; it.lift = null // Legacy-Mesh: anders groß
    }
    it.objs.get(key)?.slot.set(sk)
  }

  return {
    update(tick) {
      for (const it of shown) it.root.visible = false
      shown = []
      for (let i = upperBound(D.tick, tick - ROUND_MAX * rate); i < n && D.tick[i] <= tick; i++) {
        if (tick >= ends[i]) continue
        let it = items[i]
        if (it === undefined) it = items[i] = build(i)
        if (!it) continue
        dress(it, i)
        place(it, tick, i)
        it.root.visible = true
        it.root.updateMatrixWorld(true)
        shown.push(it)
      }
    },
  }
}

/** Ambient-Cube + Sonne aus probes.bin am Liegeplatz (wie Agent.light, einmal) */
function light(g: FloorGrid, p: THREE.Vector3, u: AgentUniforms) {
  const l = g.probes ? floorLayer(g, p.x, p.y, p.z + 8, 300) : -1
  if (l < 0) return
  const b = g.probes!, o = l * 19, f = (k: number) => (b[o + k] / 255) ** 2 * 4 * Math.PI
  u.csdaCube.value.forEach((c, i) => c.set(f(i * 3), f(i * 3 + 1), f(i * 3 + 2)))
  u.csdaSunVis.value = b[o + 18] / 255
}
