// Agenten und Waffen (Port von spike/agents agent_opt2/agentmap/weapon_opt + critic/grip_convention):
// items_game.txt → Def-Tabellen; EIN Clip-Donor (ctm_sas, 75 + 36 Clips) → clips_min2.glb für alle Modelle; Waffen: Root + Mündung aus DATA;
// Agenten- und Waffenmodelle je fehlendem Modell, aber in EINEM VRF-Aufruf pro Art.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Document, Logger, NodeIO, type Animation, type Node } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { copyToDocument, dedup, meshopt, prune, resample, textureCompress, weld } from '@gltf-transform/functions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'
import sharp from 'sharp'
import type { VmRole, WeaponAnim, WeaponAsset, WorldRole } from '../../shared/assets3d.ts'
import { clipEvents, type ClipEvents } from './clipevents.ts'
import { isFast, kv1, kv3, kvGet, kvList, vrf, vrfAsync, writeAtomic, type KV } from './cs2.ts'
import { sharpLimited, type Ctx } from './map.ts'
import { readVtex, type Vtex } from './vtex.ts'

const S = 0.0254
let ioP: Promise<NodeIO> | null = null
export const getIO = () => ioP ??= Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]).then(() =>
  new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder }))

// ---------------------------------------------------------------- items_game.txt

export interface ItemWeapon { cls: string; model: string; type: string }
/**
 * Paint-Kit: vcompmat = composite_material_path (neue Kits); legacy = use_legacy_model (Mesh body_legacy);
 * guns = Waffenklassen laut client_loot_lists ('[kit]weapon_x'), fehlt bei Messer-/Handschuh-Kits (stehen dort nicht)
 */
export interface Kit { name: string; legacy?: true; vcompmat?: string; guns?: string[] }
export interface Items { agents: Record<number, string>; weapons: Record<number, ItemWeapon>; gloves: Record<number, string>; kits: Record<number, Kit> }

/**
 * agents: def → 'ctm_sas/ctm_sas' (agents/models/<…>.vmdl); weapons: def → Klasse, Modell 'ak47/weapon_rif_ak47', visuals.weapon_type;
 * gloves: def → 'shared/arms/glove_sporty/glove_sporty' (liegen auch unter agents/models/); kits: paint_kits
 */
export function parseItems(text: string): Items {
  const ig = kvList(kv1(text), 'items_game')
  const prefabs = new Map<string, KV>()
  for (const [k, v] of kvList(ig, 'prefabs')) if (Array.isArray(v)) prefabs.set(k, v)
  const chain = (it: KV) => {
    const out = [it]
    for (let i = 0; i < out.length && i < 20; i++) {
      const p = kvGet(out[i], 'prefab')
      if (typeof p === 'string') for (const n of p.split(/\s+/)) { const q = prefabs.get(n); if (q) out.push(q) }
    }
    return out
  }
  const attr = (c: KV[], k: string) => { for (const o of c) { const v = kvGet(o, k); if (typeof v === 'string') return v } }
  const visual = (c: KV[], k: string) => { for (const o of c) { const vis = kvGet(o, 'visuals'); const v = Array.isArray(vis) && kvGet(vis, k); if (typeof v === 'string') return v } }
  const agents: Items['agents'] = {}, weapons: Items['weapons'] = {}, gloves: Items['gloves'] = {}, kits: Items['kits'] = {}
  for (const [id, it] of kvList(ig, 'items')) {
    if (!Array.isArray(it) || !/^\d+$/.test(id)) continue
    const c = chain(it), model = attr(c, 'model_player') ?? '', name = kvGet(it, 'name')
    if (model.startsWith('agents/models/shared/arms/')) gloves[+id] = model.slice(14).replace(/\.vmdl$/, '')
    else if (model.startsWith('agents/models/')) agents[+id] = model.slice(14).replace(/\.vmdl$/, '')
    else if (typeof name === 'string' && name.startsWith('weapon_') && model.startsWith('weapons/models/'))
      weapons[+id] = { cls: name, model: model.slice(15).replace(/\.vmdl$/, ''), type: visual(c, 'weapon_type') ?? '' }
  }
  for (const [id, k] of kvList(ig, 'paint_kits')) {
    const name = Array.isArray(k) && kvGet(k, 'name'), vcompmat = Array.isArray(k) && kvGet(k, 'composite_material_path')
    if (!/^\d+$/.test(id) || typeof name !== 'string') continue
    kits[+id] = { name, ...(kvGet(k as KV, 'use_legacy_model') === '1' && { legacy: true }), ...(typeof vcompmat === 'string' && { vcompmat }) }
  }
  const byName = new Map(Object.values(kits).map(k => [k.name, k]))
  for (const [, name, cls] of text.matchAll(/"\[([^\]"]+)\](weapon_[a-z0-9_]+)"/g)) {
    const k = byName.get(name)
    if (k && !k.guns?.includes(cls)) (k.guns ??= []).push(cls)
  }
  return { agents, weapons, gloves, kits }
}

/** Anzeigenamen wie demoparser2/v1 (= Schlüssel von renderer/weapons.tsx BY_NAME) */
const NAMES: Record<string, string> = {
  deagle: 'Desert Eagle', elite: 'Dual Berettas', fiveseven: 'Five-SeveN', glock: 'Glock-18', ak47: 'AK-47', aug: 'AUG', awp: 'AWP',
  famas: 'FAMAS', g3sg1: 'G3SG1', galilar: 'Galil AR', m249: 'M249', m4a1: 'M4A4', mac10: 'MAC-10', p90: 'P90', mp5sd: 'MP5-SD',
  ump45: 'UMP-45', xm1014: 'XM1014', bizon: 'PP-Bizon', mag7: 'MAG-7', negev: 'Negev', sawedoff: 'Sawed-Off', tec9: 'Tec-9',
  taser: 'Zeus x27', hkp2000: 'P2000', mp7: 'MP7', mp9: 'MP9', nova: 'Nova', p250: 'P250', scar20: 'SCAR-20', sg556: 'SG 553',
  ssg08: 'SSG 08', knife: 'knife', knife_t: 'knife_t', flashbang: 'Flashbang', hegrenade: 'High Explosive Grenade',
  smokegrenade: 'Smoke Grenade', molotov: 'Molotov', decoy: 'Decoy Grenade', incgrenade: 'Incendiary Grenade', c4: 'C4 Explosive',
  healthshot: 'Medi-Shot', m4a1_silencer: 'M4A1-S', usp_silencer: 'USP-S', cz75a: 'CZ75-Auto', revolver: 'R8 Revolver',
  bayonet: 'Bayonet', knife_css: 'Classic Knife', knife_flip: 'Flip Knife', knife_gut: 'Gut Knife', knife_karambit: 'Karambit',
  knife_m9_bayonet: 'M9 Bayonet', knife_tactical: 'Huntsman Knife', knife_falchion: 'Falchion Knife', knife_survival_bowie: 'Bowie Knife',
  knife_butterfly: 'Butterfly Knife', knife_push: 'Shadow Daggers', knife_cord: 'Paracord Knife', knife_canis: 'Survival Knife',
  knife_ursus: 'Ursus Knife', knife_gypsy_jackknife: 'Navaja Knife', knife_outdoor: 'Nomad Knife', knife_stiletto: 'Stiletto Knife',
  knife_widowmaker: 'Talon Knife', knife_skeleton: 'Skeleton Knife', knife_kukri: 'Kukri Knife',
}
/** Granaten, C4, Medi-Shot laufen mit knife-Clips, Zeus mit pistol (agents-Spike) */
const animOf = (w: ItemWeapon): WeaponAnim =>
  /^(Pistol|Equipment)$/.test(w.type) || w.cls === 'weapon_taser' ? 'pistol'
    : /^(Knife|Grenade|C4|StackableItem)$/.test(w.type) || /knife|bayonet|grenade|flashbang|molotov|decoy|c4|healthshot/.test(w.cls) ? 'knife' : 'rifle'

// ---------------------------------------------------------------- Clips (gemeinsam für alle 80 Agenten)

const DIR8 = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']
/** min-Set (75 Clips, replayset.mjs 'min'); VRF braucht volle Pfade */
export const CLIP_LIST = [
  ...['rifle', 'pistol', 'knife'].flatMap(C => [
    `idle_${C}`, `idle_crouch_${C}`, ...DIR8.map(d => `run_${d}_${C}`), ...DIR8.map(d => `crouch_${d}_${C}`),
    `jump_stand_${C}`, `inair_stand_${C}`, `inair_crouch_stand_${C}`,
  ].map(n => `${C}/_default_${C}/${n}`)),
  'grenade/_default_grenade/throw_overhand_grenade', 'grenade/_default_grenade/crouch_throw_far_grenade',
  'equipment/c4/planting', 'equipment/c4/planting_crouch',
  ...['rifle', 'pistol', 'knife'].flatMap(C => [`shared/defuse/defuse_loop_${C}`, `shared/defuse/defuse_crouch_loop_${C}`]),
  'shared/flashed', 'shared/flashed_crouch',
].map(n => 'animation/anims/world/' + n)
/** Zusatz zu CLIP_LIST: Gehen (8 Richtungen je Klasse, 24) und Sprung-Additiv Start/Landung (geduckt) je Klasse (12) */
export const CLIP_LIST2 = [
  ...['rifle', 'pistol', 'knife'].flatMap(C => DIR8.map(d => `${C}/_default_${C}/walk_${d}_${C}`)),
  ...['', '_pistol', '_rifle'].flatMap(s => ['start', 'land', 'crouch_start', 'crouch_land'].map(k => `shared/jump_additive_${k}${s}`)),
].map(n => 'animation/anims/world/' + n)

