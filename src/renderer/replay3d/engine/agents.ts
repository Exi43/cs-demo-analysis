// CS2-Agenten (Port von agents/render/agentRuntime.mjs): eine Clip-GLB für alle Modelle (Bindung über Bone-Namen),
// 8-Richtungs-Blending relativ zum Blick (Laufen, Gehen mit Shift, Ducken), Sprung mit additivem Absprung/Landung,
// Pflanzen/Entschärfen, Oberkörper-Ebene mit den Welt-Clips der Waffe (Ziehen, Nachladen, Schießen, Granate, Messer),
// prozedurales Zielen, Blend-Reaktion (Arm vors Gesicht, worldmodel.vnmgraph 'flashed'), Ragdoll beim Tod (ragdoll.ts),
// Waffe an Bone 'wpn' mit Root-Versatz (Critic P0-1), Licht aus dem Sonden-Raster (Critic P0-2).
// Draw-Calls: Schatten (und X-Ray, xray.ts) zeichnet eine Hülle je Agent (alle Primitive eines Skeletts in einer Geometrie) statt 4–6
// Primitive, im Bild sind Primitive mit gleichem Material zusammengelegt; jedes Agenten-Mesh testet eine feste Kugel um das Becken (CULL),
// die Schattenkarte zusätzlich, ob der Schatten ins Bild fällt.
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { EV, FLAG, flashAt, upperBound, type CS3D, type TrackSample } from '../../../shared/cs3d'
import { floorLayer, type FloorGrid, type WeaponAnim, type WeaponAsset, type WorldRole } from '../../../shared/assets3d'
import type { Side } from '../../../shared/model'
import { worldToGltf, type Action, type ActionKind, type Jump, type LabelInfo } from '../contracts'
import { LIGHTS_BEGIN, SKY_REFL } from './map'
import { applyStickers, hangCharm } from './econ'
import { BASES, NP, PARTICLES, RP, basis, type RagdollInput, type RagdollSim } from './ragdoll'
import { applyFinish, type SkinTex } from './skins'

const D2R = Math.PI / 180
/** 8 Richtungen gegen den Uhrzeigersinn in 45°-Schritten; rel = Bewegungs-yaw − Blick-yaw */
const DIRS = ['n', 'nw', 'w', 'sw', 's', 'se', 'e', 'ne']
/** Bodengeschwindigkeit der Clips (u/s), per Fußkontakt gemessen (agents-Spike) */
const CLIP_SPEED = { run: 190, walk: 96, crouch: 55 }
/** Waffen-Meshes liegen im glTF-Raum, der wpn-Bone im Source-Raum → lokale Rotation P⁻¹ */
const WEAPON_Q = new THREE.Quaternion(0.5, 0.5, 0.5, 0.5)
const UP = new THREE.Vector3(0, 1, 0)
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion()
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4()
const SKEL_UPDATE = THREE.Skeleton.prototype.update
/** gleiche Knochen (Objekte) und gleiche inverse Bind-Matrizen = derselbe glTF-Skin */
const sameSkin = (a: THREE.Skeleton, b: THREE.Skeleton) =>
  a.bones.length === b.bones.length && a.bones.every((x, i) => x === b.bones[i] && a.boneInverses[i].equals(b.boneInverses[i]))

/** Kugel um das Becken im Raum der Wurzel (Füße, m; Ragdoll: Wurzel unter dem Becken): Körper und Waffe in der Hand; agent-page 'sphere' (user-demo, alle Runden
 *  und Spieler, 5652 Posen): Körper bis 1,36 m, Ecken der Waffen-Box bis 1,62 m (AWP) */
export const CULL = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.65)
/** Höhe (m), aus der ein Agenten-Schatten noch ins Bild fallen kann (Körper + Absatz darunter): Länge = SHADOW_H / sin(Sonnenhöhe) */
const SHADOW_H = 3
/** Frusta der Bild-Pässe (WebGLRenderer, auch Granaten-Kamera): nur sie testen Meshes ohne castShadow, alle anderen sind Schattenkarten */
const MAIN = new WeakSet<THREE.Frustum>()
/** zuletzt gesehenes Bild-Frustum: im Schatten-Pass desselben render() hält es noch die Ebenen der Kamera */
let view: THREE.Frustum | null = null
const _s = new THREE.Sphere(), _a = new THREE.Vector3()
/** Schatten der Kugel s (entlang der Lichtrichtung dir) im Frustum f? Konservativ: aus nur, wenn beide Enden hinter derselben Ebene liegen */
function shadowIn(f: THREE.Frustum, s: THREE.Sphere, dir: THREE.Vector3) {
  _a.copy(s.center).addScaledVector(dir, SHADOW_H / Math.max(0.2, -dir.y))
  for (let i = 0; i < 6; i++) { const p = f.planes[i]; if (p.distanceToPoint(s.center) < -s.radius && p.distanceToPoint(_a) < -s.radius) return false }
  return true
}
/** Material der Hülle: zeichnet nur in die Schattenkarte (Tiefen-Material von three, Seite von hier), im Bild nie */
const HULL_MAT = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
/** T mit IBM_main·T = IBM_s für alle Knochen (gleiche Knochen-Objekte; gltfpack faltet die Quantisierung je Mesh in die IBM), sonst null */
function skinOffset(main: THREE.Skeleton, s: THREE.Skeleton) {
  if (s.bones.length !== main.bones.length || s.bones.some((b, i) => b !== main.bones[i])) return null
  const T = main.boneInverses[0].clone().invert().multiply(s.boneInverses[0]), x = new THREE.Matrix4()
  const near = (a: THREE.Matrix4, b: THREE.Matrix4) => a.elements.every((e, k) => Math.abs(e - b.elements[k]) <= 1e-4 * Math.max(1, Math.abs(e)))
  return main.boneInverses.every((ib, i) => near(x.multiplyMatrices(ib, T), s.boneInverses[i])) ? T : null
}
const REBASED = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()
/** Geometrie für IBM_main statt IBM_s: Position T·p, Normale/Tangente mat3(T)·n (der Shader skinnt sie linear und normiert danach) */
function rebased(g: THREE.BufferGeometry, T: THREE.Matrix4) {
  let r = REBASED.get(g)
  if (!r) {
    r = g.clone()
    const m3 = new THREE.Matrix3().setFromMatrix4(T), v = new THREE.Vector3()
    for (const n of ['position', 'normal', 'tangent']) {
      const a = g.getAttribute(n)
      if (!a) continue
      const o = new Float32Array(a.count * a.itemSize)
      for (let i = 0; i < a.count; i++) {
        v.fromBufferAttribute(a, i)
        if (n === 'position') v.applyMatrix4(T); else v.applyMatrix3(m3)
        v.toArray(o, i * a.itemSize)
        if (a.itemSize === 4) o[i * 4 + 3] = a.getW(i)
      }
      r.setAttribute(n, new THREE.BufferAttribute(o, a.itemSize))
    }
    r.boundingBox = r.boundingSphere = null
    REBASED.set(g, r)
  }
  return r
}
/** Geometrien als eine: Attribute names als Float32 (skinIndex Uint16), Index Uint32; quantisierte Werte entpackt wie im Shader */
function flatMerge(gs: THREE.BufferGeometry[], names: readonly string[]) {
  return mergeGeometries(gs.map(s => {
    const o = new THREE.BufferGeometry()
    for (const n of names) {
      const a = s.getAttribute(n), k = a.itemSize, out = n === 'skinIndex' ? new Uint16Array(a.count * k) : new Float32Array(a.count * k)
      for (let i = 0; i < a.count; i++) for (let c = 0; c < k; c++) out[i * k + c] = a.getComponent(i, c)
      o.setAttribute(n, new THREE.BufferAttribute(out, k))
    }
    return o.setIndex(new THREE.BufferAttribute(Uint32Array.from(s.index!.array), 1))
  }))!
}
const HULLS = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()
/** Hülle je Vorlage (Schlüssel: Geometrie des ersten Teils, Klone teilen sie): Position, Normale (X-Ray-Umriss) und Skin aller Teile */
function hullGeometry(parts: THREE.SkinnedMesh[]) {
  let g = HULLS.get(parts[0].geometry)
  if (!g) HULLS.set(parts[0].geometry, (g = flatMerge(parts.map(p => p.geometry), ['position', 'normal', 'skinIndex', 'skinWeight'])))
  return g
}
/** Körper-Teil + Standard-Handschuh-Teil mit demselben Material (Schlüssel: Geometrie des Körper-Teils, Klone teilen sie) */
const JOINED = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()

