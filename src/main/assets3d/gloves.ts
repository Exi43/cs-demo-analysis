// Handschuh-Skins (csgo_customglove.vfx, Formeln: renderer engine/gloves.ts). Rezept je Kit aus der vcompmat:
// alt (72 Kits): Container 'paint' = Handschuh-vmat (SPECIFIC_MATERIAL), Würfe aus gloves/paints/_shared_paint_generic.vcompmat;
// neu (22 Kits, Ordner volatile_02): Container 'paint' = loose variable m_strResourceMaterial (Kit-vmat, csgo_customglove_preview), Compositor
// workshop/paintkits/templates/glove_compositor.vmat (csgo_customglove mit F_BACKWARDS_COMPATIBILITY), Würfe aus instance_params.
// Texturen: die KOMPILIERTEN vtex der vmat, roh exportiert (VRF --texture_decode_flags none): Hemi-Oct-Normalen, gepackte Eigenschaften
// (Neu: SurfaceNormal = x/z Rauheit, y/w Normale; Properties = AO, Metall, Stoff, Höhe) genau wie der Shader sie liest. Die zerlegten
// Quellbilder der vmat passen dafür nicht (VRF dekodiert Normalen und teilt gepackte Kanäle auf).
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { GloveSkin, GloveSkin2, RollVar } from '../../shared/assets3d.ts'
import { kv1, kvList, vrf, type KV } from './cs2.ts'
import type { Ctx } from './map.ts'

type Layer = Record<string, string | KV>
/** wie buildSkins conv: Datei rel aus out → skins/tex/<rel>.webp (lossless, ≤ max), undefined = fehlt */
export type GloveConv = (out: string, rel: string | undefined, max?: number) => Promise<string | undefined>
export interface GloveJob { files: string[]; finish: (out: string) => Promise<void> }
export type GloveKit = GloveSkin | GloveSkin2 | { unsupported: true }

const vec = (s: unknown) => String(s ?? '').replace(/[[\]]/g, ' ').trim().split(/\s+/).map(Number)
const containers = (doc: any): any[] =>
  (doc?.m_Points ?? []).flatMap((p: any) => (p.m_vecCompositeMaterialAssemblyProcedures ?? []).flatMap((q: any) => q.m_vecCompositeInputContainers ?? []))
const mutators = (doc: any): any[] =>
  (doc?.m_Points ?? []).flatMap((p: any) => (p.m_vecCompositeMaterialAssemblyProcedures ?? []).flatMap((q: any) => q.m_vecPropertyMutators ?? []))
const looseVar = (cs: any[], alias: string, name: string) => cs.find(c => c.m_strAlias === alias)?.m_vecLooseVariables?.find((v: any) => v.m_strName === name)
const rollVar = (v: any): RollVar | null =>
  v ? { x: v.m_flValueFloatX ?? v.m_nValueIntX, xmin: v.m_flValueFloatX_Min, xmax: v.m_flValueFloatX_Max, y: v.m_flValueFloatY, ymin: v.m_flValueFloatY_Min, ymax: v.m_flValueFloatY_Max } : null

/** vmat des Kits: alt = SPECIFIC_MATERIAL 'paint', neu = loose variable m_strResourceMaterial im Container 'paint' */
export function gloveVmat(doc: any): string | undefined {
  const p = containers(doc).find(c => c.m_strAlias === 'paint')
  return p?.m_strSpecificContainerMaterial ?? p?.m_vecLooseVariables?.find((v: any) => v.m_strName === 'm_strResourceMaterial')?.m_strResourceMaterial
}

/** alle Zahlen-Parameter der vmat (Name wie im vmat, Skalar = [x]); Quell-Texturen (Texture*) und Blöcke nicht */
function vars(m: Layer): Record<string, number[]> {
  const out: Record<string, number[]> = {}
  for (const [k, v] of Object.entries(m)) if (typeof v === 'string' && /^(g_|F_)/.test(k) && v !== '') { const n = vec(v); if (n.every(Number.isFinite)) out[k] = n }
  return out
}