/** Donor-Export (ctm_sas) der Welt-Clips list → Pfad der roh exportierten GLB */
async function exportDonor(c: Ctx, out: string, list: string[]) {
  mkdirSync(out, { recursive: true })
  await vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', 'agents/models/ctm_sas/ctm_sas.vmdl_c', '-o', out, '-d', '--game', c.cs2.gi, '--gltf_export_format', 'glb',
    '--gltf_export_animations', '--gltf_compose_additive', '--gltf_animation_list', list.join(','), '--gltf_mesh_list', 'thirdperson_body'], c.log)
  const donor = join(out, 'agents', 'models', 'ctm_sas', 'ctm_sas.glb')
  if (!existsSync(donor)) throw new Error(`Agent animation export failed. Log: ${c.log}`)
  return donor
}

/** Clip-Donor exportieren (CLIP_LIST + CLIP_LIST2) → dir/clips_min2.glb, clips_meta2.json (zuletzt = fertig) */
export async function buildClips(c: Ctx, dir: string, work: string) {
  mkdirSync(dir, { recursive: true })
  const list = [...CLIP_LIST, ...CLIP_LIST2]
  const io = await getIO()
  const doc = await io.read(await exportDonor(c, join(work, 'donor'), list))
  const meta = bakeClips(doc, new Set(list))
  await finishClips(doc)
  if (Object.keys(meta).length < list.length * 0.9) throw new Error(`Only ${Object.keys(meta).length} of ${list.length} agent animations found (CS2 update?).`)
  writeAtomic(join(dir, 'clips_min2.glb'), await io.writeBinary(doc))
  writeAtomic(join(dir, 'clips_meta2.json'), JSON.stringify(meta))
  return meta
}

/** Basiswechsel Source → glTF, den VRF auf root_motion legt (Clips beider Arten backen ihn in die Kinder) */
const P = [-0.5, -0.5, -0.5, 0.5], Pinv = [0.5, 0.5, 0.5, 0.5]
const eq = (a: ArrayLike<number>, b: ArrayLike<number>, eps: number) => { for (let i = 0; i < b.length; i++) if (Math.abs(a[i] - b[i]) >= eps) return false; return true }
const qmul = (a: ArrayLike<number>, b: ArrayLike<number>) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]]
const qrot = (q: number[], v: ArrayLike<number>) => qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]).slice(0, 3)

/**
 * Port agent_opt2 'anims': nur Skelett + Clips. VRF legt die Basiswechsel-Rotation P auf root_motion und lässt pelvis/wpnPivot
 * im Source-Raum → P in die Kinder einrechnen; jiggle/eye/root_motion-Kanäle weg; Rest-Pose-Kanäle weg; int16-Rotationen.
 * keep: nur Kanäle dieser Bones (Welt-Aktionsclips = Oberkörper).
 */
function bakeClips(doc: Document, wanted: Set<string>, keep?: (n: Node) => boolean) {
  const root = doc.getRoot()
  stripHelpers(doc)
  for (const m of root.listMeshes()) m.dispose()
  for (const t of root.listTextures()) t.dispose()
  for (const m of root.listMaterials()) m.dispose()
  for (const s of root.listSkins()) s.dispose()
  const rootMotion = root.listNodes().find(n => n.getName() === 'root_motion')
  if (!rootMotion) throw new Error('Agent skeleton has no root_motion bone (CS2 update?).')
  const rmChildren = new Set(rootMotion.listChildren())
  const meta: Record<string, { dur: number; additive: boolean }> = {}
  // Kinder von root_motion: q' = P·q, t' = P(t); geteilte Accessoren vorher klonen
  const bakeChildren = (a: ReturnType<typeof root.listAnimations>[number]) => {
    for (const ch of a.listChannels()) {
      if (!rmChildren.has(ch.getTargetNode()!)) continue
      const out = ch.getSampler()!.getOutput()!, arr = Float32Array.from(out.getArray()!), p = ch.getTargetPath()
      if (p === 'rotation') for (let i = 0; i < arr.length; i += 4) arr.set(qmul(P, arr.subarray(i, i + 4)), i)
      else if (p === 'translation') for (let i = 0; i < arr.length; i += 3) arr.set(qrot(P, arr.subarray(i, i + 3)), i)
      else continue
      if (out.listParents().filter(x => x.propertyType === 'AnimationSampler').length > 1) ch.getSampler()!.setOutput(out.clone().setArray(arr)); else out.setArray(arr)
    }
  }
  for (const a of root.listAnimations()) {
    if (!wanted.has(a.getName())) { a.listChannels().forEach(c => c.dispose()); a.listSamplers().forEach(s => s.dispose()); a.dispose(); continue }
    a.setName(a.getName().split('/').pop()!) // Blattname, z. B. run_n_rifle
    let dur = 0
    for (const s of a.listSamplers()) { const i = s.getInput()!.getArray()!; dur = Math.max(dur, i[i.length - 1]) }
    meta[a.getName()] = { dur: +dur.toFixed(4), additive: !!(a.getExtras() as any)?.additive }
    const rmRot = a.listChannels().find(c => c.getTargetNode() === rootMotion && c.getTargetPath() === 'rotation')
    if (rmRot) {
      const ro = rmRot.getSampler()!.getOutput()!.getArray()!
      let isP = true
      for (let i = 0; i < ro.length && isP; i += 4) isP = eq(ro.subarray(i, i + 4), P, 1e-4)
      bakeChildren(a)
      if (isP) rmRot.dispose()
      else { // animierte Root-Rotation: R' = R·P⁻¹
        const arr = Float32Array.from(ro)
        for (let i = 0; i < arr.length; i += 4) arr.set(qmul(arr.subarray(i, i + 4), Pinv), i)
        rmRot.getSampler()!.getOutput()!.setArray(arr)
      }
    }
    for (const ch of a.listChannels()) {
      const node = ch.getTargetNode()!, path = ch.getTargetPath(), nn = node.getName()
      const s = ch.getSampler()!, out = s.getOutput()!, k = out.getElementSize(), arr = out.getArray()!
      // modellspezifische Bones dürfen nicht vom gemeinsamen Clip bewegt werden
      if (/^jiggle|^eye/.test(nn) || (nn === 'root_motion' && path !== 'rotation') || (keep && !keep(node))) { ch.dispose(); continue }
      const rest = path === 'translation' ? node.getTranslation() : path === 'rotation' ? node.getRotation() : node.getScale()
      const first = Array.from(arr.subarray(0, k))
      let constant = true
      for (let i = k; i < arr.length && constant; i += k) constant = eq(arr.subarray(i, i + k), first, 1e-5)
      if (constant && (eq(first, rest, 1e-4) || (path === 'rotation' && eq(first.map(v => -v), rest, 1e-4)))) { ch.dispose(); continue }
      if (constant) { s.getInput()!.setArray(new Float32Array([0])); out.setArray(new Float32Array(first)) }
    }
  }
  return meta
}

/** VRF-Hilfsskelette der Waffen (*.vnmskel) und leere Skins entfernen */
function stripHelpers(doc: Document) {
  const root = doc.getRoot()
  for (const n of root.listNodes()) if (n.getName().includes('.vnmskel')) n.dispose()
  for (const s of root.listSkins()) if (s.listJoints().length === 0) s.dispose()
}

/** Sampler, deren Kanal weg ist: prune lässt sie samt Accessoren stehen (VRF: 312 Sampler je Clip, JSON war 80 % der Datei) */
function dropSamplers(doc: Document) {
  for (const a of doc.getRoot().listAnimations()) {
    const used = new Set(a.listChannels().map(ch => ch.getSampler()))
    for (const s of a.listSamplers()) if (!used.has(s)) s.dispose()
  }
}

