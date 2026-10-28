// Aufkleber und Anhänger der Waffen eines Matches (Daten: main/econ.ts → header.skins[].stickers/charm); gebaut wird nur, was im Match vorkommt.
// Aufkleber: CS2 zeichnet sie im Waffen-Shader (csgo_weapon.vfx F_STICKERS, ≤ 5 je Material) im Sticker-Raum uv2 = TEXCOORD_1 des Modells,
// nur wo g_tStickerWepInputs.r > 0 und uv2.x > −1 (andere Seite). uv2 ist eine affine Seitenprojektion der Position (AK: rms 1e-4) → hier je
// Mesh-Variante (body_hd/body_legacy) Ebenen u/v + Seitenrichtung gefittet; der Renderer rechnet uv2 aus der Position, Waffen-GLBs bleiben.
// Plätze (Versatz, Skala, Drehung) aus StickerMarkup des vmdl. Anhänger: pedestal_display_model (Ursprung = Öse, hängt nach −y).
// Ablage <patch>/econ/: items.json, stickers/<id>.webp + <id>.json, charms/<id>.glb, weapons/<name>.json + <name>_<hd|legacy>.png, scratches.png
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dedup, meshopt, prune, textureCompress, weld } from '@gltf-transform/functions'
import type { Primitive } from '@gltf-transform/core'
import { MeshoptEncoder } from 'meshoptimizer'
import sharp from 'sharp'
import type { EconAssets, StickerSpace } from '../../shared/assets3d.ts'
import { fileKey, kv1, kvGet, kvList, vrf, vrfAsync, writeAtomic } from './cs2.ts'
import { sharpLimited, type Ctx } from './map.ts'
import { getIO, rerl } from './models.ts'

/** sticker_kits-ID → sticker_material ('cs20/cs20_aztec_beast' → stickers/….vmat), keychain_definitions-ID → vmdl */
export interface EconItems { stickers: Record<number, string>; charms: Record<number, string> }
export function parseEconItems(text: string): EconItems {
  const ig = kvList(kv1(text), 'items_game'), stickers: Record<number, string> = {}, charms: Record<number, string> = {}
  for (const [id, v] of kvList(ig, 'sticker_kits')) { const m = Array.isArray(v) && kvGet(v, 'sticker_material'); if (typeof m === 'string') stickers[+id] = m.toLowerCase() }
  for (const [id, v] of kvList(ig, 'keychain_definitions')) { const m = Array.isArray(v) && kvGet(v, 'pedestal_display_model'); if (typeof m === 'string') charms[+id] = m.toLowerCase() }
  return { stickers, charms }
}

export interface EconNeed { stickers: number[]; charms: number[]; models: string[] }
const SIZE = 256
const SCRATCHES = 'materials/default/stickers/sticker_default_scratches_psd_a9ad199b.vtex'

/** VRF-Block-Dump mehrerer Dateien → Datei (ohne _c) → Text */
function dump(c: Ctx, files: string[], block: string, out: string) {
  vrf(c.exe, ['-i', c.cs2.pak, '-f', files.map(f => f + '_c').join(','), '-b', block], out)
  const m = new Map<string, string>()
  for (const p of readFileSync(out, 'utf8').split(/^\[\d+\/\d+\] /m).slice(1)) m.set(p.slice(0, p.indexOf('\n')).trim().replace(/_c$/, ''), p)
  return m
}
/** Material-Parameter aus dem DATA-Dump (Textur: Pfad der .vtex, Zahl/Vektor als Text) */
const param = (text: string | undefined, name: string) =>
  text && new RegExp(`m_name = "${name}"\\s*m_(?:pValue|nValue|flValue|value) = (?:resource:"([^"]+)"|\\[([^\\]]*)\\]|([-\\d.e]+))`).exec(text)?.slice(1).find(x => x !== undefined)
const nums = (s: string | undefined) => (s ?? '').split(',').map(Number).filter(Number.isFinite)
/** .vtex mit VRF -d als PNG nach dir exportieren → Pfad der PNG je vtex. Genau eine Datei: VRF nimmt -o als Dateinamen */
async function exportTex(c: Ctx, vtex: string[], dir: string) {
  const out = new Map(vtex.map(t => [t, join(dir, t.replace(/\.vtex$/, '.png'))]))
  if (vtex.length === 1) mkdirSync(dirname(out.get(vtex[0])!), { recursive: true })
  if (vtex.length) await vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', vtex.map(t => t + '_c').join(','), '-d', '-o', vtex.length === 1 ? out.get(vtex[0])! : dir], c.log)
  return out
}

