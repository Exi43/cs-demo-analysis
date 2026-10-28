// Lineup-Startpaket aus Pro-Demos (wiederholbar für neue Demos):
//   node scripts/starter-pack.ts import <demo-ordner> <daten-ordner>  – alle .dem (rekursiv) nacheinander einlesen, je ein eigener Prozess (RAM)
//   node scripts/starter-pack.ts build <daten-ordner> <ausgabe-ordner> – Würfe je Map bündeln → starter-pack.csutil + starter-<map>.csutil
//   node scripts/starter-pack.ts images <ausgabe-ordner> <profil>     – je Lineup Bild „Aim“ + „Position“ aus der 3D-Map einbetten (App rendert)
// Daten-Ordner wie <profil>\matches der App (index.json, <id>.json.gz, <id>.3d.bin.gz), HUD-Daten fehlen.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { decode3d, encode3d, roundAt } from '../src/shared/cs3d.ts'
import type { MatchData, MatchSummary } from '../src/shared/model.ts'
import type { ThrowCandidate, UtilityLibrary } from '../src/shared/utility.ts'
import { lineupFromThrow } from '../src/shared/utility-capture.ts'
import { EXPORT_FORMAT, parseExport, type UtilityExport } from '../src/shared/utility-lib.ts'
import type { PackThrow } from '../src/shared/utility-pack.ts'

const [mode, a, b] = process.argv.slice(2)
const readIndex = (dir: string): MatchSummary[] => (existsSync(join(dir, 'index.json')) ? JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) : [])
const demos = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? demos(join(dir, e.name)) : /\.dem$/i.test(e.name) ? [join(dir, e.name)] : []))

if (mode === 'parse') {
  // eine Demo (Kindprozess): wie main/parser-process.ts, ohne HUD
  const { parseDemo, readDemoBuffer } = await import('../src/main/parse.ts')
  const { parse3d } = await import('../src/main/parse3d.ts')
  const buf = readDemoBuffer(readFileSync(a)), t0 = Date.now()
  const m = parseDemo(buf, a.split(/[\\/]/).pop()!, () => {})
  writeFileSync(join(b, `${m.id}.json.gz`), gzipSync(JSON.stringify(m)))
  writeFileSync(join(b, `${m.id}.3d.bin.gz`), gzipSync(encode3d(parse3d(buf, m))))
  const s: MatchSummary = { id: m.id, fileName: m.fileName, map: m.map, parsedAt: m.parsedAt, teams: m.teams, finalScore: m.finalScore, rounds: m.rounds.length, players: m.players, demoPath: a }
  writeFileSync(join(b, 'index.json'), JSON.stringify([...readIndex(b).filter(x => x.id !== m.id), s]))
  console.log(`${m.map} ${m.teams.join(' vs ')}: ${m.rounds.length} rounds in ${((Date.now() - t0) / 1000).toFixed(0)} s`)
} else if (mode === 'import') {
  mkdirSync(b, { recursive: true })
  for (const f of demos(resolve(a))) {
    if (readIndex(b).some(s => s.demoPath === f)) continue
    console.log(`parse ${f}`)
    const r = spawnSync(process.execPath, ['--max-old-space-size=12288', import.meta.filename, 'parse', f, b], { stdio: 'inherit', windowsHide: true })
    if (r.status) console.error(`failed (${r.status}): ${f}`)
  }
} else if (mode === 'build') {
  await build(a, b)
} else if (mode === 'images') {
  await images(a, b)
} else {
  console.error('usage: node scripts/starter-pack.ts import <demos> <data> | build <data> <out> | images <out> <profile>')
  process.exit(1)
}

/** gültig wie beim Import der App (Bilder bis 2 MB wie main/utility.ts), sonst Fehler */
function check(file: UtilityExport) { parseExport(JSON.parse(JSON.stringify(file)), Math.ceil((2 * 2 ** 20) / 3) * 4, 0) }

/** Würfe aller Matches (wie main/utility-throws.ts) plus Rundenlage für die Tags */
function throwsOf(dir: string, s: MatchSummary): PackThrow[] {
  const d = decode3d(gunzipSync(readFileSync(join(dir, `${s.id}.3d.bin.gz`))))
  const m: MatchData = JSON.parse(gunzipSync(readFileSync(join(dir, `${s.id}.json.gz`))).toString('utf8'))
  const out: PackThrow[] = []
  for (let i = 0; i < d.nade.type.length; i++) {
    const tick = d.nade.throwTick[i], sid = d.header.players[d.nade.player[i]]?.steamid, r = roundAt(d, tick)
    const R = r < 0 ? undefined : m.rounds.find(x => x.num === d.header.rounds[r].num)
    const side = R?.tracks.find(t => t.steamid === sid)?.side
    if (!R || !side) continue
    const c: ThrowCandidate | null = lineupFromThrow(d, i, s.id, side)
    if (c) out.push({ ...c, sec: (tick - R.freezeEndTick) / m.tickrate, plantSec: R.plant ? (R.plant.tick - R.freezeEndTick) / m.tickrate : undefined })
  }
  return out
}

