// Ego-Sicht wie CS2 (Port von spike/fp/viewmodel/render/viewmodel.mjs): Arme des Fokus-Agenten (Ärmel + Handschuhe) und die Waffe
// mit Skelett, bewegt von echten CS2-Viewmodel-Clips. Eigene Szene nach der Welt (clearDepth, viewmodel_fov 68): ragt nie in Wände.
// Szene ist welt-orientiert um das Auge (Kamera im Ursprung mit der Drehung der Welt-Kamera) → Sonne/Ambient-Cube gelten unverändert.
// Zustand ist eine reine Funktion des Ticks (vmStateAt aus der Aktions-Zeitleiste actions.ts): sprungsicher wie der Rest des Replays.
import * as THREE from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { FLAG, type CS3D } from '../../../shared/cs3d'
import type { VmRole, WeaponAsset, WeaponAssets } from '../../../shared/assets3d'
import { HU } from '../contracts'
import { actionsOf, vmRole } from '../actions'
import { SkinSlot, adopt, bindGlove, type AgentUniforms, type BoundGlove } from './agents'
import type { SkinTex } from './skins'

const D2R = Math.PI / 180
/**
 * viewmodel_fov (horizontal bei 4:3 wie CS) und viewmodel_offset_x/y/z (u). Pro Spieler aus der Demo (Player3D.vm), sonst CS2-Standard
 * (viewmodel_presetpos 1, gemessen bei 4 von 10 Spielern unverändert).
 */
export const VM_DEFAULT = { fov: 60, x: 1, y: 1, z: -1 }
/** wpn-Bone liegt im Source-Raum, Waffen-Root trägt P → Gruppe P⁻¹ unter wpn */
const P_INV = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5)
/** AWP, G3SG1, SCAR-20, SSG 08: im Zoom kein Viewmodel (HUD zeigt das Zielfernrohr) */
const SNIPER = new Set([9, 11, 38, 40])
const FADE_IN = 0.1, FADE_OUT = 0.15, FLASH_S = 0.035
/** Schritt-Bob: ein Links-rechts-Zyklus = zwei Schritte wie der Lauf-Clip der Agenten (s) */
const BOB_CYCLE = 0.7333

type Vm = NonNullable<WeaponAsset['vm']>
export interface VmTemplate { scene: THREE.Object3D; clips: THREE.AnimationClip[] }
/** t = Sekunden seit Aktionsstart, n = Patronen (Schrotflinten-Nachladen), prev = Aktion davor (Überblendung) */
export interface VmState { def: number; action: VmRole; t: number; empty: boolean; n?: number; prev?: { action: VmRole; t: number; n?: number } }
interface Split { arms: THREE.AnimationClip; wpn: THREE.AnimationClip }
interface Gun { obj: THREE.Object3D; mixer: THREE.AnimationMixer; clips: Map<string, Split>; actions: Map<string, THREE.AnimationAction[]>; silencer?: THREE.Object3D; slot: SkinSlot }

const vfov = (fov: number) => (2 * Math.atan(Math.tan((fov / 2) * D2R) * 0.75)) / D2R

