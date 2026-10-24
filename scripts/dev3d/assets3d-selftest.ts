// Selbsttest der Asset-Pipeline-Parser ohne VRF/Bau: node scripts/dev3d/assets3d-selftest.ts [ctm_sas.glb für die Rauheits-Stichprobe]
// Nutzt gecachte Spike-Daten (items_game.txt, Physik-GLB, DATA-Dump, Footstep-Events), wenn vorhanden.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { floorLayer, parseFloorGrid } from '../../src/shared/assets3d.ts'
import { texPackResponse } from '../../src/main/assets3d/texpack.ts'
import { TexPack, plan } from '../../src/renderer/replay3d/engine/texstream.ts'
import * as THREE from 'three'
import { Document, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import sharp from 'sharp'
import { buildRaycast } from '../../src/renderer/replay3d/engine/raycast.ts'
import { findCS2, kv1, kv3, kvGet, kvList } from '../../src/main/assets3d/cs2.ts'
import { CLIP_LIST, bc5, parseItems, parseSkeletons, parseWeaponData, splitDual, tracerFreqs, vmVariation, weaponAsset } from '../../src/main/assets3d/models.ts'
import { bc6h, ktx2, lz4, readVtex } from '../../src/main/assets3d/vtex.ts'
import { floorGrid, layerAdjust } from '../../src/main/assets3d/map.ts'
import { monoWav } from '../../src/main/assets3d/sounds.ts'
import { communityPaint, containers, inputsRecipe, kitVcompmat, paintRecipe } from '../../src/main/assets3d/skins.ts'
import { gloveKit } from '../../src/main/assets3d/gloves.ts'

const SP = '../Daten/downloads/spike/'
const t = (name: string, f: () => void) => { const t0 = performance.now(); f(); console.log('ok', name, Math.round(performance.now() - t0), 'ms') }

t('kv1', () => {
  const o = kv1('"libraryfolders" { "0" { "path" "C:\\\\Steam" "apps" { "730" "1" } } "1" { "path" "D:\\\\Lib" } }')
  assert.deepEqual(kvList(o, 'libraryfolders').map(([, v]) => Array.isArray(v) && kvGet(v, 'path')), ['C:\\Steam', 'D:\\Lib'])
})
t('kv3', () => {
  const o = kv3('<!-- kv3 x -->\n{ a = 1 b = "x" c = [ 1, 2.5, ] d = { e = true } f = resource:"p/q" // k\n }')
  assert.deepEqual(o, { a: 1, b: 'x', c: [1, 2.5], d: { e: true }, f: 'p/q' })
})
t('findCS2', () => { const c = findCS2(); assert.ok(existsSync(c.pak)); console.log('  ', c.csgo, 'patch', c.patch) })
t('clips', () => assert.equal(CLIP_LIST.length, 75))
t('layerAdjust', () => {
  assert.equal(layerAdjust(1, 1, 1, [1, 1, 1], [0, 0, 0]), null) // neutral
  const m = layerAdjust(1, 1, 2, [1, 1, 1], [0, 0, 0])!, ap = (c: number[]) => [0, 1, 2].map(r => m[r * 4] * c[0] + m[r * 4 + 1] * c[1] + m[r * 4 + 2] * c[2] + m[r * 4 + 3])
  ap([0.2, 0.3, 0.4]).forEach((v, i) => assert.ok(Math.abs(v - [0.4, 0.6, 0.8][i]) < 1e-4)) // Helligkeit 2
  const g = layerAdjust(1, 0, 1, [1, 1, 1], [0, 0, 0])!, gr = [0, 1, 2].map(r => g[r * 4] * 0.8 + g[r * 4 + 1] * 0.2 + g[r * 4 + 2] * 0.1 + g[r * 4 + 3])
  assert.ok(Math.abs(gr[0] - gr[1]) < 1e-4 && Math.abs(gr[1] - gr[2]) < 1e-4) // Sättigung 0 = grau
})
t('splitDual', () => {
  // zwei gleiche Dreiecke 0,5 m auseinander → Knoten 'left' deckungsgleich mit dem rechten
  const doc = new Document(), buf = doc.createBuffer(), tri = [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]
  const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array([...tri, ...tri.map((v, i) => i % 3 === 0 ? v + 0.5 : v)])).setBuffer(buf)
  const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2, 3, 4, 5])).setBuffer(buf))
  const node = doc.createNode('body').setMesh(doc.createMesh('body').addPrimitive(prim))
  doc.createScene().addChild(node)
  splitDual(doc)
  const left = doc.getRoot().listNodes().find(n => n.getName() === 'left')!, lp = left.getMesh()!.listPrimitives()[0], p = [0, 0, 0]
  assert.deepEqual(Array.from(prim.getIndices()!.getArray()!), [0, 1, 2])
  lp.getAttribute('POSITION')!.getElement(lp.getIndices()!.getArray()![1], p)
  assert.ok(Math.abs(p[0] - 0.1) < 1e-6 && Math.abs(p[1]) < 1e-6)
})