/**
 * Sticker-Raum einer Mesh-Variante: uv2 ≈ u·(x, y, z, 1), v·(…) im glTF-Wurzelraum (kleinste Quadrate über Ecken mit uv2.x > −1),
 * s = Seite (Projektionsnormale zur Seite der gültigen Ecken). null: kein uv2
 */
export function fitSpace(p: Primitive): Pick<StickerSpace, 'u' | 'v' | 's'> | null {
  const P = p.getAttribute('POSITION'), U = p.getAttribute('TEXCOORD_1'), N = p.getAttribute('NORMAL')
  if (!P || !U || !N) return null
  const A = new Float64Array(16), bu = new Float64Array(4), bv = new Float64Array(4), a = [0, 0, 0], t = [0, 0], n = [0, 0, 0], ns = [0, 0, 0]
  let k = 0
  for (let i = 0; i < P.getCount(); i++) {
    U.getElement(i, t)
    if (!(t[0] > -1)) continue
    P.getElement(i, a); N.getElement(i, n)
    const r = [a[0], a[1], a[2], 1]
    for (let x = 0; x < 4; x++) { for (let y = 0; y < 4; y++) A[4 * x + y] += r[x] * r[y]; bu[x] += r[x] * t[0]; bv[x] += r[x] * t[1] }
    ns[0] += n[0]; ns[1] += n[1]; ns[2] += n[2]; k++
  }
  if (k < 16) return null
  for (const i of [0, 5, 10]) A[i] += 1e-9 * k // Ridge: ebene Seite (x fast konstant) → Koeffizient 0 statt singulär
  const solve = (b: Float64Array) => { // Gauß mit Pivot, 4×4
    const M = [0, 1, 2, 3].map(i => [...A.slice(4 * i, 4 * i + 4), b[i]])
    for (let col = 0; col < 4; col++) {
      let piv = col
      for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
      ;[M[col], M[piv]] = [M[piv], M[col]]
      for (let r = 0; r < 4; r++) if (r !== col) { const f = M[r][col] / M[col][col]; for (let c = col; c < 5; c++) M[r][c] -= f * M[col][c] }
    }
    return M.map((r, i) => r[4] / r[i])
  }
  const u = solve(bu), v = solve(bv)
  // Projektionsnormale = u × v (Richtung, in der uv2 konstant ist), zur Seite der gültigen Ecken gedreht
  const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...c) || 1
  const sg = Math.sign(c[0] * ns[0] + c[1] * ns[1] + c[2] * ns[2]) || 1
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6
  return { u: u.map(r6), v: v.map(r6), s: c.map(x => r6((sg * x) / l)) }
}

/** StickerMarkup des vmdl-DATA-Dumps: Plätze je Mesh (body_hd, body_legacy …) nach Index */
export function stickerMarkup(text: string): Record<string, StickerSpace['slots']> {
  const out: Record<string, StickerSpace['slots']> = {}
  const i = text.indexOf('StickerMarkup =')
  if (i < 0) return out
  for (const m of text.slice(i).matchAll(/Index = (\d+)\s+Mesh = "([^"]+)"[\s\S]*?Offset = \[([^\]]+)\]\s+Scale = ([-\d.e]+)\s+Rotation = ([-\d.e]+)/g)) {
    const [x, y] = nums(m[3]);
    (out[m[2]] ??= [])[+m[1]] = { x, y, scale: +m[4], rot: +m[5] }
  }
  return out
}

/**
 * Fehlendes bauen (je Teil eigener Cache) und das Manifest des Matches liefern. defs: Waffen-def → Modell ('ak47/weapon_rif_ak47').
 * url = Pfad relativ zu <patch> → cs3d-URL
 */