export class Viewmodel {
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(vfov(VM_DEFAULT.fov), 16 / 9, 0.01, 10)
  /** Ambient-Cube + Sonnen-Sichtbarkeit, je Bild vom Fokus-Agenten kopiert */
  readonly u: AgentUniforms = { csdaCube: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0.5, 0.5, 0.5)) }, csdaSunVis: { value: 1 } }
  /** Bob/Versatz/Nachziehen im Kamera-Raum (über der Spiegelung für Linkshänder) */
  private readonly sway = new THREE.Group()
  private readonly pivot = new THREE.Group()
  private readonly root: THREE.Object3D
  private readonly bones: Record<string, THREE.Object3D> = {}
  private readonly wpnGroup = new THREE.Group()
  private readonly mixer: THREE.AnimationMixer
  /** Schlüssel def bzw. −def für das Legacy-Mesh */
  private readonly guns = new Map<number, Gun>()
  private readonly armActions = new Set<THREE.AnimationAction>()
  private readonly flash: THREE.Sprite
  private readonly defaultGloves: THREE.Object3D | undefined
  private readonly gloves = new Map<number, BoundGlove | null>()
  private shown: BoundGlove | null = null
  private cur: Gun | null = null

  /** sun: Richtung zur Sonne (three-Welt), Farbe/Intensität wie die Welt-Sonne. Eine feste Lichtquelle (keine Shader-Neubauten). */
  constructor(arms: THREE.Object3D, sun: THREE.DirectionalLight, flashTex: THREE.Texture) {
    this.pivot.rotation.set(0, Math.PI, 0) // Modell-vorwärts +Z → Kamera-vorwärts −Z
    this.camera.add(this.sway); this.sway.add(this.pivot); this.scene.add(this.camera)
    const s = new THREE.DirectionalLight(sun.color, sun.intensity)
    s.position.copy(sun.position).sub(sun.target.position).normalize()
    this.scene.add(s, s.target)
    this.root = cloneSkinned(arms)
    this.root.traverse(o => { this.bones[o.name] ??= o })
    adopt(this.root, this.u)
    this.defaultGloves = this.root.getObjectByName('firstperson_default_gloves_arms')
    this.wpnGroup.quaternion.copy(P_INV); this.bones.wpn?.add(this.wpnGroup)
    this.pivot.add(this.root)
    this.settings(VM_DEFAULT, false)
    this.mixer = new THREE.AnimationMixer(this.root)
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xffc070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }))
    this.flash.visible = false; this.scene.add(this.flash)
  }

  /** viewmodel_fov/offset des Fokus-Spielers; left = cl_righthand 0: alles spiegeln (auch offset_x, gegen CS2 nicht geprüft) */
  settings(v: { fov: number; x: number; y: number; z: number }, left: boolean) {
    const f = vfov(v.fov)
    if (this.camera.fov !== f) { this.camera.fov = f; this.camera.updateProjectionMatrix() }
    this.root.position.set(-v.x * HU, v.z * HU, v.y * HU)
    this.pivot.scale.x = left ? -1 : 1 // negative Determinante: three dreht die Dreieck-Orientierung selbst um
  }
  /** Handschuh-Skin: viewmodel-Mesh des Handschuh-Modells (mit nackten Armen) statt firstperson_default_gloves_arms */
  glove(def: number, tpl: THREE.Object3D | undefined, tex: SkinTex | null) {
    let g = this.gloves.get(def)
    if (g === undefined && tex && tpl) this.gloves.set(def, (g = bindGlove(tpl, 'viewmodel', this.bones, this.root, this.u)))
    const on = tex && !tex.dead && g ? g : null
    if (on !== this.shown) {
      if (this.shown) this.shown.root.visible = false
      if (on) on.root.visible = true
      if (this.defaultGloves) this.defaultGloves.visible = !on
      this.shown = on
    }
    on?.slot.set(tex)
  }

  /** Waffe einmal klonen und anhängen (unsichtbar, damit compileAsync sie vorab übersetzt); key = def, −def = Legacy-Mesh */
  addWeapon(key: number, tpl: VmTemplate) {
    const obj = cloneSkinned(tpl.scene)
    adopt(obj, this.u)
    obj.visible = false; this.wpnGroup.add(obj)
    // Spuren auf Bones der Waffe → eigener Mixer je Waffe (gleiche Namen in jeder Waffe), Rest an die Arme; Unbekanntes weg (NM-Hilfsbones)
    const node = (t: THREE.KeyframeTrack) => t.name.slice(0, t.name.lastIndexOf('.'))
    const clips = new Map<string, Split>()
    for (const c of tpl.clips) {
      const d = Math.max(c.duration, 1 / 30) // Idle mit einem Key hat Dauer 0
      const w = c.tracks.filter(t => obj.getObjectByName(node(t))), a = c.tracks.filter(t => !obj.getObjectByName(node(t)) && this.bones[node(t)])
      clips.set(c.name, { arms: new THREE.AnimationClip(c.name, d, a), wpn: new THREE.AnimationClip(c.name, d, w) })
    }
    this.guns.set(key, { obj, mixer: new THREE.AnimationMixer(obj), clips, actions: new Map(), silencer: obj.getObjectByName('silencer'), slot: SkinSlot.weapon(obj, this.u) })
  }

  /**
   * Pose aus dem Tick-Zustand; key = Waffe (addWeapon), vm = Clip-Rollen/Dauern der Waffe, clock = Demo-Sekunde (Idle-Schleifen),
   * silenced = Schalldämpfer drauf, muzzle = Mündung im Waffen-Root (glTF m) für das Mündungsfeuer, skin passend zum Mesh von key.
   */
  pose(s: VmState, key: number, vm: Vm, clock: number, silenced: boolean, muzzle: [number, number, number] | undefined, skin: SkinTex | null) {
    const g = this.guns.get(key)
    if (!g) return
    if (g !== this.cur) {
      if (this.cur) this.cur.obj.visible = false
      g.obj.visible = true; this.cur = g
    }
    g.slot.set(skin)
    for (const a of this.armActions) a.setEffectiveWeight(0)
    for (const a of g.actions.values()) a[1].setEffectiveWeight(0)
    for (let i = 0, nl = layers(vm, s, clock); i < nl; i++) {
      const name = LAYERS[i][0], t = LAYERS[i][1], w = LAYERS[i][2]
      let a = g.actions.get(name)
      if (!a) {
        const c = g.clips.get(name)
        if (!c) continue
        a = [this.mixer.clipAction(c.arms), g.mixer.clipAction(c.wpn)]
        for (const x of a) { x.play(); x.setEffectiveWeight(0) }
        this.armActions.add(a[0]); g.actions.set(name, a)
      }
      for (const x of a) { x.setEffectiveWeight(w); x.time = Math.min(Math.max(t, 0), x.getClip().duration) }
    }
    this.mixer.update(0); g.mixer.update(0)
    if (g.silencer) g.silencer.scale.setScalar(silenced ? 1 : 0) // nach dem Mixer: Clips setzen die Skalierung sonst zurück
    // weapon_fire der Granate = Abwurf (über- oder unterhand): Hand bis Clip-Ende leer, danach die nächste Granate gleicher Art
    const cn = vm.roles[s.action]
    g.obj.visible = !(cn?.startsWith('throw_') && s.t < (vm.dur[cn] ?? 0))
    const fire = (s.action === 'shoot' || s.action === 'shoot_last') && s.t < FLASH_S && muzzle
    this.flash.visible = !!fire
    if (fire) {
      this.camera.updateMatrixWorld(true)
      const wb = g.obj.getObjectByName('weapon') ?? g.obj
      this.flash.position.set(muzzle[0], muzzle[1], muzzle[2]).applyQuaternion(P_INV).applyMatrix4(wb.matrixWorld)
      this.flash.scale.setScalar((silenced ? 0.04 : 0.13) * (1 - (0.4 * s.t) / FLASH_S))
      this.flash.material.rotation = s.t * 977 + s.def
    }
  }
  /**
   * Bewegung wie CS2, dezent und rein aus dem Tick (sprungsicher): Schritt-Bob nach Tempo, Versatz gegen Lauf-/Strafe-Richtung und
   * beim Springen/Fallen, Nachziehen beim Drehen. right/fwd/up = Geschwindigkeit (u/s) in Blick-Achsen, dyaw/dpitch = Drehung (°) in
   * den letzten 0.1 s (yaw + = links, pitch + = runter), clock = Demo-Sekunde.
   * shortcut: Amplituden nach Augenmaß (CS:GO cl_bob*-Größenordnung), nicht gegen CS2-Bilder gemessen
   */
  move(right: number, fwd: number, up: number, dyaw: number, dpitch: number, clock: number) {
    const c = (v: number, m = 1) => THREE.MathUtils.clamp(v, -m, m)
    const sp = Math.min(1, Math.hypot(right, fwd) / 250), sn = Math.sin((clock / BOB_CYCLE) * 2 * Math.PI)
    // Kamera-Raum in u: x rechts, y hoch, z zurück
    this.sway.position.set(0.4 * sp * sn - 0.5 * c(right / 250), -0.25 * sp * sn * sn - 0.3 * sp - 0.6 * c(up / 300), 0.3 * c(fwd / 250)).multiplyScalar(HU)
    this.sway.rotation.set(c(0.08 * dpitch, 2) * D2R, c(-0.08 * dyaw, 2.5) * D2R, 0)
  }
  /** Ambient-Cube/Sonne des Fokus-Agenten übernehmen, Drehung der Welt-Kamera folgen */
  sync(main: THREE.Camera, light: AgentUniforms) {
    for (let i = 0; i < 6; i++) this.u.csdaCube.value[i].copy(light.csdaCube.value[i])
    this.u.csdaSunVis.value = light.csdaSunVis.value
    this.camera.quaternion.copy(main.quaternion); this.camera.updateMatrixWorld(true)
  }
  /** über die schon gezeichnete Welt (gleicher Canvas) */
  render(renderer: THREE.WebGLRenderer, aspect: number) {
    if (this.camera.aspect !== aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix() }
    const ac = renderer.autoClear
    renderer.autoClear = false
    renderer.clearDepth()
    renderer.render(this.scene, this.camera)
    renderer.autoClear = ac
  }
}

