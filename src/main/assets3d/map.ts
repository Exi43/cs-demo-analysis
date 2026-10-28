// Map-Pipeline (Port von spike/mapopt/final/pipeline): CS2-Map → GLB (meshopt, WebP, Sonden-Attribut) + Lightmap-WebP
// + Himmel + Einstellungen + Boden-Raster (Schritte) + Sonden-Raster (Agenten-Licht, Critic P0-2). Alles nacheinander, nur der
// 3D-Skybox-Export läuft als eigener VRF-Prozess im Hintergrund (skyboxJob); wartet die 3D-Ansicht (isFast), laufen auch Himmel und
// Zusatztexturen nebeneinander (prepMap).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ImageUtils, Logger, NodeIO, type Document, type Material, type Texture } from '@gltf-transform/core'
import { ALL_EXTENSIONS, KHRMaterialsUnlit, KHRTextureBasisu } from '@gltf-transform/extensions'
import { dedup, flatten, join as joinPrims, listTextureSlots, meshopt, prune, simplifyPrimitive, textureCompress, weld } from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { DataUtils, HalfFloatType } from 'three'
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
import type { AssetProfile, CSDABlend, CSDAFx, MapSettings, StationaryLight } from '../../shared/assets3d.ts'
import { colorAdjust } from '../../shared/coloradjust.ts'
import { CSDA, CS2Material, CSDAMaterialsCS2 } from './csda-ext.ts'
import { fast, images, isFast, vrf, vrfAsync, writeAtomic, type CS2 } from './cs2.ts'
import { BC6H, bc6h, ktx2, readVtex } from './vtex.ts'

export interface Ctx { cs2: CS2; exe: string; log: string; step(f: number, msg: string): void }
/** sharp für textureCompress (startet alle Texturen auf einmal): gleichzeitige Aufträge über images (cs2.ts) begrenzt */
export const sharpLimited = ((input?: any, o?: any) => {
  const s = sharp(input, o), toBuffer = s.toBuffer.bind(s) as (...a: unknown[]) => Promise<Buffer>
  return Object.assign(s, { toBuffer: (...a: unknown[]) => images.run(() => toBuffer(...a)) })
}) as typeof sharp

/**
 * Map-Cache-Version (prepare.ts hängt sie an den Map-Schlüssel): 2 = native BCn-Texturen, 3 = Farbe 1024, glTF mit Texturdateien,
 * 4 = Sonnenmaske richtig herum, Hable/Nebel/Bloom/LUT aus .vpost, HDR-Himmel, 3D-Skybox, Wasser/Glas, Wasser-Normalen ohne Alpha,
 * 5 = Blend-Layer (environment_blend, simple_2way, F_FANCY_BLENDING, _BLEND VEC4), Mod2x-Overlays, Lightmap-UV (0, 0) → Sonde, Karten-Sonde beidseitig,
 * 6 = stationäre Lichter (settings.stationary + dls.webp); Overlays zurück auf die Fläche (VRF_OVERLAY_PUSH), Draw-Call-Tönung linear,
 *     Positionen szenenweit quantisiert, Karten-Sonde sucht unter 0,1, einfarbige Basis bei Tint-Maske/Layer 2
 * 7 = Himmel/Skyline wie CS2: csgo_unlitgeneric F_BLEND_MODE (Dust2-Wolken additiv statt olivgrauer Decke, Cache-Pylonen Alpha-Test), g_bFogEnabled 0 →
 *     'nofog'; 3D-Skybox mit eigener Lightmap + Sonden, csgo_effects (Wolken, Sonnenscheiben, Dunst: ext.fx + Masken), Draw-Call-Tönung wie die
 *     Map (node000_…) und skybox.ownFog
 */
export const MAP_VERSION = 7
/** Sichtbarkeit der stationären Lichter (bakeLightmap outDls), neben der Lightmap */
const DLS_FILE = 'dls.webp'
/**
 * Profile (mapopt-Spike, gemessen Dust2 v1: high 59 MB / 1.37 GB Textur-VRAM, low 35 MB / 0.39 GB). tex = WebP-Pfad (RGBA8 auf der GPU),
 * native = Kantenlänge der durchgereichten CS2-BCn-Texturen (Farbe/Layer 2, Hemi-Oct-Normalen), 4–8× kleiner im VRAM.
 */
const PROFILES = {
  // native Farbe 1024: 2048 bei 720p kaum zu unterscheiden (mapopt), kostete aber 4× Platte/RAM (Dust2-GLB 491 MB)
  high: { simplify: 0.01, lightmap: 4096, native: { color: 1024, normal: 1024 }, tex: { color: 1024, layer2: 1024, normal: 512, orm: 512, blendmod: 512, tint: 256 } },
  low: { simplify: 0.02, lightmap: 2048, native: { color: 1024, normal: 512 }, tex: { color: 512, layer2: 512, normal: 256, orm: 256, blendmod: 256, tint: 128 } },
}
const Q = { color: 70, normal: 75, orm: 70 }
const S = 0.0254
const FLOOR_CELL = 32

/**
 * Dateinamen relativ zum Map-Ordner. skyHdr = Radiance-.hdr (gleiche Skala wie sky), lut = lut.bin (32³ RGB8, r schnellste Achse),
 * skybox = 3D-Skybox-Welt (eigener Ordner mit tex/) mit ihrer gebackenen Lightmap (lightmap, fehlt → Himmelslicht), Map-Position =
 * (Skybox-Position − origin) · scale (Source-u).
 */
export interface MapBuild {
  glb: string; lightmap: string; sky?: string; skyHdr?: string; lut?: string; skybox?: { glb: string; scale: number; origin: [number, number, number]; lightmap?: string; ownFog?: boolean }
  floor: string; probes: string; settings: MapSettings; stats: Record<string, unknown>
}

/** baut alles nach out (Dateinamen siehe MapBuild), work = Zwischenexport (Aufrufer löscht ihn) */
export async function buildMap(c: Ctx, map: string, profile: AssetProfile, out: string, work: string): Promise<MapBuild> {
  const P = PROFILES[profile], T: Record<string, number> = {}
  let t0 = Date.now()
  const lap = (k: string) => { T[k] = +((Date.now() - t0) / 1000).toFixed(1); t0 = Date.now() }
  mkdirSync(out, { recursive: true })
  const prep = await prepMap(c, map, work); lap('vrf')
  const post = prep.postFile && readFileSync(prep.postFile, 'utf8')
  const settings = mapSettings(prep.ents, prep.sky, post, prep.skyVmat)
  c.step(0.3, 'Baking lightmap')
  const lm = `${map}_lm.webp`
  const lmInfo = await bakeLightmap(prep.lmDir, join(out, lm), P.lightmap, settings.stationary && join(out, DLS_FILE)); lap('lightmap')
  c.step(0.42, 'Sky and render settings')
  const sky = prep.skyExr && await bakeSky(prep.skyExr, join(out, `${map}_sky.webp`), join(out, `${map}_sky.hdr`), 2048) ? `${map}_sky.webp` : undefined
  const lutBin = vpostLut(post)
  if (lutBin) writeAtomic(join(out, 'lut.bin'), lutBin)
  lap('sky_settings')
  c.step(0.45, 'Loading light probes')
  const probes = await loadProbes(prep.lmDir, prep.ents); lap('probes_load')
  c.step(0.5, 'Optimizing map geometry')
  const glb = `${map}.gltf`
  const rep = await optimizeMap({ in: prep.gltf, out: join(out, glb), extra: await prep.extra, probes, simplify: P.simplify, tex: P.tex, native: P.native, mapVpk: prep.mapVpk, work }, c); lap('optimize')
  c.step(0.95, 'Building floor and light grids')
  const grid = floorGrid(prep.physGlb)
  writeAtomic(join(out, 'floor.bin'), grid.bin)
  writeAtomic(join(out, 'probes.bin'), probes ? probeGrid(grid, probes) : new Uint8Array(grid.n * 19).fill(255))
  lap('grids')
  c.step(0.97, '3D skybox')
  let skybox: MapBuild['skybox'], skyRep: Record<string, unknown> | undefined
  try { // optional: ohne 3D-Skybox nur Himmel
    const sb = prep.skybox, ex = sb && await sb.job
    if (ex) {
      // halbe Texturen; Licht wie CS2 aus der eigenen gebackenen Lightmap + Sonden der Skybox-Welt (sonst Himmelslicht: Skyline zu blau/hell)
      const half = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / 2]))
      mkdirSync(join(out, 'skybox'), { recursive: true })
      const lmOk = await bakeLightmap(ex.lm, join(out, 'skybox', 'skybox_lm.webp'), P.lightmap / 4).then(() => true, () => false)
      const sbProbes = await loadProbes(ex.lm, sb.ents).catch(() => null)
      skyRep = await optimizeMap({
        in: ex.gltf, out: join(out, 'skybox', 'skybox.gltf'), extra: ex.extra, probes: sbProbes, noLightmap: !lmOk, effects: true,
        simplify: P.simplify * 2, tex: half(P.tex) as typeof P.tex, native: half(P.native) as typeof P.native, mapVpk: sb.vpk, work: sb.work,
      }, { ...c, step: () => {} })
      const ownFog = sb.ents.some(e => /^env_(cubemap|gradient)_fog$/.test(e.classname) && !on(e.startdisabled))
      skybox = { glb: 'skybox/skybox.gltf', scale: sb.scale, origin: sb.origin, ...lmOk && { lightmap: 'skybox/skybox_lm.webp' }, ...ownFog && { ownFog } }
    }
  } catch (e) { skyRep = { error: String(e) } }
  lap('skybox')
  const MB = (f: string) => +(statSync(join(out, f)).size / 1048576).toFixed(2)
  const total = +(walk(out).reduce((s, f) => s + statSync(f).size, 0) / 1048576).toFixed(2)
  const skyHdr = sky && existsSync(join(out, `${map}_sky.hdr`)) ? `${map}_sky.hdr` : undefined
  const stats = { sec: T, MB: { total, gltf: MB(glb), lightmap: MB(lm), sky: sky ? MB(sky) : 0, skyHdr: skyHdr ? MB(skyHdr) : 0, floor: MB('floor.bin'), probes: MB('probes.bin') }, lightmap: lmInfo, floorLayers: grid.n, skybox: skyRep, ...rep }
  return { glb, lightmap: lm, sky, skyHdr, lut: lutBin ? 'lut.bin' : undefined, skybox, floor: 'floor.bin', probes: 'probes.bin', settings, stats }
}

// ---------------------------------------------------------------- 1) Rohdaten aus CS2 (VRF)

