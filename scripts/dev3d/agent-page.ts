// Electron-Testseite Spielermodelle (engine/agents.ts): Agent mit Fortbewegungs- und Welt-Clips an echten Aktionen (actionsOf,
// gleiche Ticks wie actions-check), Überkopf-Schild mit Fixture-Info, Messung pose() für 10 Agenten gegen agents.ts vor den
// Spielermodell-Änderungen ('agents-old'). Gebaut von agent-build.mjs, gesteuert von engine-main.cjs über window.step.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { FLAG, decode3d, newSample, roundAt, sampleTrack, type CS3D, type TrackSample } from '../../src/shared/cs3d'
import type { WeaponAnim, WeaponAssets } from '../../src/shared/assets3d'
import type { HudAssetManifest } from '../../src/shared/hud'
import type { Side } from '../../src/shared/model'
import { CS2_VFOV, type Action, type ActionIndex } from '../../src/renderer/replay3d/contracts'
import { actionsOf } from '../../src/renderer/replay3d/actions'
import { AGENT_DEFAULT } from '../../src/shared/cs3d'
import type { MatchData } from '../../src/shared/model'
import { HU, eyeZ, worldToGltf } from '../../src/renderer/replay3d/contracts'
import { Agent, CULL, Label, worldClips, type WeaponTemplate, type WorldClips } from '../../src/renderer/replay3d/engine/agents'
import { FIXTURES } from '../../src/renderer/replay3d/hud/fixtures'
import { XrayTwins, damagePulse, hitAge } from '../../src/renderer/replay3d/engine/xray'
import { drawScope } from '../../src/renderer/replay3d/Hud'
// @ts-expect-error virtuelles Modul aus agent-build.mjs: agents.ts aus Commit 82f72a3
import * as before from 'agents-old'
// @ts-expect-error virtuelle Module aus agent-build.mjs: agents.ts/xray.ts aus Commit be79ebe (vor Hülle und Culling)
import * as headA from 'agents-head'
// @ts-expect-error siehe oben
import * as headX from 'xray-head'

type PoseOnly = { pose(s: TrackSample, cls: WeaponAnim, dt: number, plantT: number, defuseT: number): void }
const OldAgent = before.Agent as new (tpl: THREE.Object3D, clips: Map<string, THREE.AnimationClip>) => PoseOnly
const W = window as any
const D2R = Math.PI / 180

let d: CS3D, X: ActionIndex
let A: { clips: string; models: Record<Side, string>; weapons: WeaponAssets; hud: string; all: string[]; agentUrls: Record<string, string>; toSun: number[] }
let renderer: THREE.WebGLRenderer, loader: GLTFLoader, clips: Map<string, THREE.AnimationClip>, tplT: THREE.Object3D
const world = new Map<number, WorldClips>(), wtpl = new Map<number, WeaponTemplate>(), icons = new Map<string, ImageBitmap>()
const scene = new THREE.Scene(), PW = 320, PH = 720, cam = new THREE.PerspectiveCamera(44, PW / PH, 0.05, 100)
let additive: Record<string, { maxDeg: number; bone: string }> = {}

const rate = () => d.header.tickrate
const anim = (def: number): WeaponAnim => (def ? A.weapons[def]?.anim ?? 'rifle' : 'knife')
const iconOf = (def: number) => 'eq/' + (A.weapons[def]?.className ?? 'weapon_knife').replace(/^weapon_/, '')
/** v1-Waffenname (HUD-Fixtures) → Manifest-Schlüssel, wie hud/assets.tsx iconKey für die vorkommenden Namen */
const KEY: Record<string, string> = {
  'AK-47': 'ak47', 'M4A1-S': 'm4a1_silencer', 'USP-S': 'usp_silencer', 'Glock-18': 'glock', 'Desert Eagle': 'deagle', 'Galil AR': 'galilar',
  'Smoke Grenade': 'smokegrenade', 'High Explosive Grenade': 'hegrenade', 'Incendiary Grenade': 'incgrenade',
  'Talon Knife': 'knife_widowmaker', 'Butterfly Knife': 'knife_butterfly', 'M9 Bayonet': 'knife_m9_bayonet',
}
const key = (n: string) => (n ? 'eq/' + (KEY[n] ?? n.toLowerCase().replace(/[^a-z0-9_]/g, '')) : '')

/** Spur-Zustand von Spieler p bei tick; false = nicht in einer Runde */
function sample(p: number, tick: number, s: TrackSample) {
  const r = roundAt(d, tick), k = r < 0 ? -1 : d.header.rounds[r].tracks.indexOf(p)
  if (k < 0) return false
  sampleTrack(d, r, k, tick, s)
  return true
}
function newAgent() {
  const a = new Agent(tplT, clips)
  for (const [def, c] of world) a.setWorldClips(def, c)
  return a
}
async function weapon(def: number) {
  let t = wtpl.get(def)
  if (!t) { const g = A.weapons[def]?.glb; t = { asset: A.weapons[def], scene: g ? (await loader.loadAsync(g)).scene : null }; wtpl.set(def, t) }
  return t
}
/** Summe der Gewichte der Actions eines Agenten, deren Clip pred erfüllt */
function weightOf(a: Agent, pred: (c: THREE.AnimationClip) => boolean) {
  let w = 0
  for (const [c, x] of (a as any).actions as Map<THREE.AnimationClip, THREE.AnimationAction>) if (pred(c)) w += x.getEffectiveWeight()
  return w
}
const layers = (a: Agent) => [...((a as any).actions as Map<THREE.AnimationClip, THREE.AnimationAction>)].filter(([, x]) => x.getEffectiveWeight() > 0.01)
  .map(([c, x]) => `${c.name}@${x.time.toFixed(2)}x${x.getEffectiveWeight().toFixed(2)}`)

const s0 = newSample()
let still = false // scene { still: true }: ohne Fortbewegung (steht, nicht geduckt), Welt-Clip auf Idle zum Vergleich
/** wie beim Abspielen: 0,5 s Vorlauf in Tick-Schritten (Überblendung, Schrittphase); act false = alter Aufruf ohne Aktion. Agent im Ursprung. */
function poseAt(ag: Agent, p: number, tick: number, act: boolean, keepPos = false) {
  for (let t = tick - 32; t <= tick; t++) {
    if (!sample(p, t, s0)) continue
    if (!keepPos) s0.x = s0.y = s0.z = 0
    if (still) s0.vx = s0.vy = s0.duck = 0
    ag.pose(s0, anim(s0.weapon), 1 / rate(), -1, -1, act ? X.at(p, t) : undefined, act ? X.jumps(p) : undefined, t, rate())
  }
  return s0
}