const ig = SP + 'agents/vpkx/scripts/items/items_game.txt'
if (existsSync(ig)) t('items_game', () => {
  const it = parseItems(readFileSync(ig, 'utf8'))
  assert.equal(it.agents[5036], 'tm_phoenix/tm_phoenix'); assert.equal(it.agents[5037], 'ctm_sas/ctm_sas')
  assert.equal(it.agents[5601], 'ctm_sas/ctm_sas_variantf')
  assert.deepEqual(it.weapons[7], { cls: 'weapon_ak47', model: 'ak47/weapon_rif_ak47', type: 'Rifle' })
  assert.equal(it.weapons[61].cls, 'weapon_usp_silencer'); assert.equal(it.weapons[31].cls, 'weapon_taser') // weapon_type 'Knife', animOf macht pistol daraus
  for (const d of [42, 59, 507, 515, 43, 44, 45, 46, 47, 48, 49]) assert.ok(it.weapons[d]?.model, 'def ' + d)
  // Handschuhe nicht als Agent; Kits mit Legacy-Flag bzw. composite_material_path (skins-Spike paint_kits.json)
  assert.equal(it.gloves[5030], 'shared/arms/glove_sporty/glove_sporty'); assert.equal(it.agents[5030], undefined)
  assert.deepEqual(it.kits[474], { name: 'cu_ak47_courage_alt', legacy: true, guns: ['weapon_ak47'] })
  // M4A1-S-Kit gilt nicht für die M4A4 (Demo-Props beim Waffenwechsel); Messer-Kits stehen nicht in den Loot-Listen
  assert.deepEqual(it.kits[1340].guns, ['weapon_m4a1_silencer']); assert.equal(it.kits[410].guns, undefined) // m4a1s_quick_liquidation, aq_damascus
  assert.equal(kitVcompmat(it.kits[1171], false), 'weapons/paints/community/community_33/ak_porcelain.vcompmat')
  assert.equal(kitVcompmat(it.kits[10045], true), 'gloves/paints/sporty_poison_frog_blue_white.vcompmat')
  assert.equal(kitVcompmat(it.kits[542], false), 'weapons/paints/legacy/cu_bizon_curse.vcompmat')
  console.log('  ', Object.keys(it.agents).length, 'agents,', Object.keys(it.weapons).length, 'weapons,', Object.keys(it.gloves).length, 'gloves,', Object.keys(it.kits).length, 'kits; 42 =', JSON.stringify(it.weapons[42]), '49 =', JSON.stringify(it.weapons[49]))
})