async function prepMap(c: Ctx, map: string, work: string) {
  const mapVpk = join(c.cs2.csgo, 'maps', `${map}.vpk`)
  if (!existsSync(mapVpk)) throw new Error(`Map ${map} is not installed in CS2 (${mapVpk} missing).`)
  const sub = (d: string) => { const p = join(work, d); mkdirSync(p, { recursive: true }); return p }
  const run = (args: string[]) => vrf(c.exe, args, c.log)
  const tryRun = (args: string[]) => { try { run(args) } catch {} }
  // nur die gebrauchten Texturen. irradiance (BC6H 8192²) roh, bakeLightmap dekodiert selbst: VRF -d brauchte dafür 6.3 GB RAM
  const lmDir = join(work, 'lm', 'maps', map, 'lightmaps')
  run(['-i', mapVpk, '-f', `maps/${map}/lightmaps/irradiance.vtex_c`, '-o', sub('lm')])
  const bc = existsSync(join(lmDir, 'irradiance.vtex_c')) && readVtex(readFileSync(join(lmDir, 'irradiance.vtex_c')))?.format === BC6H
  // Lightmaps, Entities, Physik-Mesh (SurfaceProperty je Knoten = Untergrund für Schritte; VRF schreibt <name>_physics.glb). Im Vordergrund
  // neben dem Geometrie-Export (eigene Prozesse, ~1 GB, fertig vor dessen RAM-Spitze): Ancient 78 → 64 s, Spitze 5,2 GB wie allein (gemessen)
  const lmJob = async () => {
    for (const f of [...(bc ? [] : ['irradiance']), 'direct_light_shadows', 'env_light_probe_volume_atlas', 'env_light_probe_volume_atlas_dlshd'])
      await vrfBg(c, ['-i', mapVpk, '-f', `maps/${map}/lightmaps/${f}.vtex_c`, '-o', sub('lm'), '-d']).catch(e => { if (!f.startsWith('env_')) throw e })
    await vrfBg(c, ['-i', mapVpk, '-f', `maps/${map}/entities/default_ents.vents_c`, '-o', sub('ents'), '-d'])
    await vrfBg(c, ['-i', mapVpk, '-f', `maps/${map}/world_physics.vmdl_c`, '-o', sub('phys'), '-d', '--gltf_export_format', 'glb'])
  }
  // Hintergrund: erst nach dem Geometrie-Export; wartet die 3D-Ansicht (auch erst mittendrin, fast), sofort
  let geoDone!: () => void
  const lmP = Promise.race([fast, new Promise<void>(r => (geoDone = r))]).then(lmJob)
  lmP.catch(() => {}) // Fehler kommt beim await unten
  c.step(0, 'Exporting map geometry')
  const gltf = join(work, 'export', 'maps', map, 'world.gltf')
  // ohne weitere große Exporte daneben: sonst braucht VRF hier bis 7,7 statt 5 GB RAM (Texturen stauen sich, gemessen). Asynchron, damit lmJob
  // daneben weiterläuft (dessen Physik-Export wartet als glTF-Export bis hierher, cs2.ts heavy)
  await vrfBg(c, ['-i', mapVpk, '-f', `maps/${map}/world.vwrld_c`, '-o', sub('export'), '-d', '--gltf_export_format', 'gltf', '--gltf_export_materials', '--gltf_textures_adapt', '--game', c.cs2.gi])
  geoDone()
  if (!existsSync(gltf)) throw new Error(`Map export failed: ${gltf} missing. Log: ${c.log}`)
  c.step(0.18, 'Exporting lightmaps and entities')
  await lmP
  const entsFile = join(work, 'ents', 'maps', map, 'entities', 'default_ents.vents')
  const entsText = readFileSync(entsFile, 'utf8'), ents = parseEntities(entsText)
  const res = (key: string) => [...new Set([...entsText.matchAll(new RegExp(`^${key}\\s+resource_name:"([^"]+)"`, 'gm'))].map(m => m[1]))]
  // 3D-Skybox: skybox_reference.targetmapname maps/prefabs/<map>/<name>.vmap liegt kompiliert in maps/prefabs/<map>/<name>.vpk
  const tm = ents.find(e => e.classname === 'skybox_reference' && /^maps\/prefabs\/.+\.vmap$/.test(e.targetmapname ?? ''))?.targetmapname as string | undefined
  const sbVpk = tm && join(c.cs2.csgo, tm.replace(/\.vmap$/, '.vpk')), sbDir = tm?.replace(/\.vmap$/, '')
  let sbEnts: Ent[] = []
  if (sbVpk && existsSync(sbVpk)) {
    tryRun(['-i', sbVpk, '-f', `${sbDir}/entities/default_ents.vents_c`, '-o', sub('sbents'), '-d'])
    try { sbEnts = parseEntities(readFileSync(join(work, 'sbents', sbDir!, 'entities', 'default_ents.vents'), 'utf8')) } catch {}
  }
  const skybox = sbEnts.length ? skyboxJob(c, sbVpk!, sbDir!, sbEnts, join(work, 'skybox')) : undefined
  // sichtbarer Himmel: aktives env_sky der Skybox-Welt vor dem der Map (Ancient/Anubis/Vertigo: Map-env_sky startdisabled;
  // Inferno/Train: zweites env_sky nur fürs Licht-Backen)
  const sky = activeSky([...sbEnts, ...ents]), skyMat = String(sky?.skyname ?? '').replace(/^resource_name:/, '').replaceAll('"', '')
  // erste VPK, die die Datei hat (jeder VRF-Start kostet ~1,5 s). Im Vordergrund Himmel (bis 3 GB) neben den Zusatztexturen
  const first = async (path: string, dir: string, vpks: string[]) => { for (const v of vpks) if (!existsSync(join(work, dir, path))) await vrfBg(c, ['-i', v, '-f', path + '_c', '-o', sub(dir), '-d']).catch(() => {}) }
  const skyP = (async () => {
    if (skyMat) await first(skyMat, 'sky', [c.cs2.pak, mapVpk, ...sbEnts.length ? [sbVpk!] : []])
    for (const p of res('postprocessing')) await first(p, 'post', [mapVpk, c.cs2.pak])
  })()
  await Promise.race([skyP, fast])
  c.step(0.24, 'Exporting extra textures')
  // Vordergrund: läuft neben Lightmap/Himmel/Sonden weiter (eigene Prozesse), buildMap wartet erst vor optimizeMap darauf
  const extra = extraTextures(c, gltf, sub('extra'), mapVpk, isFast() ? a => vrfBg(c, a) : undefined)
  extra.catch(() => {}) // Fehler kommt dort beim await
  await skyP
  const files = walk(work)
  const physGlb = files.filter(f => /[\\/]phys[\\/].*\.glb$/i.test(f)).sort((a, b) => statSync(b).size - statSync(a).size)[0]
  if (!(bc || existsSync(join(lmDir, 'irradiance.exr'))) || !physGlb) throw new Error(`Map export incomplete (lightmap or physics missing). Log: ${c.log}`)
  return {
    gltf, lmDir, physGlb, extra, mapVpk, ents, sky, skybox,
    skyExr: files.find(f => /[\\/]sky[\\/].*\.exr$/i.test(f)),
    skyVmat: files.find(f => /[\\/]sky[\\/].*\.vmat$/i.test(f)),
    postFile: files.find(f => /\.vpost$/i.test(f)),
  }
}

const walk = (d: string): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]) : []

/** vrf() ohne zu blockieren (eigener Prozess, läuft neben den vrf()-Aufrufen des Map-Exports) */
const vrfBg = (c: Ctx, args: string[]) => vrfAsync(c.exe, args, c.log)

/**
 * 3D-Skybox-Welt (skybox_reference) samt Zusatztexturen im Hintergrund exportieren, sobald ihre Entities da sind: spart ~5–10 s Bauzeit,
 * buildMap wartet erst am Ende darauf. Ohne gültige sky_camera (Maßstab, Ursprung) undefined; job → null, wenn VRF keine world.gltf schreibt.
 * shortcut: scheitert der Map-Bau vorher, schreibt VRF noch einige Sekunden in work weiter; bekommt der Bau einen Abbruch-Knopf, den Prozess dort beenden.
 */
function skyboxJob(c: Ctx, vpk: string, dir: string, ents: Ent[], work: string) {
  const cam = ents.find(e => e.classname === 'sky_camera'), origin = vec(cam?.origin)
  if (!cam || !(+cam.scale > 0) || origin.length !== 3 || origin.some(Number.isNaN)) return undefined
  const sub = (d: string) => { const p = join(work, d); mkdirSync(p, { recursive: true }); return p }
  const job = (async () => {
    await vrfBg(c, ['-i', vpk, '-f', `${dir}/world.vwrld_c`, '-o', sub('export'), '-d', '--gltf_export_format', 'gltf', '--gltf_export_materials', '--gltf_textures_adapt', '--game', c.cs2.gi])
    const gltf = join(work, 'export', dir, 'world.gltf')
    if (!existsSync(gltf)) return null
    // gebackene Beleuchtung der Skybox-Welt wie prepMap (irradiance roh, wenn BC6H; fehlt etwas → buildMap ohne Lightmap/Sonden)
    const lm = join(work, 'lm', dir, 'lightmaps'), get = (f: string, d: boolean) => vrfBg(c, ['-i', vpk, '-f', `${dir}/lightmaps/${f}.vtex_c`, '-o', sub('lm'), ...d ? ['-d'] : []]).catch(() => {})
    await get('irradiance', false)
    const bc = existsSync(join(lm, 'irradiance.vtex_c')) && readVtex(readFileSync(join(lm, 'irradiance.vtex_c')))?.format === BC6H
    await Promise.all([...(bc ? [] : ['irradiance']), 'direct_light_shadows', 'env_light_probe_volume_atlas', 'env_light_probe_volume_atlas_dlshd'].map(f => get(f, true)))
    return { gltf, lm, extra: await extraTextures(c, gltf, sub('extra'), vpk, a => vrfBg(c, a), true) }
  })()
  job.catch(() => {}) // Fehler meldet erst buildMap (sonst unbehandelte Ablehnung, falls der Map-Bau vorher scheitert)
  return { vpk, work, scale: +cam.scale, origin: origin.map(v => +v.toFixed(2)) as [number, number, number], ents, job }
}

/** Layer-Texturen der Blend-Shader (csgo_lightmappedgeneric F_LAYERS, csgo_simple_2way_blend, csgo_environment_blend) */
const BLEND_TEX = ['g_tLayer2Color', 'g_tBlendModulation', 'g_tColorB', 'g_tMask', 'g_tColor2', 'g_tColor3', 'g_tHeight1', 'g_tHeight2', 'g_tHeight3']
/** Wellen-Normalen: csgo_water_fancy g_tWavesNormalHeight, csgo_water g_tNormal */
const WATER_NORMAL = ['g_tWavesNormalHeight', 'g_tNormal']
/** Masken der csgo_effects (R-Kanal, je eigene Skala/Schwenk) */
const FX_MASKS = ['g_tMask1', 'g_tMask2', 'g_tMask3']
/**
 * Blend-Layer 2, Blend-Modulation, Tint-Masken und Wasser-Normalen aus den VMAT-Extras als PNG holen (pak01, dann Map-VPK).
 * fx (3D-Skybox): dazu Masken der csgo_effects und die .vmat der Effekt-/Unlit-Materialien (DynamicParams fehlen in VRFs glTF-Extras)
 */
async function extraTextures(c: Ctx, gltf: string, outDir: string, mapVpk: string, run = (a: string[]): void | Promise<void> => vrf(c.exe, a, c.log), fx = false) {
  const g = JSON.parse(readFileSync(gltf, 'utf8'))
  const want = new Set<string>()
  for (const m of g.materials ?? []) {
    const v = m.extras?.vmat ?? {}, tp = v.TextureParams ?? {}, shader = String(v.ShaderName ?? ''), water = shader.startsWith('csgo_water')
    for (const s of [...BLEND_TEX, 'g_tTintMask', ...water ? WATER_NORMAL : [], ...fx ? FX_MASKS : []]) if (tp[s]) want.add(String(tp[s]).toLowerCase())
    if (fx && /^csgo_(effects|unlitgeneric)\./.test(shader) && v.Name) want.add(String(v.Name).toLowerCase())
  }
  const list = [...want].map(v => v + '_c'), parts = Array.from({ length: Math.ceil(list.length / 40) }, (_, i) => list.slice(i * 40, i * 40 + 40))
  // Blöcke einer VPK gleichzeitig, wenn run asynchron ist (je ~0,3 GB); pak01 vor der Map-VPK (die gewinnt bei gleichem Pfad)
  for (const vpk of [c.cs2.pak, mapVpk]) await Promise.all(parts.map(p => Promise.resolve().then(() => run(['-i', vpk, '-d', '-o', outDir, '-f', p.join(',')])).catch(() => {})))
  const found: Record<string, string> = {}
  for (const v of want) { const f = join(outDir, v.endsWith('.vmat') ? v : v.replace(/\.vtex$/, '.png')); if (existsSync(f)) found[v] = f }
  return found
}

/** default_ents.vents (VRF-Text): "====N====" je Entity, dann "key value" */
type Ent = Record<string, any>
function parseEntities(text: string): Ent[] {
  const ents: Ent[] = []
  let cur: Ent | null = null
  for (const line of text.split(/\r?\n/)) {
    if (/^====\d+====$/.test(line)) { ents.push(cur = {}); continue }
    const m = cur && line.match(/^(\S+)\s+(.*)$/)
    if (!m) continue
    let v: any = m[2].trim()
    if (v.startsWith('[')) v = v.replace(/[[\]]/g, '').split(',').map(Number)
    else if (v.startsWith('"')) v = v.slice(1, -1)
    else if (/^-?[\d.]+(e-?\d+)?$/.test(v)) v = Number(v)
    cur![m[1]] = v
  }
  return ents
}
/** Entity-Schalter: true/1 (unquotiert → Zahl/Text, quotiert → Text) */
const on = (v: unknown) => v === true || v === 1 || v === 'true' || v === '1'
/** Vektor-Wert: Liste oder (Skybox-Prefab-Entities) Text "x y z" */
const vec = (v: unknown): number[] => Array.isArray(v) ? v : String(v ?? '').trim().split(/\s+/).map(Number)
/** erstes eingeschaltetes env_sky (startdisabled nicht gesetzt), sonst das erste */
const activeSky = (ents: Ent[]): Ent | undefined => { const s = ents.filter(e => e.classname === 'env_sky'); return s.find(e => !on(e.startdisabled)) ?? s[0] }