async function build(dir: string, outDir: string) {
  const { PACK_TAGS, packLineups } = await import('../src/shared/utility-pack.ts') // erst hier: der Import-Modus braucht es nicht
  mkdirSync(outDir, { recursive: true })
  const byMap = new Map<string, PackThrow[]>()
  for (const s of readIndex(dir)) {
    const list = byMap.get(s.map) ?? []
    list.push(...throwsOf(dir, s))
    byMap.set(s.map, list)
  }
  const all: UtilityExport['library']['lineups'] = [], now = Date.now()
  const write = (name: string, lineups: typeof all) => {
    const used = new Set(lineups.flatMap(l => l.tags))
    const file: UtilityExport = {
      format: EXPORT_FORMAT, version: 1, exportedAt: now, images: {},
      library: { version: 1, lineups, tags: PACK_TAGS.filter(t => used.has(t.id)).map(t => ({ ...t, updatedAt: now })), playbooks: [], techniques: [] },
    }
    check(file)
    writeFileSync(join(outDir, name), JSON.stringify(file))
  }
  for (const [map, list] of [...byMap].sort()) {
    const lineups = packLineups(list, now)
    const count = (t: string) => lineups.filter(l => l.type === t).length
    console.log(`${map}: ${list.length} throws → ${lineups.length} lineups (smoke ${count('smoke')}, molotov ${count('molotov')}, flash ${count('flash')}, he ${count('he')})`)
    for (const l of lineups) console.log(`  ${l.side.padEnd(2)} ${l.title} | ${l.technique.join('+')} | ${l.description}`)
    write(`starter-${map.replace(/^de_/, '')}.csutil`, lineups)
    all.push(...lineups)
  }
  write('starter-pack.csutil', all)
  console.log(`starter-pack.csutil: ${all.length} lineups`)
}

/**
 * Bilder ins Paket (vorher npx electron-vite build): die App rendert unsichtbar mit Profil <profile> (fertige Map-Assets darin sparen
 * Minuten je Map) je Lineup „Aim“ + „Position“ (#utility/capture, src/renderer/utility/capture) und speichert sie in dessen library.json;
 * danach stehen die Bilder (WebP base64) in allen starter-*.csutil des Ordners. Fehlt einem Lineup ein Bild, bleibt es ohne.
 */
async function images(outDir: string, profile: string) {
  const electron = (await import('electron')).default as unknown as string // npm-Paket electron = Pfad der Programmdatei
  const dir = join(resolve(profile), 'utility'), t0 = Date.now()
  const r = spawnSync(electron, ['.', `--user-data-dir=${resolve(profile)}`], {
    cwd: join(import.meta.dirname, '..'), stdio: 'inherit', windowsHide: true,
    env: { ...process.env, CSDA_SHOT: join(resolve(profile), 'capture.png'), CSDA_VIEW: 'utility/capture', CSDA_UTIL_IMPORT: resolve(outDir, 'starter-pack.csutil'), CSDA_READY: String(6 * 3600e3), CSDA_WAIT: '500' },
  })
  if (r.status !== 0) throw new Error(`app failed (${r.status ?? r.error})`)
  const got = new Map((JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')) as UtilityLibrary).lineups.map(l => [l.id, l.images]))
  for (const f of readdirSync(outDir).filter(f => /^starter-.+\.csutil$/.test(f)).sort()) {
    const file: UtilityExport = JSON.parse(readFileSync(join(outDir, f), 'utf8')), ls = file.library.lineups
    for (const l of ls) l.images = got.get(l.id) ?? []
    file.images = Object.fromEntries(ls.flatMap(l => l.images).map(h => [h, readFileSync(join(dir, 'images', `${h}.webp`)).toString('base64')]))
    check(file)
    writeFileSync(join(outDir, f), JSON.stringify(file))
    console.log(`${f}: ${ls.filter(l => l.images.length).length}/${ls.length} lineups with images, ${(statSync(join(outDir, f)).size / 2 ** 20).toFixed(1)} MB`)
  }
  console.log(`images: ${((Date.now() - t0) / 60e3).toFixed(1)} min`)
}