/** SVG über eine Blob-URL (gleicher Ursprung, Canvas bleibt sauber) als Bitmap der Höhe h, wie hud/assets.tsx iconBitmaps */
async function svgBitmap(url: string, h = 64) {
  const src = URL.createObjectURL(new Blob([await (await fetch(url)).blob()], { type: 'image/svg+xml' })), img = new Image()
  try {
    img.src = src
    await img.decode()
    return await createImageBitmap(img, { resizeWidth: Math.max(1, Math.round((h * img.naturalWidth) / (img.naturalHeight || 1))), resizeHeight: h, resizeQuality: 'high' })
  } finally { URL.revokeObjectURL(src) }
}

// ---- Draw-Calls, Culling, Bildvergleich (calls/cull/diff/sphere): eigener Renderer mit Schattenkarte wie engine/index.ts (high)
let R2: THREE.WebGLRenderer, S2: THREE.Scene, sun2: THREE.DirectionalLight, cam2: THREE.PerspectiveCamera
const W2 = 640, H2 = 360
function rig() {
  if (R2) return
  R2 = new THREE.WebGLRenderer({ antialias: true, stencil: true, preserveDrawingBuffer: true })
  R2.setPixelRatio(1); R2.setSize(W2, H2); R2.shadowMap.enabled = true; R2.toneMapping = THREE.NeutralToneMapping; R2.info.autoReset = false
  S2 = new THREE.Scene(); S2.background = new THREE.Color(0x46505a)
  sun2 = new THREE.DirectionalLight(0xfff0dd, 3); sun2.castShadow = true; sun2.shadow.mapSize.set(2048, 2048)
  Object.assign(sun2.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 200 }); sun2.shadow.bias = -0.0004; sun2.shadow.normalBias = 0.02
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9a8f7c, roughness: 1 }))
  ground.receiveShadow = true
  S2.add(sun2, sun2.target, new THREE.HemisphereLight(0xd3e2f8, 0x8c7359, 1.2), ground)
  cam2 = new THREE.PerspectiveCamera(CS2_VFOV, W2 / H2, 0.05, 1000); cam2.layers.enable(1)
  R2.render(S2, cam2) // Schattenkarte anlegen (calls() zeichnet zuerst ohne sie)
}
/** Kamera bei pos mit Blick auf at; Sonne wie engine/index.ts (Ziel = Augpunkt, 80 m Richtung toSun = (sin az·cos el, sin el, cos az·cos el)) */
function view2(pos: number[], at: number[], el: number, az: number) {
  cam2.position.fromArray(pos); cam2.lookAt(at[0], at[1], at[2]); cam2.updateMatrixWorld()
  const ts = new THREE.Vector3(Math.sin(az * D2R) * Math.cos(el * D2R), Math.sin(el * D2R), Math.cos(az * D2R) * Math.cos(el * D2R))
  sun2.target.position.copy(cam2.position); sun2.position.copy(cam2.position).addScaledVector(ts, 80); sun2.target.updateMatrixWorld()
}
/** Draw-Calls eines Bildes ohne den Boden: Bild-Pass und Schattenkarte getrennt */
function calls() {
  const sm = R2.shadowMap
  sm.autoUpdate = false; sm.needsUpdate = false; R2.info.reset(); R2.render(S2, cam2); const main = R2.info.render.calls - 1
  sm.autoUpdate = true; R2.info.reset(); R2.render(S2, cam2)
  return { main, shadow: R2.info.render.calls - 1 - main }
}
type Any = Agent & { root: THREE.Object3D }
const tpl2 = new Map<string, Promise<THREE.Object3D>>()
/** Agent alt (be79ebe) oder neu, eigene Vorlage je Version (neu entfernt Morph-Ziele an der geteilten Geometrie), Pose von Spieler p bei tick */
async function mk(old: boolean, url: string, side: Side, p: number, tick: number) {
  const k = `${old}|${url}`
  if (!tpl2.has(k)) tpl2.set(k, loader.loadAsync(url).then(g => g.scene))
  const a: Any = old ? new headA.Agent(await tpl2.get(k)!, clips) : new Agent(await tpl2.get(k)!, clips)
  for (const [def, c] of world) a.setWorldClips(def, c)
  const x = new (old ? headX.XrayTwins : XrayTwins)(a.root, side) as XrayTwins
  x.update(false, -Infinity, 0)
  const s = poseAt(a, p, tick, true)
  a.setWeapon(s.weapon, await weapon(s.weapon), null)
  a.root.updateMatrixWorld(true)
  return { a, x, yaw: s.yaw }
}
function drop(a: Any) { S2.remove(a.root); a.root.traverse(o => { const m = o as THREE.Mesh; if (m.material) for (const x of [m.material].flat()) x.dispose() }) }
const pixels2png = () => R2.domElement.toDataURL('image/png')
const pixels = () => { const c = document.createElement('canvas'); c.width = W2; c.height = H2; const g = c.getContext('2d')!; g.drawImage(R2.domElement, 0, 0); return g.getImageData(0, 0, W2, H2) }
/** Anteil Pixel mit Abweichung > 3/255 in einem Kanal; Bild der Abweichung ×8 */
function diff(a: ImageData, b: ImageData) {
  const out = new ImageData(a.width, a.height)
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const e = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]))
    if (e > 3) n++
    out.data[i] = out.data[i + 1] = out.data[i + 2] = Math.min(255, e * 8); out.data[i + 3] = 255
  }
  return { pct: +((100 * n) / (a.width * a.height)).toFixed(3), img: out }
}