// ---------------------------------------------------------------- 2) Lightmap, Himmel, Einstellungen

const h2f = (() => { const t = new Float32Array(65536); for (let i = 0; i < 65536; i++) t[i] = DataUtils.fromHalfFloat(i); return t })()
const readExr = (file: string) => {
  const b = readFileSync(file)
  const e = new EXRLoader().setDataType(HalfFloatType).parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
  return { W: e.width as number, H: e.height as number, data: e.data as unknown as Uint16Array }
}
const srgb8 = (v: number) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055))
/** VMAT-/Entity-Farbe (sRGB 0..1) → linear, 4 Stellen */
const srgbLin = (c: number[]) => c.slice(0, 3).map(v => +(v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).toFixed(4)) as [number, number, number]

/**
 * DynamicParams einer dekompilierten .vmat (VRF -d): "float2(a, b)" bzw. "frac(float2(a, b) * time())" → v = [a, b], time = hängt an der Zeit.
 * shortcut: andere Ausdrücke → undefined (statischer Wert gilt); erst bei Bedarf einen Ausdrucks-Leser
 */
export function vmatDynamic(vmat: string, key: string): { v: [number, number]; time: boolean } | undefined {
  const e = vmat.match(/"DynamicParams"\s*\{([^}]*)\}/)?.[1].match(new RegExp(`"${key}"\\s+"([^"]*)"`))?.[1]
  const m = e?.match(/float2\(\s*([-\d.e]+)\s*,\s*([-\d.e]+)\s*\)/)
  return m ? { v: [+m[1], +m[2]], time: e!.includes('time()') } : undefined
}

/** Farbkorrektur eines Layers (shared/coloradjust.ts, Formel der DLL wie bei den Handschuhen) als affine 3×4 (Zeilen, linear); null = neutral */
export function layerAdjust(contrast: number, saturation: number, brightness: number, tint: number[], avg: number[]): number[] | null {
  if (contrast === 1 && saturation === 1 && brightness === 1 && tint.every(v => v === 1)) return null
  return colorAdjust(tint, contrast, saturation, brightness, avg).slice(0, 12).map(v => +v.toFixed(5))
}

/**
 * RGB = sRGB(irradiance/4) aus irradiance (BC6H roh, sonst VRFs EXR), A = Sonnen-Sichtbarkeit 255 − direct_light_shadows.png R
 * (R = Schattenstärke, CS2: 1 − dot(dls, Kanalmaske); licht-shader Befund 2), Alpha nie 0.
 * outDls (MAP_VERSION 6): RGB = Sichtbarkeit 255 − G/B/A der stationären Lichter (directlight 3, bakedshadowindex 1/2/3; Kanal ohne
 * Licht = 255 = ganz verschattet → 0), gleiche UVs wie die Lightmap, halbe Kantenlänge.
 * Verkleinern per Box-Filter in JS: libvips multipliziert RGB mit Alpha vor → unter Schatten schwarze Böden.
 */
export async function bakeLightmap(dir: string, out: string, size: number, outDls?: string) {
  const RANGE = 4
  // VRFs EXR (nur wenn nicht BC6H): RGBA, Zeilen von unten; bc6h(): RGB von oben
  const exr = join(dir, 'irradiance.exr'), flip = existsSync(exr), ch = flip ? 4 : 3
  const v = flip ? null : readVtex(readFileSync(join(dir, 'irradiance.vtex_c')))!
  const { W, H, data: src } = v ? { W: v.w, H: v.h, data: bc6h(v.mips[0], v.w, v.h) } : readExr(exr)
  const enc = new Uint8Array(4097); for (let i = 0; i <= 4096; i++) enc[i] = srgb8(i / 4096)
  const dlsFile = join(dir, 'direct_light_shadows.png')
  const sh = await sharp(dlsFile, { limitInputPixels: false }).extractChannel(0).raw().toBuffer({ resolveWithObject: true })
  const shScale = sh.info.width / W, shAt = (x: number, y: number) => Math.floor(y * shScale) * sh.info.width + Math.floor(x * shScale)
  const rgba = Buffer.alloc(W * H * 4), empty = new Uint8Array(W * H)
  for (let y = 0; y < H; y++) {
    const sy = flip ? H - 1 - y : y // EXRLoader liefert Zeilen von unten
    for (let x = 0; x < W; x++) {
      const si = (sy * W + x) * ch, di = (y * W + x) * 4
      const r = h2f[src[si]], g = h2f[src[si + 1]], b = h2f[src[si + 2]]
      if (r === 0 && g === 0 && b === 0) empty[y * W + x] = 1
      rgba[di] = enc[Math.min(4096, Math.round(r / RANGE * 4096))]
      rgba[di + 1] = enc[Math.min(4096, Math.round(g / RANGE * 4096))]
      rgba[di + 2] = enc[Math.min(4096, Math.round(b / RANGE * 4096))]
      rgba[di + 3] = Math.max(1, 255 - sh.data[shAt(x, y)])
    }
  }
  const f = Math.max(1, Math.round(W / size)), empty0 = outDls ? empty.slice() : empty
  const lm = dilateDown(rgba, 4, W, H, empty, f, 1)
  writeAtomic(out, await sharp(lm.buf, { raw: { width: lm.OW, height: lm.OH, channels: 4 }, limitInputPixels: false })
    .webp({ quality: 90, alphaQuality: 100, smartSubsample: true, effort: 4, exact: true }).toBuffer())
  if (outDls) {
    const d = await sharp(dlsFile, { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const vis = Buffer.alloc(W * H * 3)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const si = shAt(x, y) * 4, di = (y * W + x) * 3
      vis[di] = 255 - d.data[si + 1]; vis[di + 1] = 255 - d.data[si + 2]; vis[di + 2] = 255 - d.data[si + 3]
    }
    const o = dilateDown(vis, 3, W, H, empty0, f * 2) // halbe Lightmap-Größe: 4096² RGBA wären 89 MB VRAM
    writeAtomic(outDls, await sharp(o.buf, { raw: { width: o.OW, height: o.OH, channels: 3 }, limitInputPixels: false }).webp({ quality: 90, effort: 4 }).toBuffer())
  }
  return { src: W, size: lm.OW }
}

/**
 * Dilatation (leere Texel = Mittel gültiger Nachbarn, gegen dunkle Ränder beim Verkleinern/Mipmapping; leert empty), dann Box-Verkleinern
 * um f; ch Kanäle je Texel, min = Untergrenze des letzten Kanals
 */
function dilateDown(px: Buffer, ch: number, W: number, H: number, empty: Uint8Array, f: number, min = 0) {
  const s = new Float64Array(ch)
  for (let p = 0, passes = Math.max(2, f * 2); p < passes; p++) {
    const fill: number[] = []
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!empty[i]) continue
      let n = 0
      s.fill(0)
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const j = yy * W + xx
        if (empty[j]) continue
        n++
        for (let k = 0; k < ch; k++) s[k] += px[j * ch + k]
      }
      if (n) { fill.push(i); for (let k = 0; k < ch; k++) fill.push(Math.round(s[k] / n)) }
    }
    for (let k = 0; k < fill.length; k += ch + 1) { const i = fill[k]; for (let c = 0; c < ch; c++) px[i * ch + c] = fill[k + 1 + c]; empty[i] = 0 }
  }
  if (f === 1) return { buf: px, OW: W, OH: H }
  const OW = Math.floor(W / f), OH = Math.floor(H / f), o = Buffer.alloc(OW * OH * ch), n = f * f
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
    s.fill(0)
    for (let dy = 0; dy < f; dy++) { let i = ((y * f + dy) * W + x * f) * ch; for (let dx = 0; dx < f; dx++) for (let k = 0; k < ch; k++, i++) s[k] += px[i] }
    const j = (y * OW + x) * ch
    for (let k = 0; k < ch; k++) o[j + k] = Math.round(s[k] / n)
    o[j + ch - 1] = Math.max(min, o[j + ch - 1])
  }
  return { buf: o, OW, OH }
}

/**
 * Himmel (equirect EXR) → sRGB-WebP mit Clamp und Radiance-.hdr ohne Clamp, beide Wert/1.25 (backgroundIntensity gleicht aus, gilt für beide),
 * Zeilen von oben. HDR auf ≤ width Breite per Box-Filter in linear.
 */
async function bakeSky(exr: string, out: string, outHdr: string, width: number) {
  try {
    const { W, H, data } = readExr(exr), R = 1.25
    const lin = new Float32Array(W * H * 3)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const si = ((H - 1 - y) * W + x) * 4, di = (y * W + x) * 3
      for (let k = 0; k < 3; k++) lin[di + k] = Math.max(0, h2f[data[si + k]] / R)
    }
    const px = Buffer.alloc(W * H * 3)
    for (let i = 0; i < px.length; i++) px[i] = srgb8(Math.min(1, lin[i]))
    writeAtomic(out, await sharp(px, { raw: { width: W, height: H, channels: 3 } }).resize(width, width / 2).webp({ quality: 90 }).toBuffer())
    const f = Math.max(1, Math.floor(W / width)), OW = Math.floor(W / f), OH = Math.floor(H / f), small = new Float32Array(OW * OH * 3)
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) for (let k = 0; k < 3; k++) {
      let s = 0
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += lin[((y * f + dy) * W + x * f + dx) * 3 + k]
      small[(y * OW + x) * 3 + k] = s / (f * f)
    }
    writeAtomic(outHdr, rgbe(OW, OH, small))
    return true
  } catch { return false } // ohne Himmel: Hintergrundfarbe
}

