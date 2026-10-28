// 3D-Engine des Replays (contracts.ts → CreateEngine): CS2-Map, Agenten mit Waffen und Oberkörper-Aktionen, Kameras free/ego,
// Raycast für die Effekte (fertig vor dem ersten Bild), Überkopf-Schilder, X-Ray + Schadens-Rot (xray.ts), Granaten-Kamera (nadecam.ts),
// Agenten-Schatten (Shadow-Map nur Agenten→Map, Low: Blob), dynamische Auflösung (Critic P1-5).
// Low quality (options.ts lowQuality) wirkt sofort, ohne Neuladen und ohne neues Programm: Render-Skala höchstens 0,75, ohne MSAA/Bloom,
// Blob- statt Sonnenschatten (Shadow-Map bleibt angelegt, wird nur nicht mehr gezeichnet), ohne Granaten-Kamera; Effekt-Lichter: effects.
// Bild wie CS2 (post.ts): Welt + Viewmodel linear in ein HDR-Ziel, Himmel (gedreht) und Nebel davor, Endpass mit Auto-Belichtung,
// Hable-Kurve, Bloom (nur High) und LUT aufs Canvas; danach Flash-Schicht der Effekte und Granaten-Kamera (gleiches Endpass-Programm).
// Lichtanzahl steht ab dem ersten Bild fest (Sonne, Hemisphere, 4 Punktlichter für Effekte). Optionen aus options.ts, Free-Cam-Tasten
// aus hotkeys.ts; dirty() meldet dem Bildtakt, wann in der Pause ein neues Bild nötig ist, onDirty weckt ihn.
// Utility-Vorschau (utility/preview): ohne Agenten-Assets (nur Map gebaut) Spieler nur als Kamera; setMarks zeichnet Ziel + Flugbahn (marks.ts),
// setZoom teilt das Blickfeld, setView übersteuert die Kamera (Granate folgen mit nadecam.ts nadePose, Außenansicht) mit weicher Überblendung.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { AGENT_DEFAULT, EV, FLAG, NADE, TELEPORT, newSample, roundAt, sampleTrack, upperBound, type TrackSample } from '../../../shared/cs3d'
import { floorLayer, parseFloorGrid, type PrepareProgress } from '../../../shared/assets3d'
import type { Side } from '../../../shared/model'
import { CS2_VFOV, HU, eyeZ, worldToGltf, type CameraMode, type CreateEngine, type EffectsContext, type LineupView, type OverlayState } from '../contracts'
import { actionsOf } from '../actions'
import { createEffects } from '../effects'
import { getHotkeys, type HotkeyAction } from '../hotkeys'
import { getOptions, onOptions, shown } from '../options'
import { Agent, Label, adopt, flashWeight, phaseInc, worldClips, type Ragdoll, type WeaponTemplate } from './agents'
import { loadMap, releaseSkyRefl, setSkyRefl } from './map'
import { createDrops } from './drops'
import { createMarks } from './marks'
import { createNadeCam, nadePose } from './nadecam'
import { installMapLight } from './lighting'
import { createPost, installFog } from './post'
import { NP, RP, simulate } from './ragdoll'
import { buildRaycastAsync, type MapRaycast, type Raycast } from './raycast'
import { SkinCache } from './skins'
import { uploadPlugin } from './texstream'
import { VM_DEFAULT, Viewmodel, vmStateAt, type VmTemplate } from './viewmodel'
import { LABEL_ORDER, MAP_ORDER, XrayTwins, damagePulse, hitAge, setXrayHeight } from './xray'

const D2R = Math.PI / 180
/** Render-Skalen der dynamischen Auflösung; Low höchstens 0,75; bei 0,5 Bloom + MSAA aus */
const SCALES = [1, 0.75, 0.5]
/** Scharfschützengewehre mit Scope-Bild (wie Hud.tsx SNIPER, Anzeigenamen) */
const SNIPER = /awp|ssg|g3sg1|scar-20/i
/** Free-Cam u/s (camFast ×3) und Grad pro Pixel */
const FLY = 600, LOOK = 0.15
/** Free-Cam näher als so viele u an der Körperachse (Füße bis Auge) eines Spielers: Modell ausblenden */
const NEAR_U = 40
/** Utility-Vorschau, Granate folgen: Kamera so weit hinter (m) und über (m) dem Projektil; Außenansicht ohne freien Kreis: Schwenk ± (rad) */
const FOLLOW_M = 1.3, FOLLOW_UP = 0.35, SWEEP = 35 * (Math.PI / 180)
/** Free-Cam-Bewegungstasten (hotkeys.ts); camFast allein bewegt nicht */
const MOVE: HotkeyAction[] = ['camForward', 'camBack', 'camLeft', 'camRight', 'camUp', 'camDown']
/** horizontales CS-FOV (4:3) → vertikales FOV */
const vfov = (fov: number) => (2 * Math.atan(Math.tan((fov / 2) * D2R) * 0.75)) / D2R

