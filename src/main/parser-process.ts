// Läuft als eigener Prozess (utilityProcess), damit das Fenster beim Parsen nicht einfriert.
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { basename, join } from 'node:path'
import { parseDemo } from './parse.ts'
import type { MatchSummary } from '../shared/model.ts'

const port = (process as any).parentPort

port.on('message', (e: { data: { file: string; outDir: string } }) => {
  const { file, outDir } = e.data
  try {
    const m = parseDemo(readFileSync(file), basename(file), (pct, msg) => port.postMessage({ type: 'progress', pct, msg }))
    writeFileSync(join(outDir, `${m.id}.json.gz`), gzipSync(JSON.stringify(m)))
    const summary: MatchSummary = {
      id: m.id, fileName: m.fileName, map: m.map, parsedAt: m.parsedAt, teams: m.teams,
      finalScore: m.finalScore, rounds: m.rounds.length, players: m.players,
    }
    port.postMessage({ type: 'done', summary })
  } catch (err: any) {
    port.postMessage({ type: 'error', message: String(err?.message ?? err) })
  }
})