/** Ausgabe von layers(): [Clip, Zeit, Gewicht], fest vorbelegt (keine Allokation pro Bild) */
export const LAYERS: [string, number, number][] = [['', 0, 0], ['', 0, 0]]
const put = (i: number, name: string, t: number, w: number) => { const l = LAYERS[i]; l[0] = name; l[1] = t; l[2] = w; return i + 1 }
/** Schrotflinten-Nachladen: Intro, n × Ladeschleife (vm.win.loop), Outro → Länge und Clip-Zeit zur Zeit t seit Aktionsstart */
const loopOf = (vm: Vm, name: string, n: number | undefined) => (n ?? 0) > 1 ? vm.win?.[name]?.loop : undefined
const lenOf = (vm: Vm, name: string, n?: number) => { const lp = loopOf(vm, name, n); return (vm.dur[name] ?? 0) + (lp ? (n! - 1) * (lp[1] - lp[0]) : 0) }
function clipAt(vm: Vm, name: string, t: number, n?: number) {
  const lp = loopOf(vm, name, n)
  if (!lp || t < lp[0]) return t
  const L = lp[1] - lp[0]
  return t < lp[0] + n! * L ? lp[0] + ((t - lp[0]) % L) : t - (n! - 1) * L
}

/**
 * Ebenen in LAYERS, Rückgabe = Anzahl: Aktion 0.1 s einblenden, nach Clip-Ende 0.15 s zurück nach Idle; gleicher Clip (Spray) ohne
 * Blende; pullpin hält den letzten Frame bis zum Wurf; Inspect läuft bis Clip-Ende oder bis die nächste Aktion übernimmt.
 */