async function finishClips(doc: Document) {
  dropSamplers(doc)
  await doc.transform(resample({ tolerance: 1e-4 }), dedup(), prune({ keepLeaves: true }))
  // Rotationen als normalisiertes SHORT (glTF-Kern erlaubt das; GLTFLoader denormalisiert)
  for (const a of doc.getRoot().listAnimations()) for (const ch of a.listChannels()) {
    if (ch.getTargetPath() !== 'rotation') continue
    const out = ch.getSampler()!.getOutput()!
    if (out.getComponentType() !== 5126) continue
    const f = out.getArray()!, q = new Int16Array(f.length)
    for (let i = 0; i < f.length; i++) q[i] = Math.round(Math.max(-1, Math.min(1, f[i])) * 32767)
    const target = out.listParents().filter(p => p.propertyType === 'AnimationSampler').length > 1 ? out.clone() : out
    if (target !== out) ch.getSampler()!.setOutput(target)
    target.setArray(q).setNormalized(true)
  }
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }), prune({ keepLeaves: true }))
}

// ---------------------------------------------------------------- Agentenmodelle

/** Modelle ('ctm_sas/ctm_sas') in EINEM VRF-Aufruf exportieren, dann je Modell nur Körper+Handschuhe, WebP 1024/512, meshopt */
export async function buildAgents(c: Ctx, dir: string, work: string, models: string[]) {
  if (!models.length) return
  const out = join(work, 'agents'); mkdirSync(out, { recursive: true })
  // Ohne --gltf_export_animations schreibt VRF kein Skelett; ein Clip genügt
  await vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', models.map(m => `agents/models/${m}.vmdl_c`).join(','), '-o', out, '-d', '--game', c.cs2.gi,
    '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt', '--gltf_export_animations',
    '--gltf_animation_list', 'animation/anims/world/rifle/_default_rifle/idle_rifle', '--gltf_mesh_list', 'thirdperson_body,thirdperson_default_gloves'], c.log)
  const gloss = anisoGloss(c, models, work), done = new Map<string, Uint8Array>() // Varianten teilen Texturen
  const io = await getIO()
  for (const [i, m] of models.entries()) {
    c.step(i / models.length, `Optimizing agent ${m.split('/').pop()}`)
    const raw = join(out, 'agents', 'models', `${m}.glb`)
    if (!existsSync(raw)) throw new Error(`Agent model export failed for ${m}. Log: ${c.log}`)
    const doc = await io.read(raw)
    keepMeshes(doc, s => s === 'thirdperson_body' || s === 'thirdperson_default_gloves')
    await matteAniso(doc, gloss, done)
    await writeSkinned(io, doc, join(dir, `${m}.glb`))
  }
}

/**
 * Agenten-Materialien mit F_ANISOTROPIC_GLOSS (57 von 365, u. a. Standard-CT ctm_sas_body): Normal-Map ist BC5 ohne Alpha, VRF liest
 * daraus Rauheit 0 → Stoff glänzt wie nasses Plastik. Die Rauheit steckt in g_tAnisoGloss (BC5, R/G-Mittel ≈ 0,5; optik-gesamt P0).
 * Rückgabe: vmat-Name (= Material in der GLB) → g_tAnisoGloss roh (vtex_c, VRF ohne -d), null = ohne Textur. Fehler → leer (Material wie bisher).
 * Kosten: 3 VRF-Aufrufe ≈ 1,2 s (ein PNG-Export per VRF -d wären 2,5 s für 6 Texturen).
 */
function anisoGloss(c: Ctx, models: string[], work: string) {
  const out = new Map<string, Vtex | null>()
  try {
    const refs = rerl(c, models.map(m => `agents/models/${m}.vmdl_c`), join(work, 'agent_rerl.txt'))
    const mats = [...new Set([...refs.values()].flat().filter(r => r.endsWith('.vmat')))]
    if (!mats.length) return out
    const f = join(work, 'agent_mat.txt'), tex = new Map<string, string>()
    vrf(c.exe, ['-i', c.cs2.pak, '-f', mats.map(r => r + '_c').join(','), '-b', 'DATA'], f)
    for (const p of readFileSync(f, 'utf8').split(/^\[\d+\/\d+\] /m).slice(1)) {
      if (!/m_name = "F_ANISOTROPIC_GLOSS"\s*m_nValue = 1\b/.test(p)) continue
      const name = basename(p.slice(0, p.indexOf('\n')).trim(), '.vmat_c'), t = /m_name = "g_tAnisoGloss"\s*m_pValue = resource:"([^"]+)"/.exec(p)?.[1]
      out.set(name, null)
      if (t) tex.set(name, t + '_c')
    }
    if (!tex.size) return out
    const d = join(work, 'aniso'); mkdirSync(d, { recursive: true })
    vrf(c.exe, ['-i', c.cs2.pak, '-o', d, '-f', [...new Set(tex.values())].join(',')], c.log)
    for (const [name, t] of tex) { const v = existsSync(join(d, t)) ? readVtex(readFileSync(join(d, t))) : null; if (v?.format === 21) out.set(name, v) }
  } catch (e) { console.warn('agent roughness (aniso) skipped:', e) }
  return out
}

/** Normal/ORM-Kantenlänge der Skinned-Modelle (writeSkinned) */
const DETAIL_PX = 512

/**
 * G-Kanal (Rauheit) der ORM-Textur dieser Materialien = Mittel aus R und G von g_tAnisoGloss (Mip in Zielgröße); ohne Textur 0,55
 * (Stoff, Prototyp optik-gesamt). ORM wird gleich auf DETAIL_PX verkleinert. done: Hash(ORM + Gloss) → PNG (Varianten teilen Texturen).
 * shortcut: g_tAnisoGloss als Rauheit gelesen (nicht 1 − Glanz) und Anisotropie gemittelt; beide Lesarten ≈ 0,5 im Mittel, gegen ein
 * CS2-Ladebild mit Agent in Nahsicht prüfen, wenn Stoffdetails (Nähte, Flicken) verkehrt glänzen.
 */
async function matteAniso(doc: Document, gloss: Map<string, Vtex | null>, done: Map<string, Uint8Array>) {
  for (const m of doc.getRoot().listMaterials()) {
    if (!gloss.has(m.getName())) continue
    const orm = m.getMetallicRoughnessTexture(), v = gloss.get(m.getName())
    if (!orm) { m.setRoughnessFactor(0.55); continue }
    const key = createHash('md5').update(orm.getImage()!).update(v?.mips[0] ?? '').digest('hex')
    let img = done.get(key)
    if (!img) {
      const { data, info: { width: w, height: h } } = await sharp(Buffer.from(orm.getImage()!)).ensureAlpha()
        .resize(DETAIL_PX, DETAIL_PX, { fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true })
      // kleinste Mip ≥ ORM-Größe, nächster Nachbar (Rauheit ist weich)
      let l = 0
      while (v && l + 1 < v.mips.length && v.w >> (l + 1) >= w && v.h >> (l + 1) >= h) l++
      const gw = v ? Math.max(1, v.w >> l) : 1, gh = v ? Math.max(1, v.h >> l) : 1, rg = v && bc5(v.mips[l], gw, gh)
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
        const j = (Math.floor((y * gh) / h) * gw + Math.floor((x * gw) / w)) * 2
        data[i + 1] = rg ? (rg[j] + rg[j + 1]) >> 1 : 140
      }
      // unkomprimiert: writeSkinned macht ohnehin WebP daraus
      done.set(key, img = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer())
    }
    const t = doc.createTexture(`${m.getName()}_orm`).setMimeType('image/png').setImage(img)
    if (m.getOcclusionTexture() === orm) m.setOcclusionTexture(t) // VRF packt AO in R derselben Textur
    m.setMetallicRoughnessTexture(t)
  }
}

/** BC5 (ATI2N) → R,G je Pixel (w·h·2 Byte): je 4×4-Block zwei BC4-Blöcke (2 Endpunkte + 16 × 3-Bit-Index) */
export function bc5(src: Uint8Array, w: number, h: number) {
  const out = new Uint8Array(w * h * 2), pal = new Uint8Array(8), bw = Math.ceil(w / 4)
  for (let b = 0, o = 0; o + 16 <= src.length; b++) {
    const bx = (b % bw) * 4, by = Math.floor(b / bw) * 4
    for (let ch = 0; ch < 2; ch++, o += 8) {
      const a = src[o], z = src[o + 1]
      pal[0] = a; pal[1] = z
      if (a > z) for (let i = 1; i < 7; i++) pal[i + 1] = Math.round(((7 - i) * a + i * z) / 7)
      else { for (let i = 1; i < 5; i++) pal[i + 1] = Math.round(((5 - i) * a + i * z) / 5); pal[6] = 0; pal[7] = 255 }
      const lo = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16), hi = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16)
      for (let p = 0; p < 16; p++) {
        const x = bx + (p & 3), y = by + (p >> 2)
        if (x < w && y < h) out[(y * w + x) * 2 + ch] = pal[((p < 8 ? lo >> (3 * p) : hi >> (3 * (p - 8))) & 7)]
      }
    }
  }
  return out
}