/** Clip-Namen je Klasse einmal bauen (keine Strings pro Bild); Sprung-Additiv ohne Klasse = shared-Clip (Messer) */
const NAMES = Object.fromEntries((['rifle', 'pistol', 'knife'] as const).map(c => {
  const j = c === 'knife' ? '' : `_${c}`
  return [c, {
    run: DIRS.map(d => `run_${d}_${c}`), walk: DIRS.map(d => `walk_${d}_${c}`), crouch: DIRS.map(d => `crouch_${d}_${c}`),
    idle: `idle_${c}`, idleC: `idle_crouch_${c}`, air: `inair_stand_${c}`, airC: `inair_crouch_stand_${c}`,
    defuse: `defuse_loop_${c}`, defuseC: `defuse_crouch_loop_${c}`,
    start: `jump_additive_start${j}`, startC: `jump_additive_crouch_start${j}`, land: `jump_additive_land${j}`, landC: `jump_additive_crouch_land${j}`,
  }]
})) as Record<WeaponAnim, { run: string[]; walk: string[]; crouch: string[]; idle: string; idleC: string; air: string; airC: string; defuse: string; defuseC: string; start: string; startC: string; land: string; landC: string }>

type WorldBase = Exclude<WorldRole, `${string}_crouch`>
/** Rolle → Clip eines world/<klasse>.glb (worldClips); je Waffe einmal gebaut und von allen Agenten geteilt */
export type WorldClips = Partial<Record<WorldRole, THREE.AnimationClip>>
/** Aktion → Welt-Rollen, erste vorhandene gilt. inspect hat keinen Welt-Clip, plant läuft über den Fortbewegungs-Clip planting. */
const ROLES: Partial<Record<ActionKind, readonly WorldBase[]>> = {
  draw: ['draw'], shoot: ['shoot'], shoot_last: ['shoot'], shoot_right: ['shoot'], reload: ['reload'], reload_empty: ['reload_empty', 'reload'],
  light: ['swing'], light2: ['swing'], heavy: ['stab', 'swing'], hit: ['swing'], heavy_hit: ['stab', 'swing'], backstab: ['backstab', 'stab'],
  pullpin: ['pullpin'], throw: ['throw'], throw_under: ['throw_under', 'throw'], silencer_on: ['silencer_on'], silencer_off: ['silencer_off'],
}
const CROUCH = Object.fromEntries(Object.values(ROLES).flat().map(r => [r, `${r}_crouch`])) as Record<WorldBase, WorldRole>
/** Ein-/Ausblenden der Oberkörper-Ebene (s) */
const FADE_IN = 0.1, FADE_OUT = 0.15
/** Ausblenden τ s nach Start: nach dem Clip-Ende (letzter Frame hält) aus in FADE_OUT; hold = Pin hält bis zum Wurf */
const kOut = (tau: number, dur: number, hold: boolean) => (hold || tau <= dur ? 1 : Math.max(0, 1 - (tau - dur) / FADE_OUT))
const kOf = (tau: number, dur: number, hold: boolean) => Math.min(1, tau / FADE_IN) * kOut(tau, dur, hold)
/** Ebenen je Bild höchstens: 6 Fortbewegung + 4 Oberkörper (Aktion und Vorgänger, je stehend/geduckt) + 1 Sprung-Additiv */
const MAX_LAYERS = 16

/** Zuwachs der Schrittphase in dt s bei Tempo speed (u/s) wie die Lauf-Clips; die Engine summiert ihn je Runde (deterministisch) */
export function phaseInc(speed: number, crouch: boolean, walk: boolean, dt: number) {
  const ref = crouch ? CLIP_SPEED.crouch : walk ? CLIP_SPEED.walk : CLIP_SPEED.run
  return (dt * THREE.MathUtils.clamp(speed / ref, 0.5, 1.6)) / (crouch ? 0.8 : walk ? 1.0 : 0.7333)
}

/** Maske 'Flashed' (animation/skeletons/characters/worldmodel.vnmskel): Gewicht je Bone, Kinder erben; Becken, Beine, Waffe 0 */
const FLASH_MASK: Record<string, number> = { spine_0: 0.1, spine_1: 0.25, spine_2: 0.7, spine_3: 0.9, neck_0: 1, head_0: 1, clavicle_L: 1, arm_upper_L: 1, clavicle_R: 0.2 }
/**
 * Gewicht der Blend-Ebene wie worldmodel.vnmgraph 'flashed': Zustand an, sobald flashed_amount > 0,1 (Übergang 0,2 s linear), dann
 * flashed_amount 0,1..1 → 0..0,95. flashed_amount steht nicht in der Demo: Blendung flashAt (wie Bildschirm-Weiß und HUD).
 */
export function flashWeight(d: CS3D, p: number, tick: number) {
  const a = flashAt(d, p, tick)
  if (a <= 0.1) return 0
  const E = d.evt
  let i = upperBound(E.tick, tick) - 1
  while (i >= 0 && !(E.type[i] === EV.player_blind && E.player[i] === p)) i-- // a > 0 → es gibt eins (dasselbe wie in flashAt)
  const on = i < 0 || flashAt(d, p, E.tick[i] - 1) > 0.1 ? 1 : Math.min(1, (tick - E.tick[i]) / d.header.tickrate / 0.2)
  return on * 0.95 * Math.min(1, (a - 0.1) / 0.9)
}

/** die 15 PHYS-Körper: Bone, Elternkörper (−1 = Wurzel), Glied-Richtung Partikel a→b (Becken/Brust: Basis BASES[i]); Eltern vor Kindern */
const BODIES: readonly (readonly [string, number, number, number])[] = [
  ['pelvis', -1, -1, -1], ['spine_2', 0, -1, -1], ['head_0', 1, RP.headJ, RP.head],
  ['leg_upper_L', 0, RP.hipL, RP.kneeL], ['leg_lower_L', 3, RP.kneeL, RP.ankleL], ['ankle_L', 4, RP.ankleL, RP.ballL],
  ['leg_upper_R', 0, RP.hipR, RP.kneeR], ['leg_lower_R', 6, RP.kneeR, RP.ankleR], ['ankle_R', 7, RP.ankleR, RP.ballR],
  ['arm_upper_L', 1, RP.shL, RP.elbL], ['arm_lower_L', 9, RP.elbL, RP.wrL], ['hand_L', 10, RP.wrL, RP.handL],
  ['arm_upper_R', 1, RP.shR, RP.elbR], ['arm_lower_R', 12, RP.elbR, RP.wrR], ['hand_R', 13, RP.wrR, RP.handR],
]
/** Knie-/Ellbogen-Achse = Bone-Z dieser Bones (ragdoll.ts RagdollInput.hinge) */
const HINGE_BONES = ['leg_upper_L', 'leg_upper_R', 'arm_upper_L', 'arm_upper_R']
/**
 * Ragdoll-Start aus der Todespose (Agent.ragdollStart) + Simulation: q0 = Welt-Drehung je Körper bei Tod (q0i invers), off = Elternkörper →
 * Eltern-Bone (Bones dazwischen frieren in der Todespose; Becken: Welt-Drehung seines Eltern-Bones), k = Körper relativ zur Partikel-Basis
 * (Becken, Brust), u0 = Glied-Richtung bei Tod
 */
export interface RagdollStart extends Omit<RagdollInput, 'v'> {
  q0: THREE.Quaternion[]; q0i: THREE.Quaternion[]; off: THREE.Quaternion[]; k: THREE.Quaternion[]; u0: THREE.Vector3[]
}
export interface Ragdoll extends RagdollStart { sim: RagdollSim }
const _B = new Float64Array(9)
/** Drehung der Partikel-Basis BASES[i] als Quaternion */
function basisQ(X: ArrayLike<number>, i: number, out: THREE.Quaternion) {
  const [a, b, c, d] = BASES[i]
  basis(X, a, b, c, d, _B)
  return out.setFromRotationMatrix(_m2.set(_B[0], _B[3], _B[6], 0, _B[1], _B[4], _B[7], 0, _B[2], _B[5], _B[8], 0, 0, 0, 0, 1))
}

/** Rollen-Tabelle (WeaponAsset.world.roles) + Clips des world-GLB → WorldClips; einmal je Waffe, dann an alle Agenten (setWorldClips) */
export function worldClips(roles: Partial<Record<WorldRole, string>>, clips: readonly THREE.AnimationClip[]): WorldClips {
  const out: WorldClips = {}
  for (const [r, n] of Object.entries(roles) as [WorldRole, string][]) { const c = clips.find(x => x.name === n); if (c) out[r] = c }
  // shoot_<waffe> ist ein Rückstoß-Additiv auf die Ruhepose (nur 15–53 Spuren, Frame 0 ≈ Ruhepose): als Ebene ersetzt läge die
  // Waffe ~1 m neben der Hand. Einmal je Clip additiv machen (Bezug Frame 0), danach addiert pose() es auf
  for (const r of ['shoot', 'shoot_crouch'] as const) { const c = out[r]; if (c && c.blendMode !== THREE.AdditiveAnimationBlendMode) THREE.AnimationUtils.makeClipAdditive(c) }
  return out
}

