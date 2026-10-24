// Abnahme Paket A (Clip-Sounds, Viewmodel-Rollen, Welt-Clips, Sound-Events): baut die Assets wie die App (zweimal), prüft dann die Ergebnisse.
//   node --max-old-space-size=4096 scripts/dev3d/animsound-assets-check.ts [<id>.3d.bin.gz]
// Ohne Datei: user-demo (Match 4699fdaf49070d28) aus %APPDATA%\CS Demo Analysis\matches; dazu Nova (35) für die Schrotflinten-Schleife.
// Exit-Code 1, wenn eine Prüfung scheitert. Nur Dateien + VRF, nie cs2.exe.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
import sharp from 'sharp'
import { prepareInput, type Assets3D } from '../../src/shared/assets3d.ts'
import type { CS3DHeader } from '../../src/shared/cs3d.ts'
import { findCS2 } from '../../src/main/assets3d/cs2.ts'
import { CLIP_LIST, CLIP_LIST2 } from '../../src/main/assets3d/models.ts'
import { prepare3d } from '../../src/main/assets3d/prepare.ts'

try { setPriority(constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
sharp.concurrency(1)
sharp.cache(false)
const root = join(process.env.APPDATA!, 'CS Demo Analysis')
const file3d = process.argv[2] ?? join(root, 'matches', '4699fdaf49070d28.3d.bin.gz')
const raw = gunzipSync(readFileSync(file3d)), h: CS3DHeader = JSON.parse(raw.toString('utf8', 4, 4 + raw.readUInt32LE(0)))
h.skins ??= []
const input = prepareInput(h)
input.weapons.push(35) // Nova: Schrotflinten-Ladeschleife

const P = join(root, 'assets3d', findCS2().patch), vmDir = join(P, 'viewmodel'), log = join(P, 'build.log')
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
const logLines = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(l => l.startsWith('[prepare3d] new parts')) : []
// Viewmodel-GLBs vor dem Neubau (alte vm_<v>.json ohne dur) → Zuwachs messbar
const before: Record<string, number> = {}
if (existsSync(vmDir)) for (const f of readdirSync(vmDir)) {
  const m = /^vm_(\w+)\.json$/.exec(f)
  if (m && !readJson(join(vmDir, f))?.dur && existsSync(join(vmDir, `vm_${m[1]}.glb`))) before[m[1]] = statSync(join(vmDir, `vm_${m[1]}.glb`)).size
}

const run = async () => { const t = Date.now(); const a = await prepare3d({ root, ...input, profile: 'high' }, () => {}); return { a, s: (Date.now() - t) / 1000 } }
const n0 = logLines().length
const first = await run()
const n1 = logLines().length
const second = await run()
const n2 = logLines().length
const a: Assets3D = second.a

let failed = 0
const check = (name: string, ok: boolean, detail: unknown) => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`) }
const near = (x: number | undefined, y: number, eps = 0.02) => x !== undefined && Math.abs(x - y) <= eps
const file = (url: string) => join(root, url.replace(/^cs3d:\/\//, ''))
const W = a.weapons, byCls = (cls: string) => Object.values(W).find(w => w.className === cls)

// ---- Clip-Zeiten und Fenster
const ak = byCls('weapon_ak47')?.vm, nova = byCls('weapon_nova')?.vm
const snd = (ak?.snd?.reload_ak ?? []).filter(([, e]) => /\.(Clipout|Clipin|AddAmmo|BoltPull)$/.test(e))
const at = (e: string) => snd.find(([, x]) => x.endsWith(e))?.[0]
check('reload_ak snd', near(at('.Clipout'), 0.367) && near(at('.Clipin'), 1.067) && near(at('.AddAmmo'), 1.1) && near(at('.BoltPull'), 1.6), snd)
const loop = nova?.win?.reload_nova?.loop
check('reload_nova win.loop', near(loop?.[0], 0.367) && near(loop?.[1], 0.8), loop ?? 'missing')
const block = ak?.win?.shoot1_ak?.block?.[0]
check('shoot1_ak block', near(block?.[0], 0) && near(block?.[1], 0.4), block ?? 'missing')

// ---- Sounds
const evs = [...new Set(Object.values(W).flatMap(w => Object.values(w.vm?.snd ?? {}).flatMap(s => s.map(x => x[1]))))]
const clipMap = a.sounds.map.map.clip ?? {}, missing = evs.filter(e => !clipMap[e]?.length)
check('clip soundevents with defs >= 95 %', evs.length > 0 && (evs.length - missing.length) / evs.length >= 0.95, `${evs.length - missing.length}/${evs.length}${missing.length ? ' missing ' + missing.join(' ') : ''}`)
const land = new Set(Object.values(a.sounds.map.map.land ?? {}).map(d => d[0].ev))
check('Land_* events', land.size >= 47, `${land.size} (${Object.keys(a.sounds.map.map.land ?? {}).length} surfaces)`)
const noFile = [...Object.values(clipMap), ...Object.values(a.sounds.map.map.land ?? {})].flat().flatMap(d => d.files).filter(f => !existsSync(file(a.sounds.base + f)))
check('sound files on disk', !noFile.length, noFile.slice(0, 5))

// ---- Rollen
const knives = Object.values(W).filter(w => /^weapon_(knife|bayonet)/.test(w.className))
const noInspect = [byCls('weapon_ak47'), byCls('weapon_usp_silencer'), ...knives].filter(w => !w?.vm?.roles.inspect).map(w => w?.className)
check('inspect role (AK, USP, knives)', !noInspect.length, noInspect.length ? noInspect : `${knives.length + 2} weapons`)
const nades = ['flashbang', 'hegrenade', 'smokegrenade', 'molotov', 'decoy', 'incgrenade'].map(n => byCls('weapon_' + n))
check('pullpin role (6 grenades)', nades.every(w => w?.vm?.roles.pullpin), nades.map(w => w?.vm?.roles.pullpin ?? '-'))
check('agent clips', CLIP_LIST.length === 75 && CLIP_LIST2.length === 36 && Object.keys(a.agents.clipMeta).filter(k => /^(walk_|jump_additive_)/.test(k)).length === 36 && a.agents.clips.endsWith('clips_min2.glb'),
  `${Object.keys(a.agents.clipMeta).length} clips, ${a.agents.clips.split('/').pop()}`)

// ---- Welt-Clips: nur Oberkörper, ≤ 0.5 MB je Waffe
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
const UPPER = /^(spine_[23]|neck_0|head_0(_TWIST)?|clavicle_[LR]|scapula_[LR]|arm_(upper|lower)_[LR](_TWIST1?)?|hand_[LR]|finger_\w+_[LR]|wpnPivot|wpn|scap_\w+)$/
const world = Object.values(W).filter(w => w.world), matchDefs = new Set(input.weapons.filter(d => W[d]))
check('world clips for match weapons', world.length === matchDefs.size, `${world.length} of ${matchDefs.size}`)
const big = world.map(w => [w.className, statSync(file(w.world!.clips)).size / 1048576] as const).filter(([, mb]) => mb > 0.5)
check('world glb <= 0.5 MB', !big.length, big.length ? big : `max ${Math.max(...world.map(w => statSync(file(w.world!.clips)).size / 1048576)).toFixed(2)} MB`)
const akw = byCls('weapon_ak47')?.world
if (akw) {
  const doc = await io.read(file(akw.clips)), names = new Set(doc.getRoot().listAnimations().flatMap(x => x.listChannels().map(c => c.getTargetNode()!.getName())))
  check('world ak47 upper body only', [...names].every(n => UPPER.test(n)) && names.has('hand_R'), { roles: akw.roles, bones: names.size, other: [...names].filter(n => !UPPER.test(n)) })
} else check('world ak47 upper body only', false, 'no world clips for AK')

// ---- Viewmodel-Zuwachs ≤ 0.3 MB je Waffe (nur messbar beim ersten Neubau)
const grow = Object.entries(before).filter(([v]) => readJson(join(vmDir, `vm_${v}.json`))?.dur).map(([v, b]) => [v, (statSync(join(vmDir, `vm_${v}.glb`)).size - b) / 1048576] as const)
check('viewmodel growth <= 0.3 MB', grow.every(([, mb]) => mb <= 0.3), grow.length ? `max ${Math.max(...grow.map(g => g[1])).toFixed(2)} MB (${grow.sort((x, y) => y[1] - x[1]).slice(0, 3).map(([v, mb]) => `${v} ${mb.toFixed(2)}`).join(', ')})` : 'not measurable (already built)')

// ---- Bauzeit: erster Neubau ≤ 60 s (build.log), zweiter Start baut nichts
const lines = logLines(), firstLine = n1 > n0 ? lines[n1 - 1] : lines.at(-1)
const total = +(/total ([\d.]+) s/.exec(firstLine ?? '')?.[1] ?? NaN)
check('new parts build <= 60 s', total <= 60, `${firstLine ?? 'no log line'}${n1 > n0 ? '' : ' (earlier run)'}; prepare ${first.s.toFixed(1)} s`)
check('second start builds nothing', n2 === n1, `prepare ${second.s.toFixed(1)} s${n2 > n1 ? ': ' + lines[n2 - 1] : ''}`)

// ---- keine Valve-Datei im Repo
const st = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' })
const valve = st.split('\n').filter(l => /\.(glb|gltf|bin|wav|mp3|vsnd\w*|vnm\w+|vmdl\w*|vpk|webp|ktx2|exr)$/i.test(l.trim()))
check('no Valve files in repo', !valve.length, valve.length ? valve : 'git status clean of assets')

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0