/** VRF-Hilfsskelette weg, nur Meshes mit passendem Kurznamen (…vmdl.<name>) behalten und so benennen, Clips weg */
function keepMeshes(doc: Document, keep: (name: string, all: string[]) => boolean) {
  const root = doc.getRoot()
  stripHelpers(doc)
  const short = (n: Node) => n.getMesh()!.getName().split(/[\\/]/).pop()!.split('.').pop()!
  const nodes = root.listNodes().filter(n => n.getMesh()), all = nodes.map(short)
  for (const n of nodes) { const s = short(n), me = n.getMesh()!; if (keep(s, all)) { n.setName(s); me.setName(s) } else { me.dispose(); n.dispose() } }
  for (const a of root.listAnimations()) { a.listChannels().forEach(ch => ch.dispose()); a.listSamplers().forEach(s => s.dispose()); a.dispose() }
}
/** Normal-Maps: VRF liefert sie (Waffen) als RGBA mit Alpha 0, verlustbehaftetes WebP verwirft RGB darunter (Waffen-Normalen waren 0,0,0) → Alpha vorher weg */
async function opaqueNormals(doc: Document) {
  for (const t of new Set(doc.getRoot().listMaterials().map(m => m.getNormalTexture())))
    if (t?.getMimeType() === 'image/png') t.setImage(await sharp(t.getImage()!).removeAlpha().png().toBuffer())
}
/** Skinned-Modell schreiben: Farbe 1024, Normal/ORM 512 (32 statt 56 MB VRAM je Agent), meshopt */
async function writeSkinned(io: NodeIO, doc: Document, file: string) {
  await opaqueNormals(doc)
  await doc.transform(dedup(), weld(), prune({ keepLeaves: true }),
    textureCompress({ encoder: sharpLimited, targetFormat: 'webp', slots: /baseColor|emissive/, resize: [1024, 1024], quality: 82 }),
    textureCompress({ encoder: sharpLimited, targetFormat: 'webp', slots: /normal|occlusion|metallicRoughness/, resize: [DETAIL_PX, DETAIL_PX], quality: 80 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }), prune({ keepLeaves: true }))
  mkdirSync(dirname(file), { recursive: true })
  writeAtomic(file, await io.writeBinary(doc))
}

// ---------------------------------------------------------------- Waffen

type V3 = [number, number, number]
export interface WeaponModel { root: V3; skel: string; muzzle?: V3; muzzle2?: V3; tracer?: number | [number, number] }

/**
 * Je Modell aus VRF -b DATA (Critic P0-1): Root-Bone-Versatz zum Mesh-Ursprung (m_bonePosParent[0]) und das NM-Skelett
 * (m_vecNmSkeletonRefs); dessen Referenzpose liefert muzzle/muzzle2 (Schalldämpfer) im Root-Frame (Bone 'weapon' = Ursprung).
 * tracer aus scripts/weapons.vdata; fehlt die Datei, bleibt das Feld weg (Effekte nehmen dann ihre Tabelle).
 */
export function weaponRoots(c: Ctx, models: string[], work: string): Record<string, WeaponModel> {
  if (!models.length) return {}
  const dump = (files: string[], name: string) => { const f = join(work, name); vrf(c.exe, ['-i', c.cs2.pak, '-f', files.join(','), '-b', 'DATA'], f); return readFileSync(f, 'utf8') }
  const out = parseWeaponData(dump(models.map(m => `weapons/models/${m}.vmdl_c`), 'vmdl_DATA.txt'))
  const skels = parseSkeletons(dump([...new Set(Object.values(out).map(w => w.skel))].map(k => `animation/skeletons/weapons/${k}.vnmskel_c`), 'vnmskel_DATA.txt'))
  for (const w of Object.values(out)) Object.assign(w, skels[w.skel])
  try {
    const d = join(work, 'vdata'); mkdirSync(d, { recursive: true })
    vrf(c.exe, ['-i', c.cs2.pak, '-d', '-o', d, '-f', 'scripts/weapons.vdata_c'], c.log)
    const tr = tracerFreqs(readFileSync(join(d, 'scripts', 'weapons.vdata'), 'utf8'))
    for (const [m, w] of Object.entries(out)) if (tr[m] !== undefined) w.tracer = tr[m]
  } catch (e) { console.warn('weapon tracer frequency skipped:', e) }
  return out
}

/**
 * weapons.vdata (KV3, Einträge je Def und je Klasse, _base-Vererbung) → Modell ('ak47/weapon_rif_ak47') → m_nTracerFrequency.
 * Paar = [ohne, mit Schalldämpfer] (Index 1 = Modus 2: kleinere Streuung, Mündung weiter vorn); gleiche Paare (Burst/Zoom) → Zahl.
 */