export interface AgentUniforms { csdaCube: { value: THREE.Vector3[] }; csdaSunVis: { value: number } }

/** Agent- und Waffen-Material: Ambient-Cube + Sonnen-Sichtbarkeit pro Agent, kein Hemisphere (Programm bleibt geteilt) */
function patchAgentMaterial(mat: THREE.Material, u: AgentUniforms) {
  // Himmels-Spiegelung (High, map.ts SKY_REFL) gilt ab dem Übersetzen; der Schlüssel trennt beide Programme
  mat.customProgramCacheKey = () => SKY_REFL.csdaReflSky.value ? 'csda-agent-r' : 'csda-agent'
  mat.onBeforeCompile = sh => {
    const refl = !!SKY_REFL.csdaReflSky.value
    sh.defines = { ...sh.defines, CSDA_AGENT: '', CSDA_SUNMASK: '', CSDA_NOHEMI: '', ...refl && { CSDA_SKYREFL: '' } } // Kopie, sonst zweites Übersetzen (map.ts patchMaterial)
    Object.assign(sh.uniforms, u, refl ? SKY_REFL : {})
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 csdaCube[ 6 ];\nuniform float csdaSunVis;' + (refl ? '\nuniform sampler2D csdaReflSky;\nuniform mat3 csdaReflRot;\nuniform float csdaReflInt;' : ''))
      .replace('#include <lights_fragment_begin>', 'float csdaSun = csdaSunVis;\n' + LIGHTS_BEGIN)
  }
}
/** Kopie mit eigenen (gepatchten) Materialien; Geometrie/Texturen geteilt */
export function adopt(root: THREE.Object3D, u: AgentUniforms) {
  root.traverse(o => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.castShadow = true; m.frustumCulled = false // Skinning-Bounds stimmen nicht
    const mats = (Array.isArray(m.material) ? m.material : [m.material]).map(src => {
      const c = src.clone()
      if ((c as THREE.MeshStandardMaterial).isMeshStandardMaterial) patchAgentMaterial(c, u)
      return c
    })
    m.material = Array.isArray(m.material) ? mats : mats[0]
  })
}

/**
 * Linke Pistole der Dual Berettas: Lage der rechten Waffe (right), um (Hand L − Hand R) verschoben, sichtbar wie sie. Als letztes Kind der
 * Agenten-Wurzel aktualisiert, also nach dem Skelett. shortcut: Ausrichtung = die der rechten Pistole; echte Lage käme aus dem Bone weapon_hand_l
 */
class LeftGun extends THREE.Group {
  constructor(gun: THREE.Object3D, private readonly right: THREE.Object3D, private readonly hold: THREE.Object3D, private readonly handR: THREE.Object3D, private readonly handL: THREE.Object3D) {
    super()
    this.matrixAutoUpdate = false
    this.add(gun) // aus dem Waffen-Klon herausnehmen; lokale Matrix bleibt (Lage wie die rechte Pistole im Modell)
  }
  private place() {
    this.visible = this.right.visible && this.hold.visible
    _v.setFromMatrixPosition(this.handL.matrixWorld).sub(_v2.setFromMatrixPosition(this.handR.matrixWorld))
    const e = this.matrixWorld.copy(this.right.matrixWorld).elements
    e[12] += _v.x; e[13] += _v.y; e[14] += _v.z
    for (const c of this.children) c.updateMatrixWorld(true)
  }
  override updateMatrixWorld() { this.place() }
  override updateWorldMatrix() { this.place() }
}

/**
 * Skin-Wechsel an Meshes (Waffe: erstes Mesh mit Textur = Körper, Aufkleber-Lücken/Zielfernrohr bleiben; Handschuh: glove_*).
 * Material je Skin einmal anlegen: Kopie des Vanilla-Materials mit Composite-Texturen, gleiche Shader-Features → kein neues Programm.
 */
/** Waffe für Aufkleber/Anhänger: je Körper-Mesh lokale Ecke → glTF-Wurzelraum in Ruhelage; Träger des Anhängers (Wurzel bzw. Bone weapon_offset) */
interface EconRig { toRoot: THREE.Matrix4[]; carrier: THREE.Object3D; carrierToRoot: THREE.Matrix4 }