async function bin(url: string) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`)
  return r.arrayBuffer()
}

/** Tod in einer Runde: Angreifer (Spieler-Index, 255 = Welt), Kopfschuss; rag = Ragdoll, beim ersten Bild danach gerechnet (null = geht nicht) */
interface Death { tick: number; att: number; hs: boolean; rag?: Ragdoll | null }
/** Treffer-Stärke (m/s am getroffenen Teil) nach Waffenklasse; CS2-Kräfte stehen nicht in den Daten, nach Bild gewählt. Sonst Pistole 4, Gewehr 5,5 */
const PUSH: [RegExp, number][] = [[/knife|bayonet/, 2.5], [/taser/, 1.5], [/awp/, 9], [/ssg08|deagle|revolver|nova|xm1014|mag7|sawedoff/, 7], [/g3sg1|scar20/, 6.5], [/mac10|mp9|mp7|mp5sd|ump45|p90|bizon/, 4]]

export const createEngine: CreateEngine = async (canvas, assets, data, onProgress, opts) => {
  const t0 = performance.now()
  const d = data.d, H = d.header, step = H.frameStep, rate = H.tickrate, P = H.players
  if (!H.rounds.length) throw new Error('This match has no 3D data.')
  const st = assets.map.settings
  const progress = (stage: PrepareProgress['stage'], pct: number, msg: string) => onProgress?.({ stage, pct, msg })

  await restore(canvas)
  // Canvas nur für den Endpass: ohne MSAA/Tiefe/Stencil (die hat das HDR-Ziel, Stencil für X-Ray); Tonemapping macht post.ts
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' })
  let fogOff = () => {}, litP: Promise<() => void> = Promise.resolve(() => {}), refl: THREE.Texture | null = null
  try {
    renderer.setPixelRatio(1)
    renderer.shadowMap.enabled = true
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(CS2_VFOV, 16 / 9, 0.05, 1000)

    // ---------------------------------------------------------------- Laden (parallel)
    progress('map', 0, 'Loading map')
    // native CS2-Texturen bleiben BC1/BC3/BC5/BC7 auf der GPU (D3D11-Grafikkarten können das alle)
    const missing = ['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb', 'EXT_texture_compression_bptc'].filter(x => !renderer.extensions.has(x))
    if (missing.length) throw new Error(`The graphics driver does not support BC texture compression (${missing.join(', ')}), which the 3D map needs.`)
    const ktx2 = new KTX2Loader().detectSupport(renderer)
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).register(uploadPlugin(renderer)) // GLB-Texturen gleich hochladen
    const models = assets.agents.models
    const modelUrl = (p: number, side: Side) => models[P[p].agent?.[side] ?? 0] ?? models[AGENT_DEFAULT[side]]
    const v1ByNum = new Map(data.match.rounds.map(R => [R.num, R]))
    const rounds = H.rounds.map(R => {
      const v1 = v1ByNum.get(R.num)
      const k1 = R.tracks.map(p => v1 ? v1.tracks.findIndex(t => t.steamid === P[p].steamid) : -1)
      return { v1, k1, sides: k1.map(i => (i >= 0 ? v1!.tracks[i].side : 'T') as Side) }
    })
    const agentKeys = new Map<string, string>() // `${p}:${side}` → Modell-URL; ohne Agenten-Assets (Utility-Vorschau nur mit Map) leer
    rounds.forEach((ri, r) => H.rounds[r].tracks.forEach((p, k) => { const u = modelUrl(p, ri.sides[k]); if (u) agentKeys.set(`${p}:${ri.sides[k]}`, u) }))
    const glbCache = new Map<string, Promise<THREE.Object3D>>()
    const glb = (url: string) => {
      let g = glbCache.get(url)
      if (!g) glbCache.set(url, (g = loader.loadAsync(url).then(x => x.scene)))
      return g
    }
    const weaponDefs = H.weapons.filter(w => assets.weapons[w])
    // Skins: Legacy-Meshes (body_legacy) der 3rd-Person-Waffen und Handschuh-Modelle gleich mitladen (klein: 11 + 1 MB)
    const gloveDefs = Object.keys(assets.gloves ?? {}).map(Number)
    const opt = (u: string | undefined) => u ? glb(u).catch(e => { console.warn('skin model', u, e); return null }) : null
    // Env-Ersatz + stationäre Lichter der Map (lighting.ts): Chunk-Patch vor dem ersten Übersetzen
    litP = installMapLight(renderer, st, assets.map.lightmap).catch(e => { console.warn('map light', e); return () => {} })
    const mapP = loadMap(assets.map, ktx2, renderer, 8, f => progress('map', f * 60, 'Loading map')).finally(() => ktx2.dispose())
    // Kollisionsgitter im Worker, sobald die Map da ist (parallel zu Agenten/Waffen); vor dem ersten Bild abgewartet
    const rayP = mapP.then(m => buildRaycastAsync(m.solid).catch(e => { console.warn('raycast', e); return null }), () => null)
    const [map, clipScene, templates, weaponScenes, legacyScenes, gloveList, floorBuf, probeBuf, lutBuf] = await Promise.all([
      mapP,
      assets.agents.clips ? loader.loadAsync(assets.agents.clips) : null,
      Promise.all([...new Set(agentKeys.values())].map(async u => [u, await glb(u)] as const)).then(e => new Map(e)),
      Promise.all(weaponDefs.map(w => { const u = assets.weapons[w].glb; return u ? glb(u) : null })),
      Promise.all(weaponDefs.map(w => opt(assets.weapons[w].legacyGlb))),
      Promise.all(gloveDefs.map(g => opt(assets.gloves![g]))),
      bin(assets.map.floor), bin(assets.map.probes),
      // LUT auf allen Maps: mit Auto-Belichtung (post.ts) sind Ancient/Inferno/Nuke nicht mehr zu dunkel
      assets.map.lut ? bin(assets.map.lut).catch(e => { console.warn('lut', e); return null }) : null,
    ])
    const litOff = await litP
    progress('agents', 70, 'Preparing agents')
    const grid = parseFloorGrid(floorBuf, probeBuf)
    const clips = new Map((clipScene?.animations ?? []).map(c => [c.name, c]))
    const weapons = new Map<number, WeaponTemplate>(weaponDefs.map((w, i) => [w, { asset: assets.weapons[w], scene: weaponScenes[i], legacy: legacyScenes[i] }]))
    const gloveScenes = new Map<number, THREE.Object3D>()
    gloveDefs.forEach((g, i) => { if (gloveList[i]) gloveScenes.set(g, gloveList[i]!) })
    // dirty(): Bild in der Pause nötig (Optionswechsel, Overlay, Nachgeladenes, fertiger Skin, Maus); gehaltene Free-Cam-Tasten und
    // offene Effekt-Arbeit (Smoke-/Feuer-Füllung, Impact-Strahlen) prüft dirty() selbst. touch() weckt dazu den schlafenden Bildtakt (onDirty).
    let dirty = true, onDirty: (() => void) | undefined
    const touch = () => { dirty = true; onDirty?.() }
    const skins = new SkinCache(renderer, assets, H.skins, P, touch, 2048) // Ego-Skin/-Handschuh

    // ---------------------------------------------------------------- Szene
    scene.add(map.root)
    // statische Map-Geometrie: CPU-Kopie gleich nach dem Hochladen weg (Raycast hat seine Kopie schon, Culling braucht nur die
    // boundingSphere, die three vor dem ersten Hochladen rechnet). Gemessen Ancient: −170 MB Renderer-RAM schon beim Öffnen, mehr beim Umherfliegen.
    map.root.traverse(o => {
      const g = (o as THREE.Mesh).geometry
      if (g) for (const a of [...Object.values(g.attributes), g.index]) ((a as THREE.InterleavedBufferAttribute)?.isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data : a as THREE.BufferAttribute | null)?.onUpload(freeArray)
    })
    for (const m of map.meshes) m.receiveShadow = true
    for (const m of map.solid) m.renderOrder = MAP_ORDER // opake Map zuerst: X-Ray testet nur gegen sie
    scene.background = map.sky ?? new THREE.Color(0x9cc3e6)
    scene.backgroundIntensity = st.sky.backgroundIntensity
    scene.backgroundRotation.y = ((st.sky.yawDeg ?? 0) + 90) * D2R // env_sky angles[1]; +90° = three-Equirect gegen Source-Achsen (L, Ladebilder)
    const post = createPost(renderer, st, lutBuf, true, true)
    fogOff = installFog(renderer, scene, st)
    refl = setSkyRefl(map.sky, st) // Metall der Agenten/Waffen spiegelt den Himmel (vor dem ersten Übersetzen)
    const toSun = new THREE.Vector3(...st.sun.toSunGltf).normalize()
    const sun = new THREE.DirectionalLight()
    sun.color.setRGB(...st.sun.colorSRGB, THREE.SRGBColorSpace); sun.intensity = st.sun.threeIntensity
    sun.position.copy(toSun).multiplyScalar(100)
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048)
    Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 200 })
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02
    const hemi = new THREE.HemisphereLight(new THREE.Color().setRGB(211 / 255, 226 / 255, 248 / 255, THREE.SRGBColorSpace), new THREE.Color().setRGB(0.55, 0.45, 0.35, THREE.SRGBColorSpace), 1.5)
    const lights = Array.from({ length: 4 }, () => new THREE.PointLight(0xffffff, 0, 8, 2))
    scene.add(sun, sun.target, hemi, ...lights)

    const agents = new Map<string, Agent>(), xrays = new Map<Agent, XrayTwins>()
    for (const [key, url] of agentKeys) {
      const a = new Agent(templates.get(url)!, clips)
      agents.set(key, a); scene.add(a.root)
      xrays.set(a, new XrayTwins(a.root, key.endsWith(':CT') ? 'CT' : 'T'))
    }
    // Schilder auf Layer 1: Hauptkamera sieht 0 + 1, die Granaten-Kamera nur 0; nach Rauch/Feuer und X-Ray (durch Smokes lesbar wie CS2)
    const labels = P.map(p => { const l = new Label(p.name); l.sprite.layers.set(1); l.sprite.material.fog = false; l.sprite.renderOrder = LABEL_ORDER; scene.add(l.sprite); return l })
    camera.layers.enable(1)
    let overlay: OverlayState = { labels: {} }
    // Blob-Schatten (Low); bis zum ersten Bild sichtbar, damit compileAsync das Programm mit übersetzt
    const blobs = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 64
      const g = c.getContext('2d')!, gr = g.createRadialGradient(32, 32, 0, 32, 32, 32)
      gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64)
      const b = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }), P.length)
      b.frustumCulled = false; scene.add(b)
      return b
    })()

    // ab dem ersten Bild fertig (await rayP unten; lazyRay: kurz danach, rayDone); nur wenn der Worker scheitert, trifft der Raycast nie etwas
    let ray: Raycast = () => Infinity, mapRay: MapRaycast | null = null, rayDone = false // mapRay.near: Dreiecke für die Ragdolls
    const raycast: Raycast = (o, d, far) => ray(o, d, far)

    // ---------------------------------------------------------------- Effekte
    const active: (Agent | null)[] = P.map(() => null)
    const silenced = new Uint8Array(P.length)
    // Flash-Nachbild: Kopie des Canvas nach dem Endpass (vor Flash-Schicht und Granaten-Kamera), nur auf Anfrage; gültig im Bild danach
    let frameNo = 0, capAt = -2, capWant = false, capTex: THREE.FramebufferTexture | null = null
    const ctx: EffectsContext = {
      scene, camera, data, assets, lights, raycast, rayReady: () => rayDone,
      muzzle: (p, out) => active[p]?.muzzle(out, silenced[p] === 1) ?? false,
      captureFrame() { if (capAt === frameNo) return capTex; capWant = true; return null },
    }
    const effects = createEffects(ctx)
    const nadeCam = createNadeCam(renderer, scene, data, true) // Low: render() unten gar nicht aufrufen
    /** Programme für die HDR-Ziele übersetzen (in Render-Targets ohne Tonemapping/sRGB-Ausgabe → anderer Programm-Schlüssel als aufs Canvas) */
    const compileHdr = (s: THREE.Object3D, c: THREE.Camera) => {
      const prev = renderer.getRenderTarget()
      renderer.setRenderTarget(post.target)
      const p = renderer.compileAsync(s, c) // übersetzt synchron, wartet dann nur noch
      renderer.setRenderTarget(prev)
      return p
    }
    const X = actionsOf(d, assets.weapons) // einmal beim Laden (sonst baut das erste Bild die Liste, ~25 ms); Audio nutzt denselben Cache
    const drops = createDrops(scene, d, weapons, skins, grid, raycast) // liegende Waffen (CS3D v6)

    const offOptions = onOptions(() => { dirty = true }) // den Takt weckt frameloop.ts selbst

    // ---------------------------------------------------------------- Ego-Sicht: Arme je Agentenmodell, Waffe je Def erst bei Bedarf
    // laden (VRAM) und vorab übersetzen (compileAsync), bis dahin ohne Viewmodel. Welt-Clips der Spielermodelle ebenso je Waffe.
    const flashTex = muzzleTexture()
    // vmTpl/vmOk: Schlüssel def bzw. −def (Legacy-Mesh für Legacy-Skins)
    const vms = new Map<string, Viewmodel>(), vmTpl = new Map<number, VmTemplate>(), vmOk = new Map<Viewmodel, Set<number>>(), vmBusy = new Set<string>()
    const vmRoots: THREE.Object3D[] = [] // für dispose
    const loading = new Set<Promise<void>>() // laufende Nachlade-Aufträge (warm wartet darauf)
    const later = (key: string, job: () => Promise<void>) => {
      if (vmBusy.has(key)) return
      vmBusy.add(key)
      const p = job().then(touch, e => console.warn('lazy load', key, e))
      loading.add(p); void p.then(() => loading.delete(p))
    }
    const worldSeen = new Set<number>(), animCache = new Map<string, Promise<THREE.AnimationClip[]>>()
    /** Welt-Clips einer Waffe einmal laden (eine GLB je Waffenklasse) und allen Agenten geben (worldClips macht shoot_* additiv) */
    function worldFor(def: number) {
      if (worldSeen.has(def)) return
      worldSeen.add(def)
      const w = assets.weapons[def]?.world
      if (!w) return
      later('world' + def, async () => {
        let c = animCache.get(w.clips)
        if (!c) animCache.set(w.clips, (c = loader.loadAsync(w.clips).then(g => { vmRoots.push(g.scene); return g.animations })))
        const wc = worldClips(w.roles, await c)
        for (const a of agents.values()) a.setWorldClips(def, wc)
      })
    }
    function viewmodel(p: number, side: Side, key: number): Viewmodel | null {
      const url = assets.agents.arms?.[P[p].agent?.[side] ?? 0] ?? assets.agents.arms?.[AGENT_DEFAULT[side]], w = assets.weapons[Math.abs(key)]?.vm
      const src = key < 0 ? w?.legacyGlb : w?.glb
      if (!url || !w || !src) return null
      const vm = vms.get(url), tpl = vmTpl.get(key)
      if (!vm) later(url, async () => { const s = await glb(url); uploadAndFree(renderer, [s], []); const v = new Viewmodel(s, sun, flashTex); v.scene.fog = scene.fog; vmRoots.push(s, v.scene); vmOk.set(v, new Set()); vms.set(url, v) })
      if (!tpl) later('w' + key, async () => {
        const [s, c] = await Promise.all([glb(src), loader.loadAsync(w.clips)])
        uploadAndFree(renderer, [s], []); vmRoots.push(s, c.scene); vmTpl.set(key, { scene: s, clips: c.animations })
      })
      if (!vm || !tpl) return null
      const ok = vmOk.get(vm)!
      if (!ok.has(key)) later(`${url}|${key}`, async () => { vm.addWeapon(key, tpl); await compileHdr(vm.scene, vm.camera); ok.add(key) })
      return ok.has(key) ? vm : null
    }
    let vmShow: Viewmodel | null = null

    // ---------------------------------------------------------------- Zustand pro Bild
    const samples = P.map(() => newSample()), tmp = newSample()
    let curRound = -1, lastTick = NaN, deaths: (Death | null)[] = [], phases: Float64Array[] = []
    /** je Runde einmal: Tode (mit ihren Ragdolls) und Schrittphasen; bleiben beim Rundenwechsel, Spulen zurück rechnet nichts neu */
    const roundState = new Map<number, { deaths: (Death | null)[]; phases: Float64Array[] }>()
    const deathsOf = (r: number): (Death | null)[] => {
      const R = H.rounds[r], n = R.nFrames, end = R.firstTick + (n - 1) * step
      const ev = new Map<number, Death>() // Opfer → erster Tod
      for (let i = upperBound(d.evt.tick, R.firstTick - 1); i < d.evt.tick.length && d.evt.tick[i] <= end; i++)
        if (d.evt.type[i] === EV.player_death && !ev.has(d.evt.player[i])) ev.set(d.evt.player[i], { tick: d.evt.tick[i], att: d.evt.arg[i] & 255, hs: (d.evt.arg[i] & 256) !== 0 })
      return R.tracks.map((p, k) => {
        const fb = d.frameBase[r] + k * n
        let was = false, i = 0
        for (; i < n; i++) { const alive = (d.flags[fb + i] & FLAG.alive) !== 0; if (alive) was = true; else if (was) break }
        if (i === n) return null
        return ev.get(p) ?? { tick: R.firstTick + i * step, att: 255, hs: false }
      })
    }
    /** Schrittphase je Track, je Frame aufsummiert wie Agent.pose (phaseInc): hängt nicht vom Abspielen ab (Spulen, Todespose der Ragdoll) */
    const phasesOf = (r: number) => {
      const R = H.rounds[r], n = R.nFrames, dt = step / rate
      return R.tracks.map((_, k) => {
        const fb = d.frameBase[r] + k * n, out = new Float64Array(n)
        const speed = (i: number) => {
          const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1), s = Math.hypot(d.x[fb + b] - d.x[fb + a], d.y[fb + b] - d.y[fb + a])
          return b === a || s > TELEPORT ? 0 : s / ((b - a) * dt)
        }
        for (let i = 1; i < n; i++) {
          const f = d.flags[fb + i]
          out[i] = out[i - 1] + (f & (FLAG.airborne | FLAG.planting | FLAG.defusing) ? 0 : phaseInc((speed(i - 1) + speed(i)) / 2, d.duck[fb + i] > 0.5, (f & FLAG.walking) !== 0, dt))
        }
        return out
      })
    }
    const phaseAt = (r: number, k: number, tick: number) => {
      const R = H.rounds[r], ph = phases[k], f = Math.max(0, Math.min(R.nFrames - 1, (tick - R.firstTick) / step)), i = Math.floor(f)
      return (ph[i] + (ph[Math.min(R.nFrames - 1, i + 1)] - ph[i]) * (f - i)) % 1
    }
    /** Boden (three-y) unter einem Punkt (three) aus dem Boden-Raster, −Infinity = keiner: Netz für Ragdoll-Teile außerhalb der Dreiecke */
    const floorY = (x: number, y: number, z: number) => { const l = floorLayer(grid, z / HU, x / HU, y / HU, 200); return l < 0 ? -Infinity : grid.z[l] * HU }
    const hitDir = new THREE.Vector3(), hitAt = new THREE.Vector3(), pushOf = (def: number) => {
      const w = assets.weapons[def]
      return w ? PUSH.find(([re]) => re.test(w.className))?.[1] ?? (w.anim === 'pistol' ? 4 : 5.5) : 5
    }
    /**
     * Treffer-Impuls (m/s) auf die Ragdoll-Partikel v: HE = Druck von der Detonation auf alle Teile; sonst Richtung des letzten Schusses des
     * Angreifers (≤ 0,5 s), ohne Schuss (Messer, Zeus) Angreifer → Opfer; Kopfschuss auf den Kopf, sonst Brust und Schultern, ein Viertel
     * davon auf den ganzen Körper. Welt, Feuer, Sturz: kein Impuls, nur Schwerkraft.
     */
    function hitImpulse(v: Float32Array, dth: Death, r: number, k: number, x: ArrayLike<number>) {
      const add = (i: number, s: number) => { v[i * 3] += hitDir.x * s; v[i * 3 + 1] += hitDir.y * s; v[i * 3 + 2] += hitDir.z * s }
      const N = d.nade
      for (let i = upperBound(N.throwTick, dth.tick) - 1; i >= 0 && N.throwTick[i] > dth.tick - 10 * rate; i--) {
        if (N.type[i] !== NADE.he || N.detTick[i] > dth.tick || N.detTick[i] < dth.tick - rate / 4) continue
        hitDir.set(x[0], x[1], x[2]).sub(worldToGltf(N.x[i], N.y[i], N.z[i], hitAt))
        const dist = hitDir.length() / HU
        if (dist > 450) continue
        hitDir.normalize().y += 0.3
        hitDir.normalize()
        for (let p = 0; p < NP; p++) add(p, 1.5 + 3.5 * (1 - dist / 450))
        return
      }
      const R = H.rounds[r], ka = R.tracks.indexOf(dth.att)
      if (ka < 0 || ka === k) return
      const S = d.shot
      let def = -1
      for (let i = upperBound(S.tick, dth.tick) - 1; i >= 0 && S.tick[i] >= dth.tick - rate / 2 && def < 0; i--) {
        if (S.player[i] !== dth.att) continue
        const pi = S.pitch[i] * D2R, ya = S.yaw[i] * D2R
        worldToGltf(Math.cos(pi) * Math.cos(ya), Math.cos(pi) * Math.sin(ya), -Math.sin(pi), hitDir)
        def = S.weapon[i]
      }
      if (def < 0) {
        sampleTrack(d, r, ka, dth.tick, tmp)
        hitDir.set(x[RP.chest * 3], x[RP.chest * 3 + 1], x[RP.chest * 3 + 2]).sub(worldToGltf(tmp.x, tmp.y, eyeZ(tmp.z, tmp.duck), hitAt)).normalize()
        def = tmp.weapon
      }
      const s = pushOf(def)
      for (let p = 0; p < NP; p++) add(p, s / 4)
      if (dth.hs) add(RP.head, s * 1.3)
      else { add(RP.chest, s); add(RP.shL, s * 0.6); add(RP.shR, s * 0.6) }
    }
    /** Ragdoll aus der eben gesetzten Todespose: Tempo des Spielers + Treffer-Impuls, Map-Dreiecke um den Ort; gerechnet wird beim Zeigen */
    function ragdollOf(ag: Agent, dth: Death, r: number, k: number, s: TrackSample): Ragdoll | null {
      ag.root.updateMatrixWorld(true)
      const st = ag.ragdollStart()
      if (!st) return null
      const v = new Float32Array(NP * 3)
      worldToGltf(s.vx, s.vy, s.vz, hitAt)
      for (let i = 0; i < NP; i++) hitAt.toArray(v, i * 3)
      hitImpulse(v, dth, r, k, st.x)
      const c = st.x, tris = mapRay?.near(new THREE.Vector3(c[0] - 3, c[1] - 3, c[2] - 3), new THREE.Vector3(c[0] + 3, c[1] + 2.5, c[2] + 3))
      return { ...st, sim: simulate({ ...st, v }, { tris: tris ?? new Float32Array(0), floor: floorY }) }
    }
    /** Runde und Tick mit Daten; zwischen Runden letzten Frame halten */
    const clampTick = (tick: number): [number, number] => {
      const r = roundAt(d, tick)
      if (r >= 0) return [r, tick]
      const R = H.rounds
      let q = R.length - 1
      while (q > 0 && R[q].firstTick > tick) q--
      // Zeitleiste beginnt bei startTick, die Frames 1–3 Ticks später: nicht das Ende der Vorrunde zeigen
      if (q + 1 < R.length && tick >= (rounds[q + 1].v1?.startTick ?? Infinity)) return [q + 1, R[q + 1].firstTick]
      return tick < R[0].firstTick ? [0, R[0].firstTick] : [q, R[q].firstTick + (R[q].nFrames - 1) * step]
    }
    const since = (fb: number, fi: number, bit: number, t: number, firstTick: number) => {
      if (!(d.flags[fb + fi] & bit)) return -1
      let i = fi
      while (i > 0 && d.flags[fb + i - 1] & bit) i--
      return Math.max(0, (t - firstTick - i * step) / rate)
    }
    const head = new THREE.Vector3(), m4 = new THREE.Matrix4(), hidden = new THREE.Matrix4().makeScale(0, 0, 0)
    /** Welt-y eines Bones (Matrizen aktuell), fehlt er: def */
    const bv = new THREE.Vector3(), by = (b: THREE.Object3D | undefined, def: number) => (b ? b.getWorldPosition(bv).y : def)

    const cam = { mode: 'free' as CameraMode, focus: -1, x: 0, y: 0, z: 0, yaw: 0, pitch: 45 }
    let focusK = -1, warming = false // Track-Index des Fokus-Spielers in der aktuellen Runde; warm(): alle Agenten zeigen
    // Utility-Vorschau: Zoom der Grundkamera, übersteuerte Kamera (setView) mit Überblendung aus Pose p0/q0/f0 ab Tick t0 über dur Ticks
    type Orbit = Extract<LineupView, { orbit: unknown }>['orbit']
    let zoom = 1, view: { v: LineupView; t0: number; dur: number; p0: THREE.Vector3; q0: THREE.Quaternion; f0: number; pick?: { elev: number; yaw: number; sweep: number } } | null = null
    const vP = new THREE.Vector3(), vL = new THREE.Vector3(), vD = new THREE.Vector3(0, 0, 1), vB = new THREE.Vector3(), vQ = new THREE.Quaternion(), vM = new THREE.Matrix4()
    const orbitPos = (o: Orbit, a: number, elev: number) => {
      const ce = Math.cos(elev * D2R), c = o.center
      worldToGltf(c[0] + Math.cos(a) * ce * o.dist, c[1] + Math.sin(a) * ce * o.dist, c[2] + Math.sin(elev * D2R) * o.dist, vP); worldToGltf(...c, vL)
    }
    /** freier Anteil (0..1) der Sichtlinie von der Mitte zur Kamera bei Winkel a (rad), Höhe elev (°) */
    const freeAt = (o: Orbit, a: number, elev: number) => { orbitPos(o, a, elev); const far = vP.distanceTo(vL); return Math.min(1, raycast(vL, vD.subVectors(vP, vL).normalize(), far) / far) }
    /**
     * Außenansicht einmal je Ansicht wählen: flachste Höhe ab o.elev, bei der der ganze Kreis (16 Richtungen) zu mind. 60 % frei bleibt →
     * volle Kreisfahrt ab yaw0. Sonst (Ziel unter Dach/Vorsprung oder eng zwischen Wänden) die freieste Richtung über alle Höhen, bei Gleichstand
     * nahe Wurfrichtung und o.elev, dort ±SWEEP hin und her (nur so weit frei): die volle Runde bzw. „senkrecht von oben“ zeigte sonst Wände
     * oder das Dach über dem Rauch (Mirage Window-Smoke: Ring auf dem Dach, Rauch unsichtbar).
     */
    const orbitPick = (o: Orbit) => {
      const y0 = o.yaw0 * D2R
      let elev = 85, yaw = y0, score = -Infinity
      for (const e of [o.elev, 55, 70, 85, 25, 10]) {
        let all = true
        for (let i = 0; i < 16; i++) {
          const a = y0 + (i * Math.PI) / 8, f = freeAt(o, a, e), s = f + 0.05 * Math.cos(a - y0) - 0.002 * Math.abs(e - o.elev)
          all &&= f >= 0.6
          if (s > score) { score = s; elev = e; yaw = a }
        }
        if (all && e >= o.elev) return { elev: e, yaw: y0, sweep: 0 }
      }
      let sweep = SWEEP
      while (sweep > 0.1 && Math.min(freeAt(o, yaw + sweep, elev), freeAt(o, yaw - sweep, elev)) < 0.6) sweep /= 2
      return { elev, yaw, sweep }
    }

    function updateAgents(r: number, t: number, dt: number, snap: boolean) {
      const R = H.rounds[r], n = R.nFrames, info = rounds[r], o = getOptions(), showLabels = shown('labels')
      const fi = Math.max(0, Math.min(n - 1, Math.floor((t - R.firstTick) / step)))
      // Kamera in Source-Units für die Nähe-Prüfung: Free-Cam bzw. bei setView die zuletzt gezeigte
      const cx = view ? camera.position.z / HU : cam.x, cy = view ? camera.position.x / HU : cam.y, cz = view ? camera.position.y / HU : cam.z
      for (const a of agents.values()) a.root.visible = false
      for (const l of labels) l.sprite.visible = false
      active.fill(null); focusK = -1
      if (low) for (let p = 0; p < P.length; p++) blobs.setMatrixAt(p, hidden)
      R.tracks.forEach((p, k) => {
        const side = info.sides[k], ag = agents.get(`${p}:${side}`), s = samples[p], fb = d.frameBase[r] + k * n
        const dth = deaths[k], dead = !!dth && t >= dth.tick
        if (!dead && !(d.flags[fb + fi] & FLAG.alive)) return
        const tp = dead ? dth!.tick - step : t // Pose-Zeit; tot: Todespose (letzter Frame davor), Grundlage der Ragdoll
        sampleTrack(d, r, k, tp, s)
        if (p === cam.focus) focusK = k
        if (!ag) return // ohne Agenten-Modell (Utility-Vorschau nur mit Map): nur Kamera
        const cls = s.weapon ? assets.weapons[s.weapon]?.anim ?? 'rifle' : 'knife'
        if (!dead) ag.setWeapon(s.weapon, weapons.get(s.weapon), skins.weapon(s.skin, s.weapon))
        ag.setGlove(gloveScenes.get(P[p].glove?.[side]?.def ?? 0), skins.glove(p, side))
        const act = dead ? null : X.at(p, t)
        if (!dead) { worldFor(s.weapon); if (act) worldFor(act.def) }
        ag.pose(s, cls, dead ? 0 : dt, dead ? -1 : since(fb, fi, FLAG.planting, t, R.firstTick), dead ? -1 : since(fb, fi, FLAG.defusing, t, R.firstTick), act, X.jumps(p), tp, rate,
          flashWeight(d, p, tp), phaseAt(r, k, tp))
        if (dead) {
          if (dth!.rag === undefined) dth!.rag = ragdollOf(ag, dth!, r, k, s)
          if (dth!.rag) ag.ragdoll(dth!.rag, (t - dth!.tick) / rate)
        }
        ag.light(grid, s.x, s.y, s.z, dt, snap)
        ag.root.updateMatrixWorld(true) // Mündung und Kopf für Effekte/Schild
        // Ego: eigener Körper weg; Free-Cam/setView im Körper (Start am Augpunkt nach Ego→Free, Durchfliegen): sonst füllt sein Inneres das Bild
        ag.root.visible = warming || (cam.mode === 'ego' && !view ? p !== cam.focus
          : Math.hypot(s.x - cx, s.y - cy, cz - Math.min(Math.max(cz, s.z), eyeZ(s.z, s.duck))) >= NEAR_U)
        active[p] = ag; silenced[p] = s.flags & FLAG.silencer ? 1 : 0
        // X-Ray + Schadens-Rot (an X-Ray gekoppelt) nur Lebende; Rot von den Füßen bis Höhe × fehlende HP (nicht nur der letzte Treffer),
        // blinkt einige Sekunden nach jedem Treffer; Füße/Scheitel aus der Pose (Sprung, Ducken)
        const hp = info.v1?.tracks[info.k1[k]]?.hp[fi] ?? 100
        const age = o.xray && !dead && ag.root.visible && hp < 100 ? hitAge(d, p, t) : -1
        let top = -Infinity
        if (age >= 0) {
          const B = ag.bones, lo = Math.min(by(B.ankle_L, ag.root.position.y + 0.08), by(B.ankle_R, ag.root.position.y + 0.08)) - 0.08
          top = lo + (by(B.head_0, ag.root.position.y + (eyeZ(s.z, s.duck) - s.z) * HU) + 0.15 - lo) * (100 - Math.max(0, hp)) / 100
        }
        xrays.get(ag)!.update(o.xray && !dead, top, damagePulse(age))
        if (!dead && showLabels && ag.root.visible) { // Ego: eigener Name steht im HUD
          const lb = labels[p]
          lb.sprite.visible = true
          lb.set(hp, side, overlay.labels[P[p].steamid], overlay.icons)
          ;(ag.bones.head_0 ?? ag.root).getWorldPosition(lb.sprite.position).y += 0.28
        }
        if (low && ag.root.visible) {
          const l = floorLayer(grid, s.x, s.y, s.z, 300)
          worldToGltf(s.x, s.y, (l >= 0 ? grid.z[l] : s.z) + 0.5, head)
          blobs.setMatrixAt(p, m4.makeTranslation(head.x, head.y, head.z))
        }
      })
      if (low) blobs.instanceMatrix.needsUpdate = true
    }

    // ---------------------------------------------------------------- Kamera
    const keys = new Set<string>() // gehaltene KeyboardEvent.code
    /** Free-Cam-Taste gehalten? Belegung aus hotkeys.ts, nur e.code zählt ('Ctrl+KeyW' → KeyW); Shift links/rechts gleich */
    const down = (a: HotkeyAction) => {
      const c = getHotkeys()[a], code = c?.slice(c.lastIndexOf('+') + 1)
      return !!code && (keys.has(code) || (code.startsWith('Shift') && (keys.has('ShiftLeft') || keys.has('ShiftRight'))))
    }
    const moving = () => cam.mode === 'free' && MOVE.some(down)
    let drag = false, px = 0, py = 0
    const applyAngles = (yaw: number, pitch: number) => camera.rotation.set(-pitch * D2R, yaw * D2R + Math.PI, 0, 'YXZ')
    const fwd = new THREE.Vector3(), eye = new THREE.Vector3()
    function updateCamera(realDt: number, t: number) {
      const s = focusK >= 0 ? samples[cam.focus] : null
      let fov = CS2_VFOV
      if (cam.mode === 'ego' && s) {
        worldToGltf(s.x, s.y, eyeZ(s.z, s.duck), camera.position)
        // Blick + View-Punch + 0.9·Aim-Punch (CS:GO weapon_recoil_scale 2 · view_recoil_tracking 0.45; shortcut: Faktor gegen CS2-Bild ungeprüft)
        applyAngles(s.yaw + s.viewY + 0.9 * s.aimY, s.pitch + s.viewP + 0.9 * s.aimP)
        fov = vfov(s.fov || 90)
      } else if (cam.mode === 'free') {
        const v = (down('camFast') ? 3 * FLY : FLY) * realDt
        const ax = (down('camForward') ? 1 : 0) - (down('camBack') ? 1 : 0), ay = (down('camLeft') ? 1 : 0) - (down('camRight') ? 1 : 0)
        const az = (down('camUp') ? 1 : 0) - (down('camDown') ? 1 : 0)
        const cy = Math.cos(cam.yaw * D2R), sy = Math.sin(cam.yaw * D2R), cp = Math.cos(cam.pitch * D2R), sp = Math.sin(cam.pitch * D2R)
        // CS noclip: vorwärts entlang Blick, seitwärts waagerecht (links = +90°)
        cam.x += v * (ax * cp * cy - ay * sy); cam.y += v * (ax * cp * sy + ay * cy); cam.z += v * (-ax * sp + az)
        worldToGltf(cam.x, cam.y, cam.z, camera.position)
        applyAngles(cam.yaw, cam.pitch)
      }
      if (zoom !== 1) fov = (2 * Math.atan(Math.tan((fov * D2R) / 2) / zoom)) / D2R
      if (view) { // Granate folgen (Pose wie die Granaten-Kamera) bzw. fester Blick, weich aus der Kamera davor (smoothstep über die Demo-Zeit)
        const v = view.v
        if ('nade' in v) {
          nadePose(d, v.nade, t, vP, vD); vL.copy(vP).add(vD)
          // hinter und über der Granate, aber nicht in einer Wand (Wurf durch Tür/Fenster, Abpraller): bis kurz vor den Treffer
          vB.copy(vD).multiplyScalar(-FOLLOW_M).y += FOLLOW_UP
          const len = vB.length(), hit = raycast(vP, vB.normalize(), len)
          vP.addScaledVector(vB, Math.min(len, Math.max(0.1, hit - 0.2)))
        }
        else if ('orbit' in v) {
          const o = v.orbit, pk = view.pick ?? orbitPick(o), k = (t - o.t0) / (o.turnS * rate)
          if (rayDone) view.pick = pk // ohne Gitter wäre alles „frei“
          orbitPos(o, pk.yaw + (pk.sweep ? pk.sweep * Math.sin(2 * Math.PI * k) : 2 * Math.PI * k), pk.elev)
          const far = vP.distanceTo(vL), hit = raycast(vL, vD.subVectors(vP, vL).normalize(), far) // nicht durch Wände: vor dem Treffer halten
          // höchstens bis knapp außerhalb des Rauchs (~150 u): unter einem Dach blickt die Kamera dann durch die Wand, sieht aber den Smoke
          if (hit < far) vP.copy(vL).addScaledVector(vD, Math.max(0.45 * far, hit - 0.4))
        } else { worldToGltf(...v.pos, vP); worldToGltf(...v.look, vL) }
        vQ.setFromRotationMatrix(vM.lookAt(vP, vL, camera.up))
        const k = view.dur > 0 ? THREE.MathUtils.clamp((t - view.t0) / view.dur, 0, 1) : 1, w = k * k * (3 - 2 * k)
        camera.position.lerpVectors(view.p0, vP, w); camera.quaternion.slerpQuaternions(view.q0, vQ, w)
        fov = view.f0 + (CS2_VFOV - view.f0) * w
      }
      if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix() }
      camera.updateMatrixWorld()
    }
    const freeFromCamera = () => {
      const f = camera.getWorldDirection(fwd)
      cam.x = camera.position.z / HU; cam.y = camera.position.x / HU; cam.z = camera.position.y / HU
      cam.yaw = Math.atan2(f.x, f.z) / D2R; cam.pitch = -Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)) / D2R
    }
    // Start: über den Spielern der ersten Runde, 45° nach unten
    {
      const R = H.rounds[0], n = R.nFrames
      let sx = 0, sy = 0, sz = 0, c = 0
      R.tracks.forEach((_, k) => { const i = d.frameBase[0] + k * n; if (d.flags[i] & FLAG.alive) { sx += d.x[i]; sy += d.y[i]; sz += d.z[i]; c++ } })
      if (c) { cam.x = sx / c - 600; cam.y = sy / c; cam.z = sz / c + 600 }
    }
    const onKey = (e: KeyboardEvent) => { if (e.type === 'keydown') { keys.add(e.code); onDirty?.() } else keys.delete(e.code) }
    const onBlur = () => keys.clear()
    const onDown = (e: PointerEvent) => { canvas.focus(); drag = true; px = e.clientX; py = e.clientY; canvas.setPointerCapture(e.pointerId) }
    const onMove = (e: PointerEvent) => {
      if (!drag) return
      if (cam.mode === 'free') { cam.yaw -= (e.clientX - px) * LOOK; cam.pitch = THREE.MathUtils.clamp(cam.pitch + (e.clientY - py) * LOOK, -89, 89); touch() }
      px = e.clientX; py = e.clientY
    }
    const onUp = () => { drag = false }
    const onMenu = (e: Event) => e.preventDefault()
    if (canvas.tabIndex < 0) canvas.tabIndex = 0
    canvas.addEventListener('keydown', onKey); canvas.addEventListener('keyup', onKey); canvas.addEventListener('blur', onBlur)
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('contextmenu', onMenu)

    // ---------------------------------------------------------------- Bildzeit, GPU-Zeit, dynamische Auflösung
    const gl = renderer.getContext() as WebGL2RenderingContext
    const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    const queries: WebGLQuery[] = [], win: number[] = []
    let low = getOptions().lowQuality, si = low ? 1 : 0, cssW = canvas.clientWidth || canvas.width, cssH = canvas.clientHeight || canvas.height
    let lastNow = 0, frameMs = 0, interval = 16.7, bad = 0
    const applySize = () => {
      const w = Math.max(1, Math.round(cssW * SCALES[si])), h = Math.max(1, Math.round(cssH * SCALES[si]))
      renderer.setSize(w, h, false); post.setSize(w, h); setXrayHeight(h)
      post.setQuality(si < 2 && !low, si < 2 && !low)
      camera.aspect = cssW / Math.max(1, cssH); camera.updateProjectionMatrix()
    }
    /** Low an/aus: nur Uniforms, Ziele und Sichtbarkeit (kein Programm), wirkt im selben Bild */
    const applyLow = () => {
      // Low: Shadow-Map noch einmal zeichnen (beim Start mit Low sonst nie angelegt → Sampler-Fehler), danach stehen lassen
      sun.shadow.autoUpdate = !low; sun.shadow.needsUpdate = low; sun.shadow.intensity = low ? 0 : 1; blobs.visible = low
      si = low ? Math.max(si, 1) : 0; win.length = 0; bad = 0
      applySize()
    }
    applySize()
    const frameSample = (ms: number, limit: number) => {
      frameMs += (ms - frameMs) * 0.1
      win.push(ms)
      if (win.length < 60) return
      const p95 = win.sort((a, b) => a - b)[56]; win.length = 0
      bad = p95 > limit ? bad + 1 : 0 // erst bei zwei Fenstern in Folge: Sprünge/Uploads sind einzelne Spitzen
      if (bad >= 2 && si < SCALES.length - 1) { si++; bad = 0; applySize() }
      else if (si > (low ? 1 : 0) && p95 * (SCALES[si - 1] / SCALES[si]) ** 2 < 14) { si--; applySize() } // nur hoch, wenn es danach sicher reicht
    }
    renderer.info.autoReset = false // Statistik über alle Pässe eines Bildes (mehrere render-Aufrufe)
    const dbSize = new THREE.Vector2(), callsBy = { world: 0, viewmodel: 0, nadecam: 0, post: 0 }
    const render = (t: number, dt: number) => {
      renderer.info.reset()
      const I = renderer.info.render
      let q: WebGLQuery | null = null, c0 = 0
      const mark = (k: keyof typeof callsBy) => { callsBy[k] = I.calls - c0; c0 = I.calls }
      if (tq && queries.length < 4) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q) }
      renderer.setRenderTarget(post.target)
      renderer.render(scene, camera)
      mark('world')
      vmShow?.render(renderer, cssW / Math.max(1, cssH))
      mark('viewmodel')
      // Granaten-Kamera unter der Minimap wie Entwurf v2 (#pip, 1080p-px · k; Rahmen + Kopfzeile zeichnet das HUD); aus/keine Granate: null
      const db = renderer.getDrawingBufferSize(dbSize), k = db.y / 1080
      const nade = getOptions().hideAll || low ? null : nadeCam.render(t, 330 * k, 186 * k, cam.focus)
      mark('nadecam')
      post.finish(dt)
      frameNo++
      if (capWant) {
        if (!capTex || capTex.image.width !== db.x || capTex.image.height !== db.y) {
          capTex?.dispose(); capTex = new THREE.FramebufferTexture(db.x, db.y)
        }
        renderer.copyFramebufferToTexture(capTex); capWant = false; capAt = frameNo
      }
      if (effects.post.visible) { renderer.autoClear = false; renderer.render(effects.post, camera); renderer.autoClear = true }
      mark('post')
      if (nade) { post.draw(nade, Math.round(16 * k), Math.round(db.y - (362 + 186) * k), Math.round(330 * k), Math.round(186 * k)); callsBy.nadecam += I.calls - c0 }
      if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); queries.push(q) }
      while (queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q0 = queries.shift()!, ns = gl.getQueryParameter(q0, gl.QUERY_RESULT) as number
        gl.deleteQuery(q0)
        if (!gl.getParameter(tq!.GPU_DISJOINT_EXT)) frameSample(ns / 1e6, 16.7)
      }
    }

    let disposed = false, loadMs = 0, cpuMs = 0, first = true, marks: ReturnType<typeof createMarks> | null = null
    const setTime = (tick: number) => {
      if (disposed) return
      const now = performance.now(), gap = lastNow ? now - lastNow : 0
      lastNow = now; dirty = false
      if (getOptions().lowQuality !== low || first) { low = getOptions().lowQuality; first = false; applyLow() }
      if (gap > 0 && gap < 100) { interval += (gap - interval) * 0.1; if (!tq) frameSample(gap, 20) } // ohne GPU-Timer: Bildabstand (vsync)
      const [r, t] = clampTick(tick)
      const roundChanged = r !== curRound
      if (roundChanged) {
        curRound = r
        let rs = roundState.get(r)
        if (!rs) roundState.set(r, (rs = { deaths: deathsOf(r), phases: phasesOf(r) }))
        deaths = rs.deaths; phases = rs.phases
      }
      const dt = (t - lastTick) / rate, snap = roundChanged || !(dt >= 0 && dt < 0.5)
      if (snap) win.length = 0
      updateAgents(r, t, snap ? 0 : dt, snap)
      drops.update(t)
      // erstes Bild nach langer Pause: Free-Cam nicht springen lassen; setView-Überblendung mit dem ungeklemmten Tick (auch nach Rundenende)
      updateCamera(gap < 250 ? Math.min(0.1, gap / 1000) : 0, tick)
      const ls = Math.tan((camera.fov * D2R) / 2) / Math.tan((CS2_VFOV * D2R) / 2) // Schild-Größe unabhängig vom Scope-FOV
      for (const l of labels) l.sprite.scale.set(0.4 * ls, 0.1 * ls, 1)
      // Sonnenschatten folgt dem Blickpunkt (nur Agenten werfen Schatten); setView: um das Blickziel
      if (view) eye.copy(vL)
      else if (focusK >= 0 && cam.mode === 'ego') eye.copy(camera.position)
      else eye.copy(camera.position).addScaledVector(camera.getWorldDirection(fwd), 12)
      sun.target.position.copy(eye); sun.position.copy(eye).addScaledVector(toSun, 80)
      sun.target.updateMatrixWorld()
      effects.update(t)
      // Ego-Sicht: Arme + Waffe des Fokus-Spielers (Licht wie sein unsichtbarer Agent), Einstellungen/Skins/Handschuhe des Spielers
      vmShow = null
      if (cam.mode === 'ego' && focusK >= 0 && !view) {
        const p = cam.focus, side = rounds[r].sides[focusK], st = vmStateAt(d, r, focusK, p, t, assets.weapons)
        if (st) {
          const s = samples[p], w = assets.weapons[st.def], sk = skins.weapon(s.skin, st.def, true)
          let key = sk?.legacy && w.vm!.legacyGlb ? -st.def : st.def, vm = viewmodel(p, side, key)
          if (!vm && key < 0) vm = viewmodel(p, side, (key = st.def)) // Legacy-Mesh lädt noch: solange Vanilla
          if (vm) {
            const sil = silenced[p] === 1, g = P[p].glove?.[side], cy = Math.cos(s.yaw * D2R), sy = Math.sin(s.yaw * D2R)
            vm.settings(P[p].vm ?? VM_DEFAULT, (s.flags & FLAG.lefthand) !== 0)
            vm.glove(g?.def ?? 0, gloveScenes.get(g?.def ?? 0), skins.glove(p, side, true))
            sampleTrack(d, r, focusK, t - 0.1 * rate, tmp) // Drehung der letzten 0.1 s fürs Nachziehen
            vm.move(s.vx * sy - s.vy * cy, s.vx * cy + s.vy * sy, s.vz, ((s.yaw - tmp.yaw + 540) % 360) - 180, s.pitch - tmp.pitch, t / rate) // Yaw über ±180 hinweg
            vm.sync(camera, agents.get(`${p}:${side}`)!.u)
            vm.pose(st, key, w.vm!, t / rate, sil, (sil ? w.muzzleSilenced : undefined) ?? w.muzzle, sk && sk.legacy === key < 0 ? sk : null)
            vmShow = vm
          }
        }
      }
      // Zielfernrohr-Linse im Endpass, wenn das HUD das Scope zeichnet (Hud.tsx: gezoomt + Scharfschützengewehr + Fadenkreuz sichtbar)
      const fs = cam.mode === 'ego' && focusK >= 0 && !view ? samples[cam.focus] : null
      post.setScope(fs && fs.flags & FLAG.scoped && shown('crosshair') && SNIPER.test(assets.weapons[fs.weapon]?.name ?? '') ? cssW / Math.max(1, cssH) : 0)
      render(t, gap / 1000)
      lastTick = t
      cpuMs += (performance.now() - now - cpuMs) * 0.1
    }

    // ---------------------------------------------------------------- erstes Bild: alles einmal kompilieren (kein Shader-Bau beim Abspielen)
    // inkl. X-Ray-/Schadens-Zwillinge (bis zum ersten update sichtbar): Umschalten baut nie ein Programm
    progress('agents', 90, 'Compiling shaders')
    const wScenes = [...weaponScenes, ...legacyScenes].filter(w => w !== null)
    uploadAndFree(renderer, [scene, ...templates.values(), ...wScenes, ...gloveScenes.values()], map.extra)
    const warm = new THREE.Group(), warmU = { csdaCube: { value: Array.from({ length: 6 }, () => new THREE.Vector3()) }, csdaSunVis: { value: 1 } }
    for (const w of new Set(wScenes)) { const c = w.clone(); adopt(c, warmU); warm.add(c) }
    scene.add(warm)
    camera.position.set(0, 0, 0); applyAngles(0, 0); camera.updateMatrixWorld()
    const warmP = compileHdr(scene, camera)
    post.compile() // Bloom/Endpass; die Flash-Schicht zeichnet aufs Canvas (eigener Programm-Schlüssel)
    renderer.compile(effects.post, camera)
    await warmP
    scene.remove(warm)
    warm.traverse(o => { const m = (o as THREE.Mesh).material; if (m) for (const x of Array.isArray(m) ? m : [m]) x.dispose() })
    // Rauch/Feuer/Tracer cachen Treffer-Abstände: nie ohne Wände rechnen (lazyRay: Effekte füllen erst danach, ctx.rayReady)
    const useRay = (r: MapRaycast | null) => { mapRay = r; ray = r ?? ray; rayDone = true }
    if (opts?.lazyRay) void rayP.then(r => { if (!disposed) { useRay(r); touch() } })
    else useRay(await rayP)
    setTime(H.rounds[0].firstTick)
    gl.finish()
    loadMs = Math.round(performance.now() - t0)
    progress('done', 100, 'Ready')

    return {
      setTime,
      setCamera(mode, steamid) {
        if (mode === 'ego') {
          const p = P.findIndex(x => x.steamid === steamid)
          if (p < 0) return
          cam.focus = p
        } else if (cam.mode !== 'free') freeFromCamera() // schon frei (Start): Startposition über den Spielern behalten
        cam.mode = mode; dirty = true
      },
      setOverlay(o) { overlay = o; touch() },
      setMarks(m) { marks?.dispose(); marks = m && createMarks(scene, m); touch() },
      setZoom(k) { if (k !== zoom) { zoom = k; dirty = true } },
      setView(v, blendS = 0, t0 = lastTick) {
        view = v && { v, t0, dur: blendS * rate, p0: camera.position.clone(), q0: camera.quaternion.clone(), f0: camera.fov }
        dirty = true
      },
      // erstes Bild mit allen Agenten (auch dem eigenen, er steht im Schattenbereich): Schatten-Programme jetzt statt beim ersten Zeigen
      // (Vorschau: Außenansicht ruckelte 190 ms); Viewmodel braucht bis zu drei Runden (Arme + Waffe laden, dann anhängen und übersetzen)
      async warm(tick) {
        warming = true; setTime(tick); warming = false
        for (let i = 0; i < 4 && !disposed; i++) { setTime(tick); if (!loading.size) return; await Promise.all(loading) }
      },
      dirty: () => dirty || moving() || effects.pending() || post.adapting(),
      get onDirty() { return onDirty },
      set onDirty(f) { onDirty = f },
      resize(w, h) { cssW = w; cssH = h; applySize(); dirty = true },
      listener() {
        const f = camera.getWorldDirection(fwd)
        return { x: camera.position.z / HU, y: camera.position.x / HU, z: camera.position.y / HU, yaw: Math.atan2(f.x, f.z) / D2R, ego: cam.mode === 'ego' && focusK >= 0 ? cam.focus : -1 }
      },
      raycast(a, b) {
        const o = worldToGltf(...a, new THREE.Vector3()), v = worldToGltf(...b, new THREE.Vector3()).sub(o), far = v.length()
        const hit = far > 0 ? raycast(o, v.normalize(), far) : Infinity
        return hit < far ? hit / HU : Infinity
      },
      stats() {
        const i = renderer.info
        return { fps: 1000 / interval, frameMs: tq && frameMs ? frameMs : interval, calls: i.render.calls, triangles: i.render.triangles, geometries: i.memory.geometries, textures: i.memory.textures, loadMs, cpuMs, callsBy: { ...callsBy } }
      },
      dispose() {
        if (disposed) return
        disposed = true
        offOptions()
        nadeCam.dispose(); post.dispose(); capTex?.dispose(); fogOff(); litOff(); releaseSkyRefl(refl)
        canvas.removeEventListener('keydown', onKey); canvas.removeEventListener('keyup', onKey); canvas.removeEventListener('blur', onBlur)
        canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerup', onUp)
        canvas.removeEventListener('contextmenu', onMenu)
        effects.dispose()
        skins.dispose()
        for (const q of queries) gl.deleteQuery(q)
        for (const l of labels) l.dispose()
        marks?.dispose()
        // Vorlagen (nicht in der Szene) teilen Geometrie/Texturen mit den Klonen → alles einsammeln
        const disposables = new Set<{ dispose(): void }>()
        const roots: THREE.Object3D[] = [scene, ...clipScene ? [clipScene.scene] : [], ...templates.values(), ...wScenes, ...gloveScenes.values(), ...vmRoots]
        for (const root of roots) collect(root, disposables)
        for (const t of [map.lightmap, map.sky, flashTex, ...map.extra]) if (t) disposables.add(t)
        freeAll(disposables)
        release(renderer, canvas)
      },
    }
  } catch (e) {
    fogOff(); void litP.then(off => off()); releaseSkyRefl(refl)
    release(renderer, canvas)
    throw e
  }
}

/** onUpload-Rückruf (three-Muster): CPU-Kopie eines Puffers nach dem Hochladen freigeben; der Puffer darf danach nie mehr gelesen oder geändert werden */
function freeArray(this: { array: unknown }) { this.array = null }
/** Mündungsfeuer der Ego-Waffe: heller Kern mit sechs Strahlen (additiv) */
function muzzleTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128
  const g = c.getContext('2d')!, gr = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,210,140,0.85)'); gr.addColorStop(1, 'rgba(255,120,40,0)')
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128)
  g.globalCompositeOperation = 'lighter'; g.fillStyle = 'rgba(255,190,110,0.55)'
  for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g.beginPath(); g.moveTo(64, 64); g.lineTo(64 + Math.cos(a - 0.12) * 18, 64 + Math.sin(a - 0.12) * 18); g.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62); g.lineTo(64 + Math.cos(a + 0.12) * 18, 64 + Math.sin(a + 0.12) * 18); g.fill() }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  return t
}
/** Geometrien, Materialien und deren Texturen eines Teilbaums */
function collect(root: THREE.Object3D, out: Set<{ dispose(): void }>) {
  root.traverse(o => {
    const m = o as THREE.SkinnedMesh
    if (m.geometry) out.add(m.geometry)
    if (m.skeleton) out.add(m.skeleton) // Bone-Textur
    if ((o as THREE.Light).isLight) out.add(o as THREE.Light) // Schatten-Map
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : []
    for (const mat of mats) {
      out.add(mat)
      for (const v of Object.values(mat)) if ((v as THREE.Texture)?.isTexture) out.add(v as THREE.Texture)
    }
  })
}
/**
 * Alle Texturen jetzt auf die GPU laden und die CPU-Kopien freigeben: three behält sonst ImageBitmaps in texture.image
 * (Dust2 high v1 gemessen: Renderer +1.76 GB) bzw. die KTX2-Mips. Jede neue Engine lädt neu, die Daten werden nie wieder gebraucht.
 * shortcut: nach echtem WebGL-Kontextverlust (Treiber-Reset) kann three nicht neu hochladen, dann 3D-Tab neu öffnen.
 */
function uploadAndFree(renderer: THREE.WebGLRenderer, roots: THREE.Object3D[], extra: Iterable<THREE.Texture>) {
  const set = new Set<{ dispose(): void }>(extra)
  for (const root of roots) collect(root, set)
  const tex = [...set].filter(x => (x as THREE.Texture).isTexture) as THREE.Texture[]
  for (const t of tex) renderer.initTexture(t) // jede Textur mit ihren Parametern (eigener GL-Cache-Key je Sampler/Farbraum)
  for (const t of tex) {
    if (typeof ImageBitmap !== 'undefined' && t.image instanceof ImageBitmap) t.image.close()
    if ((t as THREE.CompressedTexture).isCompressedTexture) (t as THREE.CompressedTexture).mipmaps = []
  }
}
/** dispose() auf alles, ImageBitmaps schließen (sonst bleibt der dekodierte Speicher bis zur GC) */
function freeAll(set: Set<{ dispose(): void }>) {
  for (const x of set) {
    x.dispose()
    const img = (x as THREE.Texture).isTexture ? (x as THREE.Texture).image : null
    if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close()
  }
  set.clear()
}

// GPU-Speicher sofort frei: ANGLE behält gelöschte Texturen bis zum Kontextverlust (gemessen: nach dispose blieben +1.8 GB).
// Derselbe Canvas bekommt seinen Kontext beim nächsten createEngine zurück.
const lost = new WeakMap<HTMLCanvasElement, WEBGL_lose_context>()
function release(renderer: THREE.WebGLRenderer, canvas: HTMLCanvasElement) {
  const ext = renderer.getContext().getExtension('WEBGL_lose_context')
  renderer.dispose()
  if (!ext) return
  canvas.addEventListener('webglcontextlost', e => e.preventDefault(), { once: true }) // sonst nie wiederherstellbar
  ext.loseContext()
  lost.set(canvas, ext)
}
async function restore(canvas: HTMLCanvasElement) {
  const ext = lost.get(canvas)
  if (!ext) return
  lost.delete(canvas)
  await new Promise(r => { canvas.addEventListener('webglcontextrestored', r, { once: true }); ext.restoreContext() })
}