export function tracerFreqs(text: string): Record<string, number | [number, number]> {
  const WV = kv3(text), out: Record<string, number | [number, number]> = {}
  const get = (k: string, f: string, depth = 0): any => {
    const v = WV[k]
    return !v || typeof v !== 'object' || depth > 10 ? undefined : f in v ? v[f] : v._base ? get(v._base, f, depth + 1) : undefined
  }
  for (const k of Object.keys(WV)) {
    const m = /^weapons\/models\/(.+)\.vmdl$/.exec(get(k, 'm_szWorldModel') ?? '')?.[1], t = get(k, 'm_nTracerFrequency')
    if (m && typeof t === 'number') out[m] ??= t
    else if (m && Array.isArray(t) && t.length === 2) out[m] ??= t[0] === t[1] ? t[0] : [t[0], t[1]]
  }
  return out
}
/** Source (x,y,z) u → glTF (y,z,x) m */
const gltf = (p: number[]): V3 => [p[1] * S, p[2] * S, p[0] * S].map(v => +v.toFixed(5)) as V3
/** Inhalt des Blocks key = [ … ] (verschachtelte Klammern) */
const block = (p: string, key: string) => {
  const i = p.indexOf(key + ' ='), a = p.indexOf('[', i)
  if (i < 0 || a < 0) return ''
  for (let k = a, d = 0; k < p.length; k++) { if (p[k] === '[') d++; else if (p[k] === ']' && --d === 0) return p.slice(a + 1, k) }
  return ''
}
export function parseWeaponData(text: string) {
  const out: Record<string, WeaponModel> = {}
  for (const p of text.split(/\n\tm_name = "weapons\/models\//).slice(1)) {
    const name = p.slice(0, p.indexOf('"')).replace(/\.vmdl$/, '')
    const pos = /\[([^\]]*)\]/.exec(block(p, 'm_bonePosParent'))?.[1].split(',').map(Number) ?? [0, 0, 0]
    out[name] = { root: gltf(pos), skel: /animation\/skeletons\/weapons\/([^"/]+)\.vnmskel/.exec(p)?.[1] ?? name.split('/')[0] }
  }
  return out
}
export function parseSkeletons(text: string) {
  const out: Record<string, { muzzle?: V3; muzzle2?: V3 }> = {}
  for (const p of text.split(/\n\tm_ID = "animation\/skeletons\/weapons\//).slice(1)) {
    const ids = [...block(p, 'm_boneIDs').matchAll(/"([^"]+)"/g)].map(m => m[1])
    const pose = [...block(p, 'm_modelSpaceReferencePose').matchAll(/\[([^[\]]*)\]/g)].map(m => m[1].split(',').map(Number))
    const rec: (typeof out)[string] = {}
    for (const b of ['muzzle', 'muzzle2'] as const) { const i = ids.indexOf(b); if (i >= 0 && pose[i]) rec[b] = gltf(pose[i]) }
    out[p.slice(0, p.indexOf('.vnmskel'))] = rec
  }
  return out
}

/** Dateiname der Waffe; legacy = Mesh body_legacy für Legacy-Skins */
export const weaponFile = (m: string, legacy = false) => `${m.split('/').pop()}${legacy ? '.legacy' : ''}.glb`
/** Varianten, die in dir fehlen: Standard immer, legacy nur für Modelle in legacy */
const missingVariants = (dir: string, m: string, legacy: Set<string>) => [false, true].filter(l => (!l || legacy.has(m)) && !existsSync(join(dir, weaponFile(m, l))))

/**
 * Waffenmodelle mit fehlender Variante exportieren, ≤ 8 je VRF-Aufruf (Zwischenplatz auf C:; VRF-Peak ~3 GB bei 8 wie bei 15); Mesh body_hd (falls vorhanden),
 * WebP 512, meshopt. legacy: Modelle, die zusätzlich <name>.legacy.glb mit Mesh body_legacy brauchen (aus demselben Export).
 */
export async function buildWeapons(c: Ctx, dir: string, work: string, models: string[], legacy = new Set<string>()) {
  models = models.filter(m => missingVariants(dir, m, legacy).length)
  const io = await getIO()
  // Vordergrund: der nächste Stapel exportiert schon, während dieser optimiert wird (VRF-Prozess und Worker gleichzeitig)
  const exp = (b: number) => { const out = join(work, `weapons${b}`); mkdirSync(out, { recursive: true }); return vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', models.slice(b, b + 8).map(m => `weapons/models/${m}.vmdl_c`).join(','), '-o', out, '-d', '--game', c.cs2.gi,
    '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt'], c.log) }
  let next: Promise<void> | undefined
  for (let b = 0; b < models.length; b += 8) {
    const batch = models.slice(b, b + 8), out = join(work, `weapons${b}`)
    await (next ?? exp(b))
    next = isFast() && b + 8 < models.length ? exp(b + 8) : undefined
    next?.catch(() => {}) // Fehler beim await oben; läuft er nach einem Fehler weiter, wartet prepare3d (vrfIdle)
    for (const [k, m] of batch.entries()) {
      c.step((b + k) / models.length, `Optimizing ${m.split('/').pop()}`)
      const raw = join(out, 'weapons', 'models', `${m}.glb`)
      if (!existsSync(raw)) continue // kein Modell → Engine zeigt nichts in der Hand
      for (const lg of missingVariants(dir, m, legacy)) {
        const doc = await io.read(raw)
        const root = doc.getRoot()
        stripHelpers(doc)
        const nodes = root.listNodes().filter(n => n.getMesh())
        const suffix = (n: (typeof nodes)[number]) => n.getMesh()!.getName().split('.').pop()!
        const want = lg ? 'body_legacy' : 'body_hd', has = nodes.some(n => suffix(n) === want) // body_legacy = altes Modell
        for (const n of nodes) if (has && suffix(n) !== want) { n.getMesh()!.dispose(); n.dispose() }
        // starre Waffe: Skinning weg
        for (const me of root.listMeshes()) for (const p of me.listPrimitives()) for (const a of ['JOINTS_0', 'WEIGHTS_0']) if (p.getAttribute(a)) p.setAttribute(a, null)
        for (const a of root.listAnimations()) a.dispose()
        for (const s of root.listSkins()) s.dispose()
        if (/elite/.test(m)) splitDual(doc)
        await opaqueNormals(doc)
        await doc.transform(dedup(), weld(), prune(), textureCompress({ encoder: sharpLimited, targetFormat: 'webp', resize: [512, 512], quality: 82 }),
          meshopt({ encoder: MeshoptEncoder, level: 'medium' }), prune())
        writeAtomic(join(dir, weaponFile(m, lg)), await io.writeBinary(doc))
      }
    }
    rmSync(out, { recursive: true, force: true }) // Platz auf C: für die folgenden Exporte
  }
}

/**
 * Dual Berettas (weapon_pist_elite, ohne exportiertes Skelett): beide Pistolen liegen 0,51 m nebeneinander (Bone weapon_hand_l). Dreiecke
 * nach glTF-x am Mittelpunkt trennen → Knoten 'left' mit eigener Position, um den Abstand der Pistolen zurückverschoben (deckt sich mit der
 * rechten); die Engine hängt ihn an die linke Hand (agents.ts).
 */
export function splitDual(doc: Document) {
  const root = doc.getRoot(), node = root.listNodes().find(n => n.getMesh()), buf = root.listBuffers()[0]
  if (!node) return
  const left = doc.createMesh('left'), box = [[Infinity, -Infinity], [Infinity, -Infinity]] as [number, number][], sum = [[0, 0, 0, 0], [0, 0, 0, 0]]
  const p3 = [0, 0, 0]
  for (const prim of node.getMesh()!.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')!, idx = prim.getIndices()
    if (!idx) continue
    for (let i = 0; i < pos.getCount(); i++) { pos.getElement(i, p3); box[0][0] = Math.min(box[0][0], p3[0]); box[0][1] = Math.max(box[0][1], p3[0]) }
  }
  const mid = (box[0][0] + box[0][1]) / 2
  for (const prim of node.getMesh()!.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')!, idx = prim.getIndices()
    if (!idx) continue
    const I = idx.getArray()!, L: number[] = [], R: number[] = []
    for (let t = 0; t < I.length; t += 3) {
      let cx = 0
      for (let j = 0; j < 3; j++) { pos.getElement(I[t + j], p3); cx += p3[0] }
      const side = cx / 3 > mid ? 1 : 0;
      (side ? L : R).push(I[t], I[t + 1], I[t + 2])
      for (let j = 0; j < 3; j++) { pos.getElement(I[t + j], p3); for (let k = 0; k < 3; k++) sum[side][k] += p3[k]; sum[side][3]++ }
    }
    if (!L.length || !R.length) continue
    const lp = prim.clone()
    prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(R)).setBuffer(buf))
    lp.setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(L)).setBuffer(buf))
    left.addPrimitive(lp)
  }
  if (!left.listPrimitives().length || !sum[0][3] || !sum[1][3]) { left.dispose(); return }
  // Versatz = Schwerpunkt links − rechts (gleiche Pistole, gleich ausgerichtet): eigene Positionen für die linke Hälfte
  const d = [0, 1, 2].map(k => sum[1][k] / sum[1][3] - sum[0][k] / sum[0][3])
  for (const lp of left.listPrimitives()) {
    const pos = lp.getAttribute('POSITION')!, a = Float32Array.from(pos.getArray()!)
    for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) a[i + k] -= d[k]
    lp.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(a).setBuffer(buf))
  }
  const ln = doc.createNode('left').setMesh(left).setMatrix(node.getMatrix())
  const parent = node.getParentNode()
  if (parent) parent.addChild(ln); else for (const s of root.listScenes()) if (s.listChildren().includes(node)) s.addChild(ln)
}

/** WeaponAsset je Def; Mündung im Root-Frame = Koordinaten in der Anhänge-Group */
export function weaponAsset(w: ItemWeapon, r: WeaponModel | undefined, glb?: string): WeaponAsset {
  const short = w.cls.replace(/^weapon_/, '')
  return { name: NAMES[short] ?? short, className: w.cls, anim: animOf(w), glb, root: r?.root ?? [0, 0, 0], muzzle: r?.muzzle, muzzleSilenced: r?.muzzle2, tracerFreq: r?.tracer }
}

// ---------------------------------------------------------------- Ego-Sicht (Port von spike/fp/viewmodel: graphtable, vm_opt)
// CS2 hat keine v_-Modelle: Arme = Meshes firstperson_* des Agenten, Waffe = dasselbe Modell wie in 3rd Person (mit Skelett),
// Clips = Viewmodel-Clips je Waffen-Variation (animation/graphs/viewmodel/viewmodel_gun.vnmgraph+<v> usw.).

/** Waffenklasse → Variation der Viewmodel-Graphen; sonst Klasse ohne weapon_/weapon_knife_ (vm-Spike klasseZuVariation) */
const VARIATION: Record<string, string> = {
  weapon_usp_silencer: 'usp', weapon_m4a1_silencer: 'm4a1s', weapon_m4a1: 'm4a4', weapon_fiveseven: 'five_seven', weapon_galilar: 'galil',
  weapon_elite: 'elites', weapon_cz75a: 'cz75', weapon_knife: 'default_ct', weapon_knife_t: 'default_t', weapon_bayonet: 'bayonet',
  weapon_knife_m9_bayonet: 'm9', weapon_knife_survival_bowie: 'bowie', weapon_knife_widowmaker: 'talon', weapon_knife_gypsy_jackknife: 'navajo',
  weapon_hegrenade: 'he', weapon_flashbang: 'flash', weapon_smokegrenade: 'smoke', weapon_incgrenade: 'incendiary',
}
export const vmVariation = (cls: string) => VARIATION[cls] ?? cls.replace(/^weapon_(knife_)?/, '')
/** Rolle → erster passender Clip (Blattname) im Graphen der Variation; Granaten werfen mit throw_overhand, C4/Medi-Shot: plant/inject */
const ROLE_RE: [VmRole, RegExp][] = [
  ['idle', /^idle1?_(?!slide|left|from_activity)/], ['idle_empty', /^idle_(slide_back|leftempty)_/], ['draw', /^draw_(?!\d)/],
  ['shoot', /^(shoot1|shoot_left1|throw_overhand|plant|inject)_/], ['shoot_last', /^shoot_(empty|leftlast)_/],
  ['reload', /^reload_(?!empty)/], ['reload_empty', /^reload_empty_/],
  ['light', /^light_miss1_/], ['light2', /^light_miss2_/], ['heavy', /^heavy_miss1_/],
  ['inspect', /^lookat01_(?!draw|transfix)/], ['pullpin', /^pullpin_/], ['throw_under', /^throw_underhand_/],
  ['hit', /^light_hit1_/], ['heavy_hit', /^heavy_hit1_/], ['backstab', /^heavy_backstab_/], ['shoot_right', /^shoot_right1_/],
  ['silencer_on', /^silencer_attach_/], ['silencer_off', /^silencer_detach_/],
]
/** Inspect-Graph viewmodel_inspects.vnmgraph+<name> → Variation, wo der Name abweicht (Messer: knife_<v>) */
const INSPECT_VAR: Record<string, string> = {
  flashbang_grenade: 'flash', he_grenade: 'he', smoke_grenade: 'smoke', incendiary_grenade: 'incendiary', decoy_grenade: 'decoy', cz75a: 'cz75', elite: 'elites',
}
export interface VmVariation { roles: Partial<Record<VmRole, string>>; /** Clip-Blattname → VRF-Pfad */ paths: Record<string, string> }