export async function buildEcon(c: Ctx, P: string, work: string, need: EconNeed & { defs: Record<number, string> }, url: (rel: string) => string): Promise<EconAssets> {
  const dir = join(P, 'econ'), sd = join(dir, 'stickers'), cd = join(dir, 'charms'), wd = join(dir, 'weapons')
  for (const d of [sd, cd, wd]) mkdirSync(d, { recursive: true })
  const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
  const io = await getIO()

  // ---- Def-Tabellen (neu bei anderer pak01_dir.vpk)
  const itemsFile = join(dir, 'items.json'), pak = fileKey(c.cs2.pak)
  let items: EconItems = readJson(itemsFile)?.pak === pak ? readJson(itemsFile).items : null
  if (!items) {
    vrf(c.exe, ['-i', c.cs2.pak, '-f', 'scripts/items/items_game.txt', '-o', work], c.log)
    items = parseEconItems(readFileSync(join(work, 'scripts', 'items', 'items_game.txt'), 'utf8'))
    writeAtomic(itemsFile, JSON.stringify({ pak, items }))
  }

  // ---- Aufkleber: Material → g_tSticker0 + Wear-Parameter → 256² WebP
  const stickers = need.stickers.filter(id => items.stickers[id] && !existsSync(join(sd, `${id}.json`)))
  if (stickers.length) {
    c.step(0.1, 'Exporting stickers')
    const mat = (id: number) => `stickers/${items.stickers[id]}.vmat`
    const data = dump(c, [...new Set(stickers.map(mat))], 'DATA', join(work, 'sticker_mat.txt'))
    const tex = new Map(stickers.map(id => [id, param(data.get(mat(id)), 'g_tSticker0')]))
    const png = await exportTex(c, [...new Set([...tex.values()].filter((t): t is string => !!t))], join(work, 'stickers'))
    for (const id of stickers) {
      const t = tex.get(id), f = t && png.get(t), m = data.get(mat(id))
      if (!f || !existsSync(f)) continue
      writeAtomic(join(sd, `${id}.webp`), await sharp(f).resize(SIZE, SIZE, { fit: 'fill' }).webp({ quality: 88, alphaQuality: 100 }) /* Alpha ist codiert (Deckung + Wear-Reihenfolge) */.toBuffer())
      const wb = nums(param(m, 'g_vWearBiasSticker0')), ws = param(m, 'g_fWearScratchesSticker0')
      writeAtomic(join(sd, `${id}.json`), JSON.stringify({ wb: [wb[0] ?? 1, wb[1] ?? 1], ws: ws === undefined ? 1 : +ws, paper: param(m, 'g_bPaperBackingSticker0') !== '0' }))
    }
  }
  const scratches = join(dir, 'scratches.png')
  if (need.stickers.length && !existsSync(scratches)) {
    const f = (await exportTex(c, [SCRATCHES], join(work, 'scratches'))).get(SCRATCHES)!
    if (existsSync(f)) writeAtomic(scratches, await sharp(f).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().png().toBuffer())
  }

  // ---- Sticker-Raum je Waffenmodell: StickerMarkup (vmdl DATA), Maske/Kavität (g_tStickerWepInputs der Materialien), uv2-Fit (GLB-Export)
  const wname = (m: string) => m.split('/').pop()!
  const models = need.models.filter(m => !existsSync(join(wd, `${wname(m)}.json`)))
  if (models.length) {
    c.step(0.4, 'Exporting sticker slots')
    const vmdl = (m: string) => `weapons/models/${m}.vmdl`
    const mdata = dump(c, models.map(vmdl), 'DATA', join(work, 'sticker_vmdl.txt'))
    const refs = rerl(c, models.map(m => vmdl(m) + '_c'), join(work, 'sticker_rerl.txt'))
    const mats = [...new Set([...refs.values()].flat().filter(r => r.endsWith('.vmat')))]
    const vdata = mats.length ? dump(c, mats, 'DATA', join(work, 'sticker_vmat.txt')) : new Map<string, string>()
    const masks = new Map(mats.map(m => [m, param(vdata.get(m), 'g_tStickerWepInputs')]))
    const png = await exportTex(c, [...new Set([...masks.values()].filter((t): t is string => !!t))], join(work, 'masks'))
    const out = join(work, 'sticker_glb')
    await vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', models.map(m => vmdl(m) + '_c').join(','), '-o', out, '-d', '--game', c.cs2.gi, '--gltf_export_format', 'glb'], c.log)
    for (const m of models) {
      const slots = stickerMarkup(mdata.get(vmdl(m)) ?? ''), res: Record<string, StickerSpace> = {}, glb = join(out, 'weapons', 'models', `${m}.glb`)
      const meshes = existsSync(glb) ? (await io.read(glb)).getRoot().listMeshes() : []
      const split = meshes.some(me => /\.body_(hd|legacy)$/.test(me.getName()))
      for (const me of meshes) {
        // body_hd/body_legacy, sonst das eine Mesh des Modells (Markup nennt dessen Namen)
        const v = me.getName().split('.').pop()!, variant = v === 'body_legacy' ? 'legacy' : v === 'body_hd' || (!split && meshes.length === 1) ? 'hd' : ''
        // Material der Variante: Legacy-Materialien liegen unter …/v_models/
        const mat = (refs.get(vmdl(m) + '_c') ?? []).find(r => r.endsWith('.vmat') && masks.get(r) && r.startsWith('materials/models/weapons/v_models/') === (variant === 'legacy'))
        const mask = mat && png.get(masks.get(mat)!), prim = me.listPrimitives().sort((a, b) => b.getAttribute('POSITION')!.getCount() - a.getAttribute('POSITION')!.getCount())[0]
        const fit = variant && prim && fitSpace(prim)
        if (!fit || !mask || !existsSync(mask) || !slots[v]?.length) continue
        const file = `${wname(m)}_${variant}.png`
        writeAtomic(join(wd, file), await sharp(mask).resize(SIZE, SIZE, { fit: 'fill' }).removeAlpha().png().toBuffer())
        res[variant] = { ...fit, mask: file, slots: slots[v] }
      }
      writeAtomic(join(wd, `${wname(m)}.json`), JSON.stringify(res))
    }
  }

  // ---- Anhänger: Modell + Materialien → statisches GLB, Texturen 256² WebP
  const charms = need.charms.filter(id => items.charms[id] && !existsSync(join(cd, `${id}.glb`)))
  if (charms.length) {
    c.step(0.7, 'Exporting charms')
    const out = join(work, 'charms')
    await vrfAsync(c.exe, ['-i', c.cs2.pak, '-f', [...new Set(charms.map(id => items.charms[id] + '_c'))].join(','), '-o', out, '-d', '--game', c.cs2.gi,
      '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt'], c.log)
    for (const id of charms) {
      const raw = join(out, items.charms[id].replace(/\.vmdl$/, '.glb'))
      if (!existsSync(raw)) continue
      const doc = await io.read(raw), root = doc.getRoot()
      // Kette ist in CS2 simuliert; hier starr in Ruhelage
      for (const me of root.listMeshes()) for (const p of me.listPrimitives()) for (const a of ['JOINTS_0', 'WEIGHTS_0']) p.setAttribute(a, null)
      for (const a of root.listAnimations()) a.dispose()
      for (const s of root.listSkins()) s.dispose()
      await doc.transform(dedup(), weld(), prune(), textureCompress({ encoder: sharpLimited, targetFormat: 'webp', resize: [SIZE, SIZE], quality: 85 }),
        meshopt({ encoder: MeshoptEncoder, level: 'medium' }), prune())
      writeAtomic(join(cd, `${id}.glb`), await io.writeBinary(doc))
    }
  }

  // ---- Manifest des Matches
  const res: EconAssets = { stickers: {}, charms: {}, weapons: {}, ...(existsSync(scratches) && { scratches: url('econ/scratches.png') }) }
  for (const id of need.stickers) {
    const j = readJson(join(sd, `${id}.json`))
    if (j && existsSync(join(sd, `${id}.webp`))) res.stickers[id] = { tex: url(`econ/stickers/${id}.webp`), wb: j.wb, ws: j.ws, paper: j.paper }
  }
  for (const id of need.charms) if (existsSync(join(cd, `${id}.glb`))) res.charms[id] = url(`econ/charms/${id}.glb`)
  for (const [def, m] of Object.entries(need.defs)) {
    const j: Record<string, StickerSpace> | null = readJson(join(wd, `${wname(m)}.json`))
    if (!j) continue
    const fix = (s?: StickerSpace) => s && { ...s, mask: url(`econ/weapons/${s.mask}`) }
    if (j.hd || j.legacy) res.weapons[+def] = { hd: fix(j.hd), legacy: fix(j.legacy) }
  }
  return res
}
