// Kompletter Asset-Bau ohne Electron (gleiche Funktion wie der utilityProcess), misst Zeit/MB/RSS:
//   node --max-old-space-size=4096 scripts/dev3d/assets3d-run.ts [map=de_dust2] [profile=high] [<id>.3d.bin.gz]
// Mit .3d.bin.gz: Agenten/Waffen/Messer/Skins wie prepareForMatch aus dem Header (Map aus dem Header).
// Ohne: Agenten/Waffen wie in user-demo (agents-Spike demo_agents3.json, Waffen der Demo). Cache: %APPDATA%\CS Demo Analysis\assets3d
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import sharp from 'sharp'
import { prepareInput } from '../../src/shared/assets3d.ts'
import type { CS3DHeader } from '../../src/shared/cs3d.ts'
import { prepare3d } from '../../src/main/assets3d/prepare.ts'

try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
sharp.concurrency(1)
sharp.cache(false)
const args = process.argv.slice(2), file3d = args.find(a => a.endsWith('.gz'))
const [map0 = 'de_dust2', profile = 'high'] = args.filter(a => a !== file3d) as [string, 'high' | 'low']
const root = join(process.env.APPDATA!, 'CS Demo Analysis')
let input: ReturnType<typeof prepareInput> = {
  map: map0, agents: [5037, 4732, 5036, 5108, 5601, 5404, 5105, 5602], skins: [],
  // knife, knife_t, Butterfly, Huntsman, M9, Talon, Karambit, Bowie, Glock, USP-S, SSG, AWP, Deagle, M4A1-S, Tec-9, FAMAS, AK, Five-SeveN, Zeus, P250, Galil, M4A4, MAC-10, MP9, P90
  weapons: [42, 59, 515, 509, 508, 523, 507, 514, 4, 61, 40, 9, 1, 60, 30, 10, 7, 3, 31, 36, 13, 16, 17, 34, 19],
}
if (file3d) {
  const raw = gunzipSync(readFileSync(file3d)), h: CS3DHeader = JSON.parse(raw.toString('utf8', 4, 4 + raw.readUInt32LE(0)))
  h.skins ??= []
  input = prepareInput(h)
}
let peak = 0
const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 200)
const t0 = Date.now()
let last = ''
const a = await prepare3d({ root, ...input, profile }, p => {
  const line = `${p.stage} ${p.pct}% ${p.msg}`
  if (line !== last) console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${line}`)
  last = line
})
clearInterval(iv)
const du = (d: string): number => readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? du(join(d, e.name)) : statSync(join(d, e.name)).size), 0)
const P = join(root, 'assets3d', a.map.glb.split('/')[3])
const skins = Object.values(a.skins ?? {})
console.log(JSON.stringify({
  sec: +((Date.now() - t0) / 1000).toFixed(1), peakRssMB: Math.round(peak / 1048576),
  MB: Object.fromEntries(readdirSync(P, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => [e.name, +(du(join(P, e.name)) / 1048576).toFixed(1)])),
  map: a.map.map, agents: Object.keys(a.agents.models).length, arms: Object.keys(a.agents.arms).length, clips: Object.keys(a.agents.clipMeta).length,
  weapons: Object.keys(a.weapons).length, weaponsNoGlb: Object.entries(a.weapons).filter(([, w]) => !w.glb).map(([d]) => d),
  noVm: Object.entries(a.weapons).filter(([, w]) => !w.vm).map(([d]) => d), legacyGlb: Object.values(a.weapons).filter(w => w.legacyGlb).map(w => w.className),
  noMuzzle: Object.values(a.weapons).filter(w => w.anim !== 'knife' && !w.muzzle).map(w => w.className),
  gloves: a.gloves, skinsWanted: new Set(input.skins.map(s => `${s.def}_${s.paint}`)).size, skins: skins.length,
  weaponSkins: skins.filter(s => s.kind === 'weapon').length, legacySkins: skins.filter(s => s.kind === 'weapon' && s.legacy).length,
  skinsMissing: [...new Set(input.skins.map(s => `${s.def}_${s.paint}`))].filter(k => !a.skins?.[k]),
  sounds: Object.fromEntries(Object.entries(a.sounds.map.map).map(([k, v]) => [k, Object.keys(v).length])),
}, null, 1))
console.log('ak47', JSON.stringify(a.weapons[7]), '\nskin', JSON.stringify(Object.entries(a.skins ?? {}).find(([k]) => k.startsWith('7_'))))
console.log('glove', JSON.stringify(Object.entries(a.skins ?? {}).find(([, s]) => s.kind === 'glove')))
