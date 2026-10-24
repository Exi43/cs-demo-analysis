// Skin-Eingaben (Port von spike/fp/skins prep.mjs): je Paint-Kit Lack-Parameter + Roll-Grenzen, je Waffen-Mesh die
// composite_inputs-Texturen. Farbe/ORM setzt der Renderer daraus zusammen (CS2 macht das zur Laufzeit mit csgo_customweapon.vfx).
// Wege: items_game paint_kits → vcompmat (KV3) → Container 'paint' = Paint-vmat (Legacy) bzw. Vorlage + exposed_params (Community);
// vmdl → Materialien (RERL) → Attribut composite_inputs (DATA). Texturen: VRF -d (PNG/EXR neben der vmat) → WebP lossless, EXR roh.
// Zusätzlich (paint.vars/tex, rolls): alle Parameter so, wie CS2 sie nach den vcompmat-Mutatoren in den Shader gibt (effective()).
// Formeln dazu: build-light-skins/S/formeln.md.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import sharp from 'sharp'
import type { RollVar, SkinInputs, SkinPaint, SkinRoll } from '../../shared/assets3d.ts'
import { kv1, kv3, kvList, vrf, writeAtomic, type KV } from './cs2.ts'
import { gloveJob } from './gloves.ts'
import type { Ctx } from './map.ts'
import { rerl, type Kit } from './models.ts'

/** composite_inputs-vmat je Mesh eines Waffenmodells (Messer haben nur ein Material → nur hd) */
export interface ModelInputs { hd?: string; legacy?: string }

/** Modell → composite_inputs: vmdl → Materialien (RERL) → Attribut composite_inputs (DATA); Legacy-Materialien liegen unter …/v_models/ */
export function modelInputs(c: Ctx, models: string[], work: string): Record<string, ModelInputs> {
  const vmdl = (m: string) => `weapons/models/${m}.vmdl_c`
  const refs = rerl(c, models.map(vmdl), join(work, 'skin_rerl.txt'))
  const mats = [...new Set([...refs.values()].flat().filter(r => r.endsWith('.vmat')))]
  const ci = new Map<string, string>()
  if (mats.length) {
    const f = join(work, 'skin_mat.txt')
    vrf(c.exe, ['-i', c.cs2.pak, '-f', mats.map(r => r + '_c').join(','), '-b', 'DATA'], f)
    for (const p of readFileSync(f, 'utf8').split(/^\[\d+\/\d+\] /m).slice(1)) {
      const v = /m_name = "composite_inputs"\s*m_value = "([^"]+)"/.exec(p)?.[1]
      if (v) ci.set(p.slice(0, p.indexOf('\n')).trim().replace(/_c$/, ''), v)
    }
  }
  return Object.fromEntries(models.map(m => {
    const r: ModelInputs = {}
    for (const mat of refs.get(vmdl(m)) ?? []) { const v = ci.get(mat); if (v) r[mat.startsWith('materials/models/weapons/v_models/') ? 'legacy' : 'hd'] ??= v }
    return [m, r]
  }))
}

/** vcompmat eines Kits; Regel trifft 1478 von 1479 Kits (Patch 2000933), Pfade im VPK klein */
export const kitVcompmat = (k: Kit, glove: boolean) => (k.vcompmat ?? `${glove ? 'gloves/paints' : 'weapons/paints/legacy'}/${k.name}.vcompmat`).toLowerCase()
/** Datei für composite_inputs im Cache (Basisname ist eindeutig: Legacy 'rif_ak47_…', HD 'weapon_rif_ak47_…', Messer 'knife_…') */
export const inputsFile = (vmat: string) => `${basename(vmat, '.vmat')}.json`
const SHARED = 'weapons/paints/legacy/_shared_paint_generic.vcompmat'

// ---------------------------------------------------------------- Parser (dekompilierte vmat = KV1 "Layer0", vcompmat = KV3)

