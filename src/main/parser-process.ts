// Läuft als eigener Prozess (utilityProcess), damit das Fenster beim Parsen nicht einfriert.
// only3d = Match-ID: nur den 3D-Teil eines vorhandenen Matches neu lesen (Hintergrund, main/index.ts reread3d), <id>.json.gz bleibt.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { gunzipSync, gzipSync } from 'node:zlib'
import { basename, join } from 'node:path'
import { demoId, parseDemo, readDemoBuffer } from './parse.ts'
import { parse3d } from './parse3d.ts'
import { parseHud } from './parsehud.ts'
import { encode3d } from '../shared/cs3d.ts'
import type { MatchData, MatchSummary } from '../shared/model.ts'

const port = (process as any).parentPort

port.on('message', (e: { data: { file: string; outDir: string; only3d?: string } }) => {
  const { file, outDir, only3d } = e.data
  if (only3d) {
    try {
      try { setPriority(constants.priority.PRIORITY_LOW) } catch {}
      const buf = readDemoBuffer(readFileSync(file))
      if (demoId(buf) !== only3d) throw new Error(`${file} is a different demo now`)
      const m: MatchData = JSON.parse(gunzipSync(readFileSync(join(outDir, `${only3d}.json.gz`))).toString('utf8'))
      const out = join(outDir, `${only3d}.3d.bin.gz`)
      writeFileSync(out + '.part', gzipSync(encode3d(parse3d(buf, m)))) // erst fertig schreiben: die alte Datei bleibt bis dahin lesbar
      renameSync(out + '.part', out)
      port.postMessage({ type: 'done' })
    } catch (err: any) {
      port.postMessage({ type: 'error', message: String(err?.message ?? err) })
    }
    return
  }
  try {
    const buf = readDemoBuffer(readFileSync(file)) // Demo nur einmal entpacken (v1 + 3D + HUD)
    const m = parseDemo(buf, basename(file), (pct, msg) => port.postMessage({ type: 'progress', pct: pct * 0.75, msg }))
    writeFileSync(join(outDir, `${m.id}.json.gz`), gzipSync(JSON.stringify(m)))
    // 3D-Daten getrennt: ein Fehler hier darf den Import nicht kaputtmachen (3D-Tab zeigt dann error3d)
    let error3d: string | undefined
    try {
      const d = parse3d(buf, m, (pct, msg) => port.postMessage({ type: 'progress', pct: 75 + pct * 0.17, msg }))
      writeFileSync(join(outDir, `${m.id}.3d.bin.gz`), gzipSync(encode3d(d)))
    } catch (err: any) {
      console.error('3D data failed', err)
      error3d = String(err?.message ?? err)
    }
    // HUD-Daten ebenso getrennt: Fehler → Import ohne <id>.hud.json.gz, das HUD nutzt dann Ersatzwerte
    try {
      port.postMessage({ type: 'progress', pct: 92, msg: 'Reading HUD data' })
      writeFileSync(join(outDir, `${m.id}.hud.json.gz`), gzipSync(JSON.stringify(parseHud(buf, m))))
    } catch (err) {
      console.error('HUD data failed', err)
    }
    port.postMessage({ type: 'progress', pct: 95, msg: error3d ? 'Done (without 3D data)' : 'Done' }) // ≥ 95 schließt die Fortschrittsanzeige
    const summary: MatchSummary = {
      id: m.id, fileName: m.fileName, map: m.map, parsedAt: m.parsedAt, teams: m.teams,
      finalScore: m.finalScore, rounds: m.rounds.length, players: m.players, demoPath: file, error3d,
    }
    port.postMessage({ type: 'done', summary })
  } catch (err: any) {
    port.postMessage({ type: 'error', message: String(err?.message ?? err) })
  }
})
