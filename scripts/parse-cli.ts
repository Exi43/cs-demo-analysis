// Test: node scripts/parse-cli.ts <demo> → druckt Zusammenfassung pro Runde
import { readFileSync } from 'node:fs'
import { parseDemo } from '../src/main/parse.ts'

const file = process.argv[2]
const t0 = Date.now()
const m = parseDemo(readFileSync(file), file, (p, msg) => console.error(`${p}% ${msg} (${((Date.now() - t0) / 1000).toFixed(1)}s)`))
console.log(`Map ${m.map} | Teams ${m.teams.join(' vs ')} | Score ${JSON.stringify(m.finalScore)} | ${m.rounds.length} Runden`)
console.log('Spieler:', m.players.map(p => `${p.name} (${p.team})`).join(', '))
for (const r of m.rounds) {
  console.log(`R${r.num} ${r.teamOnSide.CT}=CT ${r.buy.CT}/${r.equipValue.CT}$ vs T ${r.buy.T}/${r.equipValue.T}$ → ${r.winner} (${r.reason})` +
    ` | ${r.kills.length} Kills, ${r.nades.length} Nades, ${r.frameTicks.length} Frames, ${r.tracks.length} Spieler` +
    (r.plant ? ` | Plant ${r.plant.site ?? '?'}` : '') +
    ` | ${['smoke', 'flash', 'he', 'molotov'].map(t => t[0] + r.nades.filter(n => n.type === t).length).join(' ')}`)
}
const json = JSON.stringify(m)
console.log(`JSON: ${(json.length / 1e6).toFixed(1)} MB`)