type Layer = Record<string, string | KV>
const layer = (text: string): Layer => Object.fromEntries(kvList(kv1(text), 'Layer0'))
const vec = (s: unknown) => String(s ?? '').replace(/[[\]]/g, ' ').trim().split(/\s+/).map(Number)
const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
/** VRF legt Texturen mit dem Quell-Basisnamen neben die vmat; '[r g b a]' = Farbwert statt Textur */
const texOf = (vmat: string, m: Layer, k: string) => typeof m[k] === 'string' && m[k] && !(m[k] as string).startsWith('[') ? `${dirname(vmat)}/${basename(m[k] as string)}` : undefined
const compiled = (vmat: string, m: Layer, k: string, ext: string) => {
  const ct = Array.isArray(m['Compiled Textures']) ? Object.fromEntries(m['Compiled Textures']) : {}
  return typeof ct[k] === 'string' ? `${dirname(vmat)}/${basename(ct[k]).replace(/\.vtex$/, ext)}` : undefined
}

/** Container aller Punkte/Prozeduren eines vcompmat */
export const containers = (doc: any): any[] =>
  (doc?.m_Points ?? []).flatMap((p: any) => (p.m_vecCompositeMaterialAssemblyProcedures ?? []).flatMap((q: any) => q.m_vecCompositeInputContainers ?? []))
const looseVars = (cs: any[], alias: string): any[] => cs.find(c => c.m_strAlias === alias)?.m_vecLooseVariables ?? []
const rollVar = (cs: any[], alias: string, name: string): RollVar | null => {
  const v = looseVars(cs, alias).find(x => x.m_strName === name)
  return v ? { x: v.m_flValueFloatX ?? v.m_nValueIntX, xmin: v.m_flValueFloatX_Min, xmax: v.m_flValueFloatX_Max, y: v.m_flValueFloatY, ymin: v.m_flValueFloatY_Min, ymax: v.m_flValueFloatY_Max } : null
}