// Skin-Rezepte gegen die geprüften Spike-Rezepte (render/recipes.json, job2.json) aus denselben dekompilierten Dateien
const SK = SP + 'fp/skins/'
if (existsSync(SK + 'render/recipes.json')) t('skin recipes', () => {
  const lay = (f: string) => Object.fromEntries(kvList(kv1(readFileSync(SK + 'vcm/' + f, 'utf8')), 'Layer0'))
  const R = JSON.parse(readFileSync(SK + 'render/recipes.json', 'utf8')), strip = (o: any) => JSON.parse(JSON.stringify(o).replaceAll('vcm/', ''))
  const ak = strip(R.find((r: any) => r.name === 'ak47_aquamarine')), V = 'materials/models/weapons/customization/'
  assert.deepEqual(strip(paintRecipe(V + 'paints/vmats/cu_ak47_courage_alt.vmat', lay(V + 'paints/vmats/cu_ak47_courage_alt.vmat'))), ak.paint)
  assert.deepEqual(strip(inputsRecipe(V + 'rif_ak47/rif_ak47_composite_inputs.vmat', lay(V + 'rif_ak47/rif_ak47_composite_inputs.vmat'))), ak.inputs)
  const inh = strip(R.find((r: any) => r.name === 'ak47_inheritance')), cm = containers(kv3(readFileSync(SK + 'vcm/weapons/paints/community/community_33/ak_porcelain.vcompmat', 'utf8')))
  const tpl = 'workshop/paintkits/templates/gs_template.vmat', p = communityPaint(paintRecipe(tpl, lay(tpl)), cm.find(c => c.m_strAlias === 'exposed_params').m_vecLooseVariables)
  assert.deepEqual(strip({ ...p, textures: { ...p.textures, wear: undefined, grunge: undefined } }), strip({ ...inh.paint, textures: { ...inh.paint.textures, wear: undefined, grunge: undefined } }))
  const job = JSON.parse(readFileSync(SK + 'render/job2.json', 'utf8')).glove, gv = 'gloves/paints/sporty_poison_frog_blue_white'
  // gloveKit nimmt die kompilierten Texturen (g_t* → Datei) statt der Quellpfade: Zuordnung mit Platzhaltern prüfen
  const tex = Object.fromEntries(['g_tLayerMask', 'g_tPattern', 'g_tSurface', 'g_tDetail1', 'g_tDetail2', 'g_tDetail3', 'g_tDetail4'].map(k => [k, k]))
  const g = gloveKit(lay(gv + '.vmat'), kv3(readFileSync(SK + 'vcm/' + gv + '.vcompmat', 'utf8')), tex)
  assert.deepEqual([g.mask, g.pattern, g.surface, g.details], ['g_tLayerMask', 'g_tPattern', 'g_tSurface', ['g_tDetail1', 'g_tDetail2', 'g_tDetail3', 'g_tDetail4']])
  for (const k of ['palette', 'replaceIndex', 'usePattern', 'patternScale', 'patternRotation', 'detailScale'] as const) assert.deepEqual(strip(g[k]), strip(job[k]), k)
  assert.deepEqual(g.tints.flat().map(v => +v.toFixed(5)), job.tints.flat().map((v: number) => +v.toFixed(5)))
  assert.deepEqual(strip(g.roll), { patternOffset: { x: 0, xmin: 0, xmax: 1, y: 0, ymin: 0, ymax: 1 }, patternRotation: { x: 30, xmin: 30, xmax: 30 } })
})

// BC5 = 2 × BC4: R mit a0 > a1 (8 Stufen), G mit a0 ≤ a1 (6 Stufen + 0/255), Index von Pixel p = p mod 8; 2×2 = Ausschnitt oben links
t('bc5', () => {
  const blk = (a: number, z: number) => { let x = 0; for (let p = 0; p < 8; p++) x |= p << (3 * p); return [a, z, x & 255, (x >> 8) & 255, x >> 16, x & 255, (x >> 8) & 255, x >> 16] }
  const b = Uint8Array.from([...blk(200, 100), ...blk(0, 255)]), R = [200, 100, 186, 171, 157, 143, 129, 114], G = [0, 255, 51, 102, 153, 204, 0, 255]
  assert.deepEqual([...bc5(b, 4, 4)], Array.from({ length: 16 }, (_, p) => [R[p % 8], G[p % 8]]).flat())
  assert.deepEqual([...bc5(b, 2, 2)], [0, 1, 4, 5].flatMap(p => [R[p], G[p]]))
})
// m_nTracerFrequency (weapons.vdata, optik-gesamt): Paar = [ohne, mit Schalldämpfer], gleiche Paare → Zahl, fehlt → kein Feld
const vd = SP + 'fidelity/optik-gesamt/cs2/x/scripts/weapons.vdata'
if (existsSync(vd)) t('tracer frequency', () => {
  const tr = tracerFreqs(readFileSync(vd, 'utf8'))
  const freq = (cls: string, model: string) => weaponAsset({ cls, model, type: '' }, { root: [0, 0, 0], skel: '', tracer: tr[model] }).tracerFreq
  assert.equal(freq('weapon_ak47', 'ak47/weapon_rif_ak47'), 3); assert.deepEqual(freq('weapon_m4a1_silencer', 'm4a1_silencer/weapon_rif_m4a1_silencer'), [3, 0])
  assert.deepEqual(freq('weapon_usp_silencer', 'usp_silencer/weapon_pist_usp_silencer'), [1, 0]); assert.equal(freq('weapon_awp', 'awp/weapon_snip_awp'), 1)
  assert.equal(freq('weapon_mp5sd', 'mp5sd/weapon_smg_mp5sd'), 0); assert.equal(freq('weapon_famas', 'famas/weapon_rif_famas'), 3) // [3, 3] Burst
  assert.equal(tr['knife/knife_karambit/weapon_knife_karambit'], 0); assert.equal(tr['grenade/hegrenade/weapon_hegrenade'], 0)
  assert.equal(weaponAsset({ cls: 'weapon_ak47', model: 'ak47/weapon_rif_ak47', type: '' }, undefined).tracerFreq, undefined)
  console.log('  ', Object.keys(tr).length, 'models, pairs', Object.entries(tr).filter(([, v]) => Array.isArray(v)).map(([m, v]) => `${m.split('/')[0]} ${v}`).join(', '))
})