// Würfe der alten Kits: _shared_paint_generic.vcompmat (gloves/paints) RANDOM_ROLL mit econ_instance.g_nRandomSeed, Material ohne seed_offset:
// Muster-Versatz xy, Muster-Drehung, Grunge-Versatz xy, Grunge-Drehung. Die Kit-vcompmat überschreibt nur Werte/Grenzen (nie Grunge, 72/72 geprüft).
const SHARED_ROLL: Record<string, RollVar> = {
  g_fPatternTexCoordOffset: { x: 0, xmin: 0, xmax: 1, y: 0, ymin: 0, ymax: 1 },
  g_fPatternTexCoordRotation: { x: 0, xmin: 0, xmax: 360 },
}

/** alter Handschuh: Felder wie bisher (heutiger Renderer liest sie weiter) + vars (alle Zahlen) + tex (g_t* → skins/tex/…) */
export function gloveKit(m: Layer, doc: any, tex: Record<string, string>): GloveSkin {
  const f = (k: string, d: number) => (typeof m[k] === 'string' ? +m[k] : d), cs = containers(doc)
  const own = (n: string) => rollVar(looseVar(cs, 'instance_params', n)) ?? SHARED_ROLL[n]
  const pattern = m.F_PATTERN === '1'
  return {
    kind: 'glove', mask: tex.g_tLayerMask, pattern: pattern ? tex.g_tPattern : undefined, surface: tex.g_tSurface,
    details: [1, 2, 3, 4].map(i => tex[`g_tDetail${i}`] ?? null), tints: [1, 2, 3, 4, 5, 6, 7, 8].map(i => vec(m[`g_vColorTint${i}`] ?? '0 0 0').slice(0, 3) as [number, number, number]),
    palette: m.g_vPatternPaletteIndices ? vec(m.g_vPatternPaletteIndices).slice(0, 4) : [1, 1, 1, 1], replaceIndex: f('g_nPatternReplaceIndex', 1), usePattern: pattern,
    patternScale: f('g_fPatternTexCoordScale', 1), patternRotation: f('g_fPatternTexCoordRotation', 0), detailScale: [1, 2, 3, 4].map(i => f(`g_fDetailScale${i}`, 1)),
    roll: { patternOffset: own('g_fPatternTexCoordOffset'), patternRotation: own('g_fPatternTexCoordRotation') },
    vars: vars(m), tex,
  }
}

/**
 * Würfe der neuen Kits in Würfel-Reihenfolge: der RANDOM_ROLL mit econ_instance.g_nRandomSeed, der ohne seed_offset gilt (13 Kits: UvOffset1–4,
 * Muster, Damage, Grime; 13 Kits mit Sync-Schaltern: Muster zuerst). Ziel 'g_vUvOffset1.xy' → Name + Komponenten, Grenzen aus instance_params.
 */
function rolls2(doc: any): [string, RollVar][] {
  const cs = containers(doc)
  const main = mutators(doc).find(x => x.m_nMutatorCommandType === 'COMP_MAT_PROPERTY_MUTATOR_RANDOM_ROLL_INPUT_VARIABLES' && x.m_strRandomRollInputVars_SeedInputVar === 'econ_instance.g_nRandomSeed'
    && (x.m_vecConditions ?? []).some((c: any) => c.m_strMutatorConditionContainerName === 'material_seed' && c.m_bPassWhenTrue === false))
  return (main?.m_vecRandomRollInputVars_InputVarsToRoll ?? []).map((s: string) => {
    const [, name, comp] = /^instance_params\.(\w+)\.(\w+)$/.exec(s) ?? []
    const r = rollVar(looseVar(cs, 'instance_params', name)) ?? { x: 0 }
    return [name, comp === 'x' ? { x: r.x, xmin: r.xmin, xmax: r.xmax } : r] as [string, RollVar]
  })
}

/** neuer Handschuh (glove_compositor): vars = Kit-vmat (Compositor-Defaults stehen im Shader), tex = kompilierte Texturen, rolls = instance_params */
export const gloveKit2 = (m: Layer, doc: any, tex: Record<string, string>): GloveSkin2 => ({ kind: 'glove2', vars: vars(m), tex, rolls: rolls2(doc) })