export class SkinSlot {
  private readonly vanilla: THREE.Material[]
  private readonly mats = new Map<SkinTex, THREE.Material[]>()
  private cur: SkinTex | null = null
  private charm: THREE.Object3D | null = null
  constructor(private readonly meshes: THREE.Mesh[], private readonly u: AgentUniforms, private readonly rig?: EconRig) { this.vanilla = meshes.map(m => m.material as THREE.Material) }
  static weapon(root: THREE.Object3D, u: AgentUniforms) {
    // Körper = erstes Mesh mit Textur, dazu Meshes mit derselben Textur (Dual Berettas: linke Pistole 'left')
    const body: THREE.Mesh[] = []
    root.traverse(o => {
      const m = o as THREE.Mesh, map = m.isMesh && (m.material as THREE.MeshStandardMaterial).map
      if (map && (!body.length || map === (body[0].material as THREE.MeshStandardMaterial).map)) body.push(m)
    })
    // Ruhelage (frisch geklont): Skinned = Bone · inverse Bind · Bind-Matrix (Quantisierung steckt in den inversen Bind-Matrizen), sonst Knoten-Matrix
    root.updateMatrixWorld(true)
    const inv = root.matrixWorld.clone().invert(), sk = body.find(m => (m as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh | undefined
    const toRoot = body.map(m => {
      const s = m as THREE.SkinnedMesh
      return s.isSkinnedMesh ? inv.clone().multiply(s.skeleton.bones[0].matrixWorld).multiply(s.skeleton.boneInverses[0]).multiply(s.bindMatrix) : inv.clone().multiply(m.matrixWorld)
    })
    const carrier = sk ? sk.skeleton.bones.find(b => b.name === 'weapon_offset') ?? sk.skeleton.bones[0] : root
    return new SkinSlot(body, u, { toRoot, carrier, carrierToRoot: inv.clone().multiply(carrier.matrixWorld) })
  }
  set(t: SkinTex | null) {
    if (t?.dead) t = null
    if (t === this.cur) return
    for (const [k, ms] of this.mats) if (k.dead) { for (const m of ms) m.dispose(); this.mats.delete(k) }
    let ms = t && this.mats.get(t)
    if (t && !ms) this.mats.set(t, (ms = this.vanilla.map((v, i) => {
      const m = v.clone() as THREE.MeshStandardMaterial
      if (t.map) { m.map = t.map; m.color.setRGB(1, 1, 1) } // Handschuh-Grundmaterial ist nur eine dunkle Farbe
      if (t.orm) { m.roughnessMap = m.metalnessMap = t.orm; m.roughness = m.metalness = 1 }
      if (t.normal) m.normalMap = t.normal // Lack mit eigener Normal-Map ersetzt die der Waffe
      patchAgentMaterial(m, this.u)
      applyFinish(m, t.finish) // Perlglanz/Iridescence/Glitter/AO-Override (nur Waffen-Skins)
      if (t.stickers && this.rig) applyStickers(m, t.stickers, this.rig.toRoot[i])
      return m
    })))
    this.meshes.forEach((m, i) => { m.material = ms ? ms[i] : this.vanilla[i] })
    this.charm?.removeFromParent(); this.charm = null
    if (t?.charm && this.rig) this.charm = hangCharm(this.rig.carrier, this.rig.carrierToRoot, t.charm)
    this.cur = t
  }
}
/**
 * Handschuh-Modell (gloves/<m>.glb, Meshes viewmodel + worldmodel, Bones wie die Arme/Agenten) per Bone-Namen an ein anderes Skelett
 * binden (vm-Spike, glove_sporty geprüft); inverse Bind-Matrizen bleiben die des Handschuhs. Hilfs-Bone, den das Ziel nicht hat
 * (glove_motorcycle: attachHand_L/R unter hand_L/R): am Eltern-Bone mit seiner festen lokalen Matrix. Fehlt auch der: nichts.
 */
export function bindGlove(src: THREE.Object3D, part: 'viewmodel' | 'worldmodel', bones: Record<string, THREE.Object3D>, parent: THREE.Object3D, u: AgentUniforms) {
  src.updateMatrixWorld(true)
  const g = new THREE.Group()
  src.traverse(o => {
    const s = o as THREE.SkinnedMesh
    if (!s.isSkinnedMesh || !(s.name.endsWith(part) || s.parent?.name.endsWith(part))) return
    const bs = s.skeleton.bones.map(b => (bones[b.name] ?? bones[b.parent?.name ?? '']) as THREE.Bone | undefined)
    if (bs.some(b => !b)) return
    const m = new THREE.SkinnedMesh(s.geometry, s.material)
    m.name = (s.material as THREE.Material).name
    g.add(m)
    // Eltern · lokal · inverse(Hilfs-Bind) = Eltern · (lokal · inverse(Hilfs-Bind))
    const inv = s.skeleton.bones.map((b, i) => bones[b.name] ? s.skeleton.boneInverses[i].clone() : b.matrix.clone().multiply(s.skeleton.boneInverses[i]))
    m.bind(new THREE.Skeleton(bs as THREE.Bone[], inv), s.bindMatrix.clone())
  })
  if (!g.children.length) return null
  adopt(g, u)
  g.visible = false; parent.add(g)
  return { root: g, slot: new SkinSlot(g.children.filter(m => m.name.startsWith('glove_')) as THREE.Mesh[], u) }
}
export type BoundGlove = NonNullable<ReturnType<typeof bindGlove>>

export interface WeaponTemplate { asset: WeaponAsset; scene: THREE.Object3D | null; legacy?: THREE.Object3D | null }

export class Agent {
  readonly root: THREE.Object3D
  readonly bones: Record<string, THREE.Object3D> = {}
  readonly u: AgentUniforms = { csdaCube: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0.5, 0.5, 0.5)) }, csdaSunVis: { value: 1 } }
  private readonly mixer: THREE.AnimationMixer
  /** Actions erst bei der ersten Nutzung (Fortbewegung und Welt-Clips) */
  private readonly actions = new Map<THREE.AnimationClip, THREE.AnimationAction>()
  /** Welt-Clips je Waffe (def), geteilt mit den anderen Agenten */
  private readonly world = new Map<number, WorldClips>()
  // Ebenen dieses Bildes in festen Puffern (keine Allokation pro Bild); T < 0 = Schrittphase
  private readonly layA: (THREE.AnimationAction | null)[] = new Array(MAX_LAYERS).fill(null)
  private readonly layW = new Float64Array(MAX_LAYERS)
  private readonly layT = new Float64Array(MAX_LAYERS)
  private nLay = 0
  /** Ebenen des letzten Bildes (Gewicht auf 0, bevor die neuen gesetzt werden) */
  private readonly used: (THREE.AnimationAction | null)[] = new Array(MAX_LAYERS).fill(null)
  private nUsed = 0
  /** zuletzt gezeigte Aktion und ihr Vorgänger (Überblenden bei Unterbrechung) */
  private cur: Action | null = null
  private prev: Action | null = null
  private phase = 0
  private readonly wpnGroup = new THREE.Group()
  /** Schlüssel def bzw. −def für das Legacy-Mesh */
  private readonly weapons = new Map<number, { obj: THREE.Object3D; slot: SkinSlot } | null>()
  private weapon: WeaponTemplate | null = null
  private key = NaN
  private glove: BoundGlove | null | undefined // undefined = noch nicht gebunden
  private readonly defaultGloves: THREE.Object3D | undefined
  /** Körper-Teile, die ein Standard-Handschuh-Teil mitzeichnen (joined); mit Handschuh-Skin wieder nur own (setGlove) */
  private readonly joins: { m: THREE.SkinnedMesh; own: THREE.BufferGeometry; joined: THREE.BufferGeometry }[] = []
  /** per Hand gesetzte Bones (Zielen, Blend-Ebene, Ragdoll) vor mixer.update auf den letzten Mixer-Wert zurücksetzen: PropertyMixer schreibt nur bei Änderung */
  private readonly preAim: { b: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion }[]
  private aimed = false
  /** Blend-Ebene: Bones ab spine_0 (Eltern vor Kind, parent −1 = Becken), Maske w, Blend-Pose stehend/geduckt, Puffer im Modellraum; null = Clips fehlen */
  private readonly fl: {
    bones: THREE.Object3D[]; parent: number[]; w: number[]; stand: THREE.Quaternion[]; crouch: THREE.Quaternion[]; pel: THREE.Quaternion[]
    base: THREE.Quaternion[]; flash: THREE.Quaternion[]; out: THREE.Quaternion[]
  } | null = null
  /** Ragdoll-Partikel der Ruhepose (Bind, Raum der Wurzel); null = Bones fehlen */
  private readonly restX: Float32Array | null = null
  private readonly rx = new Float32Array(NP * 3)
  private readonly rq = BODIES.map(() => new THREE.Quaternion())
  /** wpn-Ursprung im Raum der rechten Hand je Klasse (toHand) */
  private readonly grip: Partial<Record<WeaponAnim, THREE.Vector3>> = {}
  private lit = false
  /** zählt pose(): Knochenmatrizen nur einmal je Pose rechnen (three ruft Skeleton.update je Pass: Welt, Schatten, Granaten-Kamera) */
  private poseN = 0
  // Frustum-Tests (Object3D.intersectsFrustum, three ruft sie je Pass und Mesh): keine Allokation, Pose läuft unabhängig weiter
  private inside(f: THREE.Frustum) { return f.intersectsSphere(_s.copy(CULL).applyMatrix4(this.root.matrixWorld)) }
  private shadow(f: THREE.Frustum) { return this.inside(f) && (!view || shadowIn(view, _s, f.planes[5].normal)) } // planes[5]: Nahebene = Lichtrichtung
  /** Meshes ohne castShadow (nur Bild-Pässe): melden das Frustum als Bild-Frustum */
  private readonly cullMain = (f: THREE.Frustum) => { MAIN.add(f); view = f; return this.inside(f) }
  /** Waffe und nicht zusammengelegte Teile: Bild wie cullMain, Schattenkarte wie die Hülle */
  private readonly cullAny = (f: THREE.Frustum) => (MAIN.has(f) ? this.inside(f) : this.shadow(f))
  /** Hülle: nur Schattenkarte */
  private readonly cullShadow = (f: THREE.Frustum) => !MAIN.has(f) && this.shadow(f)

  constructor(template: THREE.Object3D, private readonly clips: Map<string, THREE.AnimationClip>) {
    this.root = cloneSkinned(template)
    // je glTF-Skin EIN Skelett: GLTFLoader/SkeletonUtils legen je Primitive eins an (5–6 je Agent, gleiche Knochen).
    // Profil Abspielen: 7 % in Skeleton.update, davon die Hälfte doppelt im Schatten-Pass
    const skel: THREE.Skeleton[] = [], all: THREE.SkinnedMesh[] = []
    this.root.traverse(o => {
      if ((o as THREE.Bone).isBone) this.bones[o.name] = o
      const m = o as THREE.SkinnedMesh
      if (!m.isSkinnedMesh) return
      all.push(m)
      // Morph-Ziele der Körper (3, Gewicht 0, keine Clip-Spur) weg: gleiches Programm wie die Handschuhe, keine Morph-Textur
      // (Geometrie ist mit der Vorlage geteilt: ab dem zweiten Klon hat nur noch das Mesh die Gewichte)
      if (m.geometry.morphAttributes.position || m.morphTargetInfluences) { m.geometry.morphAttributes = {}; m.morphTargetInfluences = undefined; m.morphTargetDictionary = undefined }
      const s = skel.find(k => sameSkin(k, m.skeleton))
      if (s) { m.skeleton = s; return }
      // Handschuhe: gleiche Knochen, IBM um eine feste Matrix versetzt (Quantisierung je Mesh) → Geometrie umrechnen, ein Skelett je Agent
      const T = skel[0] && skinOffset(skel[0], m.skeleton)
      if (T) { m.geometry = rebased(m.geometry, T); m.skeleton = skel[0]; return }
      const k = m.skeleton
      let at = -1
      k.update = () => { if (at !== this.poseN) { at = this.poseN; SKEL_UPDATE.call(k) } }
      skel.push(k)
    })
    // Standard-Handschuh-Teil mit dem Material eines Körper-Teils (tm_leet: bare_arm_133 = Hände + Unterarme), gleichem Skelett, gleicher
    // Bindung und Lage: im Bild eine Geometrie, ein Draw-Call weniger. Mit Handschuh-Skin zeichnet der Körper-Teil wieder nur sich (setGlove).
    const dg = (this.defaultGloves = this.root.getObjectByName('thirdperson_default_gloves'))
    const inDg = (o: THREE.Object3D | null) => { for (; o; o = o.parent) if (o === dg) return true; return false }
    this.root.updateMatrixWorld(true)
    if (PARTICLES.every(([n]) => this.bones[n]) && BODIES.every(([n]) => this.bones[n])) this.restX = this.particles(new Float32Array(NP * 3))
    for (const g of all) {
      if (g === dg || !inDg(g)) continue // einzelnes Primitiv = der Knoten selbst, den setGlove umschaltet
      const b = all.find(m => !inDg(m) && m.material === g.material && m.skeleton === g.skeleton && m.bindMode === g.bindMode &&
        m.bindMatrix.equals(g.bindMatrix) && m.matrixWorld.equals(g.matrixWorld))
      const names = b && Object.keys(b.geometry.attributes).filter(n => !n.startsWith('_')) // _texcoord_2/_color_1 liest kein Shader
      if (!b || !names!.every(n => g.geometry.attributes[n]) || !b.geometry.index || !g.geometry.index) continue
      let joined = JOINED.get(b.geometry)
      if (!joined) JOINED.set(b.geometry, (joined = flatMerge([b.geometry, g.geometry], names!)))
      this.joins.push({ m: b, own: b.geometry, joined }); b.geometry = joined; g.visible = false
    }
    adopt(this.root, this.u)
    // Teile mit dem ersten Skelett, gleicher Bindung und Lage, ohne Alpha-Test/Transparenz werfen den Schatten gemeinsam über die Hülle
    // (beidseitig: gleiche Silhouette wie Rückseiten bzw. DoubleSide je Teil; Agenten empfangen keine Schatten).
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert(), parts: THREE.SkinnedMesh[] = [], rel = new THREE.Matrix4()
    this.root.traverse(o => {
      const m = o as THREE.SkinnedMesh, mat = m.material as THREE.Material
      if (!m.isSkinnedMesh || !m.visible) return // mitgezeichnete Handschuh-Teile stecken schon im Körper-Teil
      const r = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)
      m.frustumCulled = true; m.boundingSphere = CULL.clone().applyMatrix4(r.clone().invert())
      const p0 = parts[0], ok = m.skeleton === skel[0] && !Array.isArray(m.material) && !mat.alphaTest && !mat.transparent && !!m.geometry.index &&
        !!m.geometry.attributes.normal && (!p0 || (r.equals(rel) && m.bindMatrix.equals(p0.bindMatrix) && m.bindMode === p0.bindMode))
      if (ok) { if (!p0) rel.copy(r); parts.push(m); m.castShadow = false; m.intersectsFrustum = this.cullMain }
      else { m.userData.hull = true; m.intersectsFrustum = this.cullAny } // eigener Schatten, eigene X-Ray-Zwillinge
    })
    if (parts.length) {
      const h = new THREE.SkinnedMesh(hullGeometry(parts), HULL_MAT)
      h.name = 'csda_hull'; h.userData.hull = true; h.castShadow = true
      h.bind(parts[0].skeleton, parts[0].bindMatrix); h.bindMode = parts[0].bindMode
      rel.decompose(h.position, h.quaternion, h.scale)
      h.boundingSphere = parts[0].boundingSphere; h.intersectsFrustum = this.cullShadow
      this.root.add(h) // nach den Körper-Teilen: im Bild-Pass ist das Frustum dann schon gemeldet
    }
    this.mixer = new THREE.AnimationMixer(this.root)
    this.wpnGroup.quaternion.copy(WEAPON_Q); this.bones.wpn?.add(this.wpnGroup)
    // Blend-Ebene: Bones ab spine_0 (jiggle/eye folgen ihrem Eltern-Bone), Blend-Pose aus flashed/flashed_crouch (je ein Frame, ohne Spur = Ruhe)
    const fs = clips.get('flashed'), fc = clips.get('flashed_crouch'), pel = this.bones.pelvis
    if (fs && fc && pel && this.bones.spine_0) {
      const bones: THREE.Object3D[] = [], parent: number[] = [], w: number[] = []
      const add = (b: THREE.Object3D, pi: number, pw: number) => {
        if (/^(jiggle|eye)/.test(b.name)) return
        const i = bones.length, wi = FLASH_MASK[b.name] ?? pw
        bones.push(b); parent.push(pi); w.push(wi)
        for (const c of b.children) if ((c as THREE.Bone).isBone) add(c, i, wi)
      }
      add(this.bones.spine_0, -1, 0)
      const key = (c: THREE.AnimationClip, b: THREE.Object3D) => { const t = c.tracks.find(x => x.name === `${b.name}.quaternion`); return t ? new THREE.Quaternion().fromArray(t.values) : b.quaternion.clone() }
      const buf = () => bones.map(() => new THREE.Quaternion())
      this.fl = { bones, parent, w, stand: bones.map(b => key(fs, b)), crouch: bones.map(b => key(fc, b)), pel: [key(fs, pel), key(fc, pel)], base: buf(), flash: buf(), out: buf() }
    }
    const touched = new Set(['spine_3', 'wpnPivot', ...BODIES.map(([n]) => n)].map(n => this.bones[n]).filter(b => b))
    for (const b of this.fl?.bones ?? []) touched.add(b)
    this.preAim = [...touched].map(b => ({ b, p: new THREE.Vector3(), q: new THREE.Quaternion() }))
    // Sprung-Additiv: mit --gltf_compose_additive als volle Pose exportiert → einmal je Clip (Map geteilt) relativ zu Frame 0 machen
    for (const [n, c] of clips) if (n.startsWith('jump_additive') && c.blendMode !== THREE.AdditiveAnimationBlendMode) THREE.AnimationUtils.makeClipAdditive(c)
  }

  /** Welt-Clips (Oberkörper) einer Waffe; worldClips() einmal je Waffe bauen und allen Agenten geben. Actions entstehen erst bei Nutzung. */
  setWorldClips(def: number, clips: WorldClips) { this.world.set(def, clips) }

  /** Waffe (item_def_idx) mit Skin in die Hand; Modell (hd bzw. Legacy) pro Agent einmal klonen (Critic P0-1: Root-Versatz) */
  setWeapon(def: number, tpl: WeaponTemplate | undefined, skin: SkinTex | null) {
    this.wpnGroup.visible = true
    const legacy = !!skin?.legacy
    if (legacy && !tpl?.legacy) skin = null // Legacy-Modell fehlt: Vanilla statt Skin auf falschen UVs
    const key = skin?.legacy ? -def : def
    if (key !== this.key) {
      this.key = key
      let m = this.weapons.get(key)
      const src = key < 0 ? tpl?.legacy : tpl?.scene
      if (m === undefined) {
        m = null
        if (src && tpl) {
          const obj = src.clone()
          obj.position.set(-tpl.asset.root[0], -tpl.asset.root[1], -tpl.asset.root[2])
          adopt(obj, this.u)
          obj.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.frustumCulled = true; o.intersectsFrustum = this.cullAny } })
          this.wpnGroup.add(obj)
          m = { obj, slot: SkinSlot.weapon(obj, this.u) }
          // Dual Berettas: linke Pistole (Knoten 'left', models.ts splitDual) folgt der linken Hand
          const left = obj.getObjectByName('left')
          if (left && this.bones.hand_L && this.bones.hand_R) this.root.add(new LeftGun(left, obj, this.wpnGroup, this.bones.hand_R, this.bones.hand_L))
        }
        this.weapons.set(key, m)
      }
      for (const [k, o] of this.weapons) if (o) o.obj.visible = k === key
      this.weapon = tpl ?? null
    }
    this.weapons.get(key)?.slot.set(skin)
  }

  /** Handschuh-Skin (worldmodel des Handschuh-Modells statt thirdperson_default_gloves); tex null = Standard des Agenten */
  setGlove(tpl: THREE.Object3D | undefined, tex: SkinTex | null) {
    if (tex && this.glove === undefined && tpl) {
      this.glove = bindGlove(tpl, 'worldmodel', this.bones, this.root, this.u)
      // Schatten der Hände wirft die Hülle (Standard-Handschuhe), Kugel wie der Körper (Gruppe und Meshes liegen in der Wurzel)
      this.glove?.root.traverse(o => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.SkinnedMesh; m.castShadow = false; m.frustumCulled = true; m.boundingSphere = CULL; m.intersectsFrustum = this.cullMain } })
    }
    const on = !!tex && !tex.dead && !!this.glove
    if (this.glove) { this.glove.root.visible = on; if (on) this.glove.slot.set(tex) }
    if (this.defaultGloves) this.defaultGloves.visible = !on
    for (const j of this.joins) j.m.geometry = on ? j.own : j.joined
  }

  /** Mündung (three-Welt); Matrizen müssen aktuell sein */
  muzzle(out: THREE.Vector3, silenced: boolean): boolean {
    const a = this.weapon?.asset, p = silenced ? a?.muzzleSilenced ?? a?.muzzle : a?.muzzle
    if (!p || !this.weapon?.scene || !this.wpnGroup.visible) return false
    out.set(p[0], p[1], p[2]).applyMatrix4(this.wpnGroup.matrixWorld)
    return true
  }

  private actionOf(c: THREE.AnimationClip | undefined) {
    if (!c) return null
    let a = this.actions.get(c)
    if (!a) { a = this.mixer.clipAction(c); a.play(); a.setEffectiveWeight(0); this.actions.set(c, a) }
    return a
  }
  /** Ebene für dieses Bild; t = Clip-Zeit (s), −1 = Schrittphase. Gleiche Action zweimal → Gewichte addieren. */
  private add(a: THREE.AnimationAction | null, w: number, t: number) {
    if (!a || w <= 1e-3) return
    for (let i = 0; i < this.nLay; i++) if (this.layA[i] === a) { this.layW[i] += w; return }
    if (this.nLay === MAX_LAYERS) return
    this.layA[this.nLay] = a; this.layW[this.nLay] = w; this.layT[this.nLay++] = t
  }
  private clip(name: string, w: number, t: number) { this.add(this.actionOf(this.clips.get(name)), w, t) }
  /** Welt-Clip einer Aktion: erste vorhandene Rolle, geduckt die _crouch-Variante, sonst stehend */
  private worldClip(a: Action, crouch: boolean) {
    const w = this.world.get(a.def), roles = ROLES[a.kind]
    if (!w || !roles) return undefined
    for (let i = 0; i < roles.length; i++) { const c = (crouch && w[CROUCH[roles[i]]]) || w[roles[i]]; if (c) return c }
    return undefined
  }
  /** Oberkörper-Ebene mit Anteil k, stehend/geduckt nach duck gemischt (gleiche Zeit); liefert k, wenn sie die Fortbewegung ersetzt (Additiv: 0) */
  private upper(a: Action, k: number, tau: number, duck: number) {
    const st = this.worldClip(a, false)
    if (!st) return 0
    const cr = this.worldClip(a, true)!
    this.add(this.actionOf(st), k * (1 - duck), Math.min(tau, st.duration))
    this.add(this.actionOf(cr), k * duck, Math.min(tau, cr.duration))
    return st.blendMode === THREE.AdditiveAnimationBlendMode ? 0 : k
  }
  /**
   * Welt-Clips setzen die Waffe (wpn unter root_motion) unabhängig vom Becken der Fortbewegung, CS2 holt die Hand per IK an die Waffe
   * (sonst bis 34 cm Abstand: Messer-Schwung, Granate im Lauf). Billiger umgekehrt: Waffe um w·(Soll − Ist) verschieben, Drehung bleibt.
   * grip = wpn-Ursprung im Raum der rechten Hand aus reiner Fortbewegung (unabhängig von der Waffen-Drehung, z. B. Karambit verkehrt herum).
   * Matrizen müssen aktuell sein.
   */
  private toHand(grip: THREE.Vector3, w: number) {
    const piv = this.bones.wpnPivot
    _v2.copy(grip).applyMatrix4(this.bones.hand_R.matrixWorld).sub(_v.setFromMatrixPosition(this.bones.wpn.matrixWorld)).multiplyScalar(w) // (Soll − Ist)·w
    piv.position.copy(_v.setFromMatrixPosition(piv.matrixWorld).add(_v2).applyMatrix4(_m.copy(piv.parent!.matrixWorld).invert()))
    piv.updateMatrixWorld(true)
  }

  /**
   * Pose aus dem Spur-Zustand. dt (s Demo-Zeit) treibt nur die Schrittphase; plantT/defuseT = Sekunden seit Beginn (−1 = nein).
   * s.pitch > 0 = nach unten (CS). Optional (ActionIndex): act = at(p, tick), jumps = jumps(p), tick + rate = aktuelle Zeit;
   * act/jumps brauchen setWorldClips bzw. die jump_additive-Clips, sonst nur Fortbewegung wie bisher.
   * flash = Gewicht der Blend-Ebene (flashWeight); phase = Schrittphase 0..1 von außen (statt dt aufzusummieren: gleich nach Spulen).
   */
  pose(s: TrackSample, cls: WeaponAnim, dt: number, plantT: number, defuseT: number, act?: Action | null, jumps?: readonly Jump[], tick = 0, rate = 64, flash = 0, phase?: number) {
    this.poseN++ // ragdoll() danach im selben Bild zählt mit: Skelett rechnet erst im nächsten render-Pass
    worldToGltf(s.x, s.y, s.z, this.root.position)
    this.root.quaternion.setFromAxisAngle(UP, s.yaw * D2R) // Modell-Vorwärts +Z = Source +X
    const N = NAMES[cls] ?? NAMES.rifle
    const duck = THREE.MathUtils.clamp(s.duck, 0, 1), crouch = duck > 0.5
    this.nLay = 0
    // ---- Fortbewegung (Gewichte summieren zu 1)
    if (plantT >= 0) { const c = this.clips.get(crouch ? 'planting_crouch' : 'planting'); if (c) this.add(this.actionOf(c), 1, Math.min(plantT, c.duration)) }
    else if (defuseT >= 0) { const c = this.clips.get(crouch ? N.defuseC : N.defuse); if (c) this.add(this.actionOf(c), 1, defuseT % Math.max(c.duration, 1e-3)) }
    else if (s.flags & FLAG.airborne) this.clip(crouch ? N.airC : N.air, 1, -1)
    else {
      const speed = Math.hypot(s.vx, s.vy)
      const move = THREE.MathUtils.clamp((speed - 5) / 40, 0, 1) // Idle ↔ Lauf zwischen 5 und 45 u/s
      const rel = Math.atan2(s.vy, s.vx) / D2R - s.yaw
      const walk = (s.flags & FLAG.walking) !== 0 && this.clips.has(N.walk[0])
      const gait = walk ? N.walk : N.run
      const a = (((rel % 360) + 360) % 360) / 45, i = Math.floor(a) % 8, t = a - Math.floor(a), i2 = (i + 1) % 8
      this.clip(gait[i], move * (1 - duck) * (1 - t), -1); this.clip(gait[i2], move * (1 - duck) * t, -1)
      this.clip(N.crouch[i], move * duck * (1 - t), -1); this.clip(N.crouch[i2], move * duck * t, -1)
      this.clip(N.idle, (1 - move) * (1 - duck), -1); this.clip(N.idleC, (1 - move) * duck, -1)
      // gemeinsame Phase hält alle Lauf-Clips fußsynchron; Rate aus echtem Tempo
      this.phase = phase ?? (this.phase + phaseInc(speed, crouch, walk, dt)) % 1
    }
    // ---- Oberkörper: Welt-Clip der Aktion, bei Unterbrechung (Vorgänger endet genau beim Start) überblendet
    if (act !== undefined && act !== this.cur) { this.prev = this.cur; this.cur = act }
    const u0 = this.nLay
    let K = 0
    if (act && tick >= act.t0) {
      const tau = (tick - act.t0) / rate, c = this.worldClip(act, false)
      const p = this.prev && this.prev !== act && this.prev.end === act.t0 ? this.prev : null, pc = p && this.worldClip(p, false)
      let kin = Math.min(1, tau / FADE_IN)
      if (pc && p) {
        const hold = p.kind === 'pullpin', k0 = kOf((act.t0 - p.t0) / rate, pc.duration, hold)
        // gleicher Clip (Feuerstoß, Messer-Serie): neu starten, Gewicht stetig weiter; sonst Vorgänger ausblenden
        if (pc === c) kin = Math.min(1, k0 + kin)
        else { const tp = (tick - p.t0) / rate; K += this.upper(p, (1 - kin) * kOf(tp, pc.duration, hold), tp, duck) }
      }
      if (c) K += this.upper(act, kin * kOut(tau, c.duration, act.kind === 'pullpin'), tau, duck)
    }
    // Gewicht k/(1−K) gegen die Fortbewegung (Summe 1): three mittelt je Spur → Oberkörper = Σ k·Aktion + (1−K)·Fortbewegung, Beine unverändert
    const f = 1 / Math.max(1e-3, 1 - K), upperOn = this.nLay > u0
    for (let i = u0; i < this.nLay; i++) if (this.layA[i]!.blendMode !== THREE.AdditiveAnimationBlendMode) this.layW[i] *= f
    // ---- Sprung: Absprung bzw. Landung als additive Ebene (letzter Sprung mit takeoff ≤ tick, Binärsuche)
    const j0 = this.nLay
    if (jumps?.length) {
      let lo = 0, hi = jumps.length
      while (lo < hi) { const m = (lo + hi) >> 1; if (jumps[m].takeoff <= tick) lo = m + 1; else hi = m }
      const j = lo > 0 ? jumps[lo - 1] : null
      if (j) {
        const landed = tick >= j.land, c = this.clips.get(landed ? (crouch ? N.landC : N.land) : crouch ? N.startC : N.start)
        const t = (tick - (landed ? j.land : j.takeoff)) / rate
        if (c && t < c.duration) this.add(this.actionOf(c), 1, t)
      }
    }
    // ---- anwenden
    if (this.aimed) for (const x of this.preAim) { x.b.position.copy(x.p); x.b.quaternion.copy(x.q) }
    for (let i = 0; i < this.nUsed; i++) this.used[i]!.setEffectiveWeight(0)
    for (let i = 0; i < this.nLay; i++) {
      const a = this.layA[i]!, t = this.layT[i]
      a.setEffectiveWeight(this.layW[i])
      a.time = t < 0 ? this.phase * a.getClip().duration : t
      this.used[i] = a
    }
    this.nUsed = this.nLay
    this.mixer.update(0)
    for (const x of this.preAim) { x.p.copy(x.b.position); x.q.copy(x.b.quaternion) }
    this.aimed = true
    // Waffe in die Hand (nur mit Welt-Clip); Griff einmal je Klasse aus reiner Fortbewegung am Boden merken
    const g = this.grip[cls], ok = !!(this.bones.hand_R && this.bones.wpn && this.bones.wpnPivot)
    const fix = ok && !!g && K > 1e-3, cap = ok && !g && !upperOn && this.nLay === j0 && plantT < 0 && defuseT < 0 && !(s.flags & FLAG.airborne)
    const pitch = THREE.MathUtils.clamp(s.pitch, -70, 70) * D2R, aim = Math.abs(pitch) >= 1e-4
    if (fix || cap || aim) this.root.updateWorldMatrix(true, true)
    if (cap) this.grip[cls] = new THREE.Vector3().setFromMatrixPosition(this.bones.wpn.matrixWorld).applyMatrix4(_m.copy(this.bones.hand_R.matrixWorld).invert())
    if (fix) this.toHand(g, Math.min(1, K))
    if (aim) this.aim(pitch)
    // Blend-Ebene nach dem Zielen (CS2: Layer über CNmAimCSNode), dann CNmSnapWeaponNode: die Waffe bleibt an der rechten Hand
    if (flash > 0 && this.fl) {
      this.flashLayer(flash, duck)
      if (ok && g) { this.root.updateWorldMatrix(true, true); this.toHand(g, Math.min(1, flash / 0.95)) }
    }
  }

  /**
   * Blend-Ebene im Modellraum (Layer 'ModelSpace' im CS2-Graphen): je Bone die Drehung relativ zum Becken zwischen jetziger Pose und
   * Blend-Pose (flashed/flashed_crouch nach duck) mit W · Maske mischen, dann zurück in lokale Drehungen. Becken und Beine bleiben.
   */
  private flashLayer(W: number, duck: number) {
    const F = this.fl!, pb = this.bones.pelvis.quaternion, pf = _q.slerpQuaternions(F.pel[0], F.pel[1], duck)
    for (let i = 0; i < F.bones.length; i++) {
      const p = F.parent[i], b = F.bones[i]
      F.base[i].multiplyQuaternions(p < 0 ? pb : F.base[p], b.quaternion)
      F.flash[i].multiplyQuaternions(p < 0 ? pf : F.flash[p], _q2.slerpQuaternions(F.stand[i], F.crouch[i], duck))
      F.out[i].slerpQuaternions(F.base[i], F.flash[i], W * F.w[i])
      b.quaternion.copy(p < 0 ? pb : F.out[p]).invert().multiply(F.out[i])
    }
  }

  /**
   * CS2 zielt per CNmAimCSNode (keine Aim-Clips): spine_3 um die Modell-Querachse drehen und den Waffen-Pivot
   * starr um denselben Punkt mitführen, damit die Hände an der Waffe bleiben. pitch in rad; Matrizen müssen aktuell sein.
   */
  private aim(pitch: number) {
    const b = this.bones.spine_3, wp = this.bones.wpnPivot
    if (!b || !wp) return
    const axis = _v.set(1, 0, 0).applyQuaternion(this.root.quaternion)
    const pivot = b.getWorldPosition(_v2)
    const Rw = _q.setFromAxisAngle(axis, pitch)
    const pq = b.parent!.getWorldQuaternion(_q2)
    b.quaternion.premultiply(_q3.copy(pq).invert().multiply(Rw).multiply(pq))
    // wpnPivot: neu = T(p)·R·T(−p)·alt
    _m.makeTranslation(pivot.x, pivot.y, pivot.z).multiply(_m2.makeRotationFromQuaternion(Rw)).multiply(_m2.makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    _m.multiply(wp.matrixWorld).premultiply(_m2.copy(wp.parent!.matrixWorld).invert())
    _m.decompose(wp.position, wp.quaternion, wp.scale)
  }

  /** Ragdoll-Partikel (ragdoll.ts PARTICLES) aus der aktuellen Pose → out (Welt m); Matrizen müssen aktuell sein */
  private particles(out: Float32Array) {
    PARTICLES.forEach(([n, off], i) => _v.set(off?.[0] ?? 0, off?.[1] ?? 0, off?.[2] ?? 0).applyMatrix4(this.bones[n].matrixWorld).toArray(out, i * 3))
    return out
  }

  /** Ragdoll-Start aus der aktuellen Pose (Todespose, Matrizen aktuell); null = Modell ohne die Ragdoll-Bones */
  ragdollStart(): RagdollStart | null {
    if (!this.restX) return null
    const x = this.particles(new Float32Array(NP * 3)), hinge = new Float32Array(HINGE_BONES.length * 3)
    HINGE_BONES.forEach((n, i) => _v.setFromMatrixColumn(this.bones[n].matrixWorld, 2).normalize().toArray(hinge, i * 3))
    const q0 = BODIES.map(([n]) => this.bones[n].getWorldQuaternion(new THREE.Quaternion()))
    const off = BODIES.map(([n, p]) => { const w = this.bones[n].parent!.getWorldQuaternion(new THREE.Quaternion()); return p < 0 ? w : q0[p].clone().invert().multiply(w) })
    const k = BODIES.map((_, i) => (i < BASES.length ? basisQ(x, i, new THREE.Quaternion()).invert().multiply(q0[i]) : new THREE.Quaternion()))
    const u0 = BODIES.map(([, , a, b]) => (a < 0 ? new THREE.Vector3() : new THREE.Vector3(x[b * 3] - x[a * 3], x[b * 3 + 1] - x[a * 3 + 1], x[b * 3 + 2] - x[a * 3 + 2]).normalize()))
    return { x, hinge, rest: this.restX, q0, q0i: q0.map(q => q.clone().invert()), off, k, u0 }
  }

  /**
   * Ragdoll tau s nach dem Tod, nach pose() mit der Todespose: Partikel zwischen den Ticks linear, Becken/Brust aus ihrer Partikel-Basis,
   * Glieder als kürzester Schwung gegenüber dem Elternkörper. Nur die 15 Körper-Bones bewegen sich, alle anderen behalten die Todespose (CS2).
   */
  ragdoll(rd: Ragdoll, tau: number) {
    this.wpnGroup.visible = false // CS2 lässt die Waffe beim Tod fallen (drops.ts)
    const S = rd.sim
    S.run(Math.ceil(tau * 64) + 1) // nur so weit rechnen, wie gezeigt wird
    const n3 = NP * 3, f = Math.max(0, Math.min(S.n - 1, tau * 64)), i = Math.floor(f), j = Math.min(S.n - 1, i + 1), t = f - i, F = S.frames, X = this.rx
    for (let c = 0; c < n3; c++) X[c] = F[i * n3 + c] + (F[j * n3 + c] - F[i * n3 + c]) * t
    // Wurzel so, dass die Culling-Kugel (CULL) um das Becken liegt: Bild- und Schatten-Test treffen den Körper, auch wenn er wegrutscht/-fällt
    this.root.position.set(X[0], X[1] - CULL.center.y, X[2])
    const Q = this.rq
    BODIES.forEach(([n, p, a, b], k) => {
      if (k < BASES.length) Q[k].multiplyQuaternions(basisQ(X, k, _q), rd.k[k])
      else {
        const pd = _q.multiplyQuaternions(Q[p], rd.q0i[p]) // Drehung des Elternkörpers seit dem Tod
        _v.copy(rd.u0[k]).applyQuaternion(pd)
        _v2.set(X[b * 3] - X[a * 3], X[b * 3 + 1] - X[a * 3 + 1], X[b * 3 + 2] - X[a * 3 + 2]).normalize()
        Q[k].setFromUnitVectors(_v, _v2).multiply(pd).multiply(rd.q0[k])
      }
      this.bones[n].quaternion.copy(p < 0 ? rd.off[k] : _q2.multiplyQuaternions(Q[p], rd.off[k])).invert().multiply(Q[k])
    })
    const pel = this.bones.pelvis
    pel.parent!.updateWorldMatrix(true, false)
    pel.position.set(X[0], X[1], X[2]).applyMatrix4(_m.copy(pel.parent!.matrixWorld).invert())
  }

  /** Ambient-Cube + Sonne aus probes.bin an (x,y,z Füße), über 0.1 s geglättet; snap bei Sprung */
  light(g: FloorGrid | null, x: number, y: number, z: number, dt: number, snap: boolean) {
    const l = g?.probes ? floorLayer(g, x, y, z, 300) : -1
    if (l < 0) return
    const b = g!.probes!, o = l * 19
    const k = snap || !this.lit ? 1 : 1 - Math.exp(-dt / 0.1)
    this.lit = true
    const c = this.u.csdaCube.value
    // Byte = sqrt(irr/4)·255 → irr; ×π hebt Lamberts 1/π auf (wie Lightmap mit Intensität 4π)
    const f = (i: number) => (b[o + i] / 255) ** 2 * 4 * Math.PI
    for (let i = 0; i < 6; i++) c[i].lerp(_v.set(f(i * 3), f(i * 3 + 1), f(i * 3 + 2)), k)
    this.u.csdaSunVis.value += (b[o + 18] / 255 - this.u.csdaSunVis.value) * k
  }
}
/** Schild-Fläche in CSS-px bei 1080p (4:1 wie die Sprite-Skalierung 0.4 × 0.1 der Engine), Canvas in doppelter Auflösung */
const LW = 288, LH = 72, LS = 2
/** Teamfarben der Namen (Entwurf v2 .oh .n), Entschärfen-Symbol (.oh .def) */
const NAME_COLOR: Record<Side, string> = { CT: '#b5d4ee', T: '#f0cf6a' }
const DEFUSE_COLOR = '#47c8f3', BOMB_ICON = 'eq/c4', DEFUSE_ICON = 'ui/defuser_white'
type Icons = ReadonlyMap<string, CanvasImageSource>
let stratum = false, fontsSeen = -1
/**
 * Stratum2 geladen? assets.tsx fügt sie fertig geladen hinzu, danach kommt setOverlay mit den Icons (dirty → ein Bild):
 * nur neu nachsehen, wenn document.fonts gewachsen ist (in der Pause gibt es kein zweites Bild, das einen Zeitfilter nachholt)
 */