/** Port prep.mjs inputs(): composite_inputs-vmat → Texturen + Maße */
export function inputsRecipe(vmat: string, m: Layer): SkinInputs {
  const sep = m.F_SEPARATE_CHANNEL_INPUTS === '1', t = (k: string) => texOf(vmat, m, k)
  return {
    separate: sep, weaponLength: +(m.g_flWeaponLength1 ?? 36), uvScale: +(m.g_flUvScale1 ?? 1),
    // gepackt: RGBA-AO-Datei (R Cavity, G AO, A NoPaint); getrennt: kompilierte RGBA-Textur
    ao: sep ? compiled(vmat, m, 'g_tAmbientOcclusion', '.png') : t('TextureAmbientOcclusion1'),
    masks: t('TextureMasks1'), surface: t('TextureSurface1'), color: t('TextureColor1'), rough: t('TextureRoughness1'), metal: t('TextureMetalness1'),
    pos: compiled(vmat, m, 'g_tPosition', '.exr'),
  }
}
/** Zahlen-Parameter einer vmat (Layer0, Name wie im vmat; Skalar = [x]) */
const numVars = (m: Layer) => Object.fromEntries(Object.entries(m).filter((e): e is [string, string] => typeof e[1] === 'string' && !e[0].startsWith('Texture') && /^\s*\[?\s*-?[\d.]/.test(e[1])).map(([k, v]) => [k, vec(v)]))

/** Port prep.mjs paint(): Paint-vmat (csgo_customweapon) → Lack-Parameter; Farben sRGB → linear wie die vfx-Expression */
export function paintRecipe(vmat: string, m: Layer): SkinPaint {
  const f = (k: string, d: number) => (typeof m[k] === 'string' ? +m[k] : d)
  const style = f('F_PAINT_STYLE', 0), t = (k: string) => texOf(vmat, m, k)
  const col = (k: string, d: number[]) => (m[k] ? vec(m[k]).slice(0, 3) : d).map(srgbToLin) as [number, number, number]
  return {
    style, roughnessTexture: f('F_ROUGHNESS_TEXTURE', 0) === 1, roughnessPerColor: f('F_ROUGHNESS_PER_COLOR', 0) === 1,
    halftone: f('F_SPRAYPAINT_HALFTONE', 0) === 1, useAllMasks: f('F_USE_ALL_MASKS', 0) === 1, ignoreWeaponSizeScale: f('g_bIgnoreWeaponSizeScale', 0) === 1,
    colors: [col('g_vColor0', [0.5, 0.5, 0.5]), col('g_vColor1', [0.59, 0.59, 0.59]), col('g_vColor2', [0.38, 0.38, 0.38]), col('g_vColor3', [0.42, 0.42, 0.42])],
    colorBrightness: f('g_flColorBrightness', 1), colorAdjustmentMode: f('g_nColorAdjustmentMode', 1),
    paintRoughness: f('g_flPaintRoughness', style === 4 || style === 5 ? 0.2 : 0.6),
    paintRoughness4: m.g_vPaintRoughness ? vec(m.g_vPaintRoughness) : [0.6, 0.6, 0.6, 0.6],
    paintMetalness: f('g_flPaintMetalness', 0), paintMetalness4: m.g_vPaintMetalness ? vec(m.g_vPaintMetalness) : [0, 0, 0, 0],
    durability: (m.g_vPaintDurability ? vec(m.g_vPaintDurability) : [0, 0, 0, 0]).map(v => 1 - v), // Expression(1-this)
    wearSoftness: f('g_fWearSoftness', 0), pearlescent: f('g_flPearlescentScale', 0), pearlescentOnMetallicOnly: f('g_bPearlescentOnMetallicOnly', 0) === 1,
    sprayBiasBlend: [f('g_bBiasSpray', 0) ? 1 : 0, ...(m.g_vSprayBlend ? vec(m.g_vSprayBlend).slice(0, 2) : [1, 1])],
    patternScale: f('g_flPatternTexCoordScale', 1), patternRotation: f('g_flPatternTexCoordRotation', 0),
    patternOffset: m.g_vPatternTexCoordOffset ? vec(m.g_vPatternTexCoordOffset).slice(0, 2) : [0, 0],
    wearScale: f('g_flWearTexCoordScale', 1), grungeScale: f('g_flGrungeTexCoordScale', 1),
    samplingU: f('g_nPatternTextureHorizontalSampling', 0), samplingV: f('g_nPatternTextureVerticalSampling', 0),
    roughnessUsesPatternUVs: f('g_bRoughnessUsesPatternUVs', 1) === 1,
    textures: { pattern: t('TexturePattern'), wear: t('TextureWear'), grunge: t('TextureGrunge'), paintRough: t('TexturePaintRoughness'), normal: t('TextureNormal') },
  }
}

/** Port prep.mjs communityPaint(): Vorlage-vmat + exposed_params (Farben 0–255 sRGB, Texturen als vtex → '<pfad>.png') */
export function communityPaint(p: SkinPaint, exposed: any[]): SkinPaint {
  const vars: Record<string, any> = {}
  for (const v of exposed) vars[v.m_strName] = v.m_cValueColor4 ?? v.m_strTextureRuntimeResourcePath ?? v.m_flValueFloatX ?? v.m_bValueBoolean
  const png = (vtex: unknown) => typeof vtex === 'string' ? vtex.replace(/\.vtex$/, '.png') : undefined
  for (let i = 0; i < 4; i++) if (Array.isArray(vars[`g_vColor${i}`])) p.colors[i] = vars[`g_vColor${i}`].slice(0, 3).map((c: number) => srgbToLin(c / 255))
  if (vars.g_flPatternTexCoordScale !== undefined) p.patternScale = vars.g_flPatternTexCoordScale
  if (vars.g_flPaintRoughness !== undefined) p.paintRoughness = vars.g_flPaintRoughness
  if (vars.g_flPearlescentScale !== undefined) p.pearlescent = vars.g_flPearlescentScale
  if (vars.g_bIgnoreWeaponSizeScale !== undefined) p.ignoreWeaponSizeScale = !!vars.g_bIgnoreWeaponSizeScale
  p.textures.pattern = png(vars.g_tPattern) ?? p.textures.pattern
  p.roughnessTexture = !!(vars.g_bUseRoughness && vars.g_tPaintRoughness)
  p.textures.paintRough = p.roughnessTexture ? png(vars.g_tPaintRoughness) : undefined
  p.textures.normal = vars.g_bUseNormalMap ? png(vars.g_tNormal) : undefined // ersetzt die Waffen-Normal-Map
  p.textures.masks = vars.g_bOverrideDefaultMasks ? png(vars.g_tPaintByNumberMasks) : undefined // ersetzt die composite_inputs-Masken
  return p
}

// ---------------------------------------------------------------- Effektive Parameter (vcompmat-Mutatoren wie CS2 nachgespielt)

/** Zahlen bzw. Textur = Pfad der von VRF exportierten Datei (relativ zum Export-Ordner) */
type Val = number[] | string
type Cont = Map<string, Val>
export interface Effective { vars: Record<string, number[]>; tex: Record<string, string>; rolls: [string, RollVar][]; vtex: string[] }

/** VRF -d einer vtex schreibt <pfad>.png, Float-Texturen (_pfm_) als .exr */
const vtexOut = (p: string) => p.replace(/\.vtex$/, /_pfm_/.test(p) ? '.exr' : '.png')
/** Platzhalter des Materialsystems (konstant, nicht exportiert) */
const isDefault = (p: string) => p.startsWith('materials/default/')
/** Standard-Wear/-Grunge (Shader-Vorgabe bzw. von Community-Kits genannt): immer einmal exportieren */
const WG = 'materials/models/weapons/customization/shared/'
export const SHARED_WEAR_GRUNGE = ['paint_wear_psd_a2abffd8', 'paint_wear_psd_19141e79', 'paint_wear_psd_41a616da', 'paint_wear_2_psd_924faa2f', 'paint_wear_2_psd_de1520a7',
  'paint_wear_3_psd_39dc8b2b', 'paint_wear_3_psd_e875a510', 'paint_wear_extreme_psd_2d6de788', 'paint_wear_extreme_psd_5d328426', 'paint_wear_extreme_psd_beb76e34',
  'gun_grunge_psd_66b72907', 'gun_grunge_psd_f3419fed', 'gun_grunge_smooth_psd_fc498665'].map(n => `${WG}${n}.vtex`)
/** Shader-Vorgabe von csgo_customweapon (kompilierte g_tWear/g_tGrunge einer vmat ohne TextureWear/-Grunge, z. B. so_sand) */
export const DEFAULT_WEAR = `${WG}paint_wear_psd_a2abffd8.vtex`, DEFAULT_GRUNGE = `${WG}gun_grunge_psd_f3419fed.vtex`

/** Loose-Variable → Wert; Farben 0–255 → 0–1 wie im vmat (sRGB, vor der vfx-Expression) */
function looseVal(v: any): Val | undefined {
  const t = String(v?.m_nVariableType ?? ''), n = +(/(\d)$/.exec(t)?.[1] ?? 1), ax = ['X', 'Y', 'Z', 'W'].slice(0, n)
  if (t.endsWith('RESOURCE_TEXTURE')) return typeof v.m_strTextureRuntimeResourcePath === 'string' && v.m_strTextureRuntimeResourcePath ? v.m_strTextureRuntimeResourcePath : undefined
  if (t.endsWith('COLOR4')) return Array.isArray(v.m_cValueColor4) ? v.m_cValueColor4.map((c: number) => c / 255) : undefined
  if (t.endsWith('BOOLEAN')) return [v.m_bValueBoolean ? 1 : 0]
  if (t.includes('FLOAT')) return ax.map(a => v[`m_flValueFloat${a}`] ?? 0)
  if (t.includes('INTEGER')) return ax.map(a => v[`m_nValueInt${a}`] ?? 0)
  return undefined
}
const rollOf = (v: any): RollVar => ({ x: v.m_flValueFloatX ?? v.m_nValueIntX, xmin: v.m_flValueFloatX_Min, xmax: v.m_flValueFloatX_Max, y: v.m_flValueFloatY, ymin: v.m_flValueFloatY_Min, ymax: v.m_flValueFloatY_Max })

/** Paint-vmat (Layer0) → Container: Zahlen, Texturen g_t<Name> (Quelle neben der vmat; nur Farbwert → kompilierte vtex = Shader-Vorgabe) */
function vmatCont(vmat: string, m: Layer): Cont {
  const c: Cont = new Map(Object.entries(numVars(m)))
  const ct: Record<string, string> = Array.isArray(m['Compiled Textures']) ? Object.fromEntries(m['Compiled Textures'] as KV) as Record<string, string> : {}
  // Texture…1 = composite_inputs (je Waffe); Quelle materials/default/… = Platzhalter (VRF legt ihn nicht immer neben die vmat)
  for (const k of Object.keys(m)) if (/^Texture\D+$/.test(k) && !isDefault(String(m[k]))) { const t = texOf(vmat, m, k); if (t) c.set(`g_t${k.slice(7)}`, t) }
  for (const [g, p] of Object.entries(ct)) if (!c.has(g) && typeof p === 'string') c.set(g, p)
  return c
}

/**
 * Effektive Parameter eines Waffen-Kits: Container (Kit über Include, je Variable) + Mutatoren wie CS2. vars/tex = Compositing-Pass
 * (GENERATE_TEXTURE g_tColor; was nur der g_tMetalness-Pass setzt, z. B. F_ROUGHNESS_TEXTURE, kommt dazu), 'final.<Name>' = Kopien ins
 * Laufzeit-Material (Perlglanz, Iridescence, Glitter, AO-Override, Normal). target/target_instance/composite_inputs gibt es erst je Waffe →
 * übersprungen (inputs). rolls = RANDOM_ROLL in Würfel-Reihenfolge; Achsen laut Swizzle; Variable fehlt → Festwert aus vars (verbraucht
 * wie rollSeed einen Wurf, in CS2 unbestätigt). Texturen: vtex (exposed/Shader-Vorgabe) → vtexOut, sonst Datei neben der vmat.
 */
export function effective(docs: any[], vmat: string, m: Layer): Effective {
  const procs = docs.flatMap(d => (d?.m_Points ?? []).flatMap((p: any) => p.m_vecCompositeMaterialAssemblyProcedures ?? []))
  const raw = new Map<string, Map<string, any>>(), conts = new Map<string, Cont>()
  for (const c of procs.flatMap((q: any) => q.m_vecCompositeInputContainers ?? [])) for (const v of c.m_vecLooseVariables ?? []) {
    if (!raw.has(c.m_strAlias)) raw.set(c.m_strAlias, new Map())
    raw.get(c.m_strAlias)!.set(v.m_strName, v) // docs: Include zuerst, Kit danach → Kit gewinnt je Variable
  }
  for (const [a, vs] of raw) conts.set(a, new Map([...vs].flatMap(([n, v]) => { const x = looseVal(v); return x === undefined ? [] : [[n, x] as [string, Val]] })))
  const paint = vmatCont(vmat, m)
  conts.set('paint', paint)
  const same = (a?: Val, b?: Val) => JSON.stringify(a) === JSON.stringify(b)
  const ok = (mu: any) => (mu.m_vecConditions ?? []).every((c: any) => {
    const v = conts.get(c.m_strMutatorConditionContainerName)?.get(c.m_strMutatorConditionContainerVarName), want = String(c.m_strMutatorConditionContainerVarValue)
    if (String(c.m_nMutatorCondition).endsWith('VALUE_EXISTS')) return v !== undefined
    return v !== undefined && (typeof v === 'string' ? v === want : v[0] === (want === 'true' ? 1 : want === 'false' ? 0 : +want))
  })
  const apply = (list: any[], out: Cont) => {
    for (const mu of list) {
      const t = String(mu.m_nMutatorCommandType).replace('COMP_MAT_PROPERTY_MUTATOR_', '')
      if (!ok(mu)) continue
      if (t === 'COPY_MATCHING_KEYS') for (const [k, v] of conts.get(mu.m_strCopyMatchingKeys_InputContainerSrc) ?? []) out.set(k, v)
      else if (t === 'COPY_PROPERTY') { const v = conts.get(mu.m_strCopyProperty_InputContainerSrc)?.get(mu.m_strCopyProperty_InputContainerProperty); if (v !== undefined) out.set(mu.m_strCopyProperty_TargetProperty, v) }
      else if (t === 'SET_VALUE') { const v = looseVal(mu.m_nSetValue_Value); if (v !== undefined) out.set(mu.m_nSetValue_Value.m_strName, v) }
    }
  }
  const muts = procs.flatMap((q: any) => q.m_vecPropertyMutators ?? [])
  const gen = (p: string) => new Map([...paint, ...(() => { const o: Cont = new Map(); apply(muts.find((x: any) => x.m_strGenerateTexture_TargetParam === p)?.m_vecTexGenInstructions ?? [], o); return o })()])
  const col = gen('g_tColor'), met = gen('g_tMetalness'), fin: Cont = new Map()
  for (const [k, v] of met) if (k !== 'F_ROUGHNESS_MODE' && !same(v, paint.get(k)) && same(col.get(k), paint.get(k))) col.set(k, v)
  apply(muts.filter((x: any) => !/GENERATE_TEXTURE|INIT|CONDITIONAL/.test(x.m_nMutatorCommandType)), fin)
  const vars: Record<string, number[]> = {}, tex: Record<string, string> = {}, vtex = new Set<string>()
  const put = (k: string, v: Val) => {
    if (Array.isArray(v)) { if (!/^(g_nRandomSeed|g_flWearAmount|g_flUvScale1|g_flWeaponLength1|MaterialLayerReferenceShaderId_\d+)$/.test(k)) vars[k] = v; return }
    if (isDefault(v)) return
    if (v.endsWith('.vtex')) { vtex.add(v); tex[k] = vtexOut(v) } else tex[k] = v
  }
  for (const [k, v] of col) put(k, v)
  for (const [k, v] of fin) put(`final.${k}`, v)
  const rolls: [string, RollVar][] = []
  for (const mu of muts.flatMap((x: any) => [x, ...(x.m_vecConditionalMutators ?? [])]).filter((x: any) => /RANDOM_ROLL/.test(x.m_nMutatorCommandType) && ok(x)))
    for (const s of mu.m_vecRandomRollInputVars_InputVarsToRoll ?? []) {
      const [a, n, sw = 'x'] = String(s).split('.'), lv = raw.get(a)?.get(n), fb = col.get(n)
      const r: RollVar = lv ? rollOf(lv) : { x: Array.isArray(fb) ? fb[0] : 0, y: Array.isArray(fb) ? fb[1] ?? 0 : 0 }
      if (sw.length < 2) { delete r.y; delete r.ymin; delete r.ymax }
      rolls.push([n, r])
    }
  return { vars, tex, rolls, vtex: [...vtex] }
}

// ---------------------------------------------------------------- Bau

export interface KitNeed { paint: number; kit: Kit; glove: boolean }
interface Job { files: string[]; finish: (out: string) => Promise<void> }

/**
 * Fehlende Kits (skins/kits/<paint>.json) und composite_inputs (skins/inputs/<name>.json) bauen; Texturen nach skins/tex/<VRF-Pfad>.
 * VRF: 1× alle vcompmat (KV3, < 1 s), dann Paint-/Inputs-vmats samt Texturen in Gruppen zu ≤ 12 Dateien (PNG bis 15 MB je Textur,
 * C: ist knapp), je Gruppe konvertieren und den Export löschen. Handschuhe (alt + neu) baut gloveJob (gloves.ts); Kits ohne vmat → {unsupported}.
 */
export async function buildSkins(c: Ctx, root: string, work: string, kits: KitNeed[], inputs: string[]) {
  const dir = join(root, 'skins')
  for (const d of ['kits', 'inputs']) mkdirSync(join(dir, d), { recursive: true })
  const texDst = (rel: string) => `skins/tex/${rel.endsWith('.exr') ? rel : rel.replace(/\.\w+$/, '.webp')}`
  const conv = async (out: string, rel: string | undefined, max = 1024, lossy = false) => {
    if (!rel) return undefined
    const dst = texDst(rel), abs = join(root, dst), src = join(out, rel)
    // shortcut: gleicher Basisname aus verschiedenen Quellordnern landet bei VRF in derselben Datei; selten, dann gewinnt der erste
    if (existsSync(abs)) return dst
    if (!existsSync(src)) { console.warn('skin texture missing:', rel); return undefined }
    mkdirSync(dirname(abs), { recursive: true })
    if (rel.endsWith('.exr')) { copyFileSync(src, abs); return dst }
    const fit = (s: ReturnType<typeof sharp>) => s.resize(max, max, { fit: 'inside', withoutEnlargement: true })
    const raw = async (s: ReturnType<typeof sharp>) => { const { data, info } = await s.raw().toBuffer({ resolveWithObject: true }); return { data, raw: { width: info.width, height: info.height, channels: info.channels } } }
    // sharp premultipliziert Alpha beim Verkleinern (auch mit removeAlpha): RGB unter A = 0 wären danach schwarz (Legacy-Farbe
    // smg_mac10_1_color hat A ≈ 0 → unlackierte Teile schwarz statt grau). Darum Farbe ohne Alpha erst roh lesen, dann getrennt skalieren.
    const { channels = 3, hasAlpha } = await sharp(src).metadata()
    let img = fit(sharp(src))
    if (hasAlpha) {
      const c = await raw(sharp(src).removeAlpha())
      const [col, a] = await Promise.all([raw(fit(sharp(c.data, { raw: c.raw }))), raw(fit(sharp(src).extractChannel((channels - 1) as 0 | 1 | 2 | 3)))])
      img = sharp(col.data, { raw: col.raw }).joinChannel(a.data, { raw: a.raw })
    }
    // lossless: Masken/AO/Metall sind Daten je Kanal, verlustbehaftetes WebP (4:2:0) würde sie vermischen; lossy nur für sRGB-Bildinhalt
    writeAtomic(abs, await img.webp({ ...(lossy ? { quality: 90 } : { lossless: true }), exact: true }).toBuffer()) // exact: RGB unter A = 0 sind Daten (AO-Datei: A = NoPaint)
    return dst
  }
  const jobs: Job[] = []

  // ---- Kits: vcompmat in einem Aufruf
  if (kits.length) {
    const out = join(work, 'vcompmat'); mkdirSync(out, { recursive: true })
    const files = [...new Set([...kits.map(k => kitVcompmat(k.kit, k.glove)), ...(kits.some(k => !k.glove) ? [SHARED] : [])])]
    vrf(c.exe, ['-i', c.cs2.pak, '-d', '-f', files.map(f => f + '_c').join(','), '-o', out], c.log)
    const read = (f: string) => { try { return kv3(readFileSync(join(out, f), 'utf8')) } catch { return null } }
    const sharedDoc = read(SHARED), shared = containers(sharedDoc)
    // Standard-Wear/-Grunge einmal (Kits ohne eigene Textur zeigen sonst keinen Verschleiß bzw. bleiben Vanilla)
    const std = SHARED_WEAR_GRUNGE.filter(v => !existsSync(join(root, texDst(vtexOut(v)))))
    if (kits.some(k => !k.glove) && std.length) jobs.push({ files: std, finish: async o => { for (const v of std) await conv(o, vtexOut(v), 1024, v.includes('grunge')) } })
    for (const k of kits) {
      const doc = read(kitVcompmat(k.kit, k.glove)), cs: any[] | null = doc ? containers(doc) : null, file = join(dir, 'kits', `${k.paint}.json`)
      // Handschuhe alt + neu (glove_compositor): eigener Export-Schritt (gloves.ts); fehlende vcompmat → Standard
      if (k.glove) {
        const j = doc && gloveJob(c, doc, work, conv, kit => writeAtomic(file, JSON.stringify(kit)))
        if (j) jobs.push(j); else writeAtomic(file, JSON.stringify({ unsupported: true }))
        continue
      }
      const vmat: string | undefined = cs?.find(x => x.m_strAlias === 'paint' && x.m_strSpecificContainerMaterial)?.m_strSpecificContainerMaterial
      if (!cs || !vmat) { writeAtomic(file, JSON.stringify({ unsupported: true })); continue }
      const exposed = looseVars(cs, 'exposed_params')
      const vtex = exposed.map(v => v.m_strTextureRuntimeResourcePath).filter((p): p is string => typeof p === 'string' && !p.startsWith('materials/default/'))
      jobs.push({ files: [vmat, ...vtex], finish: async out2 => {
        const src = join(out2, vmat)
        if (!existsSync(src)) { console.warn('paint material missing:', vmat); return }
        const m = layer(readFileSync(src, 'utf8'))
        const p = exposed.length ? communityPaint(paintRecipe(vmat, m), exposed) : paintRecipe(vmat, m)
        const eff = effective(JSON.stringify(doc).includes('_shared_paint_generic') ? [sharedDoc, doc] : [doc], vmat, m)
        // Wear/Grunge wie CS2 (exposed_params bzw. kompilierte Shader-Vorgabe der vmat), sonst Standard: kein Kit ohne Wear-Textur
        p.textures.wear = eff.tex.g_tWear ?? vtexOut(DEFAULT_WEAR); p.textures.grunge = eff.tex.g_tGrunge ?? vtexOut(DEFAULT_GRUNGE)
        for (const [key, rel] of Object.entries(p.textures) as [keyof SkinPaint['textures'], string | undefined][]) {
          const art = key === 'pattern' && p.style >= 6 // Custom-Paint-Muster ist sRGB-Bildinhalt (skins.mjs patternSrgb)
          p.textures[key] = await conv(out2, rel, art ? 2048 : 1024, art || key === 'grunge')
        }
        const own = (a: string, n: string) => rollVar(cs, a, n) ?? rollVar(shared, a, n)
        const roll: SkinRoll = {
          patternOffset: own('econ_instance', 'g_vPatternTexCoordOffset'), patternRotation: own('econ_instance', 'g_flPatternTexCoordRotation'),
          wearScale: own('grunge_wear', 'g_flWearTexCoordScale'), wearOffset: own('grunge_wear', 'g_vWearTexCoordOffset'), wearRotation: own('grunge_wear', 'g_flWearTexCoordRotation'),
          grungeScale: own('grunge_wear', 'g_flGrungeTexCoordScale'), grungeOffset: own('grunge_wear', 'g_vGrungeTexCoordOffset'), grungeRotation: own('grunge_wear', 'g_flGrungeTexCoordRotation'),
        }
        // Zusatz-Texturen: Overlay ist Bildinhalt wie Custom-Muster; Quelle fehlt im Export (kompilierte vtex ohne Quelle neben der vmat) → Folge-Job
        const art = (k: string) => k === 'g_tOverlay' || (k === 'g_tPattern' && p.style >= 6)
        const texAll = async (o: string, keys: string[]) => { for (const k of keys) { const d = await conv(o, eff.tex[k], art(k) ? 2048 : 1024, art(k) || /Grunge$/.test(k)); if (d) eff.tex[k] = d; else delete eff.tex[k] } }
        const write = () => writeAtomic(file, JSON.stringify({ kind: 'weapon', paint: { ...p, vars: eff.vars, tex: eff.tex }, roll, rolls: eff.rolls }))
        const here = Object.keys(eff.tex).filter(k => existsSync(join(out2, eff.tex[k])) || existsSync(join(root, texDst(eff.tex[k]))))
        await texAll(out2, here)
        const later = Object.keys(eff.tex).filter(k => !here.includes(k)), vt = eff.vtex.filter(v => later.some(k => eff.tex[k] === vtexOut(v)))
        if (vt.length) jobs.push({ files: vt, finish: async o => { await texAll(o, later); write() } })
        else { await texAll(out2, later); write() }
      } })
    }
  }

  // ---- composite_inputs je Waffen-Mesh
  for (const vmat of inputs) jobs.push({ files: [vmat], finish: async out2 => {
    const src = join(out2, vmat)
    if (!existsSync(src)) { console.warn('composite inputs missing:', vmat); return }
    const m = layer(readFileSync(src, 'utf8')), r: SkinInputs = { ...inputsRecipe(vmat, m), vars: numVars(m) }, ao = r.ao
    const write = () => writeAtomic(join(dir, 'inputs', inputsFile(vmat)), JSON.stringify(r))
    for (const key of ['masks', 'surface', 'color', 'rough', 'metal', 'pos'] as const) r[key] = await conv(out2, r[key], 1024, key === 'color')
    // getrennte Kanäle: die kompilierte RGBA-AO (R Cavity, G AO, A NoPaint) schreibt VRF nur beim Export der vtex selbst → Folge-Job
    if (r.separate && ao && !existsSync(join(out2, ao))) jobs.push({ files: [ao.replace(/\.png$/, '.vtex')], finish: async o => { r.ao = await conv(o, ao); write() } })
    else { r.ao = await conv(out2, ao); write() }
  } })

  // ---- vmats + Texturen in Gruppen
  for (let i = 0, n = 0; i < jobs.length; n++) {
    const batch: Job[] = []
    for (let f = 0; i < jobs.length && (!batch.length || f + jobs[i].files.length <= 12); i++) { batch.push(jobs[i]); f += jobs[i].files.length }
    c.step(i / jobs.length, 'Exporting skin textures')
    const out = join(work, `skin${n}`); mkdirSync(out, { recursive: true })
    vrf(c.exe, ['-i', c.cs2.pak, '-d', '--game', c.cs2.gi, '-f', [...new Set(batch.flatMap(j => j.files))].map(f => f + '_c').join(','), '-o', out], c.log)
    for (const j of batch) await j.finish(out)
    rmSync(out, { recursive: true, force: true })
  }
}