/** Radiance-RGBE (.hdr) mit RLE-Zeilen (nur Literal-Läufe): eindeutig für Leser, die flache Zeilen am ersten Pixel erkennen */
function rgbe(W: number, H: number, px: Float32Array): Buffer {
  const head = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${H} +X ${W}\n`)
  const body = Buffer.alloc(H * (4 + 4 * (W + Math.ceil(W / 128)))), line = new Uint8Array(W * 4)
  let o = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3, v = Math.max(px[i], px[i + 1], px[i + 2])
      if (!(v > 1e-32)) { line.fill(0, x * 4, x * 4 + 4); continue }
      const e = Math.floor(Math.log2(v)) + 1, s = 256 / 2 ** e // frexp: v = m·2^e, m ∈ [0.5, 1)
      for (let k = 0; k < 3; k++) line[x * 4 + k] = Math.min(255, Math.max(0, Math.floor(px[i + k] * s)))
      line[x * 4 + 3] = e + 128
    }
    body[o++] = 2; body[o++] = 2; body[o++] = W >> 8; body[o++] = W & 255
    for (let k = 0; k < 4; k++) for (let x = 0; x < W; x += 128) {
      const n = Math.min(128, W - x)
      body[o++] = n
      for (let j = 0; j < n; j++) body[o++] = line[(x + j) * 4 + k]
    }
  }
  return Buffer.concat([head, body.subarray(0, o)])
}

/**
 * Sonne (light_environment), Tonemapping + Bloom (.vpost CToneMappingLayer/CBloomLayer, Belichtung aus post_processing_volume),
 * Himmel (aktives env_sky), Nebel (env_cubemap_fog, env_gradient_fog) → MapSettings. Formeln: licht-shader Befunde 8, 9, 11, 12.
 */
export function mapSettings(ents: Ent[], sky: Ent | undefined, post?: string, skyVmat?: string): MapSettings {
  const one = (c: string) => ents.find(e => e.classname === c && !on(e.startdisabled)) ?? {}
  const D = Math.PI / 180
  const le = one('light_environment')
  const [pitch, yaw] = le.angles ?? [50, 43, 0]
  const fx = Math.cos(pitch * D) * Math.cos(yaw * D), fy = Math.cos(pitch * D) * Math.sin(yaw * D), fz = -Math.sin(pitch * D)
  let col: number[] = le.color ?? [255, 255, 255]
  if (+le.colormode === 1 && le.colortemperature) col = kelvin(le.colortemperature).map((v, i) => v * col[i] / 255)
  const brightness = +(le.brightness ?? 1) * +(le.brightnessscale ?? 1)
  const ppv = one('post_processing_volume')
  const expo = on(ppv.enableexposure) ? ((+ppv.minexposure || 1) + (+ppv.maxexposure || 1)) / 2 : 1
  const r4 = (v: number) => +v.toFixed(4)
  // .vpost: Zahlen je Feldname (Namen sind über die Ebenen eindeutig); 1,26 = Belichtung aus 22 CS2-Ladebildern (licht-vergleich)
  const num = (k: string) => { const m = post && new RegExp(`\\b${k} = (-?[\\d.]+(?:e-?\\d+)?)`).exec(post); return m ? +m[1] : undefined }
  let toneMapping: MapSettings['toneMapping'] = { type: 'Linear', exposure: r4(1.26 * expo / 1.5) } // ohne .vpost: W 1,5 wie basepostprocess.vpost
  if (post?.includes('"CToneMappingLayer"') && num('m_flWhitePoint')) {
    const c = { toeStrength: num('m_flToeStrength') ?? 0.2, toeNum: num('m_flToeNum') ?? 0.02, toeDenom: num('m_flToeDenom') ?? 0.3, shoulder: num('m_flShoulderStrength') ?? 0.15, linearStrength: num('m_flLinearStrength') ?? 0.5, linearAngle: num('m_flLinearAngle') ?? 0.1, whitePoint: num('m_flWhitePoint')! }
    toneMapping = { type: 'Hable', exposure: r4(1.26 * expo * 2 ** (num('m_flExposureBias') ?? 0)), curve: c }
  }
  let bloom: MapSettings['bloom']
  if (post?.includes('"CBloomLayer"')) {
    const screen = !/m_blendMode = "BLOOM_BLEND_ADD"/.test(post)
    bloom = { strength: (screen ? num('m_flScreenBloomStrength') : num('m_flBloomStrength')) ?? 0, threshold: num('m_flBloomThreshold') ?? 1, width: num('m_flBloomThresholdWidth'), mode: screen ? 'screen' : 'add' }
  }
  const skyBias = skyVmat ? +(readFileSync(skyVmat, 'utf8').match(/"g_flBrightnessExposureBias"\s+"([-\d.]+)"/)?.[1] ?? 0) : 0
  const skyScale = +(sky?.brightnessscale ?? 1) * Math.pow(2, skyBias)
  const m = (v: unknown) => +((+(v as number) || 0) * S).toFixed(2)
  const cf = one('env_cubemap_fog'), gf = one('env_gradient_fog')
  // stationäre Lichter (directlight 3, Schatten in direct_light_shadows G/B/A = bakedshadowindex 1..3): Source-Achsen X vorn, Y links, Z oben (AngleVectors) → glTF (y, z, x); Barn-Form siehe shared/assets3d.ts StationaryLight
  const lights: StationaryLight[] = ents.filter(e => /^light_(barn|omni2|rect)$/.test(e.classname) && +e.directlight === 3 && on(e.enabled ?? true) && +e.bakedshadowindex >= 1 && +e.bakedshadowindex <= 3).map(e => {
    const [p, y, r] = vec(e.angles).map(a => (a || 0) * D), o = vec(e.origin), sz = vec(e.size_params), sh = vec(e.shear), range = +e.range || 0
    const [sp, cp, sy, cy, sr, cr] = [Math.sin(p), Math.cos(p), Math.sin(y), Math.cos(y), Math.sin(r), Math.cos(r)]
    const g = (v: number[]) => [v[1], v[2], v[0]].map(x => +x.toFixed(4)) as StationaryLight['fwd']
    let c: number[] = Array.isArray(e.color) ? e.color : [255, 255, 255]
    if (+e.colormode === 1 && e.colortemperature) c = kelvin(e.colortemperature).map((v, i) => v * c[i] / 255)
    const b = +(e.brightness ?? 1) * +(e.brightnessscale ?? 1), kind = e.classname === 'light_omni2' ? 0 : e.classname === 'light_barn' ? 1 : 2
    return {
      ch: +e.bakedshadowindex - 1, kind, pos: [o[1], o[2], o[0]].map(v => +(v * S).toFixed(3)) as StationaryLight['pos'],
      fwd: g([cp * cy, cp * sy, -sp]), left: g([sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp]), up: g([cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp]),
      color: srgbLin(c.map(v => v / 255)).map(v => r4(v * b)) as StationaryLight['color'], rangeM: m(range),
      ...kind === 1 && {
        size: [m(sz[0]), m(sz[1])] as [number, number], spread: r4(+sz[2] || 0), shear: [r4((+sh[0] || 0) / (range || 1)), r4((+sh[1] || 0) / (range || 1))] as [number, number],
        soft: [r4(+e.soft_x || 0), r4(+e.soft_y || 0)] as [number, number], ellipse: +e.shape >= 0.5,
      },
      ...kind === 0 && +e.outer_angle > 0 && +e.outer_angle < 180 && { cone: [+e.outer_angle, +e.inner_angle || 0] as [number, number] },
    }
  })
  return {
    ...lights.length && { stationary: { dls: DLS_FILE, lights } },
    ...on(ppv.enableexposure) && { exposureRange: [+ppv.minexposure || 1, +ppv.maxexposure || 1].sort((a, b) => a - b) as [number, number] },
    sun: { toSunGltf: [-fy, -fz, -fx].map(v => +v.toFixed(5)) as [number, number, number], colorSRGB: col.map(v => r4(v / 255)) as [number, number, number], threeIntensity: r4(Math.PI * brightness) },
    lightmap: { range: 4, threeIntensity: r4(4 * Math.PI) },
    toneMapping,
    sky: { backgroundIntensity: r4(1.25 * skyScale), yawDeg: r4(vec(sky?.angles)[1] || 0) },
    fog: cf.classname ? {
      startM: m(cf.cubemapfogstartdistance), endM: m(cf.cubemapfogenddistance), maxOpacity: +cf.cubemapfogmaxopacity || 0, exponent: +cf.cubemapfogfalloffexponent || 1,
      lodBias: +cf.cubemapfoglodbiase || 0,
      ...on(cf.cubemapheightfog) && { heightStartM: m(cf.cubemapfogheightstart), heightEndM: m(cf.cubemapfogheightend), heightExponent: +cf.cubemapfogheightexponent || 1 },
    } : undefined,
    // heightfog aus → heightExponent 0 (Höhenterm = 1)
    gradientFog: gf.classname ? {
      startM: m(gf.fogstart), endM: m(gf.fogend), exponent: +gf.fogfalloffexponent || 1, maxOpacity: +gf.fogmaxopacity || 0,
      heightStartM: m(gf.fogstartheight), heightEndM: m(gf.fogendheight), heightExponent: on(gf.heightfog) ? +gf.fogverticalexponent || 1 : 0,
      colorLinear: srgbLin((Array.isArray(gf.fogcolor) ? gf.fogcolor : [255, 255, 255]).map((x: number) => x / 255)),
    } : undefined,
    bloom,
  }
}

/** .vpost m_lut (32³ RGB float, r schnellste Achse, Werte k/255) → lut.bin 32³ RGB8; fehlt/falsche Größe → null */
function vpostLut(post?: string): Uint8Array | null {
  const i = post?.indexOf('m_lut =') ?? -1
  if (!post || i < 0) return null
  const v = post.slice(post.indexOf('[', i) + 1, post.indexOf(']', i)).split(',').map(s => s.trim()).filter(Boolean).map(Number)
  if (v.length !== 32 ** 3 * 3 || v.some(Number.isNaN)) return null
  return Uint8Array.from(v, x => Math.round(Math.min(1, Math.max(0, x)) * 255))
}
/** Farbtemperatur (Kelvin) → sRGB 0..255 (Tanner-Helland) */
function kelvin(k: number) {
  const t = k / 100
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592)
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307
  return [r, g, b].map(v => Math.min(255, Math.max(0, v)))
}

// ---------------------------------------------------------------- 3) Lichtsonden (env_combined_light_probe_volume)

interface Probes { vols: unknown[]; sample(p: number[], n: number[], out: number[]): number[] }
/**
 * Atlas: env_light_probe_volume_atlas_zNNN.exr (6 Flächen × Z-Slices, slice = face·Z + z, Flächen +X,+Y,+Z,−X,−Y,−Z wie im CS2-Shader,
 * Daten Dust2: Block 2 = Himmel; Zeilen spiegeln) und …_dlshd_zNNN.png (R = Schattenstärke der Sonne, nicht spiegeln).
 * sample(): Source-Welt → [r,g,b] Irradiance (Lightmap-Einheiten), [3] Sonnen-Sichtbarkeit 0..1 (1 = frei).
 */
async function loadProbes(dir: string, ents: Ent[]): Promise<Probes | null> {
  const vols = ents.filter(e => e.classname === 'env_combined_light_probe_volume').map(e => {
    // vec: Skybox-Prefab-Entities haben origin als Text "x y z" (sonst Zeichen statt Zahlen → Nuke-Skybox schwarz)
    const v = { o: vec(e.origin), mn: vec(e.box_mins), mx: vec(e.box_maxs), size: [+e.light_probe_size_x, +e.light_probe_size_y, +e.light_probe_size_z], at: [+e.light_probe_atlas_x, +e.light_probe_atlas_y, +e.light_probe_atlas_z] }
    return { ...v, wmn: v.mn.map((x, i) => x + v.o[i]), wmx: v.mx.map((x, i) => x + v.o[i]), vol: (v.mx[0] - v.mn[0]) * (v.mx[1] - v.mn[1]) * (v.mx[2] - v.mn[2]) }
  }).sort((a, b) => a.vol - b.vol) // kleinstes (detailliertestes) Volumen zuerst
  const files = readdirSync(dir)
  const exrs = files.filter(f => /^env_light_probe_volume_atlas_z\d+\.exr$/.test(f)).sort()
  const dls = files.filter(f => /^env_light_probe_volume_atlas_dlshd_z\d+\.png$/.test(f)).sort()
  if (!exrs.length || !vols.length) return null
  const Z = dls.length || exrs.length / 6
  let W = 0, H = 0, cube: Uint16Array | null = null
  exrs.forEach((f, s) => {
    const e = readExr(join(dir, f))
    if (!cube) { W = e.W; H = e.H; cube = new Uint16Array(exrs.length * W * H * 3) }
    const ch = e.data.length / (W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const si = ((H - 1 - y) * W + x) * ch, di = ((s * H + y) * W + x) * 3
      cube![di] = e.data[si]; cube![di + 1] = e.data[si + 1]; cube![di + 2] = e.data[si + 2]
    }
  })
  const sun = new Uint8Array(Z * W * H).fill(255)
  for (let z = 0; z < dls.length; z++) {
    const { data, info } = await sharp(join(dir, dls[z])).raw().toBuffer({ resolveWithObject: true })
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) sun[(z * H + y) * W + x] = 255 - data[(y * W + x) * info.channels]
  }
  const C = cube!
  const findVol = (p: number[]) => {
    for (const v of vols) if (p[0] >= v.wmn[0] && p[0] <= v.wmx[0] && p[1] >= v.wmn[1] && p[1] <= v.wmx[1] && p[2] >= v.wmn[2] && p[2] <= v.wmx[2]) return v
    let best = vols[0], bd = Infinity // außerhalb: nächstes Volumen (geklemmt)
    for (const v of vols) { let d = 0; for (let i = 0; i < 3; i++) d += Math.max(0, v.wmn[i] - p[i], p[i] - v.wmx[i]) ** 2; if (d < bd) { bd = d; best = v } }
    return best
  }
  const c = [0, 0, 0], i0 = [0, 0, 0], i1 = [0, 0, 0], fr = [0, 0, 0]
  function sample(p: number[], n: number[], out: number[]) {
    const v = findVol(p)
    for (let i = 0; i < 3; i++) {
      const t = (p[i] - v.wmn[i]) / (v.wmx[i] - v.wmn[i])
      c[i] = Math.min(v.size[i] - 1, Math.max(0, t * v.size[i] - 0.5)); i0[i] = Math.floor(c[i]); fr[i] = c[i] - i0[i]; i1[i] = Math.min(v.size[i] - 1, i0[i] + 1)
    }
    const faces = [n[0] >= 0 ? 0 : 3, n[1] >= 0 ? 1 : 4, n[2] >= 0 ? 2 : 5], w = [n[0] * n[0], n[1] * n[1], n[2] * n[2]]
    out[0] = out[1] = out[2] = 0
    let s = 0
    for (let k = 0; k < 8; k++) {
      const bx = k & 1, by = (k >> 1) & 1, bz = (k >> 2) & 1
      const wt = (bx ? fr[0] : 1 - fr[0]) * (by ? fr[1] : 1 - fr[1]) * (bz ? fr[2] : 1 - fr[2])
      if (wt === 0) continue
      const x = v.at[0] + (bx ? i1[0] : i0[0]), y = v.at[1] + (by ? i1[1] : i0[1]), z = v.at[2] + (bz ? i1[2] : i0[2])
      for (let a = 0; a < 3; a++) {
        if (!w[a]) continue
        const i = (((faces[a] * Z + z) * H + y) * W + x) * 3, ww = wt * w[a]
        out[0] += ww * h2f[C[i]]; out[1] += ww * h2f[C[i + 1]]; out[2] += ww * h2f[C[i + 2]]
      }
      s += wt * sun[(z * H + y) * W + x] / 255
    }
    out[3] = s
    return out
  }
  return { vols, sample }
}

// ---------------------------------------------------------------- 4) Geometrie + Materialien + Texturen

/** linear → sRGB 0..1 */
const linSrgb = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
/**
 * VRF 20.1 schiebt Overlay-Vertices (IsMaterialOverlay: F_OVERLAY, F_DEPTHBIAS, *static_overlay) um 0,01/0,0254 entlang der Normalen, aber in
 * glTF-Metern (gemeint: 1 cm) → 15,5 u vor der Fläche (Mirage: Wandschmutz schwebt vor der angelehnten Tür, zeigt die Lightmap dahinter).
 * Rückgängig, die Fläche bekommt Tiefen-Versatz im Renderer (flags 'overlay'/'bias').
 */
const VRF_OVERLAY_PUSH = 0.01 / 0.0254
/** statische Welt-Meshes (keine Aggregate/Entities): ihre Tönung kommt aus dem Draw-Call (m_vTintColor, schon linear); 3D-Skybox: node000_… */
const STATIC_NODE = /^n(ode)?\d+_lr\d+_c\d+_s_/
const isTool = (name: string) => /^materials\/tools\//i.test(name) || /(^|\/)(tools(nodraw|clip|trigger|skip|hint|invisible|blocklight|solidblocklight|playerclip|npcclip|blockbullets|areaportal|occluder|black|skybox|fog|light)|nodraw|playerclip|trigger)/i.test(name)

interface OptOpts {
  in: string; out: string; extra: Record<string, string>; probes: Probes | null; simplify: number
  tex: typeof PROFILES.high.tex; native: typeof PROFILES.high.native; mapVpk: string; work: string
  /** Lightmap-UVs verwerfen (3D-Skybox: eigene Lightmap nicht exportiert) */
  noLightmap?: boolean
  /** 3D-Skybox: csgo_effects behalten und Himmels-Effekte (ext.fx) schreiben; extra enthält dann auch Masken und .vmat */
  effects?: boolean
}

async function optimizeMap(opt: OptOpts, c: Ctx) {
  await MeshoptEncoder.ready; await MeshoptSimplifier.ready
  const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.WARN)).registerExtensions([...ALL_EXTENSIONS, CSDAMaterialsCS2]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
  // tolerant lesen: VRF verweist manchmal auf nicht geschriebene PNGs (z. B. Glas-ORM) → 1×1-Platzhalter
  const json = JSON.parse(readFileSync(opt.in, 'utf8')), dir = join(opt.in, '..'), resources: Record<string, any> = {}
  const px = (r: number, g: number, b: number) => sharp({ create: { width: 1, height: 1, channels: 3, background: { r, g, b } } }).png().toBuffer()
  const ph = { orm: await px(255, 200, 0), normal: await px(128, 128, 255), color: await px(255, 255, 255) }
  let missingImages = 0
  for (const b of json.buffers ?? []) if (b.uri) resources[b.uri] = readFileSync(join(dir, decodeURIComponent(b.uri)))
  for (const im of json.images ?? []) {
    if (!im.uri) continue
    const p = join(dir, decodeURIComponent(im.uri))
    if (existsSync(p)) resources[im.uri] = readFileSync(p)
    else { missingImages++; resources[im.uri] = /_orm|rough|metal|occlusion/i.test(im.uri) ? ph.orm : /normal/i.test(im.uri) ? ph.normal : ph.color }
  }
  const doc = await io.readJSON({ json, resources })
  const root = doc.getRoot(), buffer = root.listBuffers()[0]
  const ext = doc.createExtension(CSDAMaterialsCS2), unlit = doc.createExtension(KHRMaterialsUnlit)
  const stats: Record<string, any> = { missingImages, removedPrims: 0, layers: 0, tint: 0 }
  const texCache = new Map<string, any>()
  const extraTexture = (vtex?: string) => {
    const png = vtex && opt.extra[vtex.toLowerCase()]
    if (!png) return null
    if (!texCache.has(png)) { const name = png.split(/[\\/]/).pop()!; texCache.set(png, doc.createTexture(name).setImage(readFileSync(png)).setMimeType('image/png').setURI(name)) }
    return texCache.get(png)
  }
  const findExisting = (vtex?: string) => {
    if (!vtex) return null
    const base = vtex.split('/').pop()!.replace(/\.vtex$/i, '').toLowerCase()
    return root.listTextures().find(t => (t.getURI() || t.getName() || '').toLowerCase().startsWith(base)) ?? null
  }
  const tex = (vtex?: string) => vtex ? extraTexture(vtex) ?? findExisting(vtex) : null
  const avgCache = new Map<Texture, number[]>()
  /** Durchschnittsfarbe (linear) einer Textur = Drehpunkt des CS2-Kontrasts (TextureAverageColor) */
  const avgOf = async (t: Texture | null) => {
    let a = t && avgCache.get(t)
    if (t && !a) {
      const { data } = await sharp(t.getImage()!).resize(16, 16, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }), s = [0, 0, 0]
      for (let i = 0; i < data.length; i += 3) for (let k = 0; k < 3; k++) { const x = data[i + k] / 255; s[k] += x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
      avgCache.set(t, a = s.map(x => x / (data.length / 3)))
    }
    return a ?? [0.5, 0.5, 0.5]
  }
  /** Weichheit der Höhen-Blends (wird beim Vertex-Attribut _BLEND eingerechnet), je Material */
  const blendSoft = new Map<Material, { height: boolean; l3: boolean; s2: number; s3: number }>()
  /**
   * Mehr-Layer-Blend → Texturen an cs + CSDABlend (Formeln Reverse-Engineering.md „Map-Blend“, Quelle VRF-Shader-Rekonstruktion):
   * csgo_environment_blend = Höhen-Blend (g_tColor1..3, g_tHeight1..3), csgo_simple_2way_blend = g_tColorB über g_tMask.r (Weichheit aus der
   * Vertex-Malerei), csgo_lightmappedgeneric F_LAYERS = g_tLayer2Color über g_tBlendModulation (F_FANCY_BLENDING 1: G, Weichheit R; 2: G; 3: A).
   */
  async function blendOf(mat: Material, shader: string, v: any, cs: CS2Material): Promise<{ blend: CSDABlend; soft: { height: boolean; l3: boolean; s2: number; s3: number } } | null> {
    const ip = v.IntParams ?? {}, fp = v.FloatParams ?? {}, tp = v.TextureParams ?? {}, vp = v.VectorParams ?? {}
    const env = shader === 'csgo_environment_blend', simple = shader === 'csgo_simple_2way_blend'
    const l2 = tex(env ? tp.g_tColor2 : simple ? tp.g_tColorB : ip.F_LAYERS === 1 ? tp.g_tLayer2Color : undefined)
    if (!l2) return null
    cs.setLayer2(l2)
    const r4 = (x: number) => +x.toFixed(4)
    const sc = (k: string) => Array.isArray(vp[k]) && vp[k][0] && vp[k][1] ? [vp[k][0], vp[k][1]] : [1, 1]
    if (env) {
      const h1 = tex(tp.g_tHeight1), h2 = tex(tp.g_tHeight2), l3 = ip.F_ENABLE_LAYER_3 ? tex(tp.g_tColor3) : null, h3 = l3 && tex(tp.g_tHeight3)
      const height = !!(h1 && h2 && (!l3 || h3))
      if (height) { cs.setTex('height1Texture', h1); cs.setTex('height2Texture', h2); if (l3) { cs.setTex('layer3BaseColorTexture', l3); cs.setTex('height3Texture', h3!) } }
      // jede Ebene hat ihre eigene UV-Skala; der Basis-Layer liegt (mit seiner Skala) als glTF-Basisfarbe vor
      const s1 = sc('g_vTexCoordScale1'), s2 = sc('g_vTexCoordScale2'), s3 = sc('g_vTexCoordScale3')
      const face = (i: number): CSDABlend['face2'] => {
        if (!(+ip[`F_BLEND_BY_FACING_DIRECTION_${i}`] > 0)) return undefined // shortcut: Modus 2 (über die Normal-Map) hier wie 1 über die Geometrie-Normale
        const spread = fp[`g_flFacingDirectionMaskSpread${i}`] ?? 0.5, fall = fp[`g_vFacingDirectionMaskFalloff${i}`] ?? 0.1
        const d = Array.isArray(vp[`g_vFacingDirection${i}`]) ? vp[`g_vFacingDirection${i}`] : [0, 0, 1], dz = d[2] || 1e-4, l = Math.hypot(d[0], d[1], dz)
        return [Math.max(0, 1 - spread - fall), Math.min(1, 1 - spread + 0.001 + fall), d[1] / l, dz / l, d[0] / l].map(r4) as CSDABlend['face2']
      }
      const cc = async (i: number, t: Texture | null) => {
        const c = fp[`g_fTextureColorContrast${i}`] ?? 1, tint = vp[`g_vTextureColorTint${i}`]
        return layerAdjust(c, fp[`g_fTextureColorSaturation${i}`] ?? 1, fp[`g_fTextureColorBrightness${i}`] ?? 1, Array.isArray(tint) ? tint.slice(0, 3) : [1, 1, 1], c !== 1 ? await avgOf(t) : [0, 0, 0])
      }
      const adj = [await cc(1, mat.getBaseColorTexture()), await cc(2, l2), l3 ? await cc(3, l3) : null]
      const blend: CSDABlend = {
        kind: height ? 'height' : 'mod', uv: [s2[0] / s1[0], s2[1] / s1[1], s3[0] / s1[0], s3[1] / s1[1]].map(r4) as CSDABlend['uv'],
        ...height && { h: [fp.g_flHeightMapScale1 ?? 1, fp.g_flHeightMapZeroPoint1 ?? 0.5, fp.g_flHeightMapScale2 ?? 1, fp.g_flHeightMapZeroPoint2 ?? 0.5, fp.g_flHeightMapScale3 ?? 1, fp.g_flHeightMapZeroPoint3 ?? 0.5] as CSDABlend['h'], face2: face(2), face3: l3 ? face(3) : undefined },
        ...adj.some(Boolean) && { adj },
        // Tint-Maske je Layer = ((Höhe.G − 0,5)·Kontrast + 0,5)·Helligkeit; Modell-Tönung (Colorize) je Layer an/aus, Stärke
        tm: [1, 2, 3].flatMap(i => [fp[`g_fTintMaskContrast${i}`] ?? 1, fp[`g_fTintMaskBrightness${i}`] ?? 1]) as CSDABlend['tm'],
        mt: [1, 2, 3].map(i => +(ip[`g_bModelTint${i}`] ?? 1)) as CSDABlend['mt'], mta: fp.g_flModelTintAmount ?? 1,
      }
      return { blend, soft: { height, l3: height && !!l3, s2: fp.g_flBlendSoftness2 ?? 0.01, s3: fp.g_flBlendSoftness3 ?? 0.01 } }
    }
    const bm = tex(simple ? tp.g_tMask : tp.g_tBlendModulation), fancy = +ip.F_FANCY_BLENDING || 0
    const mod: Pick<CSDABlend, 'ch' | 'soft'> = !bm ? {} : simple ? { ch: [1, 0, 0, 0], soft: [0, 0, 1] }
      : fancy ? { ch: fancy === 3 ? [0, 0, 0, 1] : [0, 1, 0, 0], soft: fancy === 1 ? [0, 1, 0] : [fp.g_flBlendSoftness ?? 0.1, 0, 0] } : {}
    if (mod.ch) cs.setBlendMod(bm)
    // Layer-Tönung (Farbwähler-Werte, sRGB) als Diagonal-Matrix
    const tint = (k: string) => { const t = Array.isArray(vp[k]) && vp[k].slice(0, 3).some((x: number) => x !== 1) ? srgbLin(vp[k]) : null; return t && [t[0], 0, 0, 0, 0, t[1], 0, 0, 0, 0, t[2], 0] }
    const adj = [tint('g_vLayer1Tint'), tint('g_vLayer2Tint'), null], s2 = sc('g_vTexCoordScale2')
    return { blend: { kind: 'mod', uv: [s2[0], s2[1], 1, 1], ...mod, ...simple && { tintA: true }, ...adj.some(Boolean) && { adj } }, soft: { height: false, l3: false, s2: 0, s3: 0 } }
  }

  // Materialien nur an statischen Welt-Meshes (VRF teilt Materialien je Tönung): Faktor = lin(Draw-Call-Tönung · g_vColorTint), die Tönung
  // ist aber schon linear (Nuke: Gelb 0,851/0,459/0,046 = Aggregat-Bytes 237/179/63) → CS2: Tönung · lin(g_vColorTint)
  const staticOnly = new Map<Material, boolean>()
  for (const node of root.listNodes()) for (const p of node.getMesh()?.listPrimitives() ?? []) {
    const m = p.getMaterial()
    if (m) staticOnly.set(m, (staticOnly.get(m) ?? true) && STATIC_NODE.test(node.getName()))
  }
  // Materialien nach VMAT-Shader/Flags klassifizieren
  const kind = new Map<Material, { shader: string; drop: boolean; overlay: boolean }>()
  for (const mat of root.listMaterials()) {
    const v: any = (mat.getExtras() as any)?.vmat ?? {}
    const shader = String(v.ShaderName ?? '').replace(/\.vfx$/, '')
    const ip = v.IntParams ?? {}, fp = v.FloatParams ?? {}, tp = v.TextureParams ?? {}
    // csgo_effects (Staub/Lichtschächte) brauchen Masken, die VRF nicht in Alpha packt → sichtbare Rechtecke → weg; 3D-Skybox: mit Masken (ext.fx)
    const fx = shader === 'csgo_effects'
    const drop = isTool(v.Name ?? mat.getName()) || (fx && !opt.effects)
    // wie VRF IsMaterialOverlay (VRF_OVERLAY_PUSH)
    const overlay = ip.F_OVERLAY === 1 || ip.F_DEPTHBIAS === 1 || ip.F_DEPTH_BIAS === 1 || shader.endsWith('static_overlay') || shader === 'citadel_overlay'
    kind.set(mat, { shader, drop, overlay })
    if (drop) continue
    const f0 = mat.getBaseColorFactor()
    if (staticOnly.get(mat) && f0.slice(0, 3).some(x => x < 0.999)) {
      const ct = Array.isArray(v.VectorParams?.g_vColorTint) ? v.VectorParams.g_vColorTint : [1, 1, 1], cl = srgbLin(ct)
      const t = (k: number) => ct[k] > 1e-4 ? Math.min(1, linSrgb(f0[k]) / ct[k] * cl[k]) : f0[k]
      mat.setBaseColorFactor([t(0), t(1), t(2), f0[3]])
    }
    const flags: string[] = []
    if (shader === 'csgo_static_overlay' || ip.F_OVERLAY) { mat.setAlphaMode('BLEND'); flags.push('overlay') }
    else if (overlay) flags.push('bias') // F_DEPTHBIAS: nur Tiefen-Versatz, Alpha-Modus bleibt
    if (ip.F_TRANSLUCENT && mat.getAlphaMode() === 'OPAQUE') mat.setAlphaMode('BLEND')
    if (shader === 'csgo_black_unlit') { mat.setBaseColorFactor([0, 0, 0, 1]); mat.setExtension('KHR_materials_unlit', unlit.createUnlit()); flags.push('unlit') }
    if (shader === 'csgo_unlitgeneric' || fx) { mat.setExtension('KHR_materials_unlit', unlit.createUnlit()); flags.push('unlit') }
    // csgo_unlitgeneric F_BLEND_MODE (Features: Opaque, Translucent, Alpha Test, Mod2x, Additive, Multiply, ModThenAdd); Additiv: Ziel + Farbe · Alpha
    const bm = shader === 'csgo_unlitgeneric' ? +ip.F_BLEND_MODE || 0 : 0
    if (bm === 1 || fx) mat.setAlphaMode('BLEND')
    if (bm === 2) mat.setAlphaMode('MASK').setAlphaCutoff(fp.g_flAlphaTestReference ?? 0.5)
    if (ip.F_ADDITIVE_BLEND || bm === 4) { mat.setAlphaMode('BLEND'); flags.push('additive') }
    if (ip.g_bFogEnabled === 0) flags.push('nofog')
    // Overlay F_BLEND_MODE 3 (Kaustik, Schmutz): Mod2x (Ziel × 2 × Farbe in Gamma, 0,5 = neutral) statt Alpha-Überblendung
    if (shader === 'csgo_static_overlay' && ip.F_BLEND_MODE === 3) {
      flags.push('mod2x')
      const n = +ip.g_nNumAnimationCells || 0
      if (ip.F_TEXTURE_ANIMATION && n > 1) flags.push(`anim:${n}:${+(fp.g_flAnimationFrameRate ?? fp.g_flAnimationRate ?? 0) || 15}`)
    }
    // 'blend' bleibt für Renderer ohne Glas-Shader
    if (shader === 'csgo_glass') { const f = mat.getBaseColorFactor(); mat.setAlphaMode('BLEND').setDoubleSided(true).setBaseColorFactor([f[0], f[1], f[2], 0.3]).setRoughnessFactor(0.1).setMetallicFactor(0); flags.push('blend', 'glass') }
    if (ip.F_SELF_ILLUM && mat.getEmissiveTexture()) mat.setEmissiveFactor([1, 1, 1])
    const cs = ext.create()
    let used = false
    // Wasser (csgo_water_fancy, csgo_water): nicht fest (mapbuilder.nonsolid) → BLEND, Rest zeichnet der Renderer aus ext.water
    const water = shader.startsWith('csgo_water')
    if (water) { mat.setAlphaMode('BLEND'); flags.push('water') }
    if (water || shader === 'csgo_glass') {
      const vp = v.VectorParams ?? {}, rgb = (k: string) => Array.isArray(vp[k]) ? srgbLin(vp[k]) : undefined
      const f = mat.getBaseColorFactor(), sc = vp.g_vTexCoordScrollSpeed ?? vp.g_vExtraTexCoordScroll
      cs.setWater(water ? {
        fresnelExp: fp.g_flFresnelExponent ?? 5, reflectance: fp.g_flReflectance ?? 0.025,
        colorLinear: rgb(shader === 'csgo_water' ? 'g_vRefractionTint' : 'g_vColorTint') ?? [1, 1, 1],
        fogColorLinear: rgb('g_vWaterFogColor'), fogEndM: +((fp.g_flWaterMaxDepth ?? fp.g_flWaterDepth ?? 0) * S).toFixed(3) || undefined,
        normalScale: fp.g_flWavesNormalStrength ?? fp.g_flBumpStrength,
        scroll: Array.isArray(sc) && (sc[0] || sc[1]) ? [sc[0], sc[1]] : undefined,
      } : { fresnelExp: 5, reflectance: 0.04, colorLinear: [f[0], f[1], f[2]] }) // Glas: F0 0,04, Farbe wie glTF-Basisfarbe (linear)
      const wn = water && WATER_NORMAL.map(k => tp[k]).find(Boolean)
      const nt = wn && (extraTexture(wn) ?? findExisting(wn))
      if (nt) cs.setWaterNormal(nt)
      used = true; stats.water = (stats.water ?? 0) + +water; stats.glass = (stats.glass ?? 0) + +!water
    }
    const bl = await blendOf(mat, shader, v, cs)
    if (bl) { cs.setBlend(bl.blend); blendSoft.set(mat, bl.soft); used = true; stats.layers++ }
    if ((ip.F_TINT_MASK || (shader === 'csgo_simple_2way_blend' && ip.F_ENABLE_TINT_MASKS)) && tp.g_tTintMask) {
      const f = mat.getBaseColorFactor()
      const tm = (f[0] < 0.999 || f[1] < 0.999 || f[2] < 0.999) && extraTexture(tp.g_tTintMask) // nur wenn wirklich eingefärbt
      if (tm) { cs.setTintMask(tm); used = true; stats.tint++ }
    }
    // 3D-Skybox: Himmels-Effekte (CSDAFx); Unlit-Wolken mit zweiter Textur und DynamicParams aus der .vmat (Dust2: Skala 3,5, Schwenk 0,002/s)
    if (opt.effects && (fx || shader === 'csgo_unlitgeneric')) {
      const vp = v.VectorParams ?? {}, two = (k: string, d: [number, number]): [number, number] => Array.isArray(vp[k]) ? [vp[k][0], vp[k][1]] : d
      const vf = opt.extra[String(v.Name ?? '').toLowerCase()], vmat = vf ? readFileSync(vf, 'utf8') : ''
      const off = vmatDynamic(vmat, 'g_vTexCoordOffset'), scroll = off?.time ? off.v : two('g_vTexCoordScrollSpeed', [0, 0])
      const scale = fx ? [1, 1] : vmatDynamic(vmat, 'g_vTexCoordScale')?.v ?? two('g_vTexCoordScale', [1, 1])
      const c2 = !fx && ip.F_TWOTEXTURE ? tex(tp.g_tColor2) : null
      const masks = fx ? FX_MASKS.map(k => tp[k] && !/default_mask/i.test(tp[k]) ? extraTexture(tp[k]) : null) : []
      masks.forEach((t, i) => { if (t) cs.setTex(`mask${i + 1}Texture` as 'mask1Texture', t) })
      if (c2) cs.setTex('color2Texture', c2)
      // Fresnel/Abstand nur, wenn nicht neutral (Exponent ≈ 0 bzw. Distanz ≈ 0 u ergeben das Maximum)
      const fres: CSDAFx['fresnel'] = [fp.g_flFresnelExponent ?? 0, fp.g_flFresnelFalloff ?? 1, fp.g_flFresnelMin ?? 0, fp.g_flFresnelMax ?? 1]
      const fade: CSDAFx['fade'] = [+((fp.g_flFadeDistance ?? 0) * S).toFixed(3), fp.g_flFadeFalloff ?? 1, fp.g_flFadeMin ?? 0, fp.g_flFadeMax ?? 1]
      cs.setFx({
        uv: [...scale, ...scroll] as CSDAFx['uv'], ...c2 && { uv2: two('g_vTex2CoordScale', [1, 1]) },
        boost: fx ? fp.g_flColorBoost ?? 1 : 1, opacity: fx ? fp.g_flOpacityScale ?? 1 : 1,
        ...masks.some(Boolean) && { masks: FX_MASKS.map((_, i) => [...two(`g_vMask${i + 1}Scale`, [1, 1]), ...two(`g_vMask${i + 1}PanSpeed`, [0, 0])] as [number, number, number, number]) },
        ...fx && (fres[0] > 0.01 || fres[1] < 1 || fres[3] !== 1) && { fresnel: fres },
        ...fx && (fade[0] > 0.1 || fade[3] !== 1) && { fade },
      })
      used = true; stats.fx = (stats.fx ?? 0) + 1
    }
    if (flags.length) { cs.setFlags(flags); used = true }
    if (used) mat.setExtension(CSDA, cs)
  }

  // Primitive bereinigen
  const unpushed = new Set<unknown>()
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    const mat = prim.getMaterial(), k = mat && kind.get(mat)
    if (!k || k.drop) { stats.removedPrims++; prim.dispose(); continue }
    // VRF_OVERLAY_PUSH zurück, entlang derselben Normalen (VRF gibt jeder Overlay-Primitive eigene Positionen; je Accessor nur einmal)
    const pos = prim.getAttribute('POSITION'), nor = prim.getAttribute('NORMAL')
    if (k.overlay && pos && nor && !unpushed.has(pos)) {
      unpushed.add(pos)
      for (let i = 0, p = [0, 0, 0], n = [0, 0, 0]; i < pos.getCount(); i++) { pos.getElement(i, p); nor.getElement(i, n); pos.setElement(i, p.map((x, j) => x - n[j] * VRF_OVERLAY_PUSH)) }
      stats.overlaysBack = (stats.overlaysBack ?? 0) + 1
    }
    // Vertex-Farbe nur bei Overlays und Effekten (Deckkraft); bei csgo_foliage sind es Windgewichte (sonst lila Laub)
    if (prim.getAttribute('COLOR_0') && k.shader !== 'csgo_static_overlay' && k.shader !== 'csgo_effects') prim.setAttribute('COLOR_0', null)
    const t4 = prim.getAttribute('_TEXCOORD_4'), soft = blendSoft.get(mat!)
    if (t4) {
      if (soft) { // Vertex-Malerei (VertexPaintBlendParams) → _BLEND: x Layer 2, y Layer 3, w Weichheit (height: + g_flBlendSoftness2/3 wie der CS2-Vertex-Shader)
        const src = t4.getArray()!, n = t4.getCount(), dst = new Uint16Array(n * 4), c = (x: number) => Math.round(65535 * Math.min(1, Math.max(0, x)))
        for (let i = 0; i < n; i++) {
          const x = src[i * 4], y = src[i * 4 + 1], w = src[i * 4 + 3]
          const s = soft.height ? Math.min(1, Math.max(0.001, w + (soft.l3 ? (x < 0.001 ? soft.s3 : soft.s2) * (1 - y) + soft.s3 * y : soft.s2))) : w
          dst[i * 4] = c(x); dst[i * 4 + 1] = c(y); dst[i * 4 + 3] = c(s)
        }
        prim.setAttribute('_BLEND', doc.createAccessor().setType('VEC4').setArray(dst).setNormalized(true).setBuffer(buffer))
      }
      prim.setAttribute('_TEXCOORD_4', null)
    }
    if (opt.noLightmap) { prim.setAttribute('TEXCOORD_1', null); prim.setAttribute('TEXCOORD_2', null) }
    // Lightmap-UV: hat ein Prop TEXCOORD_2, ist DAS die Atlas-UV (TEXCOORD_1 = zweite Modell-UV); nur 0..1 behalten
    const uv2 = prim.getAttribute('TEXCOORD_2')
    if (uv2) { prim.setAttribute('TEXCOORD_1', uv2); prim.setAttribute('TEXCOORD_2', null) }
    const uv1 = prim.getAttribute('TEXCOORD_1')
    // Ancient: 523 Primitive (Tempel, Hintergrund) mit Lightmap-UV überall (0, 0) = ohne Lightmap → Sonden statt Texel (0, 0)
    // shortcut: Primitive mit nur teilweise (0, 0) behalten die Lightmap (Ancient 8 von 4491); bei Bedarf je Vertex auf die Sonde umschalten
    if (uv1) {
      const mn = uv1.getMin([]), mx = uv1.getMax([]), flat = mx[0] - mn[0] < 1e-6 && mx[1] - mn[1] < 1e-6
      if (flat || !(mn[0] >= -1e-4 && mn[1] >= -1e-4 && mx[0] <= 1.0001 && mx[1] <= 1.0001)) { prim.setAttribute('TEXCOORD_1', null); stats.lmDropped = (stats.lmDropped ?? 0) + 1 }
    }
    if (prim.getAttribute('TANGENT')) prim.setAttribute('TANGENT', null)
  }
  // PNG-Basisname → vtex-Pfad (VRF benennt die PNGs nach der vtex) für die nativen Texturen
  const vtexOf = new Map<string, string>()
  for (const mat of root.listMaterials()) for (const p of Object.values<unknown>((mat.getExtras() as any)?.vmat?.TextureParams ?? {}))
    if (typeof p === 'string' && /\.vtex$/i.test(p)) vtexOf.set(p.split('/').pop()!.slice(0, -5).toLowerCase(), p.toLowerCase())
  for (const mat of root.listMaterials()) mat.setExtras({}) // VMAT-JSON ist mehrere MB
  c.step(0.55, 'Merging geometry')
  await doc.transform(dedup(), flatten(), weld())
  let before = 0, after = 0
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) {
    const idx = prim.getIndices()
    if (prim.getMaterial()?.getAlphaMode() !== 'OPAQUE' || !idx || idx.getCount() < 300) continue // Alpha-Karten/Decals nicht vereinfachen
    const scale = MeshoptSimplifier.getScale(prim.getAttribute('POSITION')!.getArray() as Float32Array, 3)
    before += idx.getCount()
    simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: 0, error: opt.simplify / scale, lockBorder: false })
    after += prim.getIndices()!.getCount()
    if (!prim.getIndices()!.getCount()) prim.dispose() // ganz weg-vereinfacht: leere Accessoren lassen den meshopt-Encoder scheitern
  }
  stats.simplify = { trisBefore: before / 3, trisAfter: after / 3 }
  await doc.transform(joinPrims({ keepMeshes: false, keepNamed: false }))

  // Props ohne Lightmap: CS2-Sonden pro Vertex backen, _PROBE = (sqrt(irr/4) rgb, Sonne) als UNSIGNED_BYTE normalisiert
  if (opt.probes) {
    c.step(0.68, 'Baking light probes')
    const skip = new Set(['csgo_static_overlay', 'csgo_black_unlit', 'generic', 'csgo_unlitgeneric', 'csgo_effects'])
    const o = [0, 0, 0, 0], o2 = [0, 0, 0, 0], p = [0, 0, 0], nn = [0, 0, 0], ps = [0, 0, 0], ns = [0, 0, 0]
    let nVerts = 0
    for (const node of root.listNodes()) {
      const mesh = node.getMesh()
      if (!mesh) continue
      const M = node.getWorldMatrix()
      for (const prim of mesh.listPrimitives()) {
        const k = kind.get(prim.getMaterial()!)
        if (prim.getAttribute('TEXCOORD_1') || !k || skip.has(k.shader)) continue
        const pos = prim.getAttribute('POSITION')!, nor = prim.getAttribute('NORMAL'), n = pos.getCount()
        // Karten (Efeu, Laub): Normale zeigt oft in die Wand, gemessen würde im Fels (schwarz) → beide Seiten, jeweils das Hellere
        const both = prim.getMaterial()!.getDoubleSided() || prim.getMaterial()!.getAlphaMode() === 'MASK'
        const dst = new Uint8Array(n * 4)
        for (let i = 0; i < n; i++) {
          pos.getElement(i, p)
          if (nor) nor.getElement(i, nn); else { nn[0] = 0; nn[1] = 1; nn[2] = 0 }
          const wx = M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], wy = M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], wz = M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]
          let ax = M[0] * nn[0] + M[4] * nn[1] + M[8] * nn[2], ay = M[1] * nn[0] + M[5] * nn[1] + M[9] * nn[2], az = M[2] * nn[0] + M[6] * nn[1] + M[10] * nn[2]
          const l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l
          // glTF (m, Y oben) → Source (u, Z oben), 2 u entlang der Normalen (nicht in der Wand messen)
          ns[0] = az; ns[1] = ax; ns[2] = ay
          ps[0] = wz / S + az * 2; ps[1] = wx / S + ax * 2; ps[2] = wy / S + ay * 2
          opt.probes.sample(ps, ns, o)
          if (both) {
            ns[0] = -az; ns[1] = -ax; ns[2] = -ay
            ps[0] = wz / S - az * 2; ps[1] = wx / S - ax * 2; ps[2] = wy / S - ay * 2
            opt.probes.sample(ps, ns, o2)
            for (let k = 0; k < 4; k++) o[k] = Math.max(o[k], o2[k])
            // Einstrahlung beider Seiten klein (Ecke im Fels: CS2 sampelt je Pixel, der sichtbare Teil liegt draußen; Anubis-Efeu: Blätter
            // schwarz, Blüten mit Sonnenglanz): Ring für Ring nach außen die hellste Einstrahlung, Abbruch am ersten Ring mit Licht; Sonne bleibt das Maximum
            const irr = (v: number[]) => (v[0] + v[1] + v[2]) / 3
            // (Normale ± und die 6 Achsen: Karten stehen oft quer zur Wand; Anubis-Efeu unter 0,1: 7,5 % → 0,9 % der Vertices, Mittel +0,6 %)
            for (const d of irr(o) < 0.1 ? [8, 24, 48, 96] : []) {
              for (const [dx, dy, dz] of [[az * d, ax * d, ay * d], [-az * d, -ax * d, -ay * d], [d, 0, 0], [-d, 0, 0], [0, d, 0], [0, -d, 0], [0, 0, d], [0, 0, -d]]) {
                ps[0] = wz / S + dx; ps[1] = wx / S + dy; ps[2] = wy / S + dz
                ns[0] = dx / d; ns[1] = dy / d; ns[2] = dz / d
                opt.probes.sample(ps, ns, o2)
                if (irr(o2) > irr(o)) { o[0] = o2[0]; o[1] = o2[1]; o[2] = o2[2]; o[3] = Math.max(o[3], o2[3]) }
              }
              if (irr(o) >= 0.1) break
            }
          }
          for (let ch = 0; ch < 3; ch++) dst[i * 4 + ch] = Math.round(255 * Math.sqrt(Math.min(1, Math.max(0, o[ch]) / 4)))
          dst[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, o[3])))
        }
        prim.setAttribute('_PROBE', doc.createAccessor().setType('VEC4').setArray(dst).setNormalized(true).setBuffer(buffer))
        nVerts += n
      }
    }
    stats.probeVerts = nVerts
  }
  // TEXCOORD_1 (Lightmap) und _BLEND sind keine Textur-UVs → keepAttributes
  // prune faltet einfarbige Basisfarben in den Faktor; Tint-Maske/Layer 2/Effekt-Masken rechnet der Renderer nur mit map → als 1×1 zurück
  // (Nuke hazard_stripe_002_trim: sonst weißes statt rot-weißes Band; Dust2-Dunst: Basis 1×1 weiß, ohne map keine Masken)
  const solidKeep = root.listMaterials().flatMap(m => { const e = m.getExtension<CS2Material>(CSDA); return m.getBaseColorTexture() && (e?.getTintMask() || e?.getLayer2() || e?.getFx()) ? [[m, m.getBaseColorFactor()] as const] : [] })
  await doc.transform(prune({ keepAttributes: true, keepLeaves: false, keepSolidTextures: false }))
  for (const [m, f0] of solidKeep) if (!m.getBaseColorTexture()) {
    const f = m.getBaseColorFactor(), c = [0, 1, 2].map(k => Math.round(255 * linSrgb(f0[k] > 1e-6 ? Math.min(1, f[k] / f0[k]) : 1)))
    m.setBaseColorFactor(f0).setBaseColorTexture(doc.createTexture().setImage(await px(c[0], c[1], c[2])).setMimeType('image/png'))
  }

  c.step(0.71, 'Native CS2 textures')
  stats.native = nativeTextures(doc, vtexOf, opt, c)
  c.step(0.72, 'Compressing textures')
  // Wasser-Normalen und Höhen (R Höhe, G Tint-Maske): VRF liefert Alpha 0, verlustbehaftetes WebP (textureCompress ohne exact) zerstört RGB
  // darunter → Alpha vorher weg
  const noAlpha = root.listMaterials().flatMap(m => { const e = m.getExtension<CS2Material>(CSDA); return e ? [e.getWaterNormal(), e.getTex('height1Texture'), e.getTex('height2Texture'), e.getTex('height3Texture')] : [] })
  for (const t of new Set(noAlpha))
    if (t?.getMimeType() === 'image/png') t.setImage(await sharp(t.getImage()!).removeAlpha().png().toBuffer())
  const T = opt.tex
  const tc = (slots: RegExp, size: number, quality: number) => textureCompress({ encoder: sharpLimited, targetFormat: 'webp', formats: /png|jpe?g/, slots, resize: [size, size], quality })
  await doc.transform(
    tc(/^(baseColorTexture|emissiveTexture)$/, T.color, Q.color),
    tc(/^layer[23]BaseColorTexture$/, T.layer2, Q.color),
    tc(/^normalTexture$/, T.normal, Q.normal),
    tc(/^(occlusionTexture|metallicRoughnessTexture)$/, T.orm, Q.orm),
    tc(/^(blendModulationTexture|height[123]Texture)$/, T.blendmod, Q.orm),
    tc(/^tintMaskTexture$/, T.tint, Q.orm),
    // Rest (Texturen ohne gezielten Slot)
    textureCompress({ encoder: sharpLimited, targetFormat: 'webp', formats: /png|jpe?g/, resize: [T.color, T.color], quality: Q.color }),
  )
  c.step(0.9, 'Compressing meshes')
  // Positionen auf einem Raster für die ganze Szene (16 Bit): je Mesh (Standard, 14 Bit) rasten gemeinsame Kanten verschiedener Meshes
  // verschieden ein → Spalten bis ~0,2 u, durch die der Himmel scheint (Inferno-Pflaster/Bordstein, roh deckungsgleich)
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high', quantizeTexcoord: 16, quantizationVolume: 'scene', quantizePosition: 16 }), prune({ keepAttributes: true, keepSolidTextures: true }))
  // glTF + .bin + tex/<i>.ktx2|webp statt GLB: der Renderer lädt jede Textur einzeln (kein 100-MB-Puffer samt Kopien).
  // Nicht atomar, map.json (zuletzt) macht den Build gültig; eindeutige URIs, sonst überschreiben sich gleichnamige Texturen
  root.listTextures().forEach((t, i) => t.setURI(`tex/${i}.${ImageUtils.mimeTypeToExtension(t.getMimeType())}`))
  await io.write(opt.out, doc)

  let prims = 0, tris = 0, texVram = 0
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) { prims++; tris += p.getIndices()!.getCount() / 3 }
  for (const t of root.listTextures()) texVram += ImageUtils.getVRAMByteLength(t.getImage()!, t.getMimeType()) ?? 0
  return { prims, tris, materials: root.listMaterials().length, textures: root.listTextures().length, texVramMB: Math.round(texVram / 1048576), ...stats }
}

/**
 * Farbe/Layer 2/Emissive (sRGB) und Normalen mit CS2-Kodierung HemiOctIsoRoughness_RG_B (linear; renderer map.ts dekodiert RG,
 * Rauheit kommt weiter aus der ORM-Textur) als native BCn-KTX2 statt WebP. Nicht passende Texturen bleiben auf dem WebP-Pfad.
 * Gemessen (Normale concrete_10): VRF-PNG = Hemi-Oct(RG) exakt, ORM.G = B.
 */
function nativeTextures(doc: Document, vtexOf: Map<string, string>, opt: OptOpts, c: Ctx) {
  const want = new Map<Texture, { path: string; normal: boolean; data?: boolean }>()
  for (const t of doc.getRoot().listTextures()) {
    const path = vtexOf.get((t.getURI() || t.getName()).replace(/\.png$/i, '').toLowerCase())
    if (!path || t.getMimeType() !== 'image/png') continue
    const slots = listTextureSlots(t)
    if (slots.length && slots.every(s => /^(baseColorTexture|layer[23]BaseColorTexture|emissiveTexture)$/.test(s))) want.set(t, { path, normal: false })
    else if (slots.length && slots.every(s => s === 'normalTexture')) want.set(t, { path, normal: true })
    // Höhen/Blend-Modulation (linear, Kanäle roh wie das VRF-PNG): BC7 512² = 0,25 MiB statt 1 MiB RGBA8
    else if (slots.length && slots.every(s => /^(height[123]Texture|blendModulationTexture)$/.test(s))) want.set(t, { path, normal: false, data: true })
  }
  const raw = join(opt.work, 'vtex'), files = [...new Set([...want.values()].map(w => w.path + '_c'))]
  mkdirSync(raw, { recursive: true })
  // roh aus pak01, Rest aus der Map-VPK; Befehlszeile ≤ 32k Zeichen
  for (const vpk of [c.cs2.pak, opt.mapVpk]) {
    const todo = files.filter(f => !existsSync(join(raw, f)))
    for (let i = 0, len = 0, batch: string[] = []; i <= todo.length; i++) {
      if (i === todo.length || len + todo[i].length > 25000) { try { if (batch.length) vrf(c.exe, ['-i', vpk, '-o', raw, '-f', batch.join(',')], c.log) } catch {} batch = []; len = 0 }
      if (i < todo.length) { batch.push(todo[i]); len += todo[i].length + 1 }
    }
  }
  // Kodierung der Normalen aus den Compiler-Abhängigkeiten (RED2)
  const red2 = join(opt.work, 'vtex_red2.txt')
  try { vrf(c.exe, ['-i', raw, '--recursive', '-b', 'RED2'], red2) } catch {}
  const hemi = new Set<string>()
  const dump = existsSync(red2) ? readFileSync(red2, 'utf8') : ''
  for (const part of dump.split(/^\[\d+\/\d+\] /m).slice(1)) if (part.includes('Mip HemiOctIsoRoughness_RG_B"')) hemi.add(part.slice(0, part.indexOf('\n')).trim().replaceAll('\\', '/').toLowerCase())
  const n = { color: 0, normal: 0, data: 0, skipped: 0, vramMB: 0 }
  for (const [t, w] of want) {
    const f = join(raw, w.path + '_c')
    const v = existsSync(f) ? readVtex(readFileSync(f)) : null
    const ok = v && v.format !== BC6H && (!w.normal || ((v.format === 20 || v.format === 21) && hemi.has(f.replaceAll('\\', '/').toLowerCase())))
    if (!ok) { n.skipped++; continue }
    const k = ktx2(v, w.data ? opt.tex.blendmod : w.normal ? opt.native.normal : opt.native.color, !w.normal && !w.data)
    t.setImage(k).setMimeType('image/ktx2').setURI(t.getURI().replace(/\.png$/i, '.ktx2'))
    n[w.data ? 'data' : w.normal ? 'normal' : 'color']++; n.vramMB += (ImageUtils.getVRAMByteLength(k, 'image/ktx2') ?? 0) / 1048576
  }
  if (n.color + n.normal + n.data) doc.createExtension(KHRTextureBasisu).setRequired(true)
  n.vramMB = Math.round(n.vramMB)
  return n
}

// ---------------------------------------------------------------- 5) Boden- und Sondenraster (Format: shared/assets3d.ts FloorGrid)

interface Floor { bin: Uint8Array; cell: number; minX: number; minY: number; W: number; H: number; n: number; offs: Uint32Array; z: Int16Array }

/** begehbare Dreiecke (|n.z| ≥ 0.7) des Physik-Mesh je 32-u-Zelle in Lagen (Abstand ≥ 6 u) mit SurfaceProperty */
export function floorGrid(glbPath: string): Floor {
  const b = readFileSync(glbPath)
  const jl = b.readUInt32LE(12)
  const g = JSON.parse(b.toString('utf8', 20, 20 + jl))
  const binOff = 20 + jl + 8
  const acc = (i: number) => {
    const a = g.accessors[i], v = g.bufferViews[a.bufferView]
    const comps = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as any)[a.type]
    const TA = ({ 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array } as any)[a.componentType]
    if (v.byteStride && v.byteStride !== comps * TA.BYTES_PER_ELEMENT) throw new Error('physics glb: strided accessor')
    const off = b.byteOffset + binOff + (v.byteOffset || 0) + (a.byteOffset || 0)
    return new TA(b.buffer.slice(off, off + a.count * comps * TA.BYTES_PER_ELEMENT)) as ArrayLike<number>
  }
  const surfaces: string[] = []
  const sidOf = (s: string) => { let i = surfaces.indexOf(s); if (i < 0) i = surfaces.push(s) - 1; return i }
  const tris: number[] = [] // je 10: a,b,c (xyz), sid
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const n of g.nodes) {
    if (n.mesh == null || n.extras?.InteractAs?.length) continue // playerclip/grenadeclip/sky
    const sid = sidOf(String(n.extras?.SurfaceProperty || 'default').toLowerCase())
    // VRF-Knotenmatrix = Source(x,y,z)→(y,z,x)·0.0254, Translation in Metern; Vertices in Source-Units
    const tx = (n.matrix?.[14] ?? 0) / S, ty = (n.matrix?.[12] ?? 0) / S, tz = (n.matrix?.[13] ?? 0) / S
    for (const p of g.meshes[n.mesh].primitives) {
      const P = acc(p.attributes.POSITION), I = acc(p.indices)
      for (let k = 0; k < I.length; k += 3) {
        const a = I[k] * 3, bb = I[k + 1] * 3, c = I[k + 2] * 3
        const ax = P[a] + tx, ay = P[a + 1] + ty, az = P[a + 2] + tz, bx = P[bb] + tx, by = P[bb + 1] + ty, bz = P[bb + 2] + tz, cx = P[c] + tx, cy = P[c + 1] + ty, cz = P[c + 2] + tz
        const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
        if (Math.abs(nz) / (Math.hypot(nx, ny, nz) || 1) < 0.7) continue
        tris.push(ax, ay, az, bx, by, bz, cx, cy, cz, sid)
        minX = Math.min(minX, ax, bx, cx); maxX = Math.max(maxX, ax, bx, cx); minY = Math.min(minY, ay, by, cy); maxY = Math.max(maxY, ay, by, cy)
      }
    }
  }
  const cell = FLOOR_CELL
  minX = Math.floor(minX); minY = Math.floor(minY)
  const W = Math.ceil((maxX - minX) / cell) + 1, H = Math.ceil((maxY - minY) / cell) + 1
  const cells = new Map<number, { z: number; sid: number }[]>()
  const put = (cx: number, cy: number, z: number, sid: number) => {
    const k = cy * W + cx
    let L = cells.get(k)
    if (!L) cells.set(k, L = [])
    for (const e of L) if (Math.abs(e.z - z) < 6) { if (z > e.z) { e.z = z; e.sid = sid } return }
    L.push({ z, sid })
  }
  for (let t = 0; t < tris.length; t += 10) {
    const ax = tris[t], ay = tris[t + 1], az = tris[t + 2], bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5], cx = tris[t + 6], cy = tris[t + 7], cz = tris[t + 8], sid = tris[t + 9]
    const d = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (Math.abs(d) < 1e-6) continue
    const x0 = Math.floor((Math.min(ax, bx, cx) - minX) / cell), x1 = Math.floor((Math.max(ax, bx, cx) - minX) / cell)
    const y0 = Math.floor((Math.min(ay, by, cy) - minY) / cell), y1 = Math.floor((Math.max(ay, by, cy) - minY) / cell)
    let hit = false
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const px = minX + (gx + 0.5) * cell, py = minY + (gy + 0.5) * cell
      const l1 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / d, l2 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / d, l3 = 1 - l1 - l2
      if (l1 < -0.05 || l2 < -0.05 || l3 < -0.05) continue
      put(gx, gy, l1 * az + l2 * bz + l3 * cz, sid); hit = true
    }
    if (!hit) put(Math.floor(((ax + bx + cx) / 3 - minX) / cell), Math.floor(((ay + by + cy) / 3 - minY) / cell), (az + bz + cz) / 3, sid)
  }
  let n = 0
  for (const L of cells.values()) n += L.length
  const offs = new Uint32Array(W * H + 1), z = new Int16Array(n), sid = new Uint8Array(n)
  let o = 0
  for (let k = 0; k < W * H; k++) {
    offs[k] = o
    for (const e of (cells.get(k) ?? []).sort((a, b) => a.z - b.z)) { z[o] = Math.round(e.z); sid[o] = e.sid; o++ }
  }
  offs[W * H] = o
  const header = Buffer.from(JSON.stringify({ v: 1, cell, minX, minY, W, H, n, surfaces }))
  const hl = Buffer.alloc(4); hl.writeUInt32LE(header.length)
  const pad = Buffer.alloc(((4 + header.length + 3) & ~3) - 4 - header.length)
  const bin = Buffer.concat([hl, header, pad, Buffer.from(offs.buffer), Buffer.from(z.buffer), Buffer.from(sid.buffer)])
  return { bin, cell, minX, minY, W, H, n, offs, z }
}

/** je Bodenlage an (Zellmitte, z+40): 6 × RGB8 (+X,−X,+Y,−Y,+Z,−Z) als round(sqrt(v/4)·255) + Sonnen-Sichtbarkeit round(s·255) */
function probeGrid(f: Floor, pr: Probes) {
  const out = new Uint8Array(f.n * 19), o = [0, 0, 0, 0], p = [0, 0, 0]
  const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  for (let cy = 0; cy < f.H; cy++) for (let cx = 0; cx < f.W; cx++) {
    const c = cy * f.W + cx
    for (let l = f.offs[c]; l < f.offs[c + 1]; l++) {
      p[0] = f.minX + (cx + 0.5) * f.cell; p[1] = f.minY + (cy + 0.5) * f.cell; p[2] = f.z[l] + 40
      let k = l * 19
      for (const nrm of N) { pr.sample(p, nrm, o); for (let ch = 0; ch < 3; ch++) out[k++] = Math.min(255, Math.round(Math.sqrt(Math.max(0, o[ch]) / 4) * 255)) }
      out[k] = Math.round(Math.min(1, Math.max(0, o[3])) * 255)
    }
  }
  return out
}