function hasStratum() {
  if (stratum || document.fonts.size === fontsSeen) return stratum
  fontsSeen = document.fonts.size
  document.fonts.forEach(f => { if (f.status === 'loaded' && f.family.replace(/"/g, '') === 'Stratum2') stratum = true })
  return stratum
}
type Img = CanvasImageSource & { width: number; height: number }
const img = (icons: Icons | undefined, name: string) => { const im = name ? icons?.get(name) as Img | undefined : undefined; return im?.width && im.height ? im : undefined }
/** Breite (CSS-px) eines Icons bei Höhe h, 0 = fehlt */
const iconW = (icons: Icons | undefined, name: string, h: number) => { const im = img(icons, name); return im ? (im.width * h) / im.height : 0 }
let tintCanvas: HTMLCanvasElement | undefined
/** Icon in Farbe col (Form aus Alpha), Höhe h, links unten bei (x, y) in CSS-px */
function drawIcon(g: CanvasRenderingContext2D, icons: Icons | undefined, name: string, h: number, col: string, x: number, y: number) {
  const im = img(icons, name)
  if (!im) return
  const w = (im.width * h) / im.height, c = (tintCanvas ??= document.createElement('canvas')), pw = Math.ceil(w * LS), ph = Math.ceil(h * LS)
  if (c.width < pw || c.height < ph) { c.width = Math.max(c.width, pw); c.height = Math.max(c.height, ph) }
  const t = c.getContext('2d')!
  t.globalCompositeOperation = 'source-over'; t.clearRect(0, 0, c.width, c.height); t.drawImage(im, 0, 0, pw, ph)
  t.globalCompositeOperation = 'source-in'; t.fillStyle = col; t.fillRect(0, 0, pw, ph)
  g.drawImage(c, 0, 0, pw, ph, x, y - h, w, h)
}
function sameInfo(a: LabelInfo, b: LabelInfo) {
  if (a.weapon !== b.weapon || a.bomb !== b.bomb || a.defusing !== b.defusing || a.utility.length !== b.utility.length) return false
  for (let i = 0; i < a.utility.length; i++) if (a.utility[i] !== b.utility[i]) return false
  return true
}

/**
 * Überkopf-Schild wie Bild 2 (Sprite, konstante Bildschirmgröße, durch Wände sichtbar wie CS2-Spectator), von unten nach oben:
 * Entschärfen-Symbol, HP %, Name in Teamfarbe, Icons (Utility, C4, Waffe; weiß). Ohne info nur Name + HP %.
 * Zeichnet nur bei Änderung (Vergleich der Felder, keine Allokation je Aufruf).
 */
export class Label {
  readonly sprite: THREE.Sprite
  private readonly ctx: CanvasRenderingContext2D
  private readonly tex: THREE.CanvasTexture
  private hp = NaN
  private side: Side | '' = ''
  private readonly info: LabelInfo = { weapon: '', utility: [], bomb: false, defusing: false }
  private hasInfo = false
  private icons: Icons | undefined
  private font = false
  constructor(private readonly name: string) {
    const c = document.createElement('canvas'); c.width = LW * LS; c.height = LH * LS
    this.ctx = c.getContext('2d')!
    this.tex = new THREE.CanvasTexture(c); this.tex.colorSpace = THREE.SRGBColorSpace
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, depthTest: false, depthWrite: false, sizeAttenuation: false, transparent: true }))
    this.sprite.center.set(0.5, 0); this.sprite.renderOrder = 10
  }
  /** info/icons aus Engine.setOverlay (OverlayState); icons = Schlüssel aus LabelInfo plus 'eq/c4' und 'ui/defuser_white' */
  set(hp: number, side: Side, info?: LabelInfo, icons?: Icons) {
    const font = hasStratum(), I = this.info
    if (hp === this.hp && side === this.side && font === this.font && icons === this.icons && !!info === this.hasInfo && (!info || sameInfo(info, I))) return
    this.hp = hp; this.side = side; this.font = font; this.icons = icons; this.hasInfo = !!info
    if (info) { I.weapon = info.weapon; I.bomb = info.bomb; I.defusing = info.defusing; I.utility = info.utility.slice() }
    const g = this.ctx, F = font ? 'Stratum2, ' : ''
    g.setTransform(LS, 0, 0, LS, 0, 0); g.clearRect(0, 0, LW, LH)
    g.shadowColor = '#000'; g.shadowBlur = 3 * LS; g.textAlign = 'center'; g.textBaseline = 'alphabetic'
    // Zeilen von unten (y = Unterkante): Entschärfen 18, HP 14 (13 px), Name 17 (17 px), Icons 21
    let y = LH - 1
    if (info?.defusing && iconW(icons, DEFUSE_ICON, 18)) { drawIcon(g, icons, DEFUSE_ICON, 18, DEFUSE_COLOR, (LW - iconW(icons, DEFUSE_ICON, 18)) / 2, y); y -= 19 }
    g.font = `700 13px ${font ? '"Stratum2 Mono", ' : ''}${F}Arial, sans-serif`; g.fillStyle = '#f2f2f2'
    g.fillText(`${Math.max(0, Math.round(hp))}%`, LW / 2, y - 2); y -= 14
    g.font = `700 17px ${F}"Arial Narrow", Arial, sans-serif`; g.letterSpacing = '0.5px'; g.fillStyle = NAME_COLOR[side]
    let n = this.name.toUpperCase()
    while (n.length > 4 && g.measureText(n).width > LW - 8) n = n.slice(0, n.endsWith('…') ? -2 : -1) + '…'
    g.fillText(n, LW / 2, y - 3); g.letterSpacing = '0px'; y -= 17
    if (info) {
      // Icon-Reihe wie .oh .icons: Utility 16 px (Abstand 2), danach 6, C4 und Waffe 21 px (Abstand 3); zentriert, unten bündig
      const row: [name: string, h: number, gap: number, w: number][] = []
      const push = (nm: string, h: number, gap: number) => { const w = iconW(icons, nm, h); if (w) row.push([nm, h, row.length ? gap : 0, w]) }
      for (const u of info.utility) push(u, 16, 2)
      const nu = row.length
      if (info.bomb) push(BOMB_ICON, 21, 6)
      push(info.weapon, 21, row.length > nu ? 3 : 6)
      let x = (LW - row.reduce((s, r) => s + r[2] + r[3], 0)) / 2
      for (const [nm, h, gap, w] of row) { x += gap; drawIcon(g, icons, nm, h, '#fff', x, y); x += w }
    }
    this.tex.needsUpdate = true
  }
  dispose() { this.tex.dispose(); this.sprite.material.dispose() }
}