/** VRF -b RERL: Datei → externe Referenzen */
export function rerl(c: Ctx, files: string[], out: string) {
  vrf(c.exe, ['-i', c.cs2.pak, '-f', files.join(','), '-b', 'RERL'], out)
  const m = new Map<string, string[]>()
  for (const p of readFileSync(out, 'utf8').split(/^\[\d+\/\d+\] /m).slice(1))
    m.set(p.slice(0, p.indexOf('\n')).trim(), [...new Set([...p.matchAll(/m_pResourceName = "([^"]+)"/g)].map(x => x[1]))])
  return m
}
/** Rolle → erster passender Clip-Blattname unter refs; ohne Pflichtrolle req → undefined */
function variation<R extends string>(refs: string[], table: [R, RegExp][], req?: R) {
  const paths = Object.fromEntries(refs.filter(r => r.endsWith('.vnmclip')).map(r => [r.split('/').pop()!.slice(0, -8), r.slice(0, -8)]))
  const roles: Partial<Record<R, string>> = {}
  for (const [role, re] of table) { const leaf = Object.keys(paths).find(l => re.test(l)); if (leaf) roles[role] = leaf }
  const leaves = Object.values(roles) as string[]
  return !leaves.length || (req && !roles[req]) ? undefined : { roles, paths: Object.fromEntries(leaves.map(l => [l, paths[l]])) }
}
/** Graphen eines Wurzelgraphen: Wurzel-Referenzen + Untergraph → Referenzen, Ebene für Ebene (viewmodel_inspects.vnmgraph+<x> hängt eine Ebene tiefer; je Ebene ein Header-Dump ≈ 1 s) */
function graphRefs(c: Ctx, root: string, work: string, tag: string) {
  const rootRefs = rerl(c, [root], join(work, `${tag}_root.txt`)).get(root) ?? []
  const all = new Map<string, string[]>(), sub = (refs: string[]) => refs.filter(r => r.endsWith('.vnmgraph') && !all.has(r + '_c')).map(r => r + '_c')
  let next = sub(rootRefs)
  if (!next.length) throw new Error(`Animation graph ${root} not found (CS2 update?)`)
  for (let level = 0; next.length && level < 4; level++) {
    const m = rerl(c, next, join(work, `${tag}_graphs${level}.txt`))
    for (const [g, refs] of m) all.set(g, refs)
    next = [...new Set([...m.values()].flatMap(sub))]
  }
  return { rootRefs, graphs: [...all].map(([g, refs]) => [g.split('/').pop()!.replace(/\.vnmgraph_c$/, ''), refs] as const) }
}
/** C4 und Medi-Shot haben keinen Untergraphen: Clips hängen direkt am Wurzelgraphen (…/<art>/equipment/<variation>/) */
function addEquipment(add: (v: string, refs: string[]) => void, rootRefs: string[]) {
  for (const r of rootRefs) { const v = /\/equipment\/(\w+)\/[^/]+\.vnmclip$/.exec(r)?.[1]; if (v) add(v, [r]) }
}

/** Clip-Tabelle aller Variationen aus dem Wurzelgraphen viewmodel.vnmgraph und seinen Untergraphen; Inspect aus viewmodel_inspects.vnmgraph+<name> */
export function vmTable(c: Ctx, work: string): Record<string, VmVariation> {
  const { rootRefs, graphs } = graphRefs(c, 'animation/graphs/viewmodel/viewmodel.vnmgraph_c', work, 'vm')
  const refsOf = new Map<string, string[]>()
  const add = (v: string, refs: string[]) => refsOf.set(v, [...refsOf.get(v) ?? [], ...refs])
  for (const [name, refs] of graphs) {
    const v = /^viewmodel_(?:gun|knife|grenade)\.vnmgraph\+(\w+)$/.exec(name)?.[1] ?? /^viewmodel_(?:gun|knife)_(\w+)$/.exec(name)?.[1]
    const i = /^viewmodel_inspects\.vnmgraph\+(\w+)$/.exec(name)?.[1]
    if (v) add(v, refs); else if (i) add(INSPECT_VAR[i] ?? i.replace(/^knife_/, ''), refs) // sonst Wurzel der Untergraphen
  }
  addEquipment(add, rootRefs)
  const out: Record<string, VmVariation> = {}
  for (const [v, refs] of refsOf) { const t = variation(refs, ROLE_RE, 'idle'); if (t) out[v] = t }
  return out
}

// ---------------------------------------------------------------- Welt-Aktionsclips (Spielermodelle, Oberkörper)

/** Rolle → Clip im worldmodel_*-Untergraphen der Variation; shoot_<w> hängt am Wurzelgraphen im Ordner der Waffe */
const WORLD_RE: [WorldRole, RegExp][] = [
  ['draw', /^draw_(?!crouch)/], ['draw_crouch', /^draw_crouch_/],
  ['reload', /^reload_(?!crouch|empty)/], ['reload_crouch', /^reload_crouch_/], ['reload_empty', /^reload_empty_(?!crouch)/], ['reload_empty_crouch', /^reload_empty_crouch_/],
  ['shoot', /^shoot_(?!crouch|right|leftlast|alt)/], ['shoot_crouch', /^shoot_crouch_/],
  ['pullpin', /^pullpin_(?!crouch)/], ['pullpin_crouch', /^pullpin_crouch_/],
  ['throw', /^throw_overhand_/], ['throw_crouch', /^crouch_throw_far_/], ['throw_under', /^throw_underhand_/], ['throw_under_crouch', /^crouch_throw_near_/],
  // Messer: frontswing/frontstab/backstab; Shadow Daggers: light_miss1/heavy_miss1/heavy_backstab
  ['swing', /^(frontswing|light_miss1)_(?!b_|crouch)/], ['swing_crouch', /^(frontswing_crouching|light_miss1_crouch)_/],
  ['stab', /^(frontstab|heavy_miss1)_(?!crouch)/], ['stab_crouch', /^(frontstab_crouching|heavy_miss1_crouch)_/],
  ['backstab', /^(backstab|heavy_backstab)_(?!crouch|overhead)/], ['backstab_crouch', /^(backstab_crouching|heavy_backstab_crouch)_/],
  ['silencer_on', /^silencer_attach_/], ['silencer_off', /^silencer_detach_/],
]
export interface WorldVariation { roles: Partial<Record<WorldRole, string>>; /** Clip-Blattname → VRF-Pfad */ paths: Record<string, string> }

/** Welt-Clip-Tabelle aus worldmodel.vnmgraph: Variationen wie vmVariation (worldmodel_gun|knife|grenade.vnmgraph+<v>, worldmodel_gun_cz75) */
export function worldTable(c: Ctx, work: string): Record<string, WorldVariation> {
  const { rootRefs, graphs } = graphRefs(c, 'animation/graphs/worldmodel/worldmodel.vnmgraph_c', work, 'world')
  const refsOf = new Map<string, string[]>()
  const add = (v: string, refs: string[]) => refsOf.set(v, [...refsOf.get(v) ?? [], ...refs])
  for (const [name, refs] of graphs) {
    const v = /^worldmodel_(?:gun|knife|grenade)\.vnmgraph\+(\w+)$/.exec(name)?.[1] ?? /^worldmodel_gun_(\w+)$/.exec(name)?.[1]
    if (v) add(v, refs) // sonst Fortbewegung, Wurzel der Untergraphen
  }
  addEquipment(add, rootRefs)
  // Schuss-Clips liegen im selben Ordner wie die übrigen Clips der Waffe (rifle/rifle_ak/shoot_ak)
  const dirOf = (r: string) => r.slice(0, r.lastIndexOf('/'))
  const shots = rootRefs.filter(r => /\/shoot_[^/]+\.vnmclip$/.test(r))
  const out: Record<string, WorldVariation> = {}
  for (const [v, refs] of refsOf) {
    const dirs = new Set(refs.map(dirOf))
    const t = variation([...refs, ...shots.filter(s => dirs.has(dirOf(s)))], WORLD_RE)
    if (t) out[v] = t
  }
  return out
}

/** Oberkörper: spine_2 mit allen Kindern (Kopf, Arme, Finger) und die Waffen-Bones wpnPivot/wpn */
const upperBody = (n: Node) => {
  if (/^wpn/.test(n.getName())) return true
  for (let p: Node | null = n; p; p = p.getParentNode()) if (p.getName() === 'spine_2') return true
  return false
}

/**
 * Variationen in VRF-Läufe teilen, ≤ 150 verschiedene Clips je Lauf (gemessen: 3.3 s fest + 0.03 s je Clip, 130 Clips Peak 1.1 GB).
 * shortcut: je Lauf wird über den Clip-Blattnamen gewählt; zwei Pfade mit gleichem Blatt in einem Lauf würden sich mischen
 * (table3/world-Tabelle: keiner), sonst Läufe nach Blattnamen trennen.
 */
function batches<T extends { paths: Record<string, string> }>(items: [string, T][]) {
  const out: { items: [string, T][]; paths: Set<string> }[] = []
  for (const it of items) {
    const p = Object.values(it[1].paths)
    let b = out.at(-1)
    if (!b || new Set([...b.paths, ...p]).size > 150) out.push(b = { items: [], paths: new Set() })
    b.items.push(it); p.forEach(x => b.paths.add(x))
  }
  return out
}
const dropAnim = (a: Animation) => { a.listChannels().forEach(ch => ch.dispose()); a.listSamplers().forEach(s => s.dispose()); a.dispose() }
/** Neues Dokument aus dem je Lauf gebackenen: Szene (Skelett) + nur die Clips leaves (≈ 20 ms; cloneDocument ≈ 250 ms je Variation) */
function only(src: Document, leaves: Set<string>) {
  const doc = new Document(), root = src.getRoot()
  copyToDocument(doc, src, [...root.listScenes(), ...root.listAnimations().filter(a => leaves.has(a.getName()))])
  return doc
}

/** Welt-Aktionsclips je Waffenklasse über den Clip-Donor → dir/<klasse>.glb + <klasse>.json {roles, dur} (zuletzt = fertig) */
export async function buildWorldClips(c: Ctx, dir: string, work: string, items: [string, WorldVariation][]) {
  mkdirSync(dir, { recursive: true })
  const io = await getIO()
  const bs = batches(items)
  for (const [run, b] of bs.entries()) {
    c.step(run / bs.length, 'Exporting player weapon animations')
    const raw = await io.read(await exportDonor(c, join(work, `world${run}`), [...b.paths]))
    const meta = bakeClips(raw, b.paths, upperBody)
    dropSamplers(raw)
    await raw.transform(prune({ keepLeaves: true }))
    for (const [cls, v] of b.items) {
      const doc = only(raw, new Set(Object.keys(v.paths)))
      await finishClips(doc)
      const leaves = Object.keys(v.paths).filter(l => meta[l])
      writeAtomic(join(dir, `${cls}.glb`), await io.writeBinary(doc))
      writeAtomic(join(dir, `${cls}.json`), JSON.stringify({
        roles: Object.fromEntries(Object.entries(v.roles).filter(([, l]) => meta[l as string])), dur: Object.fromEntries(leaves.map(l => [l, meta[l].dur])),
      }))
    }
  }
}

/** Bones der Ego-Meshes (+ Vorfahren, wpn); alles andere am Agenten bewegt der Clip nicht. Waffen-Bones bleiben alle (Engine bindet per Name) */
const ARM_BONE = /^(root_motion|pelvis|spine_[0-3]|clavicle_[LR]|arm_(upper|lower)_[LR](_TWIST1?)?|hand_[LR]|finger_\w+_[LR]|wpnPivot|wpn)$/

/**
 * Viewmodel-Clips der Variationen über den Clip-Donor (ctm_sas) → dir/vm_<v>.glb + vm_<v>.json (zuletzt = fertig)
 * { dur: Clip → s, snd: Clip → [s, Soundevent][], win: Clip → {block, loop} } (WeaponAsset.vm); Ereignisse aus einem gebündelten DATA-Dump.
 */
export async function buildVmClips(c: Ctx, dir: string, work: string, vars: [string, VmVariation][]) {
  mkdirSync(dir, { recursive: true })
  const io = await getIO()
  const ev = clipEvents(c, [...new Set(vars.flatMap(([, v]) => Object.values(v.paths)))], work)
  const bs = batches(vars)
  for (const [run, b] of bs.entries()) {
    c.step(run / bs.length, 'Exporting first-person animations')
    const out = join(work, `clips${run}`); mkdirSync(out, { recursive: true })
    await vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', 'agents/models/ctm_sas/ctm_sas.vmdl_c', '-o', out, '-d', '--game', c.cs2.gi, '--gltf_export_format', 'glb',
      '--gltf_export_animations', '--gltf_animation_list', [...b.paths].join(','), '--gltf_mesh_list', 'firstperson_default_gloves_arms,firstperson_sleeves'], c.log)
    const raw = join(out, 'agents', 'models', 'ctm_sas', 'ctm_sas.glb')
    if (!existsSync(raw)) throw new Error(`First-person animation export failed. Log: ${c.log}`)
    // einmal je Lauf backen; Waffen-Bones verschiedener Waffen teilen sich die flachen Knoten (die Engine bindet nur Spuren per Name)
    const all = await io.read(raw)
    const dur = bakeVmClips(all, new Set([...b.paths].map(p => p.split('/').pop()!)))
    dropSamplers(all)
    await all.transform(prune({ keepLeaves: true }))
    for (const [key, v] of b.items) {
      const doc = only(all, new Set(Object.keys(v.paths)))
      await doc.transform(resample({ tolerance: 1e-4 }), dedup(), prune({ keepLeaves: true }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }))
      const of = <T>(f: (e: ClipEvents) => T | undefined) => Object.fromEntries(Object.entries(v.paths).flatMap(([l, p]) => { const x = ev[p] && f(ev[p]); return x ? [[l, x]] : [] }))
      writeAtomic(join(dir, `vm_${key}.glb`), await io.writeBinary(doc))
      writeAtomic(join(dir, `vm_${key}.json`), JSON.stringify({
        dur: Object.fromEntries(Object.keys(v.paths).filter(l => l in dur).map(l => [l, dur[l]])),
        snd: of(e => e.snd.length ? e.snd : undefined), win: of(e => Object.keys(e.win).length ? e.win : undefined),
      }))
    }
  }
}