const data = SP + 'critic/all_weapons_DATA.txt'
if (existsSync(data)) t('weapon DATA', () => {
  const r = parseWeaponData(readFileSync(data, 'utf8'))
  // Critic: AK-Root 4.21 u vom Mesh-Ursprung, M4A4 0.560 m
  const ak = r['ak47/weapon_rif_ak47'], len = (v: number[]) => Math.hypot(...v)
  assert.equal(ak.skel, 'ak47'); assert.ok(Math.abs(len(ak.root) - 0.107) < 0.002, String(len(ak.root)))
  assert.ok(Math.abs(len(r['m4a4/weapon_rif_m4a4'].root) - 0.560) < 0.003)
  console.log('  ', Object.keys(r).length, 'models, ak root', ak.root)
})

const skel = '../Daten/dev-fixtures/skel.txt'
if (existsSync(skel)) t('vnmskel muzzle', () => {
  // VRF -b DATA von ak47/awp/m4a4/usp_silencer.vnmskel_c; Spike weapon_bones.json: ak47 [0.0054,-0.0165,0.5759], usp muzzle2 [0.0001,0.0212,0.3267]
  const s = parseSkeletons(readFileSync(skel, 'utf8'))
  const near = (a: number[] | undefined, b: number[]) => assert.ok(a && a.every((v, i) => Math.abs(v - b[i]) < 1e-3), JSON.stringify(a))
  near(s.ak47.muzzle, [0.0054, -0.0165, 0.5759]); near(s.awp.muzzle, [0.0049, -0.0055, 0.9727]); near(s.usp_silencer.muzzle2, [0.0001, 0.0212, 0.3267])
})

const phys = SP + 'sounds/phys/maps/de_dust2/world_physics_physics.glb'
if (existsSync(phys)) t('floor grid', () => {
  const f = floorGrid(phys)
  const g = parseFloorGrid(f.bin.buffer.slice(f.bin.byteOffset, f.bin.byteOffset + f.bin.byteLength) as ArrayBuffer, new ArrayBuffer(f.n * 19))
  assert.equal(g.offs[g.W * g.H], f.n)
  // sounds-Spike: 1181/1200 Footstep-Events getroffen, meist concrete
  const ev = JSON.parse(readFileSync(SP + 'sounds/demo_events.json', 'utf8')).filter((e: any) => e.event_name === 'player_footstep')
  const dist: Record<string, number> = {}
  let miss = 0
  for (const e of ev) { const l = floorLayer(g, e.user_X, e.user_Y, e.user_Z); if (l < 0) miss++; else dist[g.surfaces[g.sid[l]]] = (dist[g.surfaces[g.sid[l]]] ?? 0) + 1 }
  assert.ok(miss / ev.length < 0.03, `miss ${miss}/${ev.length}`)
  console.log('  ', f.n, 'layers', (f.bin.length / 1024).toFixed(0), 'KB, miss', miss, '/', ev.length, JSON.stringify(dist))
})