interface Panel { cap: string; tick: number; act: boolean }
/** Szenen mit Ticks aus actions-check: Nachladen (erstes ganzes, AK bevorzugt), Smoke-Pin Kugel666 6348 + Wurf, Messer Criminal_Boy 54704, AK-Schuss */
function scenario(kind: string): { p: number; panels: Panel[] } {
  const P = d.header.players, R = rate(), idx = (n: string) => P.findIndex(x => x.name === n)
  const at = (a: Action, s: number) => a.t0 + Math.round(s * R)
  if (kind === 'reload') {
    const full = (a: Action) => { const w = A.weapons[a.def]?.world, c = w?.roles.reload; return a.kind === 'reload' && !!c && a.end - a.t0 >= w!.dur[c] * R }
    let hit: [number, Action] | undefined
    for (const ak of [true, false]) for (let p = 0; !hit && p < P.length; p++) { const a = X.list(p).find(a => full(a) && (!ak || a.def === 7)); if (a) hit = [p, a] }
    if (!hit) throw new Error('no full reload with world clip')
    const [p, a] = hit
    return { p, panels: [{ cap: 'no action (before)', tick: at(a, 1), act: false }, { cap: 'reload +0.3 s', tick: at(a, 0.3), act: true }, { cap: 'reload +1.0 s', tick: at(a, 1), act: true }, { cap: 'reload +1.8 s', tick: at(a, 1.8), act: true }] }
  }
  if (kind === 'throw') {
    const p = idx('Kugel666'), pin = X.at(p, 6348), thr = pin && X.list(p).find(a => a.t0 >= pin.end && a.kind.startsWith('throw'))
    if (!pin || pin.kind !== 'pullpin' || !thr) throw new Error(`no pullpin + throw at Kugel666 6348 (${pin?.kind})`)
    const late = Math.min(thr.end - 1, at(thr, 0.3)) // Wurf endet oft schon nach ~0,13 s (nächste Waffe wird gezogen)
    return { p, panels: [{ cap: 'no action (before)', tick: late, act: false }, { cap: 'pull pin', tick: Math.min(pin.end - 1, at(pin, 0.5)), act: true }, { cap: `${thr.kind} +0.06 s`, tick: at(thr, 0.06), act: true }, { cap: `${thr.kind} +${((late - thr.t0) / R).toFixed(2)} s`, tick: late, act: true }] }
  }
  if (kind === 'shoot') {
    // erster AK-Feuerstoß (Rückstoß-Additiv): Schuss mit mindestens 0,3 s bis zur nächsten Aktion
    let hit: [number, Action] | undefined
    for (let p = 0; !hit && p < P.length; p++) { const a = X.list(p).find(a => a.kind === 'shoot' && a.def === 7 && a.end - a.t0 >= 0.3 * R); if (a) hit = [p, a] }
    if (!hit) throw new Error('no AK shot')
    const [p, a] = hit
    return { p, panels: [{ cap: 'no action (before)', tick: at(a, 0.08), act: false }, { cap: 'shot +0.03 s', tick: at(a, 0.03), act: true }, { cap: 'shot +0.08 s', tick: at(a, 0.08), act: true }, { cap: 'shot +0.25 s', tick: at(a, 0.25), act: true }] }
  }
  const p = idx('Criminal_Boy'), a = X.at(p, 54704)
  if (!a || a.kind !== 'light') throw new Error(`no knife swing at Criminal_Boy 54704 (${a?.kind})`)
  return { p, panels: [{ cap: 'no action (before)', tick: at(a, 0.25), act: false }, { cap: 'knife +0.1 s', tick: at(a, 0.1), act: true }, { cap: 'knife +0.25 s', tick: at(a, 0.25), act: true }, { cap: 'knife +0.45 s', tick: at(a, 0.45), act: true }] }
}

/** WebGL-Bild + Beschriftung je Feld */
function capture(caps: string[], pw: number) {
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720
  const g = c.getContext('2d')!
  g.drawImage(renderer.domElement, 0, 0)
  g.fillStyle = '#000'; for (let i = 1; i < caps.length; i++) g.fillRect(i * pw - 1, 0, 2, 720)
  g.font = '600 15px Arial, sans-serif'; g.fillStyle = '#fff'; g.shadowColor = '#000'; g.shadowBlur = 4
  caps.forEach((t, i) => g.fillText(t, i * pw + 10, 24))
  return c.toDataURL('image/png')
}