/**
 * Port vm_opt clips(): P auf die Kinder von root_motion backen (wie bakeClips), nur Arm-/Waffen-Bones, Waffen-Kanäle auf flache
 * Knoten weapon/bolt/clip/… (die Engine bindet sie per Name an das Waffenmodell), Ruhepose-Kanäle weg. Rückgabe: Clip → Dauer (s).
 */
function bakeVmClips(doc: Document, want: Set<string>) {
  const root = doc.getRoot(), buffer = root.listBuffers()[0]
  for (const m of root.listMeshes()) m.dispose()
  for (const t of root.listTextures()) t.dispose()
  for (const m of root.listMaterials()) m.dispose()
  for (const s of root.listSkins()) s.dispose()
  const top = (n: Node) => { let p = n; for (let q = p.getParentNode(); q; q = q.getParentNode()) p = q; return p }
  const rootMotion = root.listNodes().find(n => n.getName() === 'root_motion')
  if (!rootMotion) throw new Error('Agent skeleton has no root_motion bone (CS2 update?).')
  const rmChildren = new Set(rootMotion.listChildren())
  const flat = doc.createNode('vm_weapon_bones'); root.listScenes()[0].addChild(flat)
  const canon = new Map<string, Node>()
  const canonical = (src: Node) => {
    let n = canon.get(src.getName())
    if (!n) { canon.set(src.getName(), n = doc.createNode(src.getName()).setTranslation(src.getTranslation()).setRotation(src.getRotation()).setScale(src.getScale())); flat.addChild(n) }
    return n
  }
  const dur: Record<string, number> = {}
  for (const a of root.listAnimations()) {
    const leaf = a.getName().split('/').pop()!
    if (!want.has(leaf)) { dropAnim(a); continue }
    a.setName(leaf)
    let d = 0
    for (const s of a.listSamplers()) { const t = s.getInput()!.getArray()!; d = Math.max(d, t[t.length - 1]) }
    const rmRot = a.listChannels().find(ch => ch.getTargetNode() === rootMotion && ch.getTargetPath() === 'rotation')
    if (rmRot) {
      const ro = rmRot.getSampler()!.getOutput()!.getArray()!
      let isP = true
      for (let i = 0; i < ro.length && isP; i += 4) isP = eq(ro.subarray(i, i + 4), P, 1e-4) || eq(Array.from(ro.subarray(i, i + 4), v => -v), P, 1e-4)
      if (!isP) { dropAnim(a); continue } // bewegtes Auge kennt der Port nicht
      for (const ch of a.listChannels()) {
        if (!rmChildren.has(ch.getTargetNode()!)) continue
        const out = ch.getSampler()!.getOutput()!, arr = Float32Array.from(out.getArray()!), p = ch.getTargetPath()
        if (p === 'rotation') for (let i = 0; i < arr.length; i += 4) arr.set(qmul(P, arr.subarray(i, i + 4)), i)
        else if (p === 'translation') for (let i = 0; i < arr.length; i += 3) arr.set(qrot(P, arr.subarray(i, i + 3)), i)
        else continue
        ch.getSampler()!.setOutput(out.clone().setArray(arr))
      }
      rmRot.dispose()
    }
    for (const ch of a.listChannels()) {
      const node = ch.getTargetNode()!, p = ch.getTargetPath(), nn = node.getName(), wpn = top(node).getName().includes('.vnmskel')
      // Skalierung nur am Waffenskelett (Granate verschwindet beim Wurf)
      if ((!wpn && (p === 'scale' || !ARM_BONE.test(nn))) || (nn === 'root_motion' && p === 'translation')) { ch.dispose(); continue }
      const s = ch.getSampler()!, arr = s.getOutput()!.getArray()!, k = s.getOutput()!.getElementSize()
      const rest = p === 'translation' ? node.getTranslation() : node.getRotation(), first = Array.from(arr.subarray(0, k))
      let constant = true
      for (let i = k; i < arr.length && constant; i += k) constant = eq(arr.subarray(i, i + k), first, 1e-5)
      if (p === 'scale' && constant && eq(first, [1, 1, 1], 1e-4)) { ch.dispose(); continue }
      // Waffen-Root behält die konstante P-Spur: die Ruhepose des Waffenmodells weicht vom NM-Skelett ab (Root-Versatz)
      if (!wpn && constant && (eq(first, rest, 1e-4) || (p === 'rotation' && eq(first.map(v => -v), rest, 1e-4)))) { ch.dispose(); continue }
      if (wpn) ch.setTargetNode(canonical(node))
      if (constant) {
        s.setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0])).setBuffer(buffer))
        s.setOutput(doc.createAccessor().setType(k === 4 ? 'VEC4' : 'VEC3').setArray(new Float32Array(first)).setBuffer(buffer))
      }
    }
    dur[leaf] = +d.toFixed(4)
  }
  stripHelpers(doc) // NM-Waffenskelette (Kanäle hängen jetzt an den flachen Knoten)
  return dur
}