/** Layer-Farben, deren Mittelwert die Farbanpassung der neuen Kits braucht (g_m*ColorAdjust = MatrixColorCorrect2(…, TextureAverageColor(t))) */
const AVG = [1, 2, 3, 4].flatMap(i => [`g_tSurface${i}`, `g_tSubstrate${i}`])
const LIN = Array.from({ length: 256 }, (_, i) => (i <= 10 ? i / 255 / 12.92 : ((i / 255 + 0.055) / 1.055) ** 2.4))

/**
 * TextureAverageColor der vfx = Reflectivity der vtex: Mittel der linearen Farbe (sRGB-Textur), A linear. Aus dem PNG gerechnet
 * (gegen die Reflectivity von leather_top_grain_white_color geprüft: Abweichung < 0,003).
 */
export async function textureAverage(file: string): Promise<number[]> {
  const { data } = await sharp(file).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const s = [0, 0, 0, 0], n = data.length / 4
  for (let i = 0; i < data.length; i += 4) { s[0] += LIN[data[i]]; s[1] += LIN[data[i + 1]]; s[2] += LIN[data[i + 2]]; s[3] += data[i + 3] / 255 }
  return s.map(v => +(v / n).toFixed(4))
}

/** Objekt-Texturen (UV des Handschuhs, nicht gekachelt) bis 2048, Material-Layer/Detail bis 1024 */
const OBJECT = /^g_t(Surface|Normal|LayerMask|Pattern|PatternProperties|ObjectProperties|LayerId|TintId)$/

/**
 * Export-Schritt eines Handschuh-Kits für buildSkins (doc = KV3 der Kit-vcompmat): erst die vmat (KV1), dann im finish ein eigener VRF-Aufruf
 * für die kompilierten Texturen (roh, siehe oben) → conv → write(Kit-JSON). null = keine vmat (fehlende/fremde vcompmat → Standard).
 */
export function gloveJob(c: Ctx, doc: any, work: string, conv: GloveConv, write: (kit: GloveKit) => void): GloveJob | null {
  const vmat = gloveVmat(doc)
  if (!vmat) return null
  const compositor = containers(doc).some(x => x.m_strAlias === 'paint_compositor')
  return { files: [vmat], finish: async out => {
    const src = join(out, vmat)
    if (!existsSync(src)) { console.warn('glove material missing:', vmat); return }
    const m: Layer = Object.fromEntries(kvList(kv1(readFileSync(src, 'utf8')), 'Layer0'))
    if (m.shader !== (compositor ? 'csgo_customglove_preview.vfx' : 'csgo_customglove.vfx')) { write({ unsupported: true }); return }
    const compiled = Object.fromEntries(Array.isArray(m['Compiled Textures']) ? m['Compiled Textures'] : []) as Record<string, string>
    const dir = join(work, 'glove_tex'), rm = () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) // Windows: Virenscanner hält Dateien kurz offen
    rm(); mkdirSync(dir, { recursive: true })
    try {
      vrf(c.exe, ['-i', c.cs2.pak, '-d', '--texture_decode_flags', 'none', '-f', [...new Set(Object.values(compiled))].map(v => v + '_c').join(','), '-o', dir], c.log)
      const tex: Record<string, string> = {}
      for (const [k, v] of Object.entries(compiled)) { const t = await conv(dir, v.replace(/\.vtex$/, '.png'), OBJECT.test(k) ? 2048 : 1024); if (t) tex[k] = t }
      if (!compositor) { write(gloveKit(m, doc, tex)); return }
      const kit = gloveKit2(m, doc, tex)
      for (const k of AVG) { const f = compiled[k] && join(dir, compiled[k].replace(/\.vtex$/, '.png')); if (f && existsSync(f)) kit.vars[`TextureAverageColor(${k})`] = await textureAverage(f) }
      write(kit)
    } finally { rm() }
  } }
}