W.step = async (name: string, a: any = {}) => {
  if (name === 'load') {
    const t0 = performance.now()
    A = await (await fetch('cs3d://test/assets.json')).json()
    const gz = await fetch('cs3d://test/demo.3d.bin.gz')
    d = decode3d(await new Response(gz.body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    X = actionsOf(d, A.weapons)
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(1); renderer.setSize(1280, 720); renderer.setScissorTest(true)
    renderer.toneMapping = THREE.NeutralToneMapping
    document.body.appendChild(renderer.domElement)
    scene.background = new THREE.Color(0x46505a)
    const lamp = new THREE.DirectionalLight(0xfff0dd, 3); lamp.position.set(1.5, 2, 0.5) // am Kamera-Rig: Licht immer von vorn oben
    scene.add(cam, new THREE.HemisphereLight(0xd3e2f8, 0x8c7359, 1.2), new THREE.Mesh(new THREE.CircleGeometry(3, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x9a8f7c, roughness: 1 })))
    cam.add(lamp)
    loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
    const [cg, mt] = await Promise.all([loader.loadAsync(A.clips), loader.loadAsync(A.models.T)])
    clips = new Map(cg.animations.map(c => [c.name, c])); tplT = mt.scene
    // Sprung-Additiv: Frame 0 gegen Ruhepose bzw. idle_rifle (makeClipAdditive im Agent-Konstruktor nimmt Frame 0 als Bezug)
    const rest = new Map<string, THREE.Quaternion>(); tplT.traverse(o => rest.set(o.name, o.quaternion))
    const idle = new Map<string, THREE.Quaternion>()
    for (const tr of clips.get('idle_rifle')?.tracks ?? []) if (tr.name.endsWith('.quaternion')) idle.set(tr.name.slice(0, -11), new THREE.Quaternion().fromArray(tr.values))
    const diff = (c: THREE.AnimationClip | undefined, ref: Map<string, THREE.Quaternion>) => {
      let r = { maxDeg: 0, bone: '' }
      for (const tr of c?.tracks ?? []) {
        const q = tr.name.endsWith('.quaternion') && !tr.name.startsWith('wpn') && ref.get(tr.name.slice(0, -11))
        if (!q) continue
        const v = tr.values, deg = (2 * Math.acos(Math.min(1, Math.abs(q.x * v[0] + q.y * v[1] + q.z * v[2] + q.w * v[3])))) / D2R
        if (deg > r.maxDeg) r = { maxDeg: +deg.toFixed(2), bone: tr.name.slice(0, -11) }
      }
      return r
    }
    const js = clips.get('jump_additive_start_rifle')
    let span = { maxDeg: 0, bone: '' } // größte Drehung gegen Frame 0 im Clip (Körper-Bones): wie viel die additive Ebene bewegt
    for (const tr of js?.tracks ?? []) {
      if (!tr.name.endsWith('.quaternion') || tr.name.startsWith('wpn')) continue
      const v = tr.values
      for (let i = 4; i < v.length; i += 4) {
        const deg = (2 * Math.acos(Math.min(1, Math.abs(v[0] * v[i] + v[1] * v[i + 1] + v[2] * v[i + 2] + v[3] * v[i + 3])))) / D2R
        if (deg > span.maxDeg) span = { maxDeg: +deg.toFixed(2), bone: tr.name.slice(0, -11) }
      }
    }
    additive = { startVsRest: diff(js, rest), startVsIdle: diff(js, idle), span }
    // Welt-Clips aller Waffen der Demo: je Waffe einmal, von allen Agenten geteilt
    await Promise.all(d.header.weapons.map(async def => {
      const w = A.weapons[def]?.world
      if (w) world.set(def, worldClips(w.roles, (await loader.loadAsync(w.clips)).animations))
    }))
    // HUD: Stratum2 + Icons (Fixtures, Waffen der Demo, C4, Entschärfer)
    let fonts = 0
    if (A.hud) {
      const m = (await (await fetch(A.hud)).json()) as HudAssetManifest
      for (const f of m.fonts) {
        const ff = new FontFace(f.family, await (await fetch(f.url)).arrayBuffer(), { weight: String(f.weight), style: f.style })
        document.fonts.add(await ff.load()); fonts++
      }
      const names = new Set(['eq/c4', 'ui/defuser_white', ...d.header.weapons.map(iconOf)])
      for (const fx of Object.values(FIXTURES)) for (const p of fx.view.players) { names.add(key(p.weapon)); for (const u of p.utility) names.add(key(u)) }
      await Promise.all([...names].map(async n => { const u = m.icons[n]; if (u) icons.set(n, await svgBitmap(u)) }))
    }
    const all = d.header.players.reduce((s, _, p) => s + X.list(p).length, 0)
    return { ms: Math.round(performance.now() - t0), actions: all, clips: clips.size, worldWeapons: world.size, fonts, icons: icons.size, additive }
  }

  if (name === 'scene') {
    const { p, panels } = scenario(a.kind)
    still = !!a.still
    const ag = newAgent(), lb = new Label(d.header.players[p].name)
    scene.add(ag.root, lb.sprite)
    const ls = Math.tan((cam.fov * D2R) / 2) / Math.tan((CS2_VFOV * D2R) / 2) // wie engine/index.ts
    lb.sprite.scale.set(0.4 * ls, 0.1 * ls, 1)
    const info: unknown[] = []
    for (let i = 0; i < panels.length; i++) {
      const q = panels[i], s = poseAt(ag, p, q.tick, q.act)
      ag.setWeapon(s.weapon, await weapon(s.weapon), null)
      ag.root.updateMatrixWorld(true)
      lb.set(100, 'T', { weapon: iconOf(s.weapon), utility: [], bomb: false, defusing: false }, icons)
      ;(ag.bones.head_0 ?? ag.root).getWorldPosition(lb.sprite.position).y += 0.28
      const yaw = s.yaw * D2R
      cam.position.set(Math.sin(yaw) * 2.8 - Math.cos(yaw) * 1.9, 1.3, Math.cos(yaw) * 2.8 + Math.sin(yaw) * 1.9) // vorn rechts
      cam.lookAt(0, 1.05, 0)
      renderer.setViewport(i * PW, 0, PW, PH); renderer.setScissor(i * PW, 0, PW, PH)
      renderer.render(scene, cam)
      const act = X.at(p, q.tick)
      // wpn-Ursprung gegen sein Soll in der rechten Hand (aus reiner Fortbewegung): 0 = Waffe liegt in der Hand
      const grip: THREE.Vector3 | undefined = (ag as any).grip[anim(s.weapon)], wpn = ag.bones.wpn.getWorldPosition(new THREE.Vector3())
      const gap = grip ? +(wpn.distanceTo(grip.clone().applyMatrix4(ag.bones.hand_R.matrixWorld)) * 100).toFixed(1) : null
      info.push({ cap: q.cap, tick: q.tick, handToGripCm: gap, action: act && `${act.kind} def ${act.def} t0 ${act.t0} end ${act.end}`, layers: layers(ag) })
    }
    const png = capture(panels.map(q => q.cap), PW)
    scene.remove(ag.root, lb.sprite); lb.dispose()
    return { png, player: d.header.players[p].name, panels: info }
  }

  if (name === 'gaps') {
    // Hand ↔ Waffe je Welt-Clip (stehend, Blick waagerecht): Abweichung der Lage wpn in hand_R gegenüber idle der Klasse.
    // Groß = CS2 setzt die Hand per IK an die Waffe (WPN_DISABLE_HAND_IK), unsere Clips allein bringen sie nicht hin.
    const ROLE: Record<string, Action['kind']> = { draw: 'draw', reload: 'reload', reload_empty: 'reload_empty', shoot: 'shoot', pullpin: 'pullpin', throw: 'throw', throw_under: 'throw_under', swing: 'light', stab: 'heavy', backstab: 'backstab', silencer_on: 'silencer_on', silencer_off: 'silencer_off' }
    const ag = newAgent(), s = newSample(), R = rate(), m = new THREE.Matrix4(), ref = new THREE.Matrix4(), q = new THREE.Quaternion(), q0 = new THREE.Quaternion(), v = new THREE.Vector3(), v0 = new THREE.Vector3()
    const rel = (out: THREE.Matrix4) => out.copy(ag.bones.hand_R.matrixWorld).invert().multiply(ag.bones.wpn.matrixWorld)
    const out: Record<string, string> = {}, seen = new Set<THREE.AnimationClip>()
    for (const def of (a.defs as number[] | undefined) ?? [...world.keys()]) {
      const wc = world.get(def)!, cls = anim(def)
      s.flags = FLAG.alive; s.weapon = def
      ag.pose(s, cls, 0, -1, -1, null, undefined, 10000, R); ag.root.updateMatrixWorld(true); rel(ref)
      ref.decompose(v0, q0, v)
      for (const [role, kind] of Object.entries(ROLE)) {
        const c = wc[role as keyof WorldClips]
        if (!c || seen.has(c)) continue
        seen.add(c)
        let dp = 0, dr = 0
        for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const act: Action = { kind, def, t0: 10000 - Math.round(Math.max(0.12, f * c.duration) * R), end: 1e9 }
          ag.pose(s, cls, 0, -1, -1, act, undefined, 10000, R); ag.root.updateMatrixWorld(true)
          rel(m).decompose(v, q, new THREE.Vector3())
          dp = Math.max(dp, v.distanceTo(v0) * 100); dr = Math.max(dr, (2 * Math.acos(Math.min(1, Math.abs(q.dot(q0))))) / D2R)
          ag.pose(s, cls, 0, -1, -1, null, undefined, 10000, R) // Aktion wechseln (keine Überblendung zwischen den Proben)
        }
        // Frame 0 gegen die Ruhepose (wie das Sprung-Additiv): ~0° = Clip ist ein Additiv auf die Ruhepose
        let rd = 0
        for (const tr of c.tracks) {
          const b = tr.name.endsWith('.quaternion') && !tr.name.startsWith('wpn') && tplT.getObjectByName(tr.name.slice(0, -11))
          if (b) rd = Math.max(rd, (2 * Math.acos(Math.min(1, Math.abs(b.quaternion.dot(q.fromArray(tr.values)))))) / D2R)
        }
        out[c.name] = `${dp.toFixed(0)} cm / ${dr.toFixed(0)}° | f0 vs rest ${rd.toFixed(1)}° | ${c.tracks.length} tracks`
      }
    }
    return { gaps: out }
  }

  if (name === 'checks') {
    const H = d.header, R = rate(), s = newSample(), ag = newAgent()
    // Gehen: alle 16-Hz-Frames mit FLAG.walking, lebend, am Boden, über 5,5 u/s (darunter Idle), nicht ganz geduckt (dann Duck-Clips)
    let walkN = 0, walkOk = 0, walkMin = Infinity, ducked = 0
    H.rounds.forEach((Rd, r) => Rd.tracks.forEach((_, k) => {
      for (let i = 0; i < Rd.nFrames; i++) {
        sampleTrack(d, r, k, Rd.firstTick + i * H.frameStep, s)
        if (!(s.flags & FLAG.walking) || !(s.flags & FLAG.alive) || s.flags & FLAG.airborne || Math.hypot(s.vx, s.vy) < 5.5) continue
        if (s.duck >= 0.999) { ducked++; continue }
        ag.pose(s, anim(s.weapon), H.frameStep / R, -1, -1)
        const w = weightOf(ag, c => c.name.startsWith('walk_'))
        walkN++; if (w > 0) walkOk++; walkMin = Math.min(walkMin, w)
      }
    }))
    // Sprung: 6 Ticks nach Absprung bzw. Landung muss die additive Ebene anliegen
    let jN = 0, jStart = 0, jLand = 0
    const miss: string[] = []
    for (let p = 0; p < H.players.length && jN < 60; p++) for (const [i, j] of X.jumps(p).entries()) {
      if (jN >= 60 || j.land - j.takeoff < 8 || (X.jumps(p)[i + 1]?.takeoff ?? Infinity) <= j.land + 6) continue
      const pose = (t: number) => sample(p, t, s) && (ag.pose(s, anim(s.weapon), 1 / R, -1, -1, X.at(p, t), X.jumps(p), t, R), true)
      if (!pose(j.takeoff + 6)) continue
      const ws = weightOf(ag, c => /^jump_additive_(crouch_)?start/.test(c.name))
      if (!pose(j.land + 6)) continue
      const wl = weightOf(ag, c => /^jump_additive_(crouch_)?land/.test(c.name))
      jN++; if (ws > 0) jStart++; if (wl > 0) jLand++; else miss.push(`${H.players[p].name} ${j.takeoff}-${j.land} ${anim(s.weapon)} duck ${s.duck.toFixed(2)}`)
    }
    // Würfe: wie lange läuft die Aktion, bevor die nächste beginnt (meist das Ziehen der nächsten Waffe)
    const thr = H.players.flatMap((_, p) => X.list(p).filter(a => a.kind.startsWith("throw")).map(a => (a.end - a.t0) / R)).sort((x, y) => x - y)
    return { walk: { frames: walkN, withWalkClip: walkOk, minWeight: +walkMin.toFixed(3), skippedFullyDucked: ducked }, jumps: { checked: jN, startLayer: jStart, landLayer: jLand, landMissing: miss.slice(0, 5) }, throwsS: { n: thr.length, median: +thr[thr.length >> 1].toFixed(3), under02: thr.filter(x => x < 0.2).length }, additive }
  }

  if (name === 'bench') {
    // 10 Agenten über eine ganze Runde (R15, sonst erste mit 10 Spielern), je Bild 10 × pose(); abwechselnd gemessen
    const H = d.header, R = rate(), F = a.frames ?? 1500, reps = a.reps ?? 5
    const r = H.rounds[14]?.tracks.length === 10 ? 14 : H.rounds.findIndex(x => x.tracks.length === 10)
    const Rd = H.rounds[r], n = Rd.tracks.length, step = Math.max(1, Math.floor((Rd.nFrames * H.frameStep) / F)), dt = step / R
    const S: TrackSample[][] = [], ACT: (Action | null)[][] = [], CLS: WeaponAnim[][] = [], T: number[] = []
    for (let f = 0; f < F; f++) {
      const t = Rd.firstTick + f * step
      T.push(t); S.push(Rd.tracks.map((_, k) => sampleTrack(d, r, k, t, newSample())))
      ACT.push(Rd.tracks.map(p => X.at(p, t))); CLS.push(S[f].map(x => anim(x.weapon)))
    }
    const J = Rd.tracks.map(p => X.jumps(p))
    const olds = Rd.tracks.map(() => new OldAgent(tplT, clips)), plain = Rd.tracks.map(newAgent), full = Rd.tracks.map(newAgent)
    const run: Record<string, () => void> = {
      before: () => { for (let f = 0; f < F; f++) for (let k = 0; k < n; k++) olds[k].pose(S[f][k], CLS[f][k], dt, -1, -1) },
      oldCall: () => { for (let f = 0; f < F; f++) for (let k = 0; k < n; k++) plain[k].pose(S[f][k], CLS[f][k], dt, -1, -1) },
      actions: () => { for (let f = 0; f < F; f++) for (let k = 0; k < n; k++) full[k].pose(S[f][k], CLS[f][k], dt, -1, -1, ACT[f][k], J[k], T[f], R) },
    }
    for (const fn of Object.values(run)) fn() // Actions anlegen, JIT
    const ms: Record<string, number[]> = { before: [], oldCall: [], actions: [] }
    for (let i = 0; i < reps; i++) for (const [k, fn] of Object.entries(run)) { const c0 = performance.now(); fn(); ms[k].push((performance.now() - c0) / F) }
    const med = (x: number[]) => +[...x].sort((p, q) => p - q)[x.length >> 1].toFixed(4)
    const res = Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, med(v)]))
    // Abdeckung (ungemessen): Anteil Spieler-Bilder mit Oberkörper- bzw. Sprung-Ebene
    const wset = new Set([...world.values()].flatMap(w => Object.values(w)))
    let upper = 0, jump = 0
    for (let f = 0; f < F; f++) for (let k = 0; k < n; k++) {
      full[k].pose(S[f][k], CLS[f][k], dt, -1, -1, ACT[f][k], J[k], T[f], R)
      if (weightOf(full[k], c => wset.has(c)) > 0) upper++
      if (weightOf(full[k], c => c.name.startsWith('jump_additive')) > 0) jump++
    }
    return {
      round: r + 1, frames: F, ticksPerFrame: step, msPer10Agents: res, raw: ms,
      deltaVsBefore: { oldCall: +(res.oldCall - res.before).toFixed(4), actions: +(res.actions - res.before).toFixed(4) },
      upperShare: +(upper / (F * n)).toFixed(3), jumpShare: +(jump / (F * n)).toFixed(3),
    }
  }

  if (name === 'labels') {
    // links Bild 2 (Ausschnitte 5×), rechts Schilder aus den HUD-Fixtures (Canvas = 2× der 1080p-Größe)
    const c = document.createElement('canvas'); c.width = 1280; c.height = 720
    const g = c.getContext('2d')!
    g.fillStyle = '#6b6152'; g.fillRect(0, 0, 1280, 720)
    const ref = await createImageBitmap(await (await fetch('cs3d://test/ref.png')).blob())
    const crops = a.crops ?? [[236, 118, 76, 34], [186, 266, 76, 36]]
    crops.forEach(([x, y, w, h]: number[], i: number) => g.drawImage(ref, x, y, w, h, 20, 50 + i * 230, w * 5, h * 5))
    const st = FIXTURES.start.view, de = FIXTURES.defuse.view, da = FIXTURES.schaden.view
    const pick = [
      [st.players.find(p => p.bomb), false, 'bomb carrier, round start'], [st.players.filter(p => p.side === 'CT').sort((x, y) => y.utility.length - x.utility.length)[0], false, 'CT, most utility'],
      [de.players.find(p => p.steamid === de.defuse?.steamid), true, 'defusing'], [da.players.find(p => p.alive && p.hp < 100), false, 'damaged'],
    ] as const
    const out: unknown[] = []
    pick.forEach(([p, defusing, cap], i) => {
      if (!p) return
      const lb = new Label(p.name)
      lb.set(p.hp, p.side, { weapon: key(p.weapon), utility: p.utility.map(key), bomb: p.bomb, defusing }, icons)
      g.drawImage((lb.sprite.material.map as THREE.CanvasTexture).image as HTMLCanvasElement, 660, 20 + i * 172)
      g.font = '600 14px Arial, sans-serif'; g.fillStyle = '#fff'; g.fillText(cap, 670, 30 + i * 172)
      out.push({ name: p.name, side: p.side, hp: p.hp, weapon: key(p.weapon), utility: p.utility.map(key), bomb: p.bomb, defusing })
      lb.dispose()
    })
    g.font = '600 14px Arial, sans-serif'; g.fillStyle = '#fff'
    g.fillText('reference (image 2, 5x)', 20, 30); g.fillText('ours (label canvas, 2x of 1080p size)', 670, 712)
    return { png: c.toDataURL('image/png'), labels: out, stratum: document.fonts.check('700 17px Stratum2') }
  }
  if (name === 'calls') {
    // je Modell im Cache: Agent 3,2 m vor der Kamera (wie engine: Schattenkarte, Sonne 50° hoch), alt (be79ebe) gegen neu
    rig()
    const R = d.header.rounds[14] ?? d.header.rounds[0], p = R.tracks[0], tick = R.firstTick + 20 * rate()
    view2([0, 1.6, 3.2], [0, 1, 0], 50, 30)
    const per: Record<string, unknown> = {}, sum = { before: 0, after: 0 }
    for (const url of A.all) {
      const row: Record<string, unknown> = {}
      for (const old of [true, false]) {
        const { a, x } = await mk(old, url, 'T', p, tick)
        S2.add(a.root)
        const off = calls()
        x.update(true, -Infinity, 0); const xray = calls()
        x.update(false, 1, 0.5); const damage = calls()
        x.update(false, -Infinity, 0); (a as any).wpnGroup.visible = false; const noWeapon = calls()
        // nicht in der Hülle: warum (Skelett, Material, Bindung)
        const hull = a.root.getObjectByName('csda_hull') as THREE.SkinnedMesh | undefined, own: string[] = []
        if (!old) a.root.traverse(o => {
          const m = o as THREE.SkinnedMesh, mt = m.material as THREE.MeshStandardMaterial
          if (m.isSkinnedMesh && m.userData.hull && m !== hull && m.layers.mask === 1)
            own.push(`${mt.name}: skel ${m.skeleton === hull?.skeleton} alpha ${mt.alphaTest} transp ${mt.transparent} side ${mt.side} bind ${m.bindMatrix.equals(hull!.bindMatrix)}`)
        })
        drop(a)
        row[old ? 'before' : 'after'] = { off, xray, damage, noWeapon, ...(own.length ? { own } : {}) }
        sum[old ? 'before' : 'after'] += off.main + off.shadow
      }
      per[url.split('/').slice(-2).join('/')] = row
    }
    return { models: per, totalOff: sum, changePct: +((100 * (sum.after - sum.before)) / sum.before).toFixed(1) }
  }

  if (name === 'cull') {
    // Kamera 1,6 m hoch, Blick nach −Z leicht nach unten; ein Agent an verschiedenen Orten, Sonne je Fall
    rig()
    const R = d.header.rounds[14] ?? d.header.rounds[0], p = R.tracks[0], tick = R.firstTick + 20 * rate()
    const cases = [
      { cap: 'in front 4 m', pos: [0, 0, -4], el: 50, az: 30 },
      { cap: 'behind 2.5 m, sun behind camera (shadow falls into view)', pos: [0, 0, 2.5], el: 25, az: 0, png: true },
      { cap: 'behind 2.5 m, sun ahead (shadow falls behind)', pos: [0, 0, 2.5], el: 25, az: 180 },
      { cap: 'behind 30 m (outside shadow box)', pos: [0, 0, 30], el: 50, az: 30 },
      { cap: 'side 8 m, out of view, sun from the far side', pos: [-8, 0, 1], el: 40, az: 90 },
    ]
    const out: unknown[] = [], c = document.createElement('canvas'); c.width = W2 * 3; c.height = H2
    const g = c.getContext('2d')!
    for (const k of cases) {
      view2([0, 1.6, 0], [0, 0, -4], k.el, k.az)
      const row: Record<string, unknown> = { cap: k.cap }, img: ImageData[] = []
      for (const old of [true, false]) {
        const { a } = await mk(old, A.models.T, 'T', p, tick)
        a.root.position.fromArray(k.pos); a.root.updateMatrixWorld(true)
        S2.add(a.root)
        row[old ? 'before' : 'after'] = calls()
        if (k.png) img.push(pixels())
        drop(a)
      }
      if (k.png) {
        const df = diff(img[0], img[1]); row.pixelDiffPct = df.pct
        img.forEach((im, i) => g.putImageData(im, i * W2, 0)); g.putImageData(df.img, 2 * W2, 0)
      }
      out.push(row)
    }
    // Ring: 10 Agenten (Modelle reihum, Spieler der Runde) im Kreis 6 m um die Kamera; Sonne 50° hoch
    view2([0, 1.6, 0], [0, 0.6, -4], 50, 60)
    const ring: Record<string, unknown> = {}
    for (const old of [true, false]) {
      const ags: Awaited<ReturnType<typeof mk>>[] = []
      for (let i = 0; i < 10; i++) {
        const m = await mk(old, A.all[i % A.all.length], 'T', R.tracks[i % R.tracks.length], tick)
        m.a.root.position.set(6 * Math.sin(i * 0.628), 0, 6 * Math.cos(i * 0.628)); m.a.root.updateMatrixWorld(true)
        S2.add(m.a.root); ags.push(m)
      }
      const off = calls()
      for (const m of ags) m.x.update(true, -Infinity, 0)
      ring[old ? 'before' : 'after'] = { off, xray: calls() }
      for (const m of ags) drop(m.a)
    }
    g.font = '600 14px Arial, sans-serif'; g.fillStyle = '#fff'; g.shadowColor = '#000'; g.shadowBlur = 4
    ;['before (be79ebe)', 'after', 'difference x8'].forEach((t, i) => g.fillText(`${t}: agent 2.5 m behind the camera, sun behind`, i * W2 + 10, 22))
    return { png: c.toDataURL('image/png'), cases: out, ring10: ring }
  }

  if (name === 'diff') {
    // 3 Posen (Nachladen, Pin, Messer + Schadens-Rot), alt (be79ebe) gegen neu mit Schattenkarte; Kamera vorn rechts wie 'scene'
    rig()
    const picks = [[scenario('reload'), 2, A.models.T], [scenario('throw'), 1, A.models.CT], [scenario('knife'), 2, A.all.find(u => u.includes('tm_leet_variantf')) ?? A.models.T]] as const // tm_leet: Hände im Körper-Teil (agents.ts joins)
    const c = document.createElement('canvas'); c.width = W2 * 3; c.height = H2 * 3
    const g = c.getContext('2d')!, out: unknown[] = []
    for (const [i, [sc, j, url]] of picks.entries()) {
      const img: ImageData[] = []
      let yaw = 0
      for (const old of [true, false]) {
        const m = await mk(old, url, 'T', sc.p, sc.panels[j].tick)
        yaw = m.yaw * D2R
        if (i === 2) m.x.update(false, 1, 0.6) // Schadens-Rot bis 1 m
        S2.add(m.a.root)
        view2([Math.sin(yaw) * 2.8 - Math.cos(yaw) * 1.9, 1.3, Math.cos(yaw) * 2.8 + Math.sin(yaw) * 1.9], [0, 1.05, 0], 45, m.yaw + 120)
        calls(); img.push(pixels())
        drop(m.a)
      }
      const df = diff(img[0], img[1])
      img.forEach((im, k) => g.putImageData(im, k * W2, i * H2)); g.putImageData(df.img, 2 * W2, i * H2)
      out.push({ pose: sc.panels[j].cap, player: d.header.players[sc.p].name, pixelDiffPct: df.pct })
    }
    g.font = '600 14px Arial, sans-serif'; g.fillStyle = '#fff'; g.shadowColor = '#000'; g.shadowBlur = 4
    ;['before (be79ebe)', 'after (hull + culling)', 'difference x8'].forEach((t, k) => g.fillText(t, k * W2 + 10, 22))
    return { png: c.toDataURL('image/png'), poses: out }
  }

  if (name === 'frame') {
    // Engine-Bild ohne Map nachgestellt (Draw-Calls nur der Agenten): Runde/Sekunde ab Freeze-Ende, Ego von match.players[a.player],
    // Modell je Spieler und Seite, Tote umgefallen, Sonne aus map.json und Schatten-Box ±20 m um das Auge wie engine/index.ts
    rig()
    const m = JSON.parse(await new Response((await fetch('cs3d://test/match.json.gz')).body!.pipeThrough(new DecompressionStream('gzip'))).text()) as MatchData
    const tick = Math.round(m.rounds[a.round - 1].freezeEndTick + a.sec * rate()), r = roundAt(d, tick), Rd = d.header.rounds[r], P = d.header.players
    const v1 = m.rounds.find(x => x.num === Rd.num)!, focus = P.findIndex(x => x.steamid === m.players[a.player].steamid)
    if (!sample(focus, tick, s0)) throw new Error('focus not in round')
    worldToGltf(s0.x, s0.y, eyeZ(s0.z, s0.duck), cam2.position)
    cam2.rotation.set(-(s0.pitch + s0.viewP + 0.9 * s0.aimP) * D2R, (s0.yaw + s0.viewY + 0.9 * s0.aimY) * D2R + Math.PI, 0, 'YXZ')
    cam2.fov = (2 * Math.atan(Math.tan(((s0.fov || 90) / 2) * D2R) * 0.75)) / D2R; cam2.aspect = 16 / 9; cam2.updateProjectionMatrix(); cam2.updateMatrixWorld()
    sun2.target.position.copy(cam2.position); sun2.position.copy(cam2.position).addScaledVector(new THREE.Vector3().fromArray(A.toSun).normalize(), 80); sun2.target.updateMatrixWorld()
    const ground = S2.children.find(o => (o as THREE.Mesh).isMesh)!
    ground.visible = false
    const out: Record<string, unknown> = { tick, focus: P[focus].name, agents: Rd.tracks.length - 1 }
    for (const old of [true, false]) {
      const ags: Awaited<ReturnType<typeof mk>>[] = []
      let inView = 0
      const dist: string[] = []
      for (const [k, p] of Rd.tracks.entries()) {
        if (p === focus) continue
        const side = (v1.tracks.find(t => t.steamid === P[p].steamid)?.side ?? 'T') as Side
        const url = A.agentUrls[P[p].agent?.[side] || AGENT_DEFAULT[side]] ?? A.models[side]
        // tot: letzte lebende Pose, dann umgefallen (wie engine/index.ts nach 0,45 s)
        let t = tick
        const fb = d.frameBase[r] + k * Rd.nFrames, fi = Math.max(0, Math.min(Rd.nFrames - 1, Math.floor((tick - Rd.firstTick) / d.header.frameStep)))
        const dead = !(d.flags[fb + fi] & FLAG.alive)
        if (dead) { let i = fi; while (i > 0 && !(d.flags[fb + i] & FLAG.alive)) i--; if (!(d.flags[fb + i] & FLAG.alive)) continue; t = Rd.firstTick + i * d.header.frameStep }
        const mm = await mk(old, url, side, p, t)
        poseAt(mm.a, p, t, true, true)
        if (dead) mm.a.fall?.(1, new THREE.Vector3(1, 0, 0)) // nur der alte Stand; die App legt Tote als Ragdoll (ragdoll.ts, braucht die Map)
        mm.a.root.updateMatrixWorld(true)
        const age = hitAge(d, p, tick) // Schadens-Rot ist in der App an (Höhe hier fest 1 m statt fehlender HP)
        mm.x.update(!!a.xray && !dead, age >= 0 ? mm.a.root.position.y + 1 : -Infinity, damagePulse(age))
        S2.add(mm.a.root); ags.push(mm)
        const vis = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam2.projectionMatrix, cam2.matrixWorldInverse)).intersectsSphere(CULL.clone().applyMatrix4(mm.a.root.matrixWorld))
        if (vis) inView++
        dist.push(`${P[p].name}${dead ? '†' : ''} ${mm.a.root.position.distanceTo(cam2.position).toFixed(0)} m${vis ? ' in view' : ''}`)
      }
      const c = calls()
      out[old ? 'before' : 'after'] = { main: c.main + 1, shadow: c.shadow, total: c.main + 1 + c.shadow, inView } // +1: Boden ist aus
      if (!old) { out.agentsDist = dist; out.png = pixels2png() }
      for (const mm of ags) drop(mm.a)
    }
    ground.visible = true
    return out
  }

  if (name === 'scope') {
    // Hintergrund (CS2-Ladebild) + Hud-Zielfernrohr in Bildgröße (1 Bildpixel = 1 Gerätepixel)
    const res = await fetch('cs3d://test/scope-bg.png')
    if (!res.ok) throw new Error(`scope-bg.png: HTTP ${res.status}`)
    const bg = await createImageBitmap(await res.blob()).catch(e => { throw new Error(`scope-bg.png: ${e?.message ?? e?.type ?? e}`) })
    const c = document.createElement('canvas'); c.width = bg.width; c.height = bg.height
    const g = c.getContext('2d')!
    // eigenes Canvas darüber wie in der App (.h3-xhair über dem WebGL-Canvas): drawScope setzt die Kreuzung per putImageData
    const o = document.createElement('canvas'); o.width = c.width; o.height = c.height
    drawScope(o.getContext('2d')!, c.width, c.height, a.k ?? 0)
    g.drawImage(bg, 0, 0); g.drawImage(o, 0, 0)
    return { png: c.toDataURL('image/png'), w: c.width, h: c.height, k: a.k ?? 0 }
  }

  if (name === 'sphere') {
    // Deckt CULL alle gehäuteten Ecken (Hülle) und die Waffe ab? Runden a.rounds (Index, 'all' = alle; Standard Runde 15), alle Spieler,
    // a.frames Zeitpunkte je Runde, stehend und umgefallen (fall 0,45 s)
    rig()
    const H = d.header, N = a.frames ?? 30, v = new THREE.Vector3(), c = new THREE.Vector3()
    const rounds = a.rounds === 'all' ? H.rounds : ((a.rounds ?? [14]) as number[]).map(i => H.rounds[i] ?? H.rounds[0])
    const ratios: number[] = []
    const worst: Record<string, { ratio: number; what: string }> = {}
    const note = (dist: number, what: string, cat: string) => {
      const r = dist / CULL.radius; ratios.push(r)
      if (r > (worst[cat]?.ratio ?? 0)) worst[cat] = { ratio: +r.toFixed(3), what }
    }
    for (const Rd of rounds) for (const [k, p] of Rd.tracks.entries()) {
      const { a: ag } = await mk(false, k % 2 ? A.models.CT : A.models.T, 'T', p, Rd.firstTick)
      const hull = ag.root.getObjectByName('csda_hull') as THREE.SkinnedMesh
      for (let f = 0; f < N; f++) {
        const t = Rd.firstTick + Math.floor(((f + 0.5) / N) * Rd.nFrames * H.frameStep)
        if (!sample(p, t, s0) || !(s0.flags & FLAG.alive)) continue
        poseAt(ag, p, t, true); ag.setWeapon(s0.weapon, await weapon(s0.weapon), null)
        for (const fallen of ag.fall ? [false, true] : [false]) { // Ragdoll: Wurzel folgt dem Becken (Agent.ragdoll), Kugel bleibt um den Körper
          if (fallen) ag.fall(0.45, new THREE.Vector3(1, 0, 0))
          ag.root.updateMatrixWorld(true); THREE.Skeleton.prototype.update.call(hull.skeleton)
          c.copy(CULL.center).applyMatrix4(ag.root.matrixWorld)
          let m = 0
          for (let i = 0; i < hull.geometry.attributes.position.count; i++) m = Math.max(m, hull.getVertexPosition(i, v).applyMatrix4(hull.matrixWorld).distanceTo(c))
          note(m, `${H.players[p].name} t${t}`, fallen ? 'bodyFallen' : 'body')
          if (fallen) continue
          let w = 0
          ;(ag as any).wpnGroup.traverseVisible((o: THREE.Object3D) => {
            const g = (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry
            if (!g) return
            g.boundingBox ?? g.computeBoundingBox()
            const b = g.boundingBox!
            for (let q = 0; q < 8; q++) w = Math.max(w, v.set(q & 1 ? b.max.x : b.min.x, q & 2 ? b.max.y : b.min.y, q & 4 ? b.max.z : b.min.z).applyMatrix4(o.matrixWorld).distanceTo(c))
          })
          if (w) note(w, `${H.players[p].name} t${t} ${A.weapons[s0.weapon]?.className}`, 'weaponBox')
        }
      }
      drop(ag)
    }
    ratios.sort((x, y) => x - y)
    return { radius: CULL.radius, samples: ratios.length, worst, p99: +ratios[Math.floor(ratios.length * 0.99)].toFixed(3), outside: ratios.filter(r => r > 1).length }
  }
  throw new Error('unknown step ' + name)
}
console.log('agent page ready')