t('monoWav', () => {
  const rate = 1000, n = 1000, b = Buffer.alloc(44 + n * 4) // 1 s stereo, 0.3 s laut, dann Stille
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < 300; i++) { b.writeInt16LE(1000, 44 + i * 4); b.writeInt16LE(3000, 46 + i * 4) }
  const m = monoWav(b)!
  assert.equal(m.readUInt16LE(22), 1); assert.equal(m.readInt16LE(44), 2000)
  assert.equal(m.readUInt32LE(40) / 2, 310) // 300 laut + 10 ms Blende
})
t('lz4 block', () => {
  // 'abc' als Literal, Match Abstand 3 Länge 6, Schluss-Literal 'd'
  assert.equal(Buffer.from(lz4(new Uint8Array([0x32, 97, 98, 99, 3, 0, 0x10, 100]), 10)).toString(), 'abcabcabcd')
  assert.throws(() => lz4(new Uint8Array([0x32, 97, 98, 99, 9, 0]), 10)) // Abstand vor den Anfang
})
// je BC6H-Modus ein Block der Dust2-Lightmap mit VRFs Ergebnis (Halbfloat-Bits RGB je Pixel); ganze Textur: 4.2 M Blöcke bitgleich
t('bc6h', () => {
  const fx: Record<string, { block: string; px: number[] }> = JSON.parse(readFileSync(new URL('./bc6h-fixture.json', import.meta.url), 'utf8'))
  assert.equal(Object.keys(fx).length, 14)
  for (const [mode, { block, px }] of Object.entries(fx)) assert.deepEqual([...bc6h(Buffer.from(block, 'hex'), 4, 4)], px, 'mode ' + mode)
})
t('vmVariation', () => {
  assert.equal(vmVariation('weapon_ak47'), 'ak47'); assert.equal(vmVariation('weapon_knife_karambit'), 'karambit')
  assert.equal(vmVariation('weapon_m4a1'), 'm4a4'); assert.equal(vmVariation('weapon_usp_silencer'), 'usp'); assert.equal(vmVariation('weapon_knife_t'), 'default_t')
})
// Roh-vtex_c aus pak01 (VRF ohne -d): BC7 2048 mit LZ4-Mips (Farbe) und 1024 ohne (Hemi-Oct-Normale)
const vt = '../Daten/dev-fixtures/vtex/raw/materials/de_overpass/concrete/'
if (existsSync(vt)) t('vtex → ktx2', () => {
  const c = readVtex(readFileSync(vt + 'concrete_10_color_psd_56b5ecf0.vtex_c'))!
  assert.deepEqual([c.w, c.h, c.format, c.mips.length, c.mips[0].length, c.mips[9].length], [2048, 2048, 20, 10, 4194304, 16])
  const k = ktx2(c, 1024, true), v = new DataView(k.buffer)
  assert.deepEqual([v.getUint32(12, true), v.getUint32(20, true), v.getUint32(40, true), v.getUint32(44, true)], [146, 1024, 9, 0]) // BC7_SRGB, 1024, 9 Mips, roh
  const o0 = Number(v.getBigUint64(80, true)), n0 = Number(v.getBigUint64(88, true))
  assert.equal(n0, 1048576); assert.deepEqual(k.subarray(o0, o0 + 64), c.mips[1].subarray(0, 64)) // Mip 0 der KTX2 = Mip 1 der vtex
  const n = readVtex(readFileSync(vt + 'concrete_10_normal_psd_d6a32d9f.vtex_c'))!
  assert.deepEqual([n.w, n.format, n.mips.length], [1024, 20, 9])
  assert.equal(readVtex(new Uint8Array(64)), null)
})
// tex.pack: Protokoll-Handler (main) → Stream-Leser (Renderer) byte-gleich, Abholen in beliebiger Reihenfolge; Pfad aus dem Ordner → 403
{
  const t0 = performance.now(), dir = mkdtempSync(join(tmpdir(), 'texpack-'))
  try {
    mkdirSync(join(dir, 'tex'))
    const imgs = [Uint8Array.from({ length: 70000 }, (_, i) => i * 7), new Uint8Array(0), Uint8Array.of(1, 2, 3)]
    imgs.forEach((b, i) => writeFileSync(join(dir, 'tex', `${i}.webp`), b))
    writeFileSync(join(dir, 'm.gltf'), JSON.stringify({ images: imgs.map((_, i) => ({ uri: `tex/${i}.webp` })) }))
    const buf = Buffer.from(await texPackResponse(dir).arrayBuffer())
    const pack = new TexPack(`data:application/octet-stream;base64,${buf.toString('base64')}`)
    for (const i of [2, 0, 1]) assert.deepEqual(new Uint8Array(await pack.get(i)), imgs[i])
    // fehlende Datei → 200 mit Länge 0, übrige Bytes gleich; beim Lesen verschwundene Datei → Nullen in der angekündigten Länge
    writeFileSync(join(dir, 'm.gltf'), JSON.stringify({ images: [...imgs.map((_, i) => ({ uri: `tex/${i}.webp` })), { uri: 'tex/missing.webp' }] }))
    const res = texPackResponse(dir)
    assert.equal(res.status, 200)
    rmSync(join(dir, 'tex', '2.webp'))
    const buf2 = Buffer.from(await res.arrayBuffer()), lens = [...new Uint32Array(buf2.buffer, buf2.byteOffset + 4, 4)]
    assert.deepEqual(lens, [70000, 0, 3, 0])
    const pack2 = new TexPack(`data:application/octet-stream;base64,${buf2.toString('base64')}`)
    for (const [i, want] of [imgs[0], imgs[1], new Uint8Array(3), new Uint8Array(0)].entries()) assert.deepEqual(new Uint8Array(await pack2.get(i)), want)
    writeFileSync(join(dir, 'm.gltf'), JSON.stringify({ images: [{ uri: '../x.webp' }] }))
    assert.equal(texPackResponse(dir).status, 403)
  } finally { rmSync(dir, { recursive: true, force: true }) }
  console.log('ok tex.pack', Math.round(performance.now() - t0), 'ms')
}
t('texstream plan', () => {
  // Textur 1 (texCoord 1), 2 (KHR_texture_transform) und 3/4 (gleiches Bild) klont GLTFLoader noch → nicht früh hochladen
  const apply = plan({
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, occlusionTexture: { index: 1, texCoord: 1 } }, { emissiveTexture: { index: 2, extensions: { KHR_texture_transform: {} } } }],
    textures: [{ source: 0 }, { source: 1 }, { source: 2 }, { extensions: { KHR_texture_basisu: { source: 3 } } }, { source: 3 }],
  }, 8)
  const tex = [0, 1, 2, 3, 4].map(() => ({}) as { colorSpace?: string; anisotropy?: number })
  assert.deepEqual(tex.map((x, i) => apply(x as never, i)), [true, false, false, false, false])
  assert.deepEqual([tex[0].colorSpace, tex[0].anisotropy, tex[2].colorSpace, tex[1].colorSpace], ['srgb', 8, 'srgb', undefined])
})
// Raycast-Parität: quantisierte/interleavte Positionen (Pfad ohne getX) gegen dieselben Positionen als Float32, je 2000 Strahlen
t('raycast parity', () => {
  const rnd = (() => { let s = 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647) })()
  const meshes = (kind: string) => Array.from({ length: 20 }, (_, m) => {
    const n = 300, raw = Array.from({ length: n * 3 }, () => rnd() * 2 - 1), g = new THREE.BufferGeometry()
    const q = (T: Int8ArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor, s: number) => new T(raw.map(v => Math.round(T === Uint16Array ? (v + 1) / 2 * s : v * s)))
    let pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute
    if (kind === 'f32') pos = new THREE.BufferAttribute(new Float32Array(raw), 3)
    else if (kind === 'i16n') pos = new THREE.BufferAttribute(q(Int16Array, 32767), 3, true)
    else if (kind === 'u16n') pos = new THREE.BufferAttribute(q(Uint16Array, 65535), 3, true)
    else if (kind === 'i8n') pos = new THREE.BufferAttribute(q(Int8Array, 127), 3, true)
    else { // interleaved Int16 normalized, stride 4, Offset 1 (meshopt-Vertexpuffer mit Padding)
      const arr = new Int16Array(n * 4)
      for (let i = 0; i < n; i++) for (let r = 0; r < 3; r++) arr[i * 4 + 1 + r] = Math.round(raw[i * 3 + r] * 32767)
      pos = new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(arr, 4), 3, 1, true)
    }
    g.setAttribute('position', pos as THREE.BufferAttribute)
    g.setIndex(Array.from({ length: n }, (_, i) => i))
    const mesh = new THREE.Mesh(g)
    mesh.position.set(m * 0.5, 0, 0); mesh.scale.setScalar(10); mesh.updateMatrixWorld(true)
    return mesh
  })
  const ref = (ms: THREE.Mesh[]) => ms.map(m => { // dieselben Positionen über getX als Float32
    const p = m.geometry.attributes.position, a = new Float32Array(p.count * 3)
    for (let i = 0; i < p.count; i++) { a[i * 3] = p.getX(i); a[i * 3 + 1] = p.getY(i); a[i * 3 + 2] = p.getZ(i) }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(a, 3)); g.setIndex(m.geometry.index)
    const r = new THREE.Mesh(g); r.matrixWorld.copy(m.matrixWorld); return r
  })
  const o = new THREE.Vector3(), d = new THREE.Vector3(), res: string[] = []
  for (const kind of ['f32', 'i16n', 'u16n', 'i8n', 'interleaved']) {
    const ms = meshes(kind), A = buildRaycast(ms), B = buildRaycast(ref(ms))
    let diff = 0, hits = 0, grazing = 0
    for (let i = 0; i < 2000; i++) {
      o.set(rnd() * 20 - 5, rnd() * 20 - 10, rnd() * 20 - 10); d.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize()
      const a = A(o, d, 100), b = B(o, d, 100)
      if (b < Infinity) hits++
      if (a === b || Math.abs(a - b) < 1e-4) continue
      // streifender Strahl: Referenz springt schon bei 1e-6 m Versatz weiter als a von b (Float32-Rundung der Referenz-Positionen,
      // gemessen u16n Strahl 637: 5.6e-4 Abstand, ±1e-6 Versatz → ±1.7e-3) → Rundung, keine Abweichung
      const near = [b, B(o.clone().addScalar(1e-6), d, 100), B(o.clone().addScalar(-1e-6), d, 100)]
      if (Math.min(...near) - 1e-4 <= a && a <= Math.max(...near) + 1e-4) grazing++; else diff++
    }
    assert.equal(diff, 0, `${kind}: ${diff}/2000 rays differ`); assert.ok(hits > 200, `${kind}: only ${hits} hits`)
    res.push(`${kind} ${hits} hits${grazing ? ` (${grazing} grazing)` : ''}`)
  }
  console.log('  ', res.join(', '), '- 0 mismatches')
})
// Agenten-Rauheit (optik-gesamt P0, F_ANISOTROPIC_GLOSS): ORM.G von ctm_sas_body ≥ 0,3 (Bau vor dem Fix: 0,01).
// GLB als Argument → Pflicht; sonst App-Cache, der bis zum Neubau der Agenten alt sein darf → nur Warnung
{
  const arg = process.argv[2], glb = arg ?? join(process.env.APPDATA ?? '', 'CS Demo Analysis', 'assets3d', findCS2().patch, 'agents', 'ctm_sas', 'ctm_sas.glb')
  if (existsSync(glb)) {
    const t0 = performance.now()
    await MeshoptDecoder.ready
    const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).read(glb)
    const g = async (name: string) => {
      const tex = doc.getRoot().listMaterials().find(m => m.getName() === name)?.getMetallicRoughnessTexture()
      return tex ? (await sharp(Buffer.from(tex.getImage()!)).stats()).channels[1].mean / 255 : NaN
    }
    const body = await g('ctm_sas_body'), legs = await g('ctm_sas_bodylegs')
    const msg = `ctm_sas_body ORM.G ${body.toFixed(2)} < 0.3: agent built before the aniso fix, rebuild it (${glb})`
    if (arg) assert.ok(body >= 0.3, msg)
    else if (!(body >= 0.3)) console.warn('WARN', msg)
    console.log(body >= 0.3 ? 'ok' : '--', 'agent ORM.G', Math.round(performance.now() - t0), 'ms  ctm_sas_body', body.toFixed(2), 'ctm_sas_bodylegs', legs.toFixed(2))
  }
}
console.log('selftest ok')