/** Ego-Arme je Agentenmodell (firstperson_default_gloves_arms + firstperson_sleeves, an den Arm-Bones) → dir/<m>.glb */
export async function buildArms(c: Ctx, dir: string, work: string, models: string[], idleClip: string) {
  const io = await getIO()
  for (let i = 0; i < models.length; i += 2) { // 2 Agenten je VRF-Lauf: Peak 2.2 GB (vm-Spike)
    c.step(i / models.length, 'Exporting first-person arms')
    const batch = models.slice(i, i + 2), out = join(work, `arms${i}`); mkdirSync(out, { recursive: true })
    // Ohne --gltf_export_animations kein Skelett; ein Viewmodel-Clip genügt
    await vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', batch.map(m => `agents/models/${m}.vmdl_c`).join(','), '-o', out, '-d', '--game', c.cs2.gi,
      '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt', '--gltf_export_animations',
      '--gltf_animation_list', idleClip, '--gltf_mesh_list', 'firstperson_default_gloves_arms,firstperson_sleeves'], c.log)
    for (const m of batch) {
      const raw = join(out, 'agents', 'models', `${m}.glb`)
      if (!existsSync(raw)) continue // Modell ohne Ego-Arme: Engine zeigt nur die Waffe
      const doc = await io.read(raw)
      keepMeshes(doc, s => s === 'firstperson_default_gloves_arms' || s === 'firstperson_sleeves')
      reweightArms(doc)
      await writeSkinned(io, doc, join(dir, `${m}.glb`))
    }
  }
}

/**
 * Viewmodel-Clips bewegen nur Arm-/Hand-/Finger-Bones. Manche Ärmel (tm_leet) hängen auch an clavicle/spine/scapula, die in der
 * Körperpose 1.6 m entfernt bleiben → gestreckte Dreiecke. Diese Gewichte auf arm_upper_<Seite> legen (Seite aus dem Bone-Namen,
 * sonst aus dem Vertex: glTF +X = Modell links).
 */
function reweightArms(doc: Document) {
  const DRIVEN = /^(arm_(upper|lower)_[LR](_TWIST1?)?|hand_[LR]|finger_\w+_[LR])$/
  for (const n of doc.getRoot().listNodes()) {
    const m = n.getMesh(), s = n.getSkin()
    if (!m || !s) continue
    const names = s.listJoints().map(j => j.getName()), up = { L: names.indexOf('arm_upper_L'), R: names.indexOf('arm_upper_R') }
    for (const p of m.listPrimitives()) {
      const J = p.getAttribute('JOINTS_0'), W = p.getAttribute('WEIGHTS_0'), POS = p.getAttribute('POSITION')
      if (!J || !W || !POS) continue
      const a: number[] = [], w: number[] = [], v: number[] = []
      for (let i = 0; i < J.getCount(); i++) {
        J.getElement(i, a); W.getElement(i, w); POS.getElement(i, v)
        let changed = false
        for (let k = 0; k < 4; k++) {
          if (!(w[k] > 0) || DRIVEN.test(names[a[k]])) continue
          const nm = names[a[k]], side = /_L$|_L_/.test(nm) ? 'L' : /_R$|_R_/.test(nm) ? 'R' : v[0] >= 0 ? 'L' : 'R', tgt = up[side]
          if (tgt < 0) continue
          const e = a.findIndex((x, kk) => kk !== k && x === tgt && w[kk] > 0)
          if (e >= 0) { w[e] += w[k]; w[k] = 0; a[k] = 0 } else a[k] = tgt
          changed = true
        }
        if (changed) { J.setElement(i, a); W.setElement(i, w) }
      }
    }
  }
}

/** Ego-Waffen mit Skelett (Bolzen/Magazin/Schlitten animiert), body_hd falls vorhanden, Skin bleibt → dir/<vmdl-name>.glb (+ .legacy.glb wie buildWeapons) */
export async function buildVmWeapons(c: Ctx, dir: string, work: string, models: string[], legacy = new Set<string>()) {
  models = models.filter(m => missingVariants(dir, m, legacy).length)
  const io = await getIO()
  // wie buildWeapons: im Vordergrund exportiert der nächste Stapel, während dieser verarbeitet wird
  const exp = (i: number) => { const out = join(work, `w${i}`); mkdirSync(out, { recursive: true }); return vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', models.slice(i, i + 5).map(m => `weapons/models/${m}.vmdl_c`).join(','), '-o', out, '-d', '--game', c.cs2.gi,
    '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt', '--gltf_export_animations', '--gltf_animation_list', 'none'], c.log) }
  let next: Promise<void> | undefined
  for (let i = 0; i < models.length; i += 5) { // ≤ 5 je VRF-Lauf: Peak 2.2 GB (vm-Spike)
    c.step(i / models.length, 'Exporting first-person weapons')
    const batch = models.slice(i, i + 5), out = join(work, `w${i}`)
    await (next ?? exp(i))
    next = isFast() && i + 5 < models.length ? exp(i + 5) : undefined
    next?.catch(() => {})
    for (const m of batch) {
      const raw = join(out, 'weapons', 'models', `${m}.glb`)
      if (!existsSync(raw)) continue
      for (const lg of missingVariants(dir, m, legacy)) {
        const doc = await io.read(raw), want = lg ? 'body_legacy' : 'body_hd'
        keepMeshes(doc, (s, all) => !all.includes(want) || s === want) // body_legacy = altes Modell
        await writeSkinned(io, doc, join(dir, weaponFile(m, lg)))
      }
    }
    rmSync(out, { recursive: true, force: true })
  }
}

/** Handschuh-Modelle ('shared/arms/glove_sporty/glove_sporty') mit Skelett, Meshes viewmodel (Ego) + worldmodel (Agent) → dir/<name>.glb */
export async function buildGloves(c: Ctx, dir: string, work: string, models: string[]) {
  const io = await getIO()
  for (let i = 0; i < models.length; i += 4) { // ein Handschuh: Peak 0.9 GB (vm-Spike)
    c.step(i / models.length, 'Exporting gloves')
    const batch = models.slice(i, i + 4), out = join(work, `g${i}`); mkdirSync(out, { recursive: true })
    // Ohne --gltf_export_animations kein Skelett; 'none' = Skelett ohne Clip
    await vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', batch.map(m => `agents/models/${m}.vmdl_c`).join(','), '-o', out, '-d', '--game', c.cs2.gi,
      '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt', '--gltf_export_animations', '--gltf_animation_list', 'none'], c.log)
    for (const m of batch) {
      const raw = join(out, 'agents', 'models', `${m}.glb`)
      if (!existsSync(raw)) continue // Engine zeigt dann die Standard-Handschuhe des Agenten
      const doc = await io.read(raw)
      keepMeshes(doc, s => s === 'viewmodel' || s === 'worldmodel')
      await writeSkinned(io, doc, join(dir, `${m.split('/').pop()}.glb`))
    }
    rmSync(out, { recursive: true, force: true })
  }
}