export function layers(vm: Vm, s: VmState, clock: number): number {
  const idle = (s.empty && vm.roles.idle_empty) || vm.roles.idle!, idleT = clock % Math.max(vm.dur[idle] ?? 0, 1e-3)
  const name = vm.roles[s.action] ?? idle, end = vm.dur[name] ?? 0, dur = lenOf(vm, name, s.n)
  if (name === idle) return put(0, idle, idleT, 1)
  if (s.t >= dur) {
    if (s.action === 'pullpin') return put(0, name, end, 1)
    const k = Math.min(1, (s.t - dur) / FADE_OUT)
    return k >= 1 ? put(0, idle, idleT, 1) : put(put(0, name, end, 1 - k), idle, idleT, k)
  }
  const t = clipAt(vm, name, s.t, s.n), k = Math.min(1, s.t / FADE_IN)
  if (k >= 1 || s.action === 'draw') return put(0, name, t, 1) // draw kommt von unten ins Bild
  let from = idle, ft = idleT
  const pv = s.prev, pn = pv && vm.roles[pv.action]
  if (pv && pn && pn !== idle && (pv.action === 'pullpin' || pv.t < lenOf(vm, pn, pv.n) + FADE_OUT)) { from = pn; ft = Math.min(clipAt(vm, pn, pv.t, pv.n), vm.dur[pn] ?? 0) }
  if (from === name) return put(0, name, t, 1)
  return put(put(0, from, ft, 1 - k), name, t, k)
}

const ST: VmState = { def: 0, action: 'idle', t: 0, empty: false }, PREV: NonNullable<VmState['prev']> = { action: 'idle', t: 0 }
/**
 * Viewmodel-Zustand von Spieler p (Spur k in Runde r) bei tick; null = keins (tot, Zoom mit Scharfschützengewehr, keine Ego-Waffe).
 * Aktion aus actionsOf (laufende Aktion, fehlende Rolle → nächstbeste); seit Rundenstart ohne Aktion = idle.
 * Rückgabe ist ein wiederverwendetes Objekt: gilt bis zum nächsten Aufruf.
 */
export function vmStateAt(d: CS3D, r: number, k: number, p: number, tick: number, weapons: WeaponAssets): VmState | null {
  const H = d.header, R = H.rounds[r], n = R.nFrames, rate = H.tickrate, fb = d.frameBase[r] + k * n
  const fi = Math.max(0, Math.min(n - 1, Math.floor((tick - R.firstTick) / H.frameStep)))
  const fl = d.flags[fb + fi], def = d.weapon[fb + fi], roles = weapons[def]?.vm?.roles
  if (!(fl & FLAG.alive) || !roles?.idle || (fl & FLAG.scoped && SNIPER.has(def))) return null
  const A = actionsOf(d, weapons), a = A.at(p, tick)
  ST.def = def; ST.empty = d.ammo[fb + fi] === 0; ST.prev = undefined
  if (!a || a.def !== def) { ST.action = 'idle'; ST.t = 0; ST.n = undefined; return ST }
  ST.action = vmRole(a.kind, roles); ST.t = (tick - a.t0) / rate; ST.n = a.n
  const b = A.at(p, a.t0 - 1)
  if (b && b.def === def) { PREV.action = vmRole(b.kind, roles); PREV.t = (tick - b.t0) / rate; PREV.n = b.n; ST.prev = PREV }
  return ST
}
